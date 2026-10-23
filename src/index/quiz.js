// The week in AI quiz. Each Saturday a new edition is cut from the week that
// just ended (Saturday to Friday, UTC): the stories the most outlets ran with
// a name taken out ("___ releases its first open-weights model since 2019"),
// the amounts in the week's biggest money stories, and where prediction
// markets that moved most during the week ended it. Wrong options are names
// and amounts of the same kind from the same week, so a guess needs the news.
//
// An edition is built once from the index in the history worker and then
// frozen by the server (src/index/quizbook.js), so the answer key never shifts
// under readers who already played it.

import { splitOutlet, tokens } from '../pipeline/text.js';
import { isAiRelated } from '../pipeline/classify.js';
import { parseMoney } from './deals.js';

const DAY = 86400e3;
export const EDITIONS = 6;

// Saturday 00:00 UTC at or before `now`: the end of the latest full week.
export function editionEnd(now = Date.now()) {
  const d = new Date(now);
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 1) % 7));
  return d.getTime();
}
export const editionId = (end) => new Date(end).toISOString().slice(0, 10);
export const editionIds = (now = Date.now(), n = EDITIONS) => Array.from({ length: n }, (_, i) => editionId(editionEnd(now) - i * 7 * DAY));
export const isEditionId = (id, now = Date.now()) => editionIds(now).includes(id);

// Names a headline can be missing, by kind; wrong options come from the same kind.
const NAMES = {
  company: ['OpenAI', 'Anthropic', 'Google', 'Meta', 'xAI', 'Microsoft', 'Apple', 'Amazon', 'Nvidia', 'AMD', 'Intel', 'TSMC', 'Samsung', 'DeepSeek', 'Alibaba', 'Mistral', 'Perplexity', 'Hugging Face', 'Oracle', 'Salesforce', 'IBM', 'Qualcomm', 'Broadcom', 'SoftBank', 'Huawei', 'ByteDance', 'Baidu', 'Tencent', 'Moonshot', 'Scale AI', 'Databricks', 'CoreWeave', 'Character.AI', 'Midjourney', 'Runway', 'ElevenLabs', 'Cohere', 'Waymo', 'Tesla', 'Uber', 'Netflix', 'Disney', 'Adobe', 'Spotify', 'Reddit', 'Arm', 'Micron', 'Palantir', 'Cursor', 'Figma', 'Shopify', 'Zhipu', 'MiniMax', 'Unitree', 'Figure'],
  person: ['Sam Altman', 'Dario Amodei', 'Elon Musk', 'Mark Zuckerberg', 'Sundar Pichai', 'Satya Nadella', 'Jensen Huang', 'Demis Hassabis', 'Tim Cook', 'Mustafa Suleyman', 'Lisa Su', 'Ilya Sutskever', 'Donald Trump', 'Andy Jassy', 'Masayoshi Son', 'Greg Brockman', 'Alexandr Wang', 'Yann LeCun', 'Geoffrey Hinton', 'Mira Murati', 'Larry Ellison', 'Marc Benioff', 'Arvind Krishna', 'Aravind Srinivas', 'Liang Wenfeng', 'Andrej Karpathy', 'Fidji Simo', 'Kevin Weil', 'Jony Ive', 'Peter Thiel', 'JD Vance', 'Gavin Newsom'],
  product: ['ChatGPT', 'Claude', 'Gemini', 'Grok', 'Copilot', 'Llama', 'Sora', 'Codex', 'Siri', 'Alexa', 'Veo', 'Qwen', 'Kimi', 'Perplexity Comet', 'Claude Code', 'Gemini CLI', 'NotebookLM', 'Midjourney', 'Optimus', 'Atlas', 'Operator', 'Cowork'],
  place: ['China', 'India', 'Japan', 'Europe', 'the EU', 'the UK', 'France', 'Germany', 'Saudi Arabia', 'the UAE', 'Texas', 'California', 'New York', 'South Korea', 'Taiwan', 'Canada', 'Brazil', 'Australia'],
};
// Names that give each other away: a blanked "Anthropic" next to "Claude".
const FAMILIES = [
  ['OpenAI', 'ChatGPT', 'Sam Altman', 'Altman', 'Codex', 'Sora', 'GPT', 'Operator', 'Fidji Simo', 'Greg Brockman', 'Kevin Weil'],
  ['Anthropic', 'Claude', 'Dario Amodei', 'Amodei', 'Claude Code', 'Cowork'],
  ['Google', 'Gemini', 'Sundar Pichai', 'Pichai', 'DeepMind', 'Demis Hassabis', 'Hassabis', 'Veo', 'NotebookLM', 'Waymo', 'Chrome', 'Android', 'Gemini CLI', 'TPU'],
  ['Meta', 'Llama', 'Mark Zuckerberg', 'Zuckerberg', 'Muse', 'Alexandr Wang', 'Instagram', 'WhatsApp'],
  ['xAI', 'Grok', 'Elon Musk', 'Musk', 'Tesla', 'Optimus', 'SpaceX'],
  ['Microsoft', 'Copilot', 'Satya Nadella', 'Nadella', 'Mustafa Suleyman', 'Azure'],
  ['Apple', 'Siri', 'Tim Cook', 'iPhone', 'Mac'],
  ['Amazon', 'Alexa', 'Andy Jassy', 'AWS', 'Bedrock'],
  ['Nvidia', 'Jensen Huang', 'RTX', 'Blackwell', 'Rubin', 'CUDA'],
  ['AMD', 'Lisa Su'], ['Oracle', 'Larry Ellison'], ['Salesforce', 'Marc Benioff'], ['IBM', 'Arvind Krishna', 'Granite'],
  ['Perplexity', 'Aravind Srinivas', 'Perplexity Comet', 'Comet'], ['DeepSeek', 'Liang Wenfeng'], ['SoftBank', 'Masayoshi Son'],
  ['Alibaba', 'Qwen'], ['Moonshot', 'Kimi'], ['Cursor', 'Anysphere'],
];
const giveaway = (name, title) => FAMILIES.some((f) => f.includes(name) && f.some((o) => o !== name && !name.includes(o) && new RegExp(`(?<![\\w.])${escapeRe(o)}(?![\\w-])`).test(title)));
const KIND_PROMPT = { company: 'Which company is missing?', person: 'Who is missing?', product: 'Which product is missing?', place: 'Which place is missing?' };
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const NAME_RE = Object.fromEntries(Object.values(NAMES).flat().map((n) => [n, new RegExp(`(?<![\\w.])${escapeRe(n)}(?![\\w-])`, 'g')]));

