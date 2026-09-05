/**
 * Ворота отбора. Вынесены в отдельный модуль намеренно: калибровка обязана
 * проверять ровно тот же код, что и рабочий отбор. Две копии логики означали
 * бы, что калибруется не то, что работает.
 *
 * gateA возвращает не плоский список причин, а результат по каждому критерию —
 * иначе нельзя посчитать, какой именно критерий отсекает больше всего чисто
 * разрешившихся рынков.
 */

/* Оговорки, возвращающие интерпретацию через чёрный ход. */
export const ESCAPE = [
  'consensus of credible reporting', 'credible reporting', 'widely reported',
  'at the discretion', 'sole discretion', 'in the event of ambiguity',
  'generally accepted', 'reasonably determine', 'may also be used',
  'a consensus of', 'deemed to have', 'in the spirit of',
];

export const THRESHOLD = [
  'equal to or above', 'equal to or greater', 'at least', 'greater than',
  'less than', 'no later than', 'exceeds', 'or more', 'or higher',
  'or fewer', 'above', 'below', '≥', '≤',
];

export const MISSING = [
  'if no data', 'has not been published', 'will resolve based on data',
  'if data is not', 'in the absence of', 'if no such', 'fails to publish',
];

/* Имена критериев — используются и в отчёте отбора, и в калибровке. */
export const CRITERIA = {
  uma:       'рынок уже оспаривался в UMA',
  escape:    'оговорка-лазейка',
  source:    'в правилах нет ссылки на источник',
  threshold: 'нет сравнения с порогом',
  missing:   'не описано, что делать при отсутствии данных',
  dates:     'срок в правилах дальше даты на карточке',
};

const MONTHS = 'january|february|march|april|may|june|july|august|september|october|november|december';

export function datesIn(text) {
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

export function firstUrl(text) {
  const m = text.match(/https?:\/\/[^\s)"'<]+/);
  return m ? m[0].replace(/[.,;]$/, '') : null;
}

/* Термины, которые правила берут в кавычки — обычно это и есть имя поля
   в источнике. Ими проверяется, что источник отдаёт названное. */
export function quotedTerms(text) {
  const out = new Set();
  for (const m of text.matchAll(/[«"“]([^»"”]{3,60})[»"”]/g)) out.add(m[1].trim());
  return [...out];
}

/* ---------- A. форма правил ---------- */

export function gateA(m, desc) {
  const t = desc.toLowerCase();
  const checks = {};
  const ev = {};

  const uma = JSON.stringify(m.umaResolutionStatuses ?? '').toLowerCase();
  checks.uma = !uma.includes('disput');
  ev.uma_statuses = m.umaResolutionStatuses ?? null;

  const esc = ESCAPE.filter(p => t.includes(p));
  checks.escape = esc.length === 0;
  ev.escape_found = esc;

  const url = firstUrl(desc);
  checks.source = !!url;
  ev.source_url = url;

  const thr = THRESHOLD.filter(p => t.includes(p));
  checks.threshold = thr.length > 0;
  ev.threshold_words = thr;

  const miss = MISSING.filter(p => t.includes(p));
  checks.missing = miss.length > 0;
  ev.missing_data_words = miss;

  const end = new Date((m.end || m.endDate || '') + 'T00:00:00Z');
  const latest = datesIn(desc).sort((a, b) => b - a)[0];
  ev.end_date = isNaN(end) ? null : end.toISOString().slice(0, 10);
  ev.latest_date_in_rules = latest ? latest.toISOString().slice(0, 10) : null;
  checks.dates = !(latest && !isNaN(end) && latest - end > 7 * 86400e3);

  const fails = Object.entries(checks).filter(([, ok]) => !ok)
    .map(([k]) => CRITERIA[k] + (k === 'escape' ? ': ' + esc.join(', ') : '')
                              + (k === 'dates' ? `: ${ev.latest_date_in_rules} против ${ev.end_date}` : ''));
  return { pass: fails.length === 0, checks, fails, ev };
}

/* ---------- B. источник отдаёт названное ---------- */

/* Проверять код 200 недостаточно: «источник существует» и «источник публикует
   именно этот показатель» — разные утверждения. Интерфейс на JavaScript,
   который человек читает глазами, машиночитаемым источником не является. */
export async function gateB(url, desc) {
  if (!url) return { pass: false, fails: ['нет URL источника'], ev: {} };
  let r, body = '', ct = '';
  try {
    r = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(20000) });
    ct = (r.headers.get('content-type') || '').toLowerCase();
    body = (await r.text()).slice(0, 500_000);
  } catch (e) {
    return { pass: false, fails: ['источник недостижим: ' + e.message], ev: {} };
  }
  if (!r.ok) return { pass: false, fails: [`источник отвечает ${r.status}`], ev: { http: r.status } };

  const isData = /json|csv|text\/plain|octet-stream|excel|spreadsheet/.test(ct);
  const terms = quotedTerms(desc);
  const found = terms.filter(q => body.toLowerCase().includes(q.toLowerCase()));

  // страница-приложение: почти весь объём — разметка и скрипты, текста нет
  const textish = body.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<[^>]+>/g, ' ');
  const isShell = /html/.test(ct) && textish.replace(/\s+/g, ' ').trim().length < 500;

  const ev = { http: r.status, content_type: ct, bytes: body.length,
               is_data: isData, is_shell: isShell,
               quoted_terms: terms, terms_found: found };

  const fails = [];
  if (!isData && !found.length) {
    fails.push(isShell
      ? 'источник — интерфейс на скриптах, а не машиночитаемые данные'
      : 'в источнике не найдено ни одного термина, названного в правилах');
  }
  return { pass: fails.length === 0, fails, ev };
}

/* ---------- C. резолвер ---------- */

export const RESOLVER_PROMPT = `Ты проверяешь, можно ли разрешить рынок предсказаний механически.

Задача: по тексту правил написать процедуру, которую выполнит компьютер в дату дедлайна БЕЗ единого человеческого решения.

Ответ давай ТОЛЬКО вызовом инструмента resolver, без текста вокруг.

Правило отказа: если ХОТЬ ОДИН шаг требует оценить намерение, значимость, качественный признак или выбрать между толкованиями — ставь executable=false и назови это в human_judgment_required. Формулировки вида «наступление с намерением установить контроль», «существенное нарушение», «широко признано» неисполнимы по определению.

Что НЕ считается требующим человека:
— метаданные рынка, которые тебе даны отдельно (дата создания, дата окончания, идентификатор): они доступны машине, даже если в тексте правил не повторены;
— дискреция, влияющая только на СРОК разрешения, а не на исход Yes/No.

Каждый input обязан нести дословную цитату из правил.`;

export const RESOLVER_TOOL = {
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

export function extractJson(text) {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const src = fence ? fence[1] : text;
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
        } catch { /* не тот объект */ }
        break;
      }
    }
  }
  return null;
}

