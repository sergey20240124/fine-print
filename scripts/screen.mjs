#!/usr/bin/env node
/**
 * Отбор случая Бёрри: правила самодостаточны настолько, что рынок
 * разрешается механически, без человеческого суждения.
 *
 * Нас интересует ТОЛЬКО положительный класс. Всё, что не прошло, просто
 * не попадает в шортлист; категории «размыто» здесь нет, потому что она
 * ни на что не влияет.
 *
 * Три стадии, в порядке дешевизны:
 *   A. Детерминированные ворота  — обычный код, без сети и без модели
 *   B. Достижимость источника    — один GET по названному URL
 *   C. Резолвер                  — модель обязана написать процедуру
 *
 * Стадии независимы по конструкции: A смотрит на форму текста, B на мир
 * за текстом, C требует построить работающую процедуру. Повторить один и
 * тот же анализ дважды было бы бесполезно — ошибки коррелировали бы.
 *
 * Везде отказ по умолчанию: любая неопределённость — не в шортлист.
 */

import fs from 'node:fs/promises';

const GAMMA = 'https://gamma-api.polymarket.com/markets';
const API   = 'https://api.anthropic.com/v1/messages';
const MODEL = process.env.MODEL || 'claude-opus-5';
const KEY   = process.env.ANTHROPIC_API_KEY || '';

/* ---------- A. детерминированные ворота ---------- */

/* Оговорки, возвращающие интерпретацию через чёрный ход. Одной достаточно. */
const ESCAPE = [
  'consensus of credible reporting', 'credible reporting', 'widely reported',
  'at the discretion', 'sole discretion', 'in the event of ambiguity',
  'generally accepted', 'reasonably determine', 'may also be used',
  'a consensus of', 'deemed to have', 'in the spirit of',
];

/* Слова, без которых порог не является порогом. */
const THRESHOLD = [
  'equal to or above', 'equal to or greater', 'at least', 'greater than',
  'less than', 'no later than', 'exceeds', 'or more', 'or higher',
  'or fewer', 'above', 'below', '≥', '≤',
];

/* Что происходит, когда данных нет. Без этого правила не самодостаточны. */
const MISSING = [
  'if no data', 'has not been published', 'will resolve based on data',
  'if data is not', 'in the absence of', 'if no such', 'fails to publish',
];

const MONTHS = 'january|february|march|april|may|june|july|august|september|october|november|december';

function datesIn(text) {
  const out = [];
  const push = (y, m, d) => {
    const dt = new Date(Date.UTC(+y, m, +d || 1));
    if (!isNaN(dt)) out.push(dt);
  };
  for (const m of text.matchAll(new RegExp(`(${MONTHS})\\s+(\\d{1,2}),?\\s+(\\d{4})`, 'gi')))
    push(m[3], MONTHS.split('|').indexOf(m[1].toLowerCase()), m[2]);
  for (const m of text.matchAll(new RegExp(`(\\d{1,2})\\s+(${MONTHS})\\s+(\\d{4})`, 'gi')))
    push(m[3], MONTHS.split('|').indexOf(m[2].toLowerCase()), m[1]);
  for (const m of text.matchAll(/(\d{4})-(\d{2})-(\d{2})/g))
    push(m[1], +m[2] - 1, m[3]);
  return out;
}

