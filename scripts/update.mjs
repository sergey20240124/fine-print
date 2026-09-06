#!/usr/bin/env node
/**
 * Обновляет data/markets.json из публичного Gamma API Polymarket.
 * Без зависимостей: нужен Node 18+ (нативный fetch).
 *
 * Принцип, который здесь важнее кода: скрипт НЕ выставляет флаги про
 * ясность правил. Их ставит человек, прочитавший описание рынка, в
 * data/rules-read.json. Автоматическая уверенность — ровно то, против
 * чего построена эта страница.
 */

const API = 'https://gamma-api.polymarket.com/markets';
const KEEP = 20;                 // сколько рынков показать на странице
const MIN_VOLUME = 200_000;      // порог для витрины
const HORIZON_DAYS = 400;        // не берём разрешение дальше этого срока

/* Пул для отбора — отдельная сущность, и намеренно.
   Витрина показывает крупнейшие по обороту рынки: там видно, где деньги
   толпы. Но отбирать случай Бёрри среди самых разобранных контрактов
   бессмысленно: их правила прочитали все. Пул берёт порог на порядок ниже
   и не ограничен двадцаткой — заброшенные рынки живут именно там. */
const POOL_KEEP = 300;
const POOL_MIN_VOLUME = 20_000;

/* Ставки комиссии тейкера по категориям площадки.
   Категории в API на уровне рынка нет, поэтому: сначала ручное
   переопределение по slug, затем эвристика, затем консервативный
   максимум — чтобы доходность в таблице скорее занижалась, чем завышалась. */
const FEE = { geopolitics: 0, politics: 0.04, finance: 0.04, tech: 0.04,
              economy: 0.05, culture: 0.05, weather: 0.05, crypto: 0.07 };
const FEE_DEFAULT = 0.05;

const EXCLUDE = [
  /\b(nba|nfl|nhl|mlb|ufc|atp|wta|epl|uefa|premier league|champions league)\b/i,
  /\b(vs\.?|beat|win the (game|match|series|title)|super bowl|world cup)\b/i,
  /\b(bitcoin|ethereum|solana|btc|eth|xrp|dogecoin|token|airdrop)\b/i,
  /\bprice (above|below|between)\b/i,
];

const GEO = /\b(invade|invasion|war|ceasefire|strike|nuclear|nato|troops|hostage|blockade|strait|sanction)\b/i;
const FIN = /\b(fed|interest rate|inflation|cpi|recession|gdp|unemployment|treasury)\b/i;
const POL = /\b(election|president|prime minister|senate|congress|governor|parliament|impeach|nominee)\b/i;

async function getPage(offset) {
  const url = `${API}?closed=false&volume_num_min=${POOL_MIN_VOLUME}` +
              `&order=volumeNum&ascending=false&limit=50&offset=${offset}`;
  const r = await fetch(url, { headers: { 'User-Agent': 'fine-print-tracker' } });
  if (!r.ok) throw new Error(`Gamma API ${r.status} на offset=${offset}`);
  return r.json();
}

function feeFor(slug, question, overrides) {
  if (overrides[slug] && overrides[slug].category) {
    const c = overrides[slug].category;
    if (c in FEE) return FEE[c];
  }
  if (GEO.test(question)) return FEE.geopolitics;
  if (FIN.test(question)) return FEE.finance;
  if (POL.test(question)) return FEE.politics;
  return FEE_DEFAULT;
}

function parsePrices(m) {
  let raw = m.outcomePrices;
  if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch { return null; } }
  if (!Array.isArray(raw) || raw.length < 2) return null;
  const a = Number(raw[0]), b = Number(raw[1]);
  if (!isFinite(a) || !isFinite(b)) return null;
  if (a <= 0 || b <= 0 || a >= 1 || b >= 1) return null;   // разрешённые/вырожденные пропускаем
  return [a, b];
}

const MONTHS = ['января','февраля','марта','апреля','мая','июня',
                'июля','августа','сентября','октября','ноября','декабря'];
const ruDate = d => `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;

async function main() {
  const fs = await import('node:fs/promises');
  let rulesRead = {};
  try { rulesRead = JSON.parse(await fs.readFile('data/rules-read.json', 'utf8')); }
  catch { console.log('data/rules-read.json не найден — флаги про правила будут пустыми'); }

  const pages = await Promise.all(
    Array.from({ length: 12 }, (_, i) => getPage(i * 50)));   // до 600 рынков
  const all = pages.flat();
  console.log(`получено рынков: ${all.length}`);

  const now = new Date();
  const horizon = new Date(now.getTime() + HORIZON_DAYS * 86400_000);

  const rows = [];
  for (const m of all) {
    const q = m.question || '';
    if (EXCLUDE.some(re => re.test(q))) continue;
    const prices = parsePrices(m);
    if (!prices) continue;
    const end = (m.endDateIso || m.endDate || '').slice(0, 10);
    if (!end) continue;
    if (new Date(end + 'T00:00:00Z') > horizon) continue;

    const [p, q2] = prices;
    const slug = m.slug || '';
    const manual = rulesRead[slug] || {};

    let flag = '';
    if (new Date(end + 'T00:00:00Z') < now) flag = 'дата прошла';
    else if (p >= 0.45 && p <= 0.55) flag = 'монетка';
    // флаг про правила ставится ТОЛЬКО вручную, из rules-read.json
    if (manual.rules === 'clear') flag = 'правила ясны';
    else if (manual.rules === 'vague') flag = 'правила размыты';

    rows.push({
      q: manual.title_ru || q,
      slug,
      /* описание кладём сразу: иначе отбор делает по запросу на каждый
         рынок пула, то есть триста лишних обращений к API за прогон */
      desc: m.description || '',
      createdAt: m.createdAt || null,
      p, q2,
      vol: Math.round(Number(m.volumeNum) || 0),
      end,
      cat: feeFor(slug, q, rulesRead),
      spread: m.spread != null ? Number(m.spread) : null,
      liq: m.liquidityNum != null ? Math.round(Number(m.liquidityNum)) : null,
      flag,
    });
  }

  rows.sort((a, b) => b.vol - a.vol);
  const markets = rows.filter(r => r.vol >= MIN_VOLUME).slice(0, KEEP)
    .map(({ desc, createdAt, ...rest }) => rest);   // витрине описания не нужны
  const pool = rows.slice(0, POOL_KEEP);
  if (!markets.length) throw new Error('после фильтрации не осталось рынков — не перезаписываю данные');

  const out = {
    asof: ruDate(now),
    generated: now.toISOString(),
    source: 'Polymarket Gamma API',
    kept: markets.length,
    scanned: all.length,
    markets,
  };
  await fs.writeFile('data/markets.json', JSON.stringify(out, null, 2) + '\n');
  console.log(`записано ${markets.length} рынков в data/markets.json`);

  await fs.writeFile('data/pool.json', JSON.stringify({
    generated: now.toISOString(),
    min_volume: POOL_MIN_VOLUME,
    kept: pool.length,
    scanned: all.length,
    note: 'Пул для отбора. Порог по обороту на порядок ниже витрины: случай Бёрри ищется среди незамеченных рынков, а не среди самых разобранных.',
    markets: pool,
  }, null, 2) + '\n');
  console.log(`записано ${pool.length} рынков в data/pool.json (из ${all.length} просмотренных)`);
}

main().catch(e => { console.error('ОШИБКА:', e.message); process.exit(1); });
