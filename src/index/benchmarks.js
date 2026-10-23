// Benchmarks: the scores models are reported to get on the benchmarks people
// quote (SWE-bench Verified, GPQA Diamond, ARC-AGI-2, Humanity's Last Exam…),
// read from coverage, and who leads each one, and since when.
//
// For every benchmark, the articles naming it (FTS) are split into sentences.
// In a sentence, each benchmark mention takes the nearest percentage that no
// other mention took ("96.9% AIME 2025, 84.3% GPQA Diamond" or "scores 81.2%
// on SWE-bench Verified"). The model is the nearest model name before the
// score in the same sentence; failing that, the one model the headline
// names. Research deltas ("raised X from 41.8% to 56.4%") and baselines
// ("human experts") are skipped. The same model, benchmark and score from
// several outlets is one claim, ranked by how many outlets carried it; when
// outlets disagree on a score, the most carried wins and the rest are listed.

import { cachedJob } from './offload.js';

const DAY = 86400e3;
const TTL_MS = 60 * 60e3;
export const BENCH_DAYS = 365;

// key, label, what it measures, aliases (regex source, case-insensitive)
export const BENCHMARKS = [
  ['swe-bench-verified', 'SWE-bench Verified', 'Fixing real GitHub issues in Python repositories', String.raw`SWE[- ]?bench(?:[- ]Verified)?(?![- ]?(?:Pro|Multi|Lite))`],
  ['swe-bench-pro', 'SWE-bench Pro', 'Harder, longer software engineering tasks', String.raw`SWE[- ]?bench[- ]Pro`],
  ['terminal-bench', 'Terminal-Bench', 'Getting real work done in a command-line terminal', String.raw`Terminal[- ]?Bench(?:[- ]?2(?:\.\d)?)?`],
  ['gpqa', 'GPQA Diamond', 'PhD-level science questions written to resist search', String.raw`GPQA(?:[- ]Diamond)?`],
  ['hle', "Humanity's Last Exam", 'Expert questions across dozens of fields, at the edge of human knowledge', String.raw`Humanity['’]?s Last Exam|\bHLE\b`],
  ['arc-agi-2', 'ARC-AGI-2', 'Abstract visual puzzles that are easy for people and hard for models', String.raw`ARC[- ]AGI[- ]?2`],
  ['arc-agi-3', 'ARC-AGI-3', 'Interactive puzzle games learned from scratch', String.raw`ARC[- ]AGI[- ]?3`],
  ['aime', 'AIME', 'Competition maths (American Invitational Mathematics Examination)', String.raw`\bAIME(?:[- ]?(?:20)?2[4-6])?\b`],
  ['frontiermath', 'FrontierMath', 'Unpublished research-level maths problems', String.raw`FrontierMath`],
  ['osworld', 'OSWorld', 'Using a computer: real desktop tasks through the screen', String.raw`OSWorld(?:[- ]Verified)?`],
  ['mmlu-pro', 'MMLU-Pro', 'Broad knowledge and reasoning, multiple choice', String.raw`MMLU[- ]Pro`],
  ['mmmu', 'MMMU', 'College-level questions over images and diagrams', String.raw`\bMMMU(?![- ]Pro)\b`],
  ['browsecomp', 'BrowseComp', 'Finding hard-to-find facts by browsing the web', String.raw`BrowseComp`],
  ['tau-bench', 'τ²-bench', 'Customer-service agents following policy with tools', String.raw`(?:τ|tau)[²2]?[- ]?bench`],
  ['livecodebench', 'LiveCodeBench', 'Fresh competitive-programming problems', String.raw`LiveCodeBench`],
].map(([key, label, about, re]) => ({ key, label, about, re: new RegExp(re, 'gi') }));

// Model names: families with a version ("Claude Opus 5.5", "GPT-6.1 Sol",
// "Gemini 3.7 Flash", "Qwen3.5-122B", "DeepSeek V4.1", "o4-mini").
const MODEL = new RegExp([
  String.raw`GPT[- ]?\d(?:\.\d+)?(?:[- ](?:mini|nano|pro|Sol|Astra|Codex|turbo))*`,
  String.raw`\bo[1-9](?:[- ](?:mini|pro|high))?\b`,
  String.raw`Claude(?: (?:Opus|Sonnet|Haiku|Fable|Mythos|Duet))? ?\d(?:\.\d+)?(?: (?:Opus|Sonnet|Haiku|Fable|Mythos))?`,
  String.raw`Gemini \d(?:\.\d+)?(?: (?:Pro|Flash(?:[- ]Lite)?|Ultra|Deep Think|Argon))*`,
  String.raw`Grok[- ]?\d(?:\.\d+)?(?: (?:Heavy|Fast|mini))?`,
  String.raw`Llama[- ]?\d(?:\.\d+)?(?:[- ](?:\d+B|Maverick|Scout|Behemoth))?`,
  String.raw`Qwen\d?(?:\.\d+)?(?:[- ](?:Max|Coder|Plus|\d+B(?:[- ]A\d+B)?))*`,
  String.raw`DeepSeek[- ](?:V|R)\d(?:\.\d+)?(?:[- ](?:Flash|Pro|Exp|Terminus))?`,
  String.raw`Kimi[- ]K\d(?:\.\d+)?(?:[- ]Thinking)?`,
  String.raw`GLM[- ]\d(?:\.\d+)?(?:V)?`,
  String.raw`MiniMax[- ]M\d(?:\.\d+)?(?:[- ]Flash)?`,
  String.raw`Mistral (?:Large|Medium|Small) ?\d(?:\.\d+)?`,
  String.raw`Nemotron(?: \d(?:\.\d+)?)?(?: (?:Super|Ultra|Nano))+`,
  String.raw`Muse (?:Spark|Wonder)(?: Open)?`,
  String.raw`Phi[- ]\d(?:\.\d+)?`,
].join('|'), 'g');

