// The mood of AI coverage: how good or bad the news about AI reads, week by
// week for half a year, for each big company, and by outlet. Every English
// AI headline gets a tone from its evaluative words (src/pipeline/tone.js):
// good, bad or neither. A week's mood is the share of good minus the share of
// bad, so +10 means ten points more good news than bad. Companies are the
// ones a headline names (the same entity matching as topics); outlets need
// enough headlines to say anything.

import { splitOutlet, hostOf } from '../pipeline/text.js';
import { toneOf, signOf } from '../pipeline/tone.js';
import { isAiRelated, extractEntities } from '../pipeline/classify.js';
import { ENTITY_LABELS } from '../pipeline/trending.js';
import { cachedJob } from './offload.js';

const DAY = 86400e3;
const WEEK = 7 * DAY;
const TTL_MS = 60 * 60e3;
export const MOOD_WEEKS = 26;
export const COMPANIES = ['openai', 'anthropic', 'google', 'meta', 'xai', 'microsoft', 'apple', 'amazon', 'nvidia', 'deepseek', 'qwen', 'mistral', 'perplexity', 'tesla'];
const MIN_OUTLET = 40;

const bucket = () => ({ n: 0, pos: 0, neg: 0 });
const add = (b, s) => {
  b.n++;
  if (s > 0) b.pos++;
  else if (s < 0) b.neg++;
};
// Points of good news minus bad, -100..100.
export const moodOf = (b) => (b.n ? Math.round(((b.pos - b.neg) / b.n) * 1000) / 10 : null);

export function computeMood(db, now = Date.now(), weeks = MOOD_WEEKS) {
  // Weeks end at now, so the last one is always seven full days.
  const since = now - weeks * WEEK;
  // Title and URL sit before the body in each row and the date is in the
  // index; asking for site or source too makes this read three times slower.
  const rows = db.prepare(`SELECT title, url, published_at AS at FROM docs INDEXED BY docs_type_pub
    WHERE type = 'article' AND published_at >= ? AND published_at <= ? AND hidden = 0 AND (lang IS NULL OR lang = '' OR lang LIKE 'en%')`).all(since, now + 5 * 60e3);
  const series = Array.from({ length: weeks }, (_, i) => ({ start: since + i * WEEK, ...bucket() }));
  const companies = new Map(COMPANIES.map((k) => [k, { key: k, label: ENTITY_LABELS[k] || k, weeks: Array.from({ length: weeks }, bucket), r90: bucket(), rPrev: bucket(), wk: bucket(), good: [], bad: [] }]));
  const outlets = new Map();
  const all90 = bucket();
  const allPrev = bucket();
  const wordsWeek = { pos: new Map(), neg: new Map(), prevPos: new Map(), prevNeg: new Map() };
  const extremes = { good: [], bad: [] };
  const seen = new Set();
  let headlines = 0;
  for (const r of rows) {
    const { title, outlet } = splitOutlet(r.title || '');
    if (!title || !/^[\x20-\x7E‘-”–—…$€£]+$/.test(title) || !isAiRelated(title)) continue;
    // Syndicated copies count once.
    const key = title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (seen.has(key)) continue;
    seen.add(key);
    headlines++;
    const t = toneOf(title);
    const s = signOf(t);
    const wi = Math.floor((r.at - since) / WEEK);
    if (series[wi]) add(series[wi], s);
    const in90 = r.at >= now - 90 * DAY;
    const prev = !in90 && r.at >= now - 180 * DAY;
    const thisWeek = r.at >= now - WEEK;
    const lastWeek = !thisWeek && r.at >= now - 2 * WEEK;
    if (in90) add(all90, s);
    if (prev) add(allPrev, s);
    if (thisWeek || lastWeek) {
      const into = thisWeek ? [wordsWeek.pos, wordsWeek.neg] : [wordsWeek.prevPos, wordsWeek.prevNeg];
      for (const w of t.pos) into[0].set(w, (into[0].get(w) || 0) + 1);
      for (const w of t.neg) into[1].set(w, (into[1].get(w) || 0) + 1);
    }
    const host = hostOf(r.url).replace(/^www\./, '');
    const item = { title, url: r.url, source: outlet || host, at: r.at, words: s > 0 ? t.pos : t.neg, strength: Math.abs(t.pos.length - t.neg.length) };
    if (thisWeek && s) (s > 0 ? extremes.good : extremes.bad).push(item);
    const site = outlet || host;
    if (in90 && site) {
      const o = outlets.get(site) || { name: site, site: host, ...bucket() };
      add(o, s);
      outlets.set(site, o);
    }
    for (const [k, strong] of extractEntities(title)) {
      const c = strong && companies.get(k);
      if (!c) continue;
      if (series[wi]) add(c.weeks[wi], s);
      if (in90) add(c.r90, s);
      if (prev) add(c.rPrev, s);
      if (thisWeek) {
        add(c.wk, s);
        if (s) (s > 0 ? c.good : c.bad).push(item);
      }
    }
  }

  // The strongest-worded first, then newest; one headline per story wording.
  const pick = (list, n) => list.sort((a, b) => b.strength - a.strength || b.at - a.at).slice(0, n).map(({ strength, ...x }) => x);
  const topWords = (cur, prev) => [...cur.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([w, n]) => ({ w, n, prev: prev.get(w) || 0 }));
  const outletList = [...outlets.values()].filter((o) => o.n >= MIN_OUTLET).map((o) => ({ name: o.name, site: o.site, n: o.n, mood: moodOf(o), pos: o.pos, neg: o.neg }));
  return {
    generatedAt: now,
    weeks,
    headlines,
    series: series.map((b) => ({ start: b.start, n: b.n, pos: b.pos, neg: b.neg, mood: moodOf(b) })),
    companies: [...companies.values()].filter((c) => c.r90.n >= 20).map((c) => ({
      key: c.key,
      label: c.label,
      n90: c.r90.n,
      mood90: moodOf(c.r90),
      moodPrev: c.rPrev.n >= 20 ? moodOf(c.rPrev) : null,
      moodWeek: c.wk.n >= 5 ? moodOf(c.wk) : null,
      nWeek: c.wk.n,
      weeks: c.weeks.map((b) => (b.n >= 5 ? moodOf(b) : null)),
      good: pick(c.good, 3),
      bad: pick(c.bad, 3),
    })).sort((a, b) => b.n90 - a.n90),
    outlets: {
      warmest: [...outletList].sort((a, b) => b.mood - a.mood).slice(0, 8),
      coolest: [...outletList].sort((a, b) => a.mood - b.mood).slice(0, 8),
      count: outletList.length,
    },
    words: { good: topWords(wordsWeek.pos, wordsWeek.prevPos), bad: topWords(wordsWeek.neg, wordsWeek.prevNeg) },
    week: { good: pick(extremes.good, 6), bad: pick(extremes.bad, 6) },
    stats: {
      mood90: moodOf(all90),
      moodPrev: moodOf(allPrev),
      moodWeek: moodOf(series.at(-1)),
      moodLastWeek: moodOf(series.at(-2)),
      share90: all90.n ? { pos: all90.pos / all90.n, neg: all90.neg / all90.n } : null,
      headlines90: all90.n,
    },
  };
}

export const moodQuery = () => cachedJob('mood', { kind: 'mood' }, TTL_MS);
