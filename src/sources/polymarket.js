import { getJSON, pool } from '../http.js';
import { POLYMARKET } from '../config.js';
import { isAiRelated, extractEntities } from '../pipeline/classify.js';

const API = 'https://gamma-api.polymarket.com';

const parse = (s, fallback) => {
  try {
    return typeof s === 'string' ? JSON.parse(s) : s ?? fallback;
  } catch {
    return fallback;
  }
};

// One event can hold many markets ("Which company has the best model?").
// We keep the event as the unit and list its leading outcomes.
function shapeEvent(ev) {
  const markets = (ev.markets || []).filter((m) => m.active && !m.closed);
  if (!markets.length) return null;
  const outcomes = markets
    .map((m) => {
      const prices = parse(m.outcomePrices, []).map(Number);
      const names = parse(m.outcomes, ['Yes', 'No']);
      const yes = prices[names.indexOf('Yes')] ?? prices[0];
      return {
        label: m.groupItemTitle || m.question,
        question: m.question,
        yes: Number.isFinite(yes) ? yes : null,
        change24h: m.oneDayPriceChange ?? null,
        volume24h: m.volume24hr || 0,
        slug: m.slug,
        endDate: m.endDate,
      };
    })
    .filter((o) => o.yes != null && o.yes > 0.004 && o.yes < 0.996)
    .sort((a, b) => b.yes - a.yes);
  if (!outcomes.length) return null;

  const text = `${ev.title} ${outcomes.map((o) => o.question).join(' ')}`;
  return {
    id: `pm:${ev.id}`,
    title: ev.title,
    url: `https://polymarket.com/event/${ev.slug}`,
    image: ev.icon || ev.image,
    volume: ev.volume || 0,
    volume24h: ev.volume24hr || 0,
    liquidity: ev.liquidity || 0,
    endDate: ev.endDate,
    binary: outcomes.length === 1,
    outcomes: outcomes.slice(0, 6),
    // Biggest absolute move across outcomes, for the "moving" sort.
    move: Math.max(...outcomes.map((o) => Math.abs(o.change24h || 0))),
    entities: [...extractEntities(text).keys()],
    text,
  };
}

export async function fetchPolymarket() {
  const urls = [
    ...POLYMARKET.tags.map((t) => `${API}/events?tag_slug=${t}&closed=false&active=true&limit=100&order=volume24hr&ascending=false`),
    ...POLYMARKET.searches.map((q) => `${API}/public-search?q=${encodeURIComponent(q)}&limit_per_type=20&events_status=active`),
  ];
  const { results, errors } = await pool(urls, 6, async (u) => {
    const json = await getJSON(u);
    return Array.isArray(json) ? json : json.events || [];
  });

  const byId = new Map();
  for (const ev of results.flat()) {
    if (!ev || ev.closed || byId.has(ev.id)) continue;
    // Search results may lack nested markets; they get filled by tag pulls or skipped.
    if (!ev.markets?.length) continue;
    const shaped = shapeEvent(ev);
    if (!shaped || shaped.volume < POLYMARKET.minVolume) continue;
    if (!isAiRelated(shaped.text) && !shaped.entities.some((e) => ['openai', 'anthropic', 'xai', 'nvidia', 'deepseek', 'agi'].includes(e))) continue;
    byId.set(ev.id, shaped);
  }
  return { markets: [...byId.values()], errors };
}