function firstUrl(text) {
  const m = text.match(/https?:\/\/[^\s)"']+/);
  return m ? m[0].replace(/[.,;]$/, '') : null;
}

function gateA(m, desc) {
  const t = desc.toLowerCase();
  const fails = [];
  const ev = {};

  // 1. история споров UMA — эмпирический признак, не суждение
  const uma = JSON.stringify(m.umaResolutionStatuses ?? '').toLowerCase();
  if (uma.includes('disput')) fails.push('рынок уже оспаривался в UMA');
  ev.uma_bond = m.umaBond ?? null;
  ev.uma_statuses = m.umaResolutionStatuses ?? null;

  // 2. запасной вход для интерпретации
  const esc = ESCAPE.filter(p => t.includes(p));
  if (esc.length) fails.push('оговорка-лазейка: ' + esc.join(', '));

  // 3. машиночитаемый источник
  const url = firstUrl(desc);
  if (!url) fails.push('в правилах нет ссылки на источник');
  ev.source_url = url;

  // 4. измеримый порог
  const thr = THRESHOLD.filter(p => t.includes(p));
  if (!thr.length) fails.push('нет сравнения с порогом');
  ev.threshold_words = thr;

  // 5. поведение при отсутствии данных
  const miss = MISSING.filter(p => t.includes(p));
  if (!miss.length) fails.push('не описано, что делать при отсутствии данных');
  ev.missing_data_words = miss;

  // 6. дата в правилах не должна уходить дальше даты на карточке
  const end = new Date((m.end || m.endDate || '') + 'T00:00:00Z');
  const latest = datesIn(desc).sort((a, b) => b - a)[0];
  ev.end_date = isNaN(end) ? null : end.toISOString().slice(0, 10);
  ev.latest_date_in_rules = latest ? latest.toISOString().slice(0, 10) : null;
  if (latest && !isNaN(end) && latest - end > 7 * 86400e3)
    fails.push(`срок в правилах (${ev.latest_date_in_rules}) дальше даты на карточке (${ev.end_date})`);

  return { pass: fails.length === 0, fails, ev };
}

/* ---------- B. достижимость источника ---------- */

async function gateB(url) {
  if (!url) return { pass: false, fails: ['нет URL источника'], ev: {} };
  try {
    const r = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(15000) });
    if (!r.ok) return { pass: false, fails: [`источник отвечает ${r.status}`], ev: { http: r.status } };
    return { pass: true, fails: [], ev: { http: r.status } };
  } catch (e) {
    return { pass: false, fails: ['источник недостижим: ' + e.message], ev: {} };
  }
}

/* ---------- C. резолвер ---------- */

const RESOLVER_PROMPT = `Ты проверяешь, можно ли разрешить рынок предсказаний механически.

Задача: по тексту правил написать процедуру, которую выполнит компьютер в дату дедлайна БЕЗ единого человеческого решения.

Ответ давай ТОЛЬКО вызовом инструмента resolver, без текста вокруг.

Правило отказа: если ХОТЬ ОДИН шаг требует оценить намерение, значимость, качественный признак или выбрать между толкованиями — ставь executable=false и назови это в human_judgment_required. Формулировки вида «наступление с намерением установить контроль», «существенное нарушение», «широко признано» неисполнимы по определению.

Каждый input обязан нести дословную цитату. Цитата без соответствия тексту — отказ.`;

const RESOLVER_TOOL = {
  name: 'resolver',
  description: 'Процедура механического разрешения рынка предсказаний.',
  input_schema: {
    type: 'object',
    properties: {
      executable: { type: 'boolean' },
      inputs: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            source_url: { type: 'string' },
            field: { type: 'string' },
            quote: { type: 'string', description: 'дословная цитата из правил' },
          },
          required: ['name', 'quote'],
        },
      },
      procedure: { type: 'array', items: { type: 'string' } },
      comparison: { type: 'string' },
      missing_data_rule: { type: 'string' },
      human_judgment_required: { type: ['string', 'null'] },
    },
    required: ['executable', 'inputs', 'procedure', 'comparison'],
  },
};

/* Запасной разбор, если модель почему-то ответила текстом: ищем
   сбалансированный объект от первой скобки, а не жадной регуляркой —
   она цепляет фигурные скобки из окружающей прозы. */
function extractJson(text) {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const src = fence ? fence[1] : text;
  // пробуем каждую открывающую скобку: первая может принадлежать прозе
  for (let start = src.indexOf('{'); start >= 0; start = src.indexOf('{', start + 1)) {
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < src.length; i++) {
      const c = src[i];
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (c === '{') depth++;
      else if (c === '}' && --depth === 0) {
        try {
          const o = JSON.parse(src.slice(start, i + 1));
          if (o && typeof o === 'object' && 'executable' in o) return o;
        } catch { /* не тот объект — идём к следующей скобке */ }
        break;
      }
    }
  }
  return null;
}

