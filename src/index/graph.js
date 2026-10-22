// Who is in the news together: a co-mention network of labs, companies,
// people, products and governments over the last 7, 30 or 90 days of stored
// articles.
//
// Names come from a typed vocabulary (below) plus names the coverage itself
// keeps using that aren't in it ("Claude Duet", "Gemini 4 Argon"): capitalised
// phrases in article summaries, kept only when they're almost never written
// in lower case (so "Link" and "Hardware" drop out) and aren't an outlet's
// name. Each article counts once per name, from its headline and the start of
// its summary, and a longer name wins over a shorter one inside it ("Claude
// Code" isn't also "Claude").
//
// Two names are linked by how often they appear together, ranked by count
// times lift (how much more often than chance), keeping each name's strongest
// few links so the biggest names don't connect to everything.
//
// Model repo pages and listings (Hugging Face, OpenRouter, GitHub) aren't
// coverage and are left out.
//
// 30 days (~17k articles) take ~2 s in the history worker, cached.

import { cachedJob } from './offload.js';

const DAY = 86400e3;
const TTL_MS = 30 * 60e3;
export const WINDOWS = [7, 30, 90];

// [label, type, aliases (case-sensitive), topic page key]
const VOCAB = [
  ['OpenAI', 'org', ['OpenAI'], 'openai'],
  ['Anthropic', 'org', ['Anthropic'], 'anthropic'],
  ['Google', 'org', ['Google', 'Alphabet'], 'google'],
  ['DeepMind', 'org', ['DeepMind', 'Google DeepMind'], 'google'],
  ['Meta', 'org', ['Meta'], 'meta'],
  ['xAI', 'org', ['xAI'], 'xai'],
  ['Microsoft', 'org', ['Microsoft'], 'microsoft'],
  ['Apple', 'org', ['Apple'], 'apple'],
  ['Amazon', 'org', ['Amazon', 'AWS'], 'amazon'],
  ['Nvidia', 'org', ['Nvidia', 'NVIDIA'], 'nvidia'],
  ['AMD', 'org', ['AMD'], 'amd'],
  ['Intel', 'org', ['Intel'], null],
  ['TSMC', 'org', ['TSMC'], 'tsmc'],
  ['Samsung', 'org', ['Samsung'], null],
  ['Qualcomm', 'org', ['Qualcomm'], null],
  ['Broadcom', 'org', ['Broadcom'], null],
  ['Oracle', 'org', ['Oracle'], null],
  ['CoreWeave', 'org', ['CoreWeave'], null],
  ['SoftBank', 'org', ['SoftBank'], null],
  ['Tesla', 'org', ['Tesla'], 'tesla'],
  ['SpaceX', 'org', ['SpaceX'], null],
  ['DeepSeek', 'org', ['DeepSeek'], 'deepseek'],
  ['Alibaba', 'org', ['Alibaba'], 'qwen'],
  ['Tencent', 'org', ['Tencent'], null],
  ['ByteDance', 'org', ['ByteDance'], null],
  ['Baidu', 'org', ['Baidu'], null],
  ['Huawei', 'org', ['Huawei'], null],
  ['Moonshot AI', 'org', ['Moonshot AI', 'Moonshot'], null],
  ['Zhipu', 'org', ['Zhipu', 'Z.ai'], null],
  ['MiniMax', 'org', ['MiniMax'], null],
  ['Mistral', 'org', ['Mistral', 'Mistral AI'], 'mistral'],
  ['Cohere', 'org', ['Cohere'], null],
  ['Perplexity', 'org', ['Perplexity'], 'perplexity'],
  ['Hugging Face', 'org', ['Hugging Face', 'HuggingFace'], 'huggingface'],
  ['Cursor', 'org', ['Cursor', 'Anysphere'], 'cursor'],
  ['Scale AI', 'org', ['Scale AI'], null],
  ['Databricks', 'org', ['Databricks'], null],
  ['Salesforce', 'org', ['Salesforce'], null],
  ['IBM', 'org', ['IBM'], null],
  ['Palantir', 'org', ['Palantir'], null],
  ['Cloudflare', 'org', ['Cloudflare'], null],
  ['GitHub', 'org', ['GitHub'], null],
  ['Adobe', 'org', ['Adobe'], null],
  ['Figure AI', 'org', ['Figure AI'], 'figure'],
  ['Waymo', 'org', ['Waymo'], null],
  ['Character.AI', 'org', ['Character.AI', 'Character AI'], null],
  ['Midjourney', 'org', ['Midjourney'], null],
  ['Stability AI', 'org', ['Stability AI'], null],
  ['Runway', 'org', ['Runway'], null],
  ['ElevenLabs', 'org', ['ElevenLabs'], null],
  ['Thinking Machines', 'org', ['Thinking Machines'], null],
  ['Safe Superintelligence', 'org', ['Safe Superintelligence', 'SSI'], 'ssi'],
  ['Disney', 'org', ['Disney'], null],
  ['New York Times', 'org', ['New York Times', 'NYT'], null],
  ['Sam Altman', 'person', ['Sam Altman', 'Altman'], 'openai'],
  ['Dario Amodei', 'person', ['Dario Amodei', 'Amodei'], 'anthropic'],
  ['Demis Hassabis', 'person', ['Demis Hassabis', 'Hassabis'], 'google'],
  ['Sundar Pichai', 'person', ['Sundar Pichai', 'Pichai'], 'google'],
  ['Mark Zuckerberg', 'person', ['Mark Zuckerberg', 'Zuckerberg'], 'meta'],
  ['Elon Musk', 'person', ['Elon Musk', 'Musk'], 'musk'],
  ['Satya Nadella', 'person', ['Satya Nadella', 'Nadella'], 'microsoft'],
  ['Jensen Huang', 'person', ['Jensen Huang', 'Huang'], 'nvidia'],
  ['Lisa Su', 'person', ['Lisa Su'], 'amd'],
  ['Tim Cook', 'person', ['Tim Cook'], 'apple'],
  ['Andy Jassy', 'person', ['Andy Jassy', 'Jassy'], 'amazon'],
  ['Ilya Sutskever', 'person', ['Ilya Sutskever', 'Sutskever'], 'ssi'],
  ['Mira Murati', 'person', ['Mira Murati', 'Murati'], null],
  ['Mustafa Suleyman', 'person', ['Mustafa Suleyman', 'Suleyman'], null],
  ['Andrej Karpathy', 'person', ['Andrej Karpathy', 'Karpathy'], null],
  ['Yann LeCun', 'person', ['Yann LeCun', 'LeCun'], null],
  ['Greg Brockman', 'person', ['Greg Brockman', 'Brockman'], null],
  ['Alexandr Wang', 'person', ['Alexandr Wang'], null],
  ['Masayoshi Son', 'person', ['Masayoshi Son'], null],
  ['Geoffrey Hinton', 'person', ['Geoffrey Hinton', 'Hinton'], null],
  ['Fei-Fei Li', 'person', ['Fei-Fei Li'], null],
  ['Aravind Srinivas', 'person', ['Aravind Srinivas'], null],
  ['Donald Trump', 'person', ['Donald Trump', 'Trump'], null],
  ['Xi Jinping', 'person', ['Xi Jinping'], null],
  ['ChatGPT', 'product', ['ChatGPT'], 'openai'],
  ['Claude', 'product', ['Claude'], 'anthropic'],
  ['Gemini', 'product', ['Gemini'], 'google'],
  ['Grok', 'product', ['Grok'], 'xai'],
  ['Llama', 'product', ['Llama'], 'meta'],
  ['Copilot', 'product', ['Copilot'], 'microsoft'],
  ['Codex', 'product', ['Codex'], 'openai'],
  ['Claude Code', 'product', ['Claude Code'], 'anthropic'],
  ['Sora', 'product', ['Sora'], 'openai'],
  ['Veo', 'product', ['Veo'], 'google'],
  ['Siri', 'product', ['Siri'], 'apple'],
  ['Alexa', 'product', ['Alexa'], 'amazon'],
  ['Qwen', 'product', ['Qwen'], 'qwen'],
  ['Kimi', 'product', ['Kimi'], null],
  ['Gemma', 'product', ['Gemma'], 'google'],
  ['Muse', 'product', ['Muse'], 'meta'],
  ['Stargate', 'product', ['Stargate'], null],
  ['White House', 'gov', ['White House'], 'regulation'],
  ['Pentagon', 'gov', ['Pentagon', 'Department of Defense', 'Department of War'], null],
  ['Congress', 'gov', ['Congress'], 'regulation'],
  ['Senate', 'gov', ['Senate'], 'regulation'],
  ['European Union', 'gov', ['EU', 'European Union', 'European Commission', 'Brussels'], 'regulation'],
  ['China', 'gov', ['China', 'Beijing'], 'china'],
  ['United Kingdom', 'gov', ['UK', 'Britain'], null],
  ['FTC', 'gov', ['FTC', 'Federal Trade Commission'], 'regulation'],
  ['Justice Department', 'gov', ['DOJ', 'Justice Department', 'Department of Justice'], 'regulation'],
  ['SEC', 'gov', ['SEC'], null],
  ['Commerce Department', 'gov', ['Commerce Department', 'Department of Commerce'], null],
  ['California', 'gov', ['California'], null],
  ['Taiwan', 'gov', ['Taiwan'], null],
  ['Japan', 'gov', ['Japan'], null],
  ['India', 'gov', ['India'], null],
  ['Vatican', 'gov', ['Vatican', 'Pope Leo'], null],
];