const MONEY = /\$\s?(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(trillion|billion|million|bn|mn|tn|[bmt])?(?![\p{L}\p{N}])/giu;

// Deterministic per edition, so a rebuild before freezing gives the same quiz.
function rng(seed) {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 3432918353), h = (h << 13) | (h >>> 19);
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}
const shuffle = (arr, rand) => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

export function fmtUsd(v) {
  const [d, w] = v >= 1e12 ? [1e12, 'trillion'] : v >= 1e9 ? [1e9, 'billion'] : [1e6, 'million'];
  const x = v / d;
  return `$${x >= 100 ? Math.round(x) : +x.toPrecision(2)} ${w}`;
}

// A plain news headline: not a question, a link dump, a listicle or a newsletter.
const usable = (t) => t.length >= 30 && t.length <= 140 && !/\?$|https?:|\.\.\.|…$|\[|\bnewsletter\b|\bpodcast\b|\bImport AI\b|^How\b|^Why\b|^\d+ /i.test(t) && /^[\x20-\x7E‘-”–—…$€£]+$/.test(t);

// "___ releases …": the first name in the headline with three same-kind
// names from the week that the headline doesn't contain.
export function nameQuestion(title, seen, rand) {
  for (const [kind, names] of Object.entries(NAMES)) {
    for (const name of names) {
      const re = NAME_RE[name];
      re.lastIndex = 0;
      if (!re.test(title)) continue;
      // A name inside a longer one ("Claude" in "Claude Code") isn't the blank.
      if (names.some((o) => o !== name && o.includes(name) && NAME_RE[o].test(title) && ((NAME_RE[o].lastIndex = 0), true))) continue;
      if (giveaway(name, title)) continue;
      const pool = names.filter((o) => o !== name && !title.includes(o) && !o.includes(name) && !name.includes(o));
      // Prefer names the week's headlines carried, so wrong options are plausible.
      const ranked = shuffle(pool, rand).sort((a, b) => (seen.get(b) || 0) - (seen.get(a) || 0));
      const wrong = ranked.slice(0, 3);
      if (wrong.length < 3) continue;
      const options = shuffle([name, ...wrong], rand);
      re.lastIndex = 0;
      return { type: 'name', kind, prompt: KIND_PROMPT[kind], text: title.replace(re, '_____'), options, answer: options.indexOf(name) };
    }
  }
  return null;
}

// "How much?": the amount blanked, three wrong amounts a few times off.
export function moneyQuestion(title, rand) {
  MONEY.lastIndex = 0;
  for (const m of title.matchAll(MONEY)) {
    const usd = parseMoney('$', m[1], m[2]);
    if (!usd || usd < 1e6) continue;
    const right = fmtUsd(usd);
    const wrong = [];
    for (const f of shuffle([0.1, 0.25, 0.4, 2.5, 4, 10], rand)) {
      const s = fmtUsd(usd * f);
      if (s !== right && !wrong.includes(s)) wrong.push(s);
      if (wrong.length === 3) break;
    }
    const options = shuffle([right, ...wrong], rand);
    return { type: 'money', kind: 'money', prompt: 'How much?', text: title.replace(m[0], '$_____'), options, answer: options.indexOf(right) };
  }
  return null;
}

// "OpenAI resumes training by...?" with its one outcome "October 31".
export function marketText(title, label) {
  if (!label || label === title) return title;
  if (/(?:\.\.\.|…)\?$/.test(title)) return title.replace(/\s*(?:\.\.\.|…)\?$/, ` ${label}?`);
  return `${title} (${label})`;
}

// Where a market that moved this week ended it: options ten or more points
// apart, one of them where it started.
export function marketQuestion(market, start, end, rand, since = 'when the week began') {
  const right = Math.round(end * 100);
  const from = Math.round(start * 100);
  const picks = [right];
  const cands = shuffle([from, right + 15, right - 15, right + 30, right - 30, right + 45, right - 45], rand);
  for (const c of [from, ...cands]) {
    if (c < 1 || c > 99 || picks.some((p) => Math.abs(p - c) < 10)) continue;
    picks.push(c);
    if (picks.length === 4) break;
  }
  if (picks.length < 4) return null;
  const options = picks.sort((a, b) => a - b).map((p) => `${p}%`);
  return {
    type: 'market',
    kind: 'market',
    prompt: `On Polymarket, the odds were ${from}% ${since}. Where did they end the week?`,
    text: marketText(market.title, market.outcomes?.[0]),
    options,
    answer: options.indexOf(`${right}%`),
    market: { title: marketText(market.title, market.outcomes?.[0]), url: market.url, start: from, end: right },
  };
}

// The week's English AI headlines, grouped when they tell the same story
// (most words shared), with how many outlets ran each.
export function weekStories(db, from, to) {
  const rows = db.prepare(`SELECT title, url, site, source, published_at AS at FROM docs INDEXED BY docs_type_pub
    WHERE type = 'article' AND published_at >= ? AND published_at < ? AND hidden = 0 AND (lang IS NULL OR lang = '' OR lang LIKE 'en%')
    ORDER BY published_at`).all(from, to);
  const groups = [];
  const byTok = new Map();
  for (const r of rows) {
    const { title, outlet } = splitOutlet(r.title.replace(/^\[[^\]]{1,30}\]\s*/, ''));
    if (!usable(title) || !isAiRelated(title)) continue;
    const toks = [...new Set(tokens(title))];
    if (toks.length < 4) continue;
    const hits = new Map();
    for (const t of toks) for (const g of byTok.get(t) || []) hits.set(g, (hits.get(g) || 0) + 1);
    let best = null;
    for (const [g, n] of hits) if (n / Math.min(toks.length, g.size) >= 0.6 && (!best || n > hits.get(best))) best = g;
    const outletName = outlet || r.source || r.site;
    if (best) {
      best.outlets.add(outletName);
      continue;
    }
    const g = { title, url: r.url, source: outletName, publishedAt: r.at, outlets: new Set([outletName]), size: toks.length };
    groups.push(g);
    for (const t of toks) {
      if (!byTok.has(t)) byTok.set(t, []);
      byTok.get(t).push(g);
    }
  }
  return groups.map((g) => ({ title: g.title, url: g.url, source: g.source, publishedAt: g.publishedAt, n: g.outlets.size, eng: 0 }));
}