const norm = s => String(s).toLowerCase()
  .replace(/[‐-―−]/g, '-')
  .replace(/[‘’“”]/g, '"')
  .replace(/[^a-z0-9а-яё"%.-]+/gi, ' ')
  .replace(/\s+/g, ' ').trim();

export async function gateC(desc, meta = {}, opts = {}) {
  const KEY = opts.key ?? process.env.ANTHROPIC_API_KEY ?? '';
  const MODEL = opts.model ?? process.env.MODEL ?? 'claude-opus-5';
  if (!KEY) return { pass: false, skipped: true, fails: ['ANTHROPIC_API_KEY не задан'], ev: {} };

  const metaBlock = Object.entries(meta).filter(([, v]) => v != null)
    .map(([k, v]) => `${k}: ${v}`).join('\n');

  let body;
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': KEY,
                 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: MODEL, max_tokens: 4000,
        system: RESOLVER_PROMPT,
        tools: [RESOLVER_TOOL],
        tool_choice: { type: 'tool', name: 'resolver' },
        messages: [{ role: 'user', content:
          (metaBlock ? 'МЕТАДАННЫЕ РЫНКА (доступны машине):\n' + metaBlock + '\n\n' : '') +
          'ПРАВИЛА РАЗРЕШЕНИЯ:\n\n' + desc }],
      }),
      signal: AbortSignal.timeout(120000),
    });
    if (!r.ok) return { pass: false, fails: [`API ${r.status}: ${(await r.text()).slice(0, 200)}`], ev: {} };
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
    if (!j) return { pass: false,
      fails: ['модель не вернула структуру' + (body.stop_reason === 'max_tokens' ? ' (обрезано по max_tokens)' : '')],
      ev: { stop_reason: body.stop_reason, raw: text.slice(0, 400) } };
  }

  const fails = [];
  if (j.executable !== true) fails.push('модель: процедура неисполнима');
  if (j.human_judgment_required) fails.push('требует человека: ' + j.human_judgment_required);
  if (!Array.isArray(j.procedure) || j.procedure.length < 2) fails.push('процедура короче двух шагов');
  if (!Array.isArray(j.inputs) || !j.inputs.length) fails.push('не названы входные данные');
  else for (const i of j.inputs) {
    if (!i.quote) { fails.push('вход без цитаты: ' + (i.name || '?')); continue; }
    const needle = norm(i.quote).slice(0, 30);
    if (needle.length >= 12 && !norm(desc).includes(needle))
      fails.push('цитата не найдена в правилах: ' + String(i.quote).slice(0, 60));
  }
  return { pass: fails.length === 0, fails, ev: j };
}