const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// Words that start capitalised phrases without being part of a name.
const STOP = new Set(('The A An This That These Those It Its In On At For With From By Of And Or But As If When While After Before Over Under Into New Why How What Who Which ' +
  'Where AI We I You He She They Our Your Their Here There Now Today Yesterday Tomorrow Monday Tuesday Wednesday Thursday Friday Saturday Sunday January February ' +
  'March April May June July August September October November December Jan Feb Mar Apr Jun Jul Aug Sep Sept Oct Nov Dec Image Photo Credit Read More Also However ' +
  'Meanwhile According Last Next First Second Third One Two Three CEO CTO CFO Inc Corp LLC Ltd Co Mr Ms Dr Click Subscribe Sign Getty Images Big Series Pro Max ' +
  'Ultra Plus Mini Company Platform Mode Search Media Blog Link See Science University Department Center Council Hardware Software Tech Technology Data Cloud ' +
  'Large Language Models Model Agent Agents US U.S American Americans European Chinese English German French Japanese Russian Australian South North East West ' +
  'Q1 Q2 Q3 Q4 Wall Street Silicon Valley San Francisco New York PC PCs TV TVs GPU GPUs CPU API APIs LLM LLMs IT ML RL RAG MCP MoE HR B2B GB RAM YES IPO America Tom President Prime Minister Chairman Founder PRNewswire Newswire GlobeNewswire Wire Business NASDAQ Nasdaq NYSE').split(' '));