// markets: [{ id, title, url, binary, outcomes }] from the live feed.
export function buildQuiz(db, { id, markets = [], stories }) {
  const end = Date.parse(`${id}T00:00:00Z`);
  const from = end - 7 * DAY;
  stories ??= weekStories(db, from, end);
  const rand = rng(`quiz:${id}`);
  const seen = new Map();
  const ranked = [...stories].sort((a, b) => b.n - a.n || b.eng - a.eng);
  for (const s of ranked) for (const n of Object.keys(NAME_RE)) if ((NAME_RE[n].lastIndex = 0, NAME_RE[n].test(s.title))) seen.set(n, (seen.get(n) || 0) + 1);

  const story = (s) => ({ title: s.title, url: s.url, source: s.lead?.source || s.source || '', sources: s.n, at: s.publishedAt });
  const names = [];
  const money = [];
  const used = new Set();
  for (const s of ranked.slice(0, 150)) {
    const title = splitOutlet(s.title).title;
    if (!usable(title)) continue;
    if (money.length < 2 && /\$\s?\d/.test(title)) {
      const q = moneyQuestion(title, rand);
      if (q) { money.push({ ...q, story: story(s) }); continue; }
    }
    if (names.length >= 6) continue;
    const q = nameQuestion(title, seen, rand);
    // One question per answer, so the quiz isn't six OpenAI blanks.
    if (q && !used.has(q.options[q.answer])) {
      used.add(q.options[q.answer]);
      names.push({ ...q, story: story(s) });
    }
  }

  // Binary markets with the biggest move between the week's start and end.
  const at = db.prepare('SELECT yes, ts FROM odds WHERE market = ? AND outcome = ? AND ts <= ? ORDER BY ts DESC LIMIT 1');
  const after = db.prepare('SELECT yes, ts FROM odds WHERE market = ? AND outcome = ? AND ts >= ? AND ts < ? ORDER BY ts LIMIT 1');
  const moved = [];
  for (const m of markets) {
    if (!m.binary || !m.outcomes?.length) continue;
    const o = m.outcomes[0];
    // Where it stood when the week began, or when the history starts if
    // that's within the week's first five days.
    const s0 = at.get(m.id, o, from) || after.get(m.id, o, from, from + 5 * DAY);
    const b = at.get(m.id, o, end)?.yes;
    if (!s0 || b == null || Math.abs(b - s0.yes) < 0.08) continue;
    moved.push({ m, a: s0.yes, b, d: Math.abs(b - s0.yes), since: s0.ts <= from ? 'when the week began' : `on ${new Date(s0.ts).toLocaleDateString('en', { weekday: 'long', timeZone: 'UTC' })}` });
  }
  const mq = moved.sort((x, y) => y.d - x.d).slice(0, 2).map(({ m, a, b, since }) => marketQuestion(m, a, b, rand, since)).filter(Boolean);

  // Names lead, money and markets break it up.
  const questions = [...names];
  money.forEach((q, i) => questions.splice(Math.min(questions.length, 2 + i * 4), 0, q));
  mq.forEach((q, i) => questions.splice(Math.min(questions.length, 4 + i * 4), 0, q));
  return {
    id,
    from,
    to: end,
    builtAt: Date.now(),
    questions: questions.slice(0, 10).map((q, i) => ({ n: i, ...q })),
  };
}
