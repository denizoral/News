// Ask the Wire: a question in, an answer made of sentences from stored
// coverage out, each with its source. Nothing is generated.
//
//   1. Find the articles: the nearest by meaning (sentence embeddings) and the
//      best keyword matches (BM25), merged by reciprocal rank.
//   2. Split them into sentences, keeping the lead and any sentence that shares
//      words with the question (at most ~120).
//   3. Embed the sentences and score each against the question, with a little
//      credit for shared words, the lead and the article's rank.
//   4. Pick up to five by maximal marginal relevance, so the answer doesn't
//      repeat itself, at most two from one article.
//
// Model cards and repos (Hugging Face, GitHub, OpenRouter) aren't coverage
// and are left out. Steps 1-2 run in the vectors worker (it holds the vectors); 3-4 here, since
// they wait on the embedding service. About 1 s (embedding ~70 sentences),
// less when the articles came up before; cached.

import { tokens } from '../pipeline/text.js';
import { runJob } from './offload.js';
import { embedTexts } from './vectors.js';

const TTL_MS = 30 * 60e3;
const MAX_SENTENCES = 72;
const VEC_CACHE = 8000; // sentence -> Float32Array, ~12 MB at most
const RECENT = /\b(latest|recent|recently|now|today|this (?:week|month|year)|currently|new|newest|just|last)\b/i;
const QUESTION_WORDS = new Set('what who whom whose which when where why how is are was were do does did can could will would should has have had the a an of to in on for about with and or vs versus tell me explain latest new news happened happening'.split(' '));
const BOILER = /cookie|subscribe|sign up|newsletter|all rights reserved|click here|read more|advertisement|©|privacy policy|terms of (?:use|service)|follow us|share this|getty images|image credit|photo:|^(?:by|source|via)\b/i;

// The words worth matching: no question words, at most eight.
export function questionTerms(q) {
  return [...new Set(tokens(q).filter((t) => t.length > 1 && !QUESTION_WORDS.has(t)))].slice(0, 8);
}

// Any of the words, best (most matched, rarest) first.
export function ftsQuery(terms) {
  if (!terms.length) return null;
  return `{title description body} : (${terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ')})`;
}

