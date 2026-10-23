// Framing: how outlets tell the same story. The last two days of English
// headlines are grouped into stories by meaning (bge-small embeddings, close
// to the story's first headline) among those that share words, so differently
// worded headlines about one event land together. For each story told by
// four or more outlets: one headline per outlet, the words most of them use,
// the words only one used, each headline's tone (src/pipeline/tone.js), how
// differently they're worded, and the headline's shape (a question, a quote,
// a number, an explainer). Across stories, each outlet's tone is compared
// with the other outlets on the same stories, so a darker-than-the-pack
// outlet shows up even when it covers different news from the rest.

import { splitOutlet, tokens, hostOf } from '../pipeline/text.js';
import { toneOf } from '../pipeline/tone.js';
import { isAiRelated } from '../pipeline/classify.js';
import { cachedJob } from './offload.js';

const HOUR = 3600e3;
const TTL_MS = 20 * 60e3;
export const FRAMING_HOURS = 48;
const MIN_OUTLETS = 4;
const SIM = 0.85;

// One outlet across its domains and names: "bbc.co.uk", "bbc.com" and "BBC".
export const outletKey = (s) => s.toLowerCase().replace(/^www\./, '').replace(/\.(?:com|co\.uk|org|net|io|ai|co|news|blog|uk)$/, '').replace(/[^a-z0-9]+/g, '');

const jaccard = (a, b) => {
  let n = 0;
  for (const t of a) if (b.has(t)) n++;
  return n / Math.max(1, a.size + b.size - n);
};

