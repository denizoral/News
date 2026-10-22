// Model comparison: every release on the Releases page with its price,
// context, size and open weights (from the listing), its coverage since
// launch, and the benchmark scores the press reported for it.
//
// Scores come from the stored articles that name the model. Only a sentence
// that names this model, no other model, and puts a percentage right next to
// a known benchmark counts ("Claude Sonnet 5.5 scores 70.6% on Terminal-Bench
// 4.0"); tables and comparisons are left alone. When outlets disagree, the
// value most outlets printed wins, and the count is shown.
//
// ~120 releases take ~0.4 s, so it runs in the history worker, cached.

import { cachedJob, expireJob } from './offload.js';
import { nameMatcher, releaseCoverage } from './releases.js';

const DAY = 86400e3;
const TTL_MS = 30 * 60e3;
const ts = 'COALESCE(d.published_at, d.first_seen)';

// Ordered: the specific name before the general one. `v` keeps a version
// ("Terminal-Bench 4.0", "ARC-AGI-3") as part of the key: scores across
// versions aren't comparable.
export const BENCHMARKS = [
  { key: 'swe-verified', label: 'SWE-bench Verified', src: 'SWE-?bench Verified' },
  { key: 'swe-pro', label: 'SWE-bench Pro', src: 'SWE-?bench Pro' },
  { key: 'terminal', label: 'Terminal-Bench', src: 'Terminal-?Bench(?:\\s?(\\d(?:\\.\\d)?)(?![\\d%]))?', v: true },
  { key: 'hle', label: 'Humanity’s Last Exam', src: 'Humanity[\'’]?s Last Exam|\\bHLE\\b' },
  { key: 'gpqa', label: 'GPQA Diamond', src: 'GPQA(?: Diamond)?' },
  { key: 'arc-agi', label: 'ARC-AGI', src: 'ARC-AGI(?:-(\\d))?', v: true },
  { key: 'aime', label: 'AIME', src: 'AIME(?: ?(20\\d\\d))?', v: true },
  { key: 'osworld', label: 'OSWorld', src: 'OSWorld(?:-Verified)?' },
  { key: 'mmlu-pro', label: 'MMLU-Pro', src: 'MMLU-Pro' },
  { key: 'mmmu', label: 'MMMU', src: 'MMMU(?:-Pro)?' },
  { key: 'livecodebench', label: 'LiveCodeBench', src: 'LiveCodeBench' },
  { key: 'browsecomp', label: 'BrowseComp', src: 'BrowseComp' },
  { key: 'gdpval', label: 'GDPval', src: 'GDPval(?:-AA)?' },
  { key: 'simpleqa', label: 'SimpleQA', src: 'SimpleQA' },
  { key: 'frontiermath', label: 'FrontierMath', src: 'FrontierMath' },
  { key: 'tau-bench', label: 'τ²-bench', src: '(?:τ²?|tau2?)-bench' },
];
// Each benchmark is one group; versions are nested groups inside it.
const parts = BENCHMARKS.map((b) => `(${b.src})`);
const BENCH_RE = new RegExp(parts.join('|'), 'gi');
const groupStart = [];
{
  let g = 1;
  for (const b of BENCHMARKS) {
    groupStart.push(g);
    g += 1 + (b.v ? 1 : 0);
  }
}

// Families a sentence might compare against; one of these left over after
// removing this model's own name means the number may be someone else's.
const RIVALS = /\b(?:GPT-?\d|o\d\b|Claude|Opus|Sonnet|Haiku|Gemini|Gemma|Grok|Llama|Qwen|DeepSeek|Mistral|Kimi|GLM|MiniMax|Muse|Nemotron|Phi-?\d|Command [A-Z]|Nova|Hunyuan|Doubao|Seed|Ernie)\b/i;
const PCT = '(\\d{1,2}(?:\\.\\d{1,2})?|100)\\s?%';
const AFTER = new RegExp(`^\\s*(?:v\\d(?:\\.\\d)?\\s*)?(?:\\([^)]{0,30}\\)\\s*)?(?:score\\s+of|of|:|at|with|—|–|-)?\\s*${PCT}`, 'i');
const BEFORE = new RegExp(`${PCT}\\s*(?:on|in|for|at)\\s+(?:the\\s+)?$`, 'i');

