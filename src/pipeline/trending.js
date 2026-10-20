// Trending now: which companies, people and themes are getting more coverage
// than usual. For each entity we count distinct items mentioning it in the
// recent window and compare with its rate over the baseline window before it,
// so "OpenAI" (always busy) only trends on an unusually busy day while a
// quieter name trends as soon as several outlets pick it up.

import { extractEntities } from './classify.js';

export const ENTITY_LABELS = {
  openai: 'OpenAI', anthropic: 'Anthropic', google: 'Google', meta: 'Meta', xai: 'xAI', musk: 'Elon Musk',
  microsoft: 'Microsoft', apple: 'Apple', amazon: 'Amazon', nvidia: 'Nvidia', amd: 'AMD', tsmc: 'TSMC',
  deepseek: 'DeepSeek', qwen: 'Qwen', mistral: 'Mistral', perplexity: 'Perplexity', huggingface: 'Hugging Face',
  cursor: 'Cursor', ssi: 'SSI', tesla: 'Tesla', figure: 'Humanoids', china: 'China', agi: 'AGI', ipo: 'IPOs',
  regulation: 'Regulation', funding: 'Funding', benchmark: 'Benchmarks',
};

const HOUR = 3600e3;

// Entities are extracted once per item text and remembered, since the same
// items are seen on every rebuild.
const entityCache = new Map();
function strongEntities(it) {
  const text = `${it.title} ${it.summary || ''}`;
  let ents = entityCache.get(text);
  if (!ents) {
    ents = [...extractEntities(text)].filter(([, strong]) => strong).map(([k]) => k);
    if (entityCache.size > 20000) entityCache.clear();
    entityCache.set(text, ents);
  }
  return ents;
}

/**
 * @param {Iterable<object>} items  raw news items (title, summary, publishedAt, source)
 * @returns {{ hours: number, generatedAt: number, topics: object[] }}
 */
export function computeTrending(items, { now = Date.now(), hours = 6, baselineHours = 24, limit = 10, buckets = 12 } = {}) {
  const recentStart = now - hours * HOUR;
  const baseStart = recentStart - baselineHours * HOUR;
  const sparkStart = now - 24 * HOUR;
  const bucketMs = (24 * HOUR) / buckets;
  const stats = new Map();
  const get = (k) => {
    let s = stats.get(k);
    if (!s) stats.set(k, (s = { recent: 0, base: 0, sources: new Set(), spark: new Array(buckets).fill(0) }));
    return s;
  };
  for (const it of items) {
    const t = it.publishedAt;
    if (!t || t < Math.min(baseStart, sparkStart) || t > now + 5 * 60e3 || (it.section || 'news') !== 'news') continue;
    for (const k of strongEntities(it)) {
      const s = get(k);
      if (t >= recentStart) {
        s.recent++;
        s.sources.add(it.source);
      } else if (t >= baseStart) s.base++;
      if (t >= sparkStart) s.spark[Math.min(buckets - 1, Math.floor((t - sparkStart) / bucketMs))]++;
    }
  }
  const topics = [];
  for (const [key, s] of stats) {
    // Several outlets, not one prolific feed.
    if (s.recent < 3 || s.sources.size < 2) continue;
    const expected = (s.base * hours) / baselineHours;
    const lift = (s.recent + 1) / (expected + 1);
    const score = Math.log2(1 + s.recent) * lift;
    topics.push({ key, label: ENTITY_LABELS[key] || key, count: s.recent, sources: s.sources.size, lift: +lift.toFixed(2), score: +score.toFixed(3), spark: s.spark });
  }
  topics.sort((a, b) => b.score - a.score || b.count - a.count);
  return { hours, generatedAt: now, topics: topics.slice(0, limit) };
}
