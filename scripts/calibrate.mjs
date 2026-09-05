#!/usr/bin/env node
/**
 * Калибровка порога.
 *
 * Пустой шортлист допускает два объяснения, и снаружи они выглядят одинаково:
 * либо рынки предсказаний действительно не предлагают случаев Бёрри, либо
 * планка задрана выше, чем её способен взять любой реальный контракт.
 *
 * Отличить можно только одним способом: прогнать те же ворота на рынках,
 * которые УЖЕ разрешились без спора. Это заведомо исполнимые механически
 * контракты — иначе они бы до спора дошли.
 *
 * Главный результат — не общая доля прошедших, а доля отказов ПО КАЖДОМУ
 * критерию. Если какой-то критерий отсекает почти все чисто разрешившиеся
 * рынки, он описывает не исполнимость, а вкус автора.
 *
 * Запуск: node scripts/calibrate.mjs [сколько рынков]
 */

import fs from 'node:fs/promises';
import { gateA, gateB, gateC, CRITERIA } from './gates.mjs';

const GAMMA = 'https://gamma-api.polymarket.com/markets';
const WANT = Number(process.argv[2] || 120);
const WITH_C = process.env.CALIBRATE_RESOLVER === '1';   // стадия C платная — по флагу
const C_LIMIT = Number(process.env.CALIBRATE_RESOLVER_LIMIT || 10);

async function page(offset) {
  const url = `${GAMMA}?closed=true&order=volumeNum&ascending=false&limit=50&offset=${offset}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`Gamma API ${r.status}`);
  return r.json();
}

/* Чисто разрешившийся рынок: закрыт, исход определён, спора не было. */
function cleanlyResolved(m) {
  if (!m.closed) return false;
  const uma = JSON.stringify(m.umaResolutionStatuses ?? '').toLowerCase();
  if (uma.includes('disput')) return false;
  let p = m.outcomePrices;
  if (typeof p === 'string') { try { p = JSON.parse(p); } catch { return false; } }
  if (!Array.isArray(p) || p.length < 2) return false;
  const a = Number(p[0]), b = Number(p[1]);
  // исход определён: одна сторона 1, другая 0
  return (a === 1 && b === 0) || (a === 0 && b === 1);
}

async function main() {
  const pages = [];
  for (let off = 0; off < WANT; off += 50) pages.push(page(off));
  const all = (await Promise.all(pages)).flat();

  const clean = all.filter(cleanlyResolved).filter(m => (m.description || '').length > 200);
  console.log(`закрытых рынков получено: ${all.length}, из них разрешились чисто и с правилами: ${clean.length}`);
  if (!clean.length) throw new Error('не нашлось чисто разрешившихся рынков — калибровать не на чем');

  const perCriterion = Object.fromEntries(Object.keys(CRITERIA).map(k => [k, { pass: 0, fail: 0 }]));
  let passA = 0;
  const rowsA = [];

  for (const m of clean) {
    const desc = m.description;
    const a = gateA({ ...m, end: (m.endDateIso || m.endDate || '').slice(0, 10) }, desc);
    for (const [k, ok] of Object.entries(a.checks)) perCriterion[k][ok ? 'pass' : 'fail']++;
    if (a.pass) { passA++; rowsA.push({ m, desc, ev: a.ev }); }
  }

  // стадия B — только на прошедших A, иначе бессмысленно
  let passB = 0;
  const rowsB = [];
  for (const r of rowsA) {
    const b = await gateB(r.ev.source_url, r.desc);
    if (b.pass) { passB++; rowsB.push({ ...r, evB: b.ev }); }
    else r.failB = b.fails;
  }

  // стадия C — по флагу и с лимитом, она платная
  let passC = null, cRows = [];
  if (WITH_C && rowsB.length) {
    passC = 0;
    for (const r of rowsB.slice(0, C_LIMIT)) {
      const c = await gateC(r.desc, {
        slug: r.m.slug, created_at: r.m.createdAt,
        end_date: (r.m.endDateIso || r.m.endDate || '').slice(0, 10),
      });
      if (c.pass) passC++;
      cRows.push({ q: r.m.question, pass: c.pass, fails: c.fails });
    }
  }

  const out = {
    generated: new Date().toISOString(),
    sample: clean.length,
    stage_a_passed: passA,
    stage_b_passed: passB,
    stage_c_checked: cRows.length || null,
    stage_c_passed: passC,
    per_criterion: Object.fromEntries(Object.entries(perCriterion).map(([k, v]) => [k, {
      name: CRITERIA[k],
      passed: v.pass,
      failed: v.fail,
      fail_rate: +(v.fail / (v.pass + v.fail) * 100).toFixed(1),
    }])),
    stage_c_detail: cRows,
    verdict: null,
  };

  const worst = Object.entries(out.per_criterion).sort((a, b) => b[1].fail_rate - a[1].fail_rate)[0];
  out.verdict = passA === 0
    ? `Ни один из ${clean.length} чисто разрешившихся рынков не прошёл ворота A. Планка выше реальности. Больше всего отсекает: «${worst[1].name}» (${worst[1].fail_rate}%).`
    : `Ворота A прошли ${passA} из ${clean.length} чисто разрешившихся рынков (${(passA / clean.length * 100).toFixed(1)}%). Планка достижима. Самый строгий критерий: «${worst[1].name}» (${worst[1].fail_rate}%).`;

  await fs.writeFile('data/calibration.json', JSON.stringify(out, null, 2) + '\n');
  console.log('\n' + out.verdict + '\n');
  console.log('отказы по критериям:');
  for (const [, v] of Object.entries(out.per_criterion).sort((a, b) => b[1].fail_rate - a[1].fail_rate))
    console.log(`  ${String(v.fail_rate).padStart(5)}%  ${v.name}`);
  console.log(`\nстадия B прошла: ${passB} из ${passA}`);
  if (passC !== null) console.log(`стадия C прошла: ${passC} из ${cRows.length}`);
}

main().catch(e => { console.error('ОШИБКА:', e.message); process.exit(1); });