async function gateC(desc) {
  if (!KEY) return { pass: false, skipped: true, fails: ['ANTHROPIC_API_KEY не задан'], ev: {} };
  let body;
  try {
    const r = await fetch(API, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 4000,
        system: RESOLVER_PROMPT,
        tools: [RESOLVER_TOOL],
        tool_choice: { type: 'tool', name: 'resolver' },
        messages: [{ role: 'user', content: 'ПРАВИЛА РАЗРЕШЕНИЯ:\n\n' + desc }],
      }),
      signal: AbortSignal.timeout(120000),
    });
    if (!r.ok) {
      const txt = await r.text();
      return { pass: false, fails: [`API ${r.status}: ${txt.slice(0, 200)}`], ev: {} };
    }
    body = await r.json();
  } catch (e) {
    return { pass: false, fails: ['вызов модели не удался: ' + e.message], ev: {} };
  }

  const blocks = body.content || [];
  const tool = blocks.find(c => c.type === 'tool_use' && c.name === 'resolver');
  let j = tool ? tool.input : null;
  if (!j) {
    const text = blocks.map(c => c.text || '').join('');
    j = extractJson(text);
    if (!j) return {
      pass: false,
      fails: ['модель не вернула структуру' + (body.stop_reason === 'max_tokens' ? ' (ответ обрезан по max_tokens)' : '')],
      ev: { stop_reason: body.stop_reason, raw: text.slice(0, 400) },
    };
  }

  const fails = [];
  if (j.executable !== true) fails.push('модель: процедура неисполнима');
  if (j.human_judgment_required) fails.push('требует человека: ' + j.human_judgment_required);
  if (!Array.isArray(j.procedure) || j.procedure.length < 2) fails.push('процедура короче двух шагов');
  if (!Array.isArray(j.inputs) || !j.inputs.length) fails.push('не названы входные данные');
  else for (const i of j.inputs) {
    if (!i.quote) { fails.push('вход без цитаты: ' + (i.name || '?')); continue; }
    // цитата должна реально встречаться в правилах — защита от выдумывания
    const norm = s => s.toLowerCase()
      .replace(/[\u2010-\u2015\u2212]/g, '-')      // все виды тире
      .replace(/[\u2018\u2019\u201c\u201d]/g, '"') // все виды кавычек
      .replace(/[^a-z0-9а-яё"%.-]+/gi, ' ')
      .replace(/\s+/g, ' ').trim();
    const needle = norm(i.quote).slice(0, 30);
    if (needle.length >= 12 && !norm(desc).includes(needle))
      fails.push('цитата не найдена в тексте правил: ' + String(i.quote).slice(0, 60));
  }
  return { pass: fails.length === 0, fails, ev: j };
}

/* ---------- прогон ---------- */

async function fetchDesc(slug) {
  const r = await fetch(`${GAMMA}?slug=${encodeURIComponent(slug)}`,
                        { signal: AbortSignal.timeout(20000) });
  if (!r.ok) return null;
  const arr = await r.json();
  return Array.isArray(arr) && arr[0] ? arr[0] : null;
}

async function main() {
  const scan = JSON.parse(await fs.readFile('data/markets.json', 'utf8'));
  const results = [];

  for (const m of scan.markets) {
    if (!m.slug) { results.push({ q: m.q, slug: m.slug, stage: 'A', pass: false, fails: ['нет slug'] }); continue; }
    const full = await fetchDesc(m.slug);
    const desc = full?.description || '';
    if (!desc) { results.push({ q: m.q, slug: m.slug, stage: 'A', pass: false, fails: ['нет описания'] }); continue; }

    const a = gateA({ ...m, ...full }, desc);
    if (!a.pass) { results.push({ q: m.q, slug: m.slug, stage: 'A', pass: false, fails: a.fails, ev: a.ev }); continue; }

    const b = await gateB(a.ev.source_url);
    if (!b.pass) { results.push({ q: m.q, slug: m.slug, stage: 'B', pass: false, fails: b.fails, ev: { ...a.ev, ...b.ev } }); continue; }

    const c = await gateC(desc);
    results.push({
      q: m.q, slug: m.slug, stage: 'C', pass: c.pass, skipped: c.skipped || false,
      fails: c.fails, ev: { ...a.ev, ...b.ev }, resolver: c.ev,
      market: { p: m.p, q2: m.q2, vol: m.vol, end: m.end, cat: m.cat, spread: m.spread },
    });
  }

  const shortlist = results.filter(r => r.pass);
  const out = {
    generated: new Date().toISOString(),
    model: KEY ? MODEL : null,
    checked: results.length,
    passed: shortlist.length,
    note: 'Пустой шортлист — нормальный и частый результат. Стабильные три-четыре рынка в неделю означают, что пороги поехали, а не что рынок стал щедрее.',
    shortlist,
    rejected: results.filter(r => !r.pass)
      .map(({ q, slug, stage, fails, ev }) => ({
        q, slug, stage, fails,
        // диагностика только для поздних стадий — на A причина и так в fails
        ...(stage === 'C' && ev ? { diag: { stop_reason: ev.stop_reason, raw: ev.raw } } : {}),
      })),
  };
  await fs.writeFile('data/shortlist.json', JSON.stringify(out, null, 2) + '\n');
  console.log(`проверено ${results.length}, прошло ${shortlist.length}`);
  for (const r of shortlist) console.log('  ПРОШЁЛ:', r.q);
}

main().catch(e => { console.error('ОШИБКА:', e.message); process.exit(1); });