const sentences = (text) => text.split(/(?<=[.!?])\s+(?=[A-Z“"])|\n+/);

// One sentence -> [{ key, label, value }] for the model `nameRe` matches.
export function extractScores(sentence, nameRe) {
  if (sentence.length > 320 || !nameRe.test(sentence)) return [];
  const rest = sentence.replace(new RegExp(nameRe.source, 'gi'), ' ');
  if (RIVALS.test(rest)) return [];
  const out = [];
  for (const m of sentence.matchAll(BENCH_RE)) {
    const i = groupStart.findIndex((g) => m[g] !== undefined);
    if (i < 0) continue;
    const b = BENCHMARKS[i];
    const ver = b.v ? m[groupStart[i] + 1] : null;
    const v = sentence.slice(m.index + m[0].length).match(AFTER)?.[1] ?? sentence.slice(0, m.index).match(BEFORE)?.[1];
    if (v == null) continue;
    const key = ver ? `${b.key}-${ver}` : b.key;
    const label = ver ? (b.key === 'arc-agi' ? `${b.label}-${ver}` : `${b.label} ${ver}`) : b.label;
    if (!out.some((o) => o.key === key)) out.push({ key, label, value: Number(v) });
  }
  return out;
}

// Release -> { scores: [{ key, label, value, sources, url, site }] }, the
// value most outlets agree on per benchmark.
export function releaseScores(db, r, { now = Date.now() } = {}) {
  const since = r.date - DAY;
  const until = Math.min(now, r.date + 30 * DAY);
  const spaced = r.name.replace(/([a-z])(\d)/gi, '$1 $2');
  const q = (s) => `"${s.replace(/"/g, '')}"`;
  let match = `{title description body}: (${q(r.name)}${spaced !== r.name ? ` OR ${q(spaced)}` : ''})`;
  if (/^[a-z]+$/i.test(r.name.trim())) match += ` AND {title description body}: ${q(r.provider)}`; // "Extract", "Flint"
  let rows;
  try {
    rows = db.prepare(`SELECT d.url, d.site, d.title, d.description, substr(d.body, 1, 30000) AS body, ${ts} AS at FROM docs_fts JOIN docs d ON d.id = docs_fts.rowid
      WHERE docs_fts MATCH ? AND ${ts} >= ? AND ${ts} <= ? AND d.hidden = 0 AND d.type IN ('article', 'post')
      ORDER BY ${ts} LIMIT 400`).all(match, since, until + 5 * 60e3);
  } catch {
    return { scores: [] };
  }
  const re = nameMatcher(r.name);
  const found = new Map(); // key -> { label, values: Map(value -> { sites, url, site, at }) }
  const near = new RegExp(re.source, 'gi');
  for (const row of rows) {
    const seen = new Set();
    // Only the text around each mention of the name is read.
    const text = `${row.title}.\n${row.description}\n${row.body}`;
    const spans = [];
    for (const m of text.matchAll(near)) {
      const a = Math.max(0, m.index - 320);
      const b = m.index + 320;
      if (spans.length && a <= spans.at(-1)[1]) spans.at(-1)[1] = b;
      else spans.push([a, b]);
    }
    for (const s of spans.flatMap(([a, b]) => sentences(text.slice(a, b)))) {
      for (const sc of extractScores(s, re)) {
        if (seen.has(sc.key)) continue; // one value per benchmark per article
        seen.add(sc.key);
        const f = found.get(sc.key) || found.set(sc.key, { label: sc.label, values: new Map() }).get(sc.key);
        const v = f.values.get(sc.value) || f.values.set(sc.value, { sites: new Set(), url: row.url, site: row.site, at: row.at }).get(sc.value);
        v.sites.add(row.site);
      }
    }
  }
  const scores = [...found].map(([key, f]) => {
    const [value, v] = [...f.values].sort((a, b) => b[1].sites.size - a[1].sites.size || a[1].at - b[1].at)[0];
    return { key, label: f.label, value, sources: v.sites.size, url: v.url, site: v.site, disputed: f.values.size > 1 };
  });
  return { scores: scores.sort((a, b) => b.sources - a.sources) };
}

// Worker: { [release id]: { coverage, scores } }.
export function computeModels(db, releases, { now = Date.now() } = {}) {
  const out = {};
  for (const r of releases) {
    const c = releaseCoverage(db, r, { now, perRelease: 0 });
    const { scores } = releaseScores(db, r, { now });
    const series = c?.series || [];
    out[r.id] = {
      n: c?.n || 0,
      outlets: c?.outlets || 0,
      first: c?.first ? { source: c.first.source, url: c.first.url, at: c.first.at } : null,
      week: series.slice(0, 8).reduce((s, d) => s + d.n, 0), // the day before launch and its first week
      recent: series.slice(-7).reduce((s, d) => s + d.n, 0),
      series: series.map((d) => d.n),
      scores,
    };
  }
  return out;
}

// ---- Server side ----

// Parameters in billions from the name, its sizes and the listing's blurb:
// "Beam 1.0 501B A23B" -> { total: 501, active: 23 }.
export function paramsOf(r) {
  const names = [r.name, ...(r.sizes || []).map((s) => s.split('/')[1] || s)];
  let total = null;
  let active = null;
  for (const n of names) {
    for (const m of n.matchAll(/(?:^|[\s_-])(\d+(?:\.\d+)?)([bBtT])(?=$|[\s_-])/g)) total = Math.max(total || 0, Number(m[1]) * (/t/i.test(m[2]) ? 1000 : 1));
    const a = n.match(/[\s_-]A(\d+(?:\.\d+)?)B(?=$|[\s_-])/i);
    if (a) active = Math.max(active || 0, Number(a[1]));
  }
  const s = r.summary || '';
  const sa = s.match(/(\d+(?:\.\d+)?)\s?B\s+active/i) || s.match(/(\d+(?:\.\d+)?)\s?B\s+(?:of\s+which\s+)?(?:are\s+)?activated/i);
  const st = s.match(/(\d+(?:\.\d+)?)\s?([BT])\s+total/i) || s.match(/(\d+(?:\.\d+)?)\s?([BT])(?:-|\s)param/i);
  if (st && total == null) total = Number(st[1]) * (/t/i.test(st[2]) ? 1000 : 1);
  if (sa && active == null) active = Number(sa[1]);
  if (active != null && total != null && active >= total) active = null;
  return { total, active };
}

// A blended price per million tokens, 3 parts input to 1 part output.
export const blendedPrice = (r) => (r.priceIn == null || r.priceOut == null ? null : +((3 * r.priceIn + r.priceOut) / 4).toFixed(4));

let listStamp = '';
export async function modelsTable(releases) {
  const slim = releases.map(({ id, name, provider, date }) => ({ id, name, provider, date }));
  const stamp = slim.map((r) => r.id).join('|');
  if (stamp !== listStamp) {
    listStamp = stamp;
    expireJob('models');
  }
  const extra = await cachedJob('models', { kind: 'models', releases: slim }, TTL_MS);
  return shapeModels(releases, extra);
}

export function shapeModels(releases, extra) {
  const benches = new Map();
  const models = releases.map((r) => {
    const x = extra[r.id] || { n: 0, outlets: 0, first: null, week: 0, recent: 0, series: [], scores: [] };
    for (const s of x.scores) {
      const b = benches.get(s.key) || benches.set(s.key, { key: s.key, label: s.label, models: 0 }).get(s.key);
      b.models++;
    }
    return {
      id: r.id, name: r.name, provider: r.provider, org: r.org, date: r.date, url: r.url, summary: r.summary || '',
      api: !!r.api, open: !!r.open, hf: r.hf || null, notable: !!r.notable, modality: r.modality || 'text',
      context: r.context || null, priceIn: r.priceIn ?? null, priceOut: r.priceOut ?? null, blended: blendedPrice(r),
      params: paramsOf(r), sizes: (r.sizes || []).length,
      coverage: { n: x.n, outlets: x.outlets, first: x.first, week: x.week, recent: x.recent, series: x.series },
      scores: x.scores,
    };
  });
  return {
    generatedAt: Date.now(),
    models,
    benchmarks: [...benches.values()].sort((a, b) => b.models - a.models),
  };
}