// Capitalised phrases of one to three words in sentence-case text.
const PHRASE = /(?<![\p{L}\p{N}])(?:[A-Z][\p{L}\p{N}]*(?:[-.][\p{L}\p{N}]+)*)(?:\s+(?:[A-Z][\p{L}\p{N}]*(?:[-.][\p{L}\p{N}]+)*|\d+(?:\.\d+)?)){0,2}/gu;

// Names the coverage keeps using that the vocabulary lacks.
export function discoverNames(texts, { known = [], sources = new Set(), min = 12, limit = 25 } = {}) {
  const counts = new Map();
  for (const text of texts) {
    const seen = new Set();
    for (const sent of text.split(/(?<=[.!?])\s+/)) {
      for (const m of sent.matchAll(PHRASE)) {
        const words = m[0].split(/\s+/);
        // A name doesn't contain a stop word, and one word at the start of a
        // sentence is capitalised anyway.
        if (words.some((w) => STOP.has(w)) || (m.index === 0 && words.length === 1) || /^AI-/.test(m[0])) continue;
        const name = m[0];
        if (name.length < 3 || /^\d/.test(name) || seen.has(name)) continue;
        seen.add(name);
        counts.set(name, (counts.get(name) || 0) + 1);
      }
    }
  }
  const knownSet = new Set(known);
  const cands = [...counts].filter(([name, n]) => n >= min && !knownSet.has(name) && !sources.has(name.toLowerCase())).sort((a, b) => b[1] - a[1]).slice(0, limit * 4);
  if (!cands.length) return [];
  // Proper nouns: written this way nearly every time the words appear.
  const lower = new Map(cands.map(([name]) => [name.toLowerCase(), 0]));
  const anyCase = new RegExp(`(?<![\\p{L}\\p{N}])(?:${cands.map(([n]) => escRe(n)).join('|')})(?![\\p{L}\\p{N}])`, 'giu');
  for (const text of texts) for (const m of text.matchAll(anyCase)) if (!/[A-Z]/.test(m[0][0])) lower.set(m[0].toLowerCase(), (lower.get(m[0].toLowerCase()) || 0) + 1);
  const knownWords = known.map((k) => new RegExp(`(?<![\\p{L}\\p{N}])${escRe(k)}(?![\\p{L}\\p{N}])`, 'u'));
  return cands
    .filter(([name, n]) => lower.get(name.toLowerCase()) / n < 0.1)
    // A known name plus a word ("Claude Duet", "Gemini 4 Argon") is a product
    // of its own; a part of a known name ("Huang") isn't new.
    .filter(([name]) => !known.some((k) => k.includes(name)) && (!knownWords.some((re) => re.test(name)) || name.split(/\s+/).length > 1))
    // A shorter form of a longer name used about as often ("Opus 5.5" in
    // "Claude Opus 5.5") is the same thing.
    .filter(([name, n], _, all) => !all.some(([other, m]) => other !== name && other.includes(name) && m >= n * 0.5))
    .slice(0, limit)
    .map(([name, n]) => ({ label: name, n }));
}