export function shapeOf(title) {
  const out = [];
  if (/\?\s*$/.test(title)) out.push('question');
  if (/["“”]|['‘’][^'‘’]{6,}['‘’]|\b(?:says|said|claims|warns|insists|admits)\b/i.test(title)) out.push('quote');
  if (/(?:^|\s)[$€£]?\d[\d,.]*\s*(?:%|percent|billion|million|trillion|[BMK]\b|x\b)?/i.test(title)) out.push('number');
  if (/^(?:how|why|what|who|when|here['’]s|inside|explained|everything)\b/i.test(title) || /\bexplained\b/i.test(title)) out.push('explainer');
  if (/^(?:exclusive|scoop|breaking|report)\b/i.test(title)) out.push('scoop');
  return out;
}

// rows: [{ id, title, url, at }] oldest first; vi: the vector index (or null).
export function clusterHeadlines(rows, vi) {
  const groups = [];
  const byTok = new Map();
  for (const r of rows) {
    const split = splitOutlet(r.title || '');
    const { title } = split;
    // A dashed subtitle ("… - Chief Executive says AI is 'icing on the cake'") isn't an outlet.
    const outlet = split.outlet && split.outlet.split(/\s+/).length <= 4 ? split.outlet : null;
    if (!title || !/^[\x20-\x7E‘-”–—…$€£]+$/.test(title) || !isAiRelated(title)) continue;
    const toks = new Set(tokens(title));
    if (toks.size < 3) continue;
    const row = vi?.rowOf(r.id) ?? null;
    // Candidates share at least two words with the story's first headline.
    const hits = new Map();
    for (const t of toks) for (const g of byTok.get(t) || []) hits.set(g, (hits.get(g) || 0) + 1);
    let best = null;
    let bestSim = 0;
    for (const [g, n] of hits) {
      if (n < 2) continue;
      // Without both vectors, most of the shorter headline's words in common.
      const sim = row != null && g.row != null ? vi.dot(row, g.row) : n / Math.min(toks.size, g.toks.size) >= 0.4 ? SIM : 0;
      if (sim >= SIM && sim > bestSim) { best = g; bestSim = sim; }
    }
    const host = hostOf(r.url).replace(/^www\./, '');
    const source = outlet || (r.source && !/^https?:/.test(r.source) ? r.source : '') || host;
    const h = { title, url: r.url, source, at: r.at, toks, key: outletKey(source) };
    if (best) {
      if (!best.items.some((x) => x.key === h.key)) best.items.push(h);
      continue;
    }
    const g = { row, toks, items: [h] };
    groups.push(g);
    for (const t of toks) {
      if (!byTok.has(t)) byTok.set(t, []);
      byTok.get(t).push(g);
    }
  }
  return groups;
}

export function frameStory(g) {
  const items = g.items;
  const df = new Map();
  for (const h of items) for (const t of h.toks) df.set(t, (df.get(t) || 0) + 1);
  const core = [...df.entries()].filter(([, n]) => n >= Math.ceil(items.length / 2)).sort((a, b) => b[1] - a[1]).map(([t]) => t).slice(0, 8);
  const headlines = items.map((h) => {
    const t = toneOf(h.title);
    return {
      source: h.source,
      url: h.url,
      title: h.title,
      at: h.at,
      tone: Math.round(t.score * 100) / 100,
      pos: t.pos,
      neg: t.neg,
      only: [...h.toks].filter((w) => df.get(w) === 1 && w.length > 2 && !/^\d+$/.test(w)).slice(0, 6),
      shape: shapeOf(h.title),
    };
  });
  let sum = 0;
  let pairs = 0;
  for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) { sum += jaccard(items[i].toks, items[j].toks); pairs++; }
  const tones = headlines.map((h) => h.tone);
  const meanTone = tones.reduce((a, b) => a + b, 0) / tones.length;
  // The headline closest to the others stands for the story.
  const central = items.map((h, i) => [i, items.reduce((a, o) => a + (o === h ? 0 : jaccard(h.toks, o.toks)), 0)]).sort((a, b) => b[1] - a[1])[0][0];
  return {
    id: `${new Date(items[0].at).toISOString().slice(0, 13)}-${[...items[central].toks].slice(0, 3).join('-')}`.replace(/[^a-z0-9-]/gi, '').slice(0, 60),
    title: items[central].title,
    first: { at: items[0].at, source: items[0].source },
    outlets: items.length,
    spread: pairs ? Math.round((1 - sum / pairs) * 100) / 100 : 0,
    meanTone: Math.round(meanTone * 100) / 100,
    toneRange: Math.round((Math.max(...tones) - Math.min(...tones)) * 100) / 100,
    core,
    headlines: headlines.sort((a, b) => a.at - b.at).slice(0, 16),
  };
}

export function computeFraming(db, { vi = null, now = Date.now(), hours = FRAMING_HOURS } = {}) {
  const rows = db.prepare(`SELECT id, title, url, source, published_at AS at FROM docs INDEXED BY docs_type_pub
    WHERE type = 'article' AND published_at >= ? AND published_at <= ? AND hidden = 0 AND (lang IS NULL OR lang = '' OR lang LIKE 'en%')
    ORDER BY published_at`).all(now - hours * HOUR, now + 5 * 60e3);
  const stories = clusterHeadlines(rows, vi).filter((g) => g.items.length >= MIN_OUTLETS).map(frameStory);

  // Each outlet against the rest on the same stories.
  const outlets = new Map();
  for (const s of stories) {
    for (const h of s.headlines) {
      const others = s.headlines.filter((o) => o !== h);
      const rest = others.reduce((a, o) => a + o.tone, 0) / others.length;
      const o = outlets.get(h.source) || { name: h.source, n: 0, diff: 0, darker: 0, brighter: 0, questions: 0 };
      o.n++;
      o.diff += h.tone - rest;
      if (h.tone < rest - 0.25) o.darker++;
      if (h.tone > rest + 0.25) o.brighter++;
      if (h.shape.includes('question')) o.questions++;
      outlets.set(h.source, o);
    }
  }
  const outletList = [...outlets.values()].filter((o) => o.n >= 4).map((o) => ({ ...o, diff: Math.round((o.diff / o.n) * 100) / 100 }));
  const byOutlets = [...stories].sort((a, b) => b.outlets - a.outlets);
  return {
    generatedAt: now,
    hours,
    headlines: rows.length,
    stories: byOutlets.slice(0, 40),
    divided: [...stories].filter((s) => s.outlets >= 5).sort((a, b) => b.toneRange - a.toneRange || b.spread - a.spread).slice(0, 6).map((s) => s.id),
    outlets: {
      darker: [...outletList].sort((a, b) => a.diff - b.diff).filter((o) => o.diff < 0).slice(0, 8),
      brighter: [...outletList].sort((a, b) => b.diff - a.diff).filter((o) => o.diff > 0).slice(0, 8),
      count: outletList.length,
    },
    stats: {
      stories: stories.length,
      outletsPerStory: stories.length ? Math.round((stories.reduce((a, s) => a + s.outlets, 0) / stories.length) * 10) / 10 : 0,
      spread: stories.length ? Math.round((stories.reduce((a, s) => a + s.spread, 0) / stories.length) * 100) / 100 : 0,
      split: stories.filter((s) => s.headlines.some((h) => h.tone > 0) && s.headlines.some((h) => h.tone < 0)).length,
    },
  };
}

export const framingQuery = () => cachedJob('framing', { kind: 'framing' }, TTL_MS);
