// An extractive brief: the few sentences that best sum up what several
// outlets wrote about one story, each credited to its outlet.
//
// Sentences are scored by how close they are to the story's centre (TF-IDF
// cosine against the sum of all sentences) and how many outlets said much the
// same thing, with a nudge for leads. They are then picked greedily, skipping
// any too close to one already chosen, at most two per outlet.

import { tokens } from './text.js';

const ANAPHORA = /^(the (decision|move|company|report|deal|order|ban|announcement|news|change)|this|that|these|those|it|its|he|she|they|his|her|their|but|and|also|however|meanwhile)\b/i;
const BOILER = /\b(subscribe|sign up|newsletter|cookies?|click here|read more|all rights reserved|follow us|getty images|image credit|photo by|advertisement|this story|our coverage|related:)\b/i;

export function sentences(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+(?=[A-Z"“‘(])/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 50 && s.length <= 320 && !/https?:\/\/|www\.|@\w{3,}/.test(s) && !BOILER.test(s) && /[.!?"”’)]$/.test(s));
}

function vectorize(toks, idf) {
  const tf = new Map();
  for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
  const v = new Map();
  let norm = 0;
  for (const [t, n] of tf) {
    const w = (1 + Math.log(n)) * (idf.get(t) || 0);
    if (!w) continue;
    v.set(t, w);
    norm += w * w;
  }
  norm = Math.sqrt(norm) || 1;
  for (const [t, w] of v) v.set(t, w / norm);
  return v;
}

function cosine(a, b) {
  if (a.size > b.size) [a, b] = [b, a];
  let s = 0;
  for (const [t, w] of a) s += w * (b.get(t) || 0);
  return s;
}

// docs: [{ source, url, text }] — one per outlet, the lead outlet first.
export function extractiveBrief(docs, { max = 4, perSource = 2 } = {}) {
  const cands = [];
  for (const d of docs) {
    sentences(d.text).slice(0, 30).forEach((text, pos) => {
      const toks = tokens(text).filter((t) => t.length > 2 || /\d/.test(t));
      if (toks.length >= 6) cands.push({ text, source: d.source, url: d.url, pos, toks });
    });
  }
  if (!cands.length) return [];
  const df = new Map();
  for (const c of cands) for (const t of new Set(c.toks)) df.set(t, (df.get(t) || 0) + 1);
  const idf = new Map([...df].map(([t, n]) => [t, Math.log(1 + cands.length / n)]));
  for (const c of cands) c.vec = vectorize(c.toks, idf);
  const centre = new Map();
  for (const c of cands) for (const [t, w] of c.vec) centre.set(t, (centre.get(t) || 0) + w);
  const cn = Math.sqrt([...centre.values()].reduce((s, w) => s + w * w, 0)) || 1;
  for (const [t, w] of centre) centre.set(t, w / cn);
  const outlets = new Set(cands.map((c) => c.source)).size;
  for (const c of cands) {
    // A sentence leaning on one before it ("The decision…", "He said…") reads badly alone.
    c.score = cosine(c.vec, centre) * (ANAPHORA.test(c.text) ? 0.7 : 1) + (c.pos < 3 ? 0.08 * (3 - c.pos) / 3 : 0);
  }
  // Agreement across outlets (other outlets with a close sentence), for the
  // most central sentences only: all pairs would be quadratic.
  cands.sort((a, b) => b.score - a.score);
  const top = cands.slice(0, 80);
  for (const c of top) {
    const echoed = new Set();
    for (const o of cands) if (o.source !== c.source && !echoed.has(o.source) && cosine(c.vec, o.vec) > 0.35) echoed.add(o.source);
    c.score *= 1 + (outlets > 1 ? echoed.size / (outlets - 1) : 0) * 0.5;
  }
  top.sort((a, b) => b.score - a.score);
  cands.splice(0, top.length, ...top);
  const picked = [];
  const bySource = new Map();
  for (const c of cands) {
    if (picked.length >= max) break;
    if ((bySource.get(c.source) || 0) >= perSource) continue;
    if (picked.some((p) => cosine(p.vec, c.vec) > 0.45)) continue;
    picked.push(c);
    bySource.set(c.source, (bySource.get(c.source) || 0) + 1);
  }
  return picked.map(({ text, source, url }) => ({ text, source, url }));
}