// Each text's names, longest match first.
export function nameMatcher(nodes) {
  const byAlias = new Map();
  for (const [i, n] of nodes.entries()) for (const a of n.aliases) if (!byAlias.has(a)) byAlias.set(a, i);
  const re = new RegExp(`(?<![\\p{L}\\p{N}])(?:${[...byAlias.keys()].sort((a, b) => b.length - a.length).map(escRe).join('|')})(?![\\p{L}\\p{N}]|-[\\p{L}\\p{N}])`, 'gu');
  return (text) => {
    const found = new Set();
    for (const m of text.matchAll(re)) found.add(byAlias.get(m[0]));
    return [...found];
  };
}

// The scan behind a window, kept in the worker for the detail calls.
const scans = new Map(); // days -> { at, scan }

export function scanWindow(db, days, now) {
  const hit = scans.get(days);
  if (hit && now - hit.at < TTL_MS) return hit.scan;
  const since = now - days * DAY;
  // Seven- and thirty-day windows compare with the window before.
  const from = days <= 30 ? since - days * DAY : since;
  const rows = db.prepare(`SELECT url, title, substr(description, 1, 300) AS description, site, source, published_at AS at FROM docs INDEXED BY docs_type_pub
    WHERE type = 'article' AND published_at >= ? AND published_at <= ? AND hidden = 0 AND title != '' AND (lang IS NULL OR lang = '' OR lang LIKE 'en%')
      AND site NOT IN ('huggingface.co', 'openrouter.ai', 'github.com')`).all(from, now + 5 * 60e3);
  const cur = rows.filter((r) => r.at >= since);
  const sources = new Set(db.prepare('SELECT DISTINCT lower(source) AS s FROM docs WHERE source IS NOT NULL AND published_at >= ?').all(since).map((r) => r.s));
  const vocab = VOCAB.map(([label, type, aliases, topic]) => ({ key: slug(label), label, type, aliases, topic }));
  const extra = discoverNames(cur.map((r) => r.description || ''), { known: vocab.flatMap((v) => v.aliases), sources, min: Math.max(6, Math.round(cur.length / 1500)) })
    .map(({ label }) => ({ key: slug(label), label, type: 'other', aliases: [label], topic: null }));
  const nodes = [...vocab, ...extra.filter((e) => !vocab.some((v) => v.key === e.key))];
  const names = nameMatcher(nodes);
  const docs = rows.map((r) => ({ url: r.url, title: r.title, site: r.site, source: r.source || r.site, at: r.at, cur: r.at >= since, names: names(`${r.title}. ${r.description || ''}`) })).filter((d) => d.names.length);
  const scan = { days, since, now, total: cur.length, nodes, docs };
  scans.set(days, { at: now, scan });
  return scan;
}

const dayIndex = (scan, at) => Math.min(scan.days - 1, Math.max(0, Math.floor((at - scan.since) / DAY)));