const PCT = /(\d{1,3}(?:\.\d{1,2})?)\s?(?:%|percent\b)/g;
const DELTA = /\bfrom \d{1,3}(?:\.\d+)?\s?%\s*(?:to|→)|\bup from\b|\bimprov\w* (?:by|from)\b|percentage points?\b/i;
const BASELINE = /\bhuman(?:s| experts?| baseline)?\b(?! ?(?:'s|’s) last)|\bbaseline\b|\brandom\b/i;

export const normModel = (s) => s.toLowerCase().replace(/[-\s]+/g, ' ').replace(/(\d)\.0\b/g, '$1').trim();

const modelsIn = (s) => {
  MODEL.lastIndex = 0;
  return [...s.matchAll(MODEL)].map((m) => ({ name: m[0].trim(), at: m.index, end: m.index + m[0].length }));
};

/** Claims in one sentence: [{ bench, model, score }]. */
export function claimsIn(sentence, { titleModel = null, only = null } = {}) {
  if (sentence.length > 400 || DELTA.test(sentence)) return [];
  const mentions = [];
  for (const b of only ? BENCHMARKS.filter((x) => only.includes(x.key)) : BENCHMARKS) {
    b.re.lastIndex = 0;
    for (const m of sentence.matchAll(b.re)) mentions.push({ b, at: m.index, end: m.index + m[0].length });
  }
  if (!mentions.length) return [];
  // "SWE-bench Pro" also matches the bare pattern on some engines; keep the longest at a position.
  const byAt = new Map();
  for (const m of mentions) if (!byAt.has(m.at) || byAt.get(m.at).end < m.end) byAt.set(m.at, m);
  const ms = [...byAt.values()].sort((a, b) => a.at - b.at);
  PCT.lastIndex = 0;
  const nums = [...sentence.matchAll(PCT)].map((m) => ({ v: Number(m[1]), at: m.index, end: m.index + m[0].length, used: false })).filter((n) => n.v > 0 && n.v <= 100);
  if (!nums.length) return [];
  const models = modelsIn(sentence);
  const out = [];
  // Pair greedily by distance: a mention and the closest unused number.
  const pairs = [];
  for (const m of ms) for (const n of nums) {
    const after = n.at >= m.end;
    let dist = after ? n.at - m.end : m.at - n.end;
    if (dist < 0 || dist > 60) continue;
    const between = after ? sentence.slice(m.end, n.at) : sentence.slice(n.end, m.at);
    // "81.2% on SWE-bench" is the usual phrasing; a score across an "and"
    // or a comma belongs to the next benchmark.
    if (!after && /^\s*(?:on|in|at|for)\s+(?:the\s+)?$/i.test(between)) dist = 0;
    else if (/\band\b|[,;]/.test(between)) dist += 30;
    else if (!after) dist += 4;
    pairs.push({ m, n, dist });
  }
  pairs.sort((a, b) => a.dist - b.dist);
  const usedM = new Set();
  for (const { m, n } of pairs) {
    if (usedM.has(m) || n.used) continue;
    // A baseline between the number and the benchmark ("humans score 98% on ARC") isn't a model.
    // The number's own subject: the few words before it.
    if (BASELINE.test(sentence.slice(Math.max(0, n.at - 30), n.at))) continue;
    const pos = Math.min(m.at, n.at);
    const before = models.filter((x) => x.end <= pos + 1);
    const model = before.length ? before[before.length - 1].name : models.length === 1 ? models[0].name : titleModel;
    if (!model) continue;
    usedM.add(m);
    n.used = true;
    out.push({ bench: m.b.key, model, score: n.v });
  }
  return out;
}

const sentences = (text) => text.replace(/\s+/g, ' ').split(/(?<=[.!?])\s+(?=[A-Z0-9“"(])|(?<=[a-z0-9)%])(?=[A-Z][a-z]+ [a-z])/);

export function computeBenchmarks(db, { now = Date.now(), days = BENCH_DAYS, perBench = 900 } = {}) {
  const since = now - days * DAY;
  const fts = (b) => {
    const terms = { 'swe-bench-verified': '"swe bench"', 'swe-bench-pro': '"swe bench pro"', 'terminal-bench': '"terminal bench"', gpqa: 'gpqa', hle: '"last exam" OR hle', 'arc-agi-2': '"arc agi"', 'arc-agi-3': '"arc agi"', aime: 'aime', frontiermath: 'frontiermath', osworld: 'osworld', 'mmlu-pro': '"mmlu pro"', mmmu: 'mmmu', browsecomp: 'browsecomp', 'tau-bench': '"tau bench" OR "τ bench" OR "tau2 bench"', livecodebench: 'livecodebench' };
    return terms[b.key];
  };
  const stmt = db.prepare(`SELECT d.id, d.url, d.title, d.source, d.site, d.published_at AS at, substr(d.description, 1, 600) AS description, substr(d.body, 1, 30000) AS body
    FROM docs d WHERE d.id IN (SELECT rowid FROM docs_fts WHERE docs_fts MATCH ? ORDER BY rowid DESC LIMIT ?) AND d.published_at >= ? AND d.published_at <= ? AND d.hidden = 0 AND d.type = 'article'`);
  const seen = new Set();
  const raw = []; // { bench, model, score, doc }
  for (const b of BENCHMARKS) {
    let rows = [];
    try { rows = stmt.all(fts(b), perBench, since, now + 5 * 60e3); } catch { continue; }
    for (const d of rows) {
      if (seen.has(`${b.key}:${d.id}`)) continue;
      seen.add(`${b.key}:${d.id}`);
      const tm = modelsIn(d.title);
      const titleModel = new Set(tm.map((m) => normModel(m.name))).size === 1 ? tm[0].name : null;
      const found = new Map();
      for (const s of sentences(`${d.title}. ${d.description || ''} ${d.body || ''}`)) {
        for (const c of claimsIn(s, { titleModel, only: [b.key] })) {
          const k = `${normModel(c.model)}|${c.score}`;
          if (!found.has(k)) found.set(k, { ...c, sentence: s.trim().slice(0, 300) });
        }
      }
      for (const c of found.values()) raw.push({ ...c, doc: d });
    }
  }

  // Claims: model + benchmark + score, across outlets.
  const claims = new Map();
  for (const r of raw) {
    const k = `${r.bench}|${normModel(r.model)}|${r.score}`;
    const c = claims.get(k) || { bench: r.bench, key: normModel(r.model), names: new Map(), score: r.score, outlets: new Set(), first: r.doc, quote: r.sentence, docs: 0 };
    c.names.set(r.model, (c.names.get(r.model) || 0) + 1);
    c.outlets.add(r.doc.source || r.doc.site);
    c.docs++;
    if (r.doc.at < c.first.at) { c.first = r.doc; c.quote = r.sentence; }
    claims.set(k, c);
  }

  // Per benchmark and model: the score most outlets carried (ties: higher
  // score, then earlier), with the alternatives.
  const benches = BENCHMARKS.map((b) => {
    const mine = [...claims.values()].filter((c) => c.bench === b.key);
    const byModel = new Map();
    for (const c of mine) (byModel.get(c.key) || byModel.set(c.key, []).get(c.key)).push(c);
    const models = [...byModel.values()].map((cs) => {
      cs.sort((x, y) => y.outlets.size - x.outlets.size || y.score - x.score || x.first.at - y.first.at);
      const top = cs[0];
      const name = [...cs.flatMap((c) => [...c.names])].sort((x, y) => y[1] - x[1])[0][0];
      return {
        model: name,
        key: top.key,
        score: top.score,
        outlets: top.outlets.size,
        at: top.first.at,
        source: top.first.source || top.first.site,
        url: top.first.url,
        title: top.first.title,
        quote: top.quote,
        others: cs.slice(1, 4).map((c) => ({ score: c.score, outlets: c.outlets.size })),
        // One outlet alone is often a misread (or another benchmark's number).
        confirmed: top.outlets.size >= 2,
      };
    })
      .sort((x, y) => y.confirmed - x.confirmed || y.score - x.score || y.outlets - x.outlets);
    // State of the art over time: each claim that beat everything before it.
    const sota = [];
    let best = -1;
    for (const m of models.filter((x) => x.confirmed).sort((x, y) => x.at - y.at)) if (m.score > best) { best = m.score; sota.push({ model: m.model, score: m.score, at: m.at }); }
    return { key: b.key, label: b.label, about: b.about, models: models.slice(0, 40), sota, articles: new Set(raw.filter((r) => r.bench === b.key).map((r) => r.doc.id)).size };
  }).filter((b) => b.models.length >= 3 && b.models.filter((m) => m.confirmed).length >= 2);

  return { days, since, generatedAt: now, benchmarks: benches.sort((a, b) => b.articles - a.articles) };
}

export const benchmarksQuery = () => cachedJob('benchmarks', { kind: 'benchmarks' }, TTL_MS);