// Sentences of a text, cleaned, between 50 and 320 characters.
const DATELINE = /^(?:(?:posted|updated|published)\s+)?(?:(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*,?\s+)?[A-Z][a-z]{2,8}\.?\s+\d{1,2},?\s+\d{4}(?:\s+at\s+[\d:]+\s*[AP]M(?:\s+[A-Z]{2,4})?)?\s*[-–—|:]?\s*/i;
// "Gerry Miller | CNBCAnthropic is…": a photo credit run into the text.
const CREDIT = /^(?:[A-Z][\w.'’-]+\s){1,3}\|\s*[A-Z][\w.]{1,15}?(?=[A-Z][a-z])/;
// Untagged pages in other languages: English has its function words.
const FUNCTION_WORDS = /\b(?:the|and|of|to|that|with|for|from|on|by|are|was|were|has|have|it|its|this|as|at|will|be)\b/gi;
const english = (s) => new Set((s.match(FUNCTION_WORDS) || []).map((w) => w.toLowerCase())).size >= 2 && (s.match(/[^\x00-\x7F’“”–—…€£]/g) || []).length <= s.length * 0.03;

export function sentences(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    // Paragraphs joined without a space when the page was read ("round.The").
    .replace(/([a-z0-9%)”"][.!?])(?=[A-Z][a-z])/g, '$1 ')
    .replace(/([.!?][”"])(?=[A-Z][a-z])/g, '$1 ')
    .split(/(?<=[.!?][”"]?)\s+(?=["“(]?[A-Z0-9])/)
    .map((s) => s.trim().replace(/^skip to (?:main )?content\s*/i, '').replace(DATELINE, '').replace(CREDIT, ''))
    .filter((s) => s.length >= 50 && s.length <= 320 && /[a-z]{3}/.test(s) && !BOILER.test(s) && !/external link/i.test(s) && !/\?["”]?$/.test(s)
      && !/^[^A-Z0-9"“(]/.test(s) && (s.match(/\|/g) || []).length < 2 && english(s)
      // Menus and captions don't end like sentences.
      && /[.!]["”')]?$/.test(s));
}

const overlapCount = (terms, s) => {
  const toks = new Set(tokens(s));
  return terms.reduce((n, t) => n + (toks.has(t) ? 1 : 0), 0);
};

// ---- Worker side ----

// The articles for a question and their candidate sentences.
export function askPassages(db, { vec, terms, similar, perDoc = 9, docs: want = 10 }) {
  const sem = vec ? similar({ vec, perPage: 24, types: ['article'], minScore: 0.5 }).results : [];
  const match = ftsQuery(terms);
  let kw = [];
  if (match) {
    try {
      kw = db.prepare(`SELECT f.rowid AS id FROM docs_fts f WHERE docs_fts MATCH ? ORDER BY bm25(docs_fts, 10, 4, 1, 0, 0) LIMIT 24`).all(match);
    } catch { /* a query FTS5 can't parse: meaning only */ }
  }
  // Reciprocal rank fusion of the two lists.
  const score = new Map();
  sem.forEach((r, i) => score.set(r.id, (score.get(r.id) || 0) + 1 / (20 + i)));
  kw.forEach((r, i) => score.set(r.id, (score.get(r.id) || 0) + 1 / (20 + i)));
  const ids = [...score].sort((a, b) => b[1] - a[1]).slice(0, want * 2).map(([id]) => id);
  if (!ids.length) return { docs: [], sentences: [] };
  const rows = new Map(db.prepare(`SELECT id, url, title, description, substr(body, 1, 8000) AS body, site, source, published_at, first_seen FROM docs
    WHERE id IN (${ids.map(() => '?').join(',')}) AND hidden = 0 AND type = 'article' AND (lang IS NULL OR lang = '' OR lang LIKE 'en%') AND site NOT IN ('huggingface.co', 'github.com', 'openrouter.ai')`).all(...ids).map((r) => [r.id, r]));
  const docs = [];
  const heads = new Set();
  for (const id of ids) {
    const r = rows.get(id);
    if (!r) continue;
    const head = tokens(r.title).slice(0, 6).join(' ');
    if (heads.has(head)) continue;
    heads.add(head);
    docs.push(r);
    if (docs.length >= want) break;
  }
  const out = [];
  docs.forEach((r, d) => {
    // A short or missing body (a feed item) still has its description.
    const all = sentences((r.body || '').length > 600 ? r.body : `${r.description || ''} ${r.body || ''}`);
    // The lead, then the sentences sharing the most words with the question.
    const ranked = all.map((text, pos) => ({ d, text, pos, hits: overlapCount(terms, text) }))
      .sort((a, b) => (b.pos < 3) - (a.pos < 3) || b.hits - a.hits || a.pos - b.pos)
      .slice(0, perDoc);
    out.push(...ranked);
  });
  out.sort((a, b) => b.hits - a.hits || a.pos - b.pos);
  return {
    docs: docs.map((r) => ({ id: r.id, url: r.url, title: r.title, site: r.site, source: r.source || r.site, at: r.published_at || r.first_seen })),
    sentences: out.slice(0, MAX_SENTENCES),
  };
}

// ---- Server side ----

const dot = (a, b) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
};

// Up to `n` sentences by maximal marginal relevance.
export function pickAnswer(cands, { n = 5, lambda = 0.75, perDoc = 2, floor = 0.6, dupe = 0.92 } = {}) {
  const chosen = [];
  const perDocCount = new Map();
  const pool = cands.filter((c) => c.sim >= floor);
  while (chosen.length < n && pool.length) {
    let best = -1;
    let bestScore = -Infinity;
    pool.forEach((c, i) => {
      if ((perDocCount.get(c.d) || 0) >= perDoc) return;
      const red = chosen.length ? Math.max(...chosen.map((x) => dot(x.vec, c.vec))) : 0;
      if (red >= dupe) return;
      const s = lambda * c.score - (1 - lambda) * red;
      if (s > bestScore) { bestScore = s; best = i; }
    });
    if (best < 0) break;
    const [c] = pool.splice(best, 1);
    chosen.push(c);
    perDocCount.set(c.d, (perDocCount.get(c.d) || 0) + 1);
  }
  return chosen;
}

export const confidenceOf = (top) => (top >= 0.76 ? 'strong' : top >= 0.64 ? 'partial' : 'weak');

const cache = new Map();
const vecCache = new Map();

// Sentence vectors, from the cache where an article came up before.
async function sentenceVectors(texts, embed) {
  const missing = [...new Set(texts.filter((t) => !vecCache.has(t)))];
  if (missing.length) {
    const vecs = await embed(missing, { timeoutMs: 20000 });
    missing.forEach((t, i) => {
      if (vecCache.size >= VEC_CACHE) vecCache.delete(vecCache.keys().next().value);
      vecCache.set(t, Float32Array.from(vecs[i]));
    });
  }
  return texts.map((t) => vecCache.get(t));
}

export async function ask(question, { embed = embedTexts, job = runJob } = {}) {
  const q = String(question || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  const key = q.toLowerCase().replace(/[?!.]+$/, '');
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.data;
  const started = Date.now();
  const terms = questionTerms(q);
  const [qvec] = await embed([`Represent this sentence for searching relevant passages: ${q}`], { timeoutMs: 15000 });
  const { docs, sentences: cands } = await job({ kind: 'askPassages', vec: qvec, terms });
  let answer = [];
  let top = 0;
  if (cands.length) {
    const vecs = await sentenceVectors(cands.map((c) => c.text), embed);
    // Newer coverage counts a little more, and a lot more when the question
    // asks for the latest.
    const fresh = RECENT.test(q) ? 0.08 : 0.025;
    const now = Date.now();
    const scored = cands.map((c, i) => {
      const sim = dot(qvec, vecs[i]);
      const words = terms.length ? Math.min(3, c.hits) / Math.max(3, terms.length) : 0;
      const age = Math.max(0, (now - (docs[c.d].at || now)) / 86400e3);
      return { ...c, vec: vecs[i], sim, score: sim + 0.06 * words + (c.pos === 0 ? 0.015 : 0) + 0.02 * (1 - c.d / Math.max(1, docs.length)) + fresh * Math.exp(-age / 120) };
    });
    top = Math.max(...scored.map((c) => c.sim));
    answer = pickAnswer(scored.sort((a, b) => b.score - a.score));
  }
  // Number the sources in the order the answer cites them, then the rest.
  const order = [...new Set([...answer.map((a) => a.d), ...docs.map((_, i) => i)])];
  const num = new Map(order.map((d, i) => [d, i + 1]));
  const data = {
    q,
    terms,
    confidence: answer.length ? confidenceOf(top) : 'none',
    answer: answer.map((a) => ({ text: a.text, cite: num.get(a.d), sim: Math.round(a.sim * 1000) / 1000 })),
    sources: order.map((d) => ({ n: num.get(d), ...docs[d], cited: answer.some((a) => a.d === d) })),
    tookMs: Date.now() - started,
  };
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  cache.set(key, { at: Date.now(), data });
  return data;
}