export function computeGraph(db, { days = 30, now = Date.now(), maxNodes = 72, perNode = 5, maxEdges = 220 } = {}) {
  const scan = scanWindow(db, days, now);
  const N = Math.max(1, scan.total);
  const count = new Array(scan.nodes.length).fill(0);
  const prev = new Array(scan.nodes.length).fill(0);
  const series = scan.nodes.map(() => new Array(days).fill(0));
  const pairs = new Map(); // "i|j" -> n
  for (const d of scan.docs) {
    if (!d.cur) { for (const i of d.names) prev[i]++; continue; }
    const day = dayIndex(scan, d.at);
    for (const i of d.names) { count[i]++; series[i][day]++; }
    for (let x = 0; x < d.names.length; x++) for (let y = x + 1; y < d.names.length; y++) {
      const [i, j] = d.names[x] < d.names[y] ? [d.names[x], d.names[y]] : [d.names[y], d.names[x]];
      const k = `${i}|${j}`;
      pairs.set(k, (pairs.get(k) || 0) + 1);
    }
  }
  const keep = scan.nodes.map((_, i) => i).filter((i) => count[i] >= 5).sort((a, b) => count[b] - count[a]).slice(0, maxNodes);
  const kept = new Set(keep);
  const minPair = Math.max(3, Math.round(N / 4000));
  const cands = [...pairs]
    .map(([k, n]) => { const [i, j] = k.split('|').map(Number); return { i, j, n, lift: (n * N) / (count[i] * count[j]) }; })
    .filter((e) => kept.has(e.i) && kept.has(e.j) && e.n >= minPair && e.lift > 1);
  for (const e of cands) e.score = e.n * Math.log2(1 + e.lift);
  cands.sort((a, b) => b.score - a.score);
  // Each name's strongest links, so a big name doesn't take every edge.
  const per = new Map();
  const edges = [];
  for (const e of cands) {
    if (edges.length >= maxEdges) break;
    if ((per.get(e.i) || 0) >= perNode && (per.get(e.j) || 0) >= perNode) continue;
    per.set(e.i, (per.get(e.i) || 0) + 1);
    per.set(e.j, (per.get(e.j) || 0) + 1);
    edges.push(e);
  }
  const linked = new Set(edges.flatMap((e) => [e.i, e.j]));
  const nodes = keep.filter((i) => linked.has(i)).map((i) => {
    const { key, label, type, topic } = scan.nodes[i];
    return { key, label, type, topic, n: count[i], prev: days <= 30 ? prev[i] : null, series: series[i] };
  });
  return {
    days,
    generatedAt: now,
    articles: scan.total,
    nodes,
    edges: edges.map((e) => ({ a: scan.nodes[e.i].key, b: scan.nodes[e.j].key, n: e.n, lift: +e.lift.toFixed(1) })),
  };
}

// Headlines for one name, or two names together, newest first, with the
// pair's count per day.
export function graphDetail(db, { days = 30, a, b = null, now = Date.now(), limit = 12 }) {
  const scan = scanWindow(db, days, now);
  const ia = scan.nodes.findIndex((n) => n.key === a);
  const ib = b ? scan.nodes.findIndex((n) => n.key === b) : -1;
  if (ia < 0 || (b && ib < 0)) return null;
  const hits = scan.docs.filter((d) => d.cur && d.names.includes(ia) && (ib < 0 || d.names.includes(ib))).sort((x, y) => y.at - x.at);
  const series = new Array(days).fill(0);
  for (const d of hits) series[dayIndex(scan, d.at)]++;
  // Who else comes up alongside (for a single name).
  const others = new Map();
  if (ib < 0) for (const d of hits) for (const i of d.names) if (i !== ia) others.set(i, (others.get(i) || 0) + 1);
  const seen = new Set();
  const items = [];
  for (const d of hits) {
    const k = d.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').slice(0, 7).join(' ');
    if (seen.has(k)) continue;
    seen.add(k);
    items.push({ url: d.url, title: d.title, site: d.site, source: d.source, at: d.at });
    if (items.length >= limit) break;
  }
  const info = (i) => (({ key, label, type, topic }) => ({ key, label, type, topic }))(scan.nodes[i]);
  return {
    days,
    a: info(ia),
    b: ib >= 0 ? info(ib) : null,
    n: hits.length,
    since: scan.since,
    series,
    items,
    with: [...others].sort((x, y) => y[1] - x[1]).slice(0, 8).map(([i, n]) => ({ ...info(i), n })),
  };
}

// ---- Main process ----

export const entityGraph = (days) => cachedJob(`graph:${days}`, { kind: 'graph', days }, TTL_MS);
export const entityDetail = (days, a, b) => cachedJob(`graph:${days}:${a}:${b || ''}`, { kind: 'graphDetail', days, a, b }, TTL_MS);
