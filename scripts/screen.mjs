#!/usr/bin/env node
/**
 * Отбор случая Бёрри: правила самодостаточны настолько, что рынок
 * разрешается механически, без человеческого суждения.
 *
 * Нас интересует ТОЛЬКО положительный класс. Всё, что не прошло, просто
 * не попадает в шортлист; категории «размыто» здесь нет, потому что она
 * ни на что не влияет.
 *
 * Три стадии, независимые по конструкции (см. gates.mjs):
 *   A. форма правил   — код, без сети и без модели
 *   B. источник       — отдаёт ли он названный показатель
 *   C. резолвер       — можно ли написать процедуру
 *
 * Везде отказ по умолчанию: любая неопределённость — не в шортлист.
 */

import fs from 'node:fs/promises';
import { gateA, gateB, gateC } from './gates.mjs';
import { attention } from './attention.mjs';

/* Стадия C платная, пул большой — платим только за самых заброшенных.
   Порядок обхода задаёт вторая ось, и это её основная работа. */
const C_LIMIT = Number(process.env.SCREEN_LIMIT || 12);

const GAMMA = 'https://gamma-api.polymarket.com/markets';

async function fetchFull(slug) {
  const r = await fetch(`${GAMMA}?slug=${encodeURIComponent(slug)}`,
                        { signal: AbortSignal.timeout(20000) });
  if (!r.ok) return null;
  const arr = await r.json();
  return Array.isArray(arr) && arr[0] ? arr[0] : null;
}

async function main() {
  /* Отбираем по пулу, а не по витрине. Витрина — двадцать крупнейших по
     обороту, то есть ровно самые разобранные контракты: искать случай
     Бёрри там бессмысленно по построению. */
  let pool;
  try {
    pool = JSON.parse(await fs.readFile('data/pool.json', 'utf8')).markets;
  } catch {
    console.log('data/pool.json нет — работаю по витрине');
    pool = JSON.parse(await fs.readFile('data/markets.json', 'utf8')).markets;
  }

  /* Ворота A и B бесплатны, их гоняем по всему пулу. */
  const results = [];
  const survivors = [];

  for (const m of pool) {
    const base = { q: m.q, slug: m.slug };
    if (!m.slug) { results.push({ ...base, stage: 'A', pass: false, fails: ['нет slug'] }); continue; }

    /* Описание уже в пуле — доп. запрос только если его там нет. */
    let full = m.desc ? { description: m.desc, createdAt: m.createdAt } : await fetchFull(m.slug);
    const desc = full?.description || '';
    if (!desc) { results.push({ ...base, stage: 'A', pass: false, fails: ['нет описания'] }); continue; }

    const a = gateA({ ...m, ...full }, desc);
    if (!a.pass) { results.push({ ...base, stage: 'A', pass: false, fails: a.fails, ev: a.ev }); continue; }

    const b = await gateB(a.ev.source_url, desc);
    if (!b.pass) { results.push({ ...base, stage: 'B', pass: false, fails: b.fails, ev: { ...a.ev, ...b.ev } }); continue; }

    /* Ненайденный термин источника — предупреждение, а не отказ: стадия B
       не может отличить «поля нет» от «поле за запросом». */
    const attrs = [...a.attrs];
    if (b.ev.terms_missing)
      attrs.push({ key: 'terms', note: 'названный в правилах термин в источнике не найден: '
                                       + (b.ev.quoted_terms || []).join(', ') });

    survivors.push({ base, m, full, desc, a, b, attrs, att: attention(m) });
  }

  /* Вторая ось решает, за кого платим. Разобранный рынок может быть сколь
     угодно механическим — читать его правила бессмысленно, их прочитали все. */
  survivors.sort((x, y) => y.att.score - x.att.score);
  const paid = survivors.slice(0, C_LIMIT);
  console.log(`ворота прошли ${survivors.length}, в резолвер уходит ${paid.length}`);

  for (const s of survivors.slice(C_LIMIT))
    results.push({ ...s.base, stage: 'C', pass: false, attention: s.att,
                   fails: ['не попал в лимит стадии C: слишком много внимания к рынку'],
                   ev: { ...s.a.ev, ...s.b.ev } });

  for (const s of paid) {
    const { base, m, full, desc, a, b, attrs, att } = s;
    /* Метаданные подаются отдельно: доступны машине, даже если правила их не
       повторяют. Иначе резолвер справедливо жалуется на дату, которой в
       тексте нет, — а это ограничение чтения, не контракта. */
    const c = await gateC(desc, {
      slug: m.slug,
      created_at: full.createdAt,
      start_date: full.startDateIso || full.startDate,
      end_date: m.end,
    });

    results.push({
      ...base, stage: 'C', pass: c.pass, skipped: c.skipped || false,
      fails: c.fails, attrs, attention: att,
      ev: { ...a.ev, ...b.ev }, resolver: c.ev,
      market: { p: m.p, q2: m.q2, vol: m.vol, end: m.end, cat: m.cat, spread: m.spread },
    });
  }

  const shortlist = results.filter(r => r.pass);
  const out = {
    generated: new Date().toISOString(),
    model: process.env.ANTHROPIC_API_KEY ? (process.env.MODEL || 'claude-opus-5') : null,
    checked: results.length,
    gates_passed: results.filter(r => r.stage === 'C').length,
    resolver_calls: Math.min(C_LIMIT, results.filter(r => r.stage === 'C' && r.resolver).length),
    passed: shortlist.length,
    note: 'Пустой шортлист — нормальный результат. Достижима ли планка вообще, отвечает scripts/calibrate.mjs, а не догадки. Ворота жёсткие только по трём критериям; остальное — атрибуты, они показываются на карточке, но не отсеивают.',
    shortlist: shortlist.sort((a, b) => (b.attention?.score || 0) - (a.attention?.score || 0)),
    rejected: results.filter(r => !r.pass).map(({ q, slug, stage, fails, ev }) => ({
      q, slug, stage, fails,
      ...(stage !== 'A' && ev ? { diag: {
        source_url: ev.source_url, http: ev.http, content_type: ev.content_type,
        is_data: ev.is_data, is_shell: ev.is_shell, terms_found: ev.terms_found,
        stop_reason: ev.stop_reason, raw: ev.raw,
      } } : {}),
    })),
  };
  await fs.writeFile('data/shortlist.json', JSON.stringify(out, null, 2) + '\n');
  console.log(`проверено ${results.length}, прошло ${shortlist.length}`);
  for (const r of shortlist) console.log('  ПРОШЁЛ:', r.q);
  for (const r of results.filter(x => !x.pass && x.stage !== 'A'))
    console.log(`  ${r.stage}: ${r.q} — ${r.fails.join(' | ').slice(0, 160)}`);
}

main().catch(e => { console.error('ОШИБКА:', e.message); process.exit(1); });
