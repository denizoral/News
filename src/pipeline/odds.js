// Polymarket odds over time. Every Polymarket crawl records each outcome's
// price when it has moved (and at least every 30 minutes), so the site keeps
// its own history. Markets first seen today would otherwise have none, so
// their hourly history for the past week is backfilled from Polymarket's
// public price-history API: a few markets per crawl, each once.

import { q, tx } from '../db.js';
import { getJSON, pool } from '../http.js';

const HOUR = 3600e3;
const DAY = 24 * HOUR;
const KEEP_MS = 30 * DAY;
const HEARTBEAT_MS = 30 * 60e3;
const MIN_MOVE = 0.0005;
const CLOB = 'https://clob.polymarket.com/prices-history';

export const oddsStatus = { recorded: 0, backfilled: 0, backfillErrors: 0, lastPrune: 0 };

let last = null; // "market|outcome" -> { ts, yes }
const key = (m, o) => `${m}|${o}`;

function seed() {
  last = new Map();
  // SQLite returns the row holding MAX(ts) for the bare `yes` column.
  for (const r of q('SELECT market, outcome, MAX(ts) AS ts, yes FROM odds GROUP BY market, outcome').all()) {
    last.set(key(r.market, r.outcome), { ts: r.ts, yes: r.yes });
  }
}

// Records the current prices. Returns the number of rows written.
export function recordOdds(markets, now = Date.now()) {
  if (!last) seed();
  const ins = q('INSERT OR REPLACE INTO odds (market, outcome, ts, yes) VALUES (?, ?, ?, ?)');
  let n = 0;
  tx(() => {
    for (const m of markets) {
      for (const o of m.outcomes) {
        if (o.yes == null) continue;
        const k = key(m.id, o.label);
        const prev = last.get(k);
        if (prev && Math.abs(prev.yes - o.yes) < MIN_MOVE && now - prev.ts < HEARTBEAT_MS) continue;
        ins.run(m.id, o.label, now, o.yes);
        last.set(k, { ts: now, yes: o.yes });
        n++;
      }
    }
  });
  oddsStatus.recorded += n;
  if (now - oddsStatus.lastPrune > 6 * HOUR) {
    q('DELETE FROM odds WHERE ts < ?').run(now - KEEP_MS);
    oddsStatus.lastPrune = now;
  }
  return n;
}

export function series(market, outcome, since) {
  return q('SELECT ts, yes FROM odds WHERE market = ? AND outcome = ? AND ts >= ? ORDER BY ts').all(market, outcome, since).map((r) => [r.ts, r.yes]);
}

// Resamples [ts, yes] points onto n evenly spaced slots ending at `now`,
// carrying the last known price forward. Slots before the first point are
// dropped. Null when there's too little history to draw a line.
export function resample(points, since, now, n) {
  if (points.length < 2) return null;
  const step = (now - since) / (n - 1);
  const out = [];
  let j = 0;
  let cur = null;
  for (let i = 0; i < n; i++) {
    const t = since + i * step;
    while (j < points.length && points[j][0] <= t) cur = points[j++][1];
    if (cur != null) out.push(Math.round(cur * 1000) / 1000);
  }
  return out.length >= 2 ? out : null;
}

// Each market gets a 7-day sparkline of its leading outcome.
export function attachSparks(markets, now = Date.now()) {
  const since = now - 7 * DAY;
  for (const m of markets) {
    const o = m.outcomes[0];
    m.spark = o ? resample(series(m.id, o.label, since), since, now, 42) : null;
  }
}

// Full history for one market's outcomes (the expanded chart): hourly-ish
// points, at most `max` per outcome.
export function marketHistory(market, { days = 7, now = Date.now(), max = 170 } = {}) {
  const since = now - days * DAY;
  return market.outcomes.slice(0, 4).map((o) => {
    const pts = series(market.id, o.label, since);
    const keep = pts.length > max ? pts.filter((_, i) => i % Math.ceil(pts.length / max) === 0 || i === pts.length - 1) : pts;
    return { label: o.label, yes: o.yes, points: keep.map(([t, y]) => [t, Math.round(y * 1000) / 1000]) };
  });
}

const done = new Set(); // "market|outcome" backfilled this process
const hasWeek = (m, o, now) => (q('SELECT MIN(ts) AS t FROM odds WHERE market = ? AND outcome = ?').get(m, o)?.t ?? Infinity) < now - 5 * DAY;

async function backfillOne(m, o, now) {
  const k = key(m.id, o.label);
  done.add(k);
  if (!o.token || hasWeek(m.id, o.label, now)) return 0;
  const { history = [] } = await getJSON(`${CLOB}?market=${o.token}&interval=1w&fidelity=60`, { retries: 0 });
  const ins = q('INSERT OR IGNORE INTO odds (market, outcome, ts, yes) VALUES (?, ?, ?, ?)');
  tx(() => {
    for (const { t, p } of history) if (Number.isFinite(p) && t * 1000 < now) ins.run(m.id, o.label, t * 1000, p);
  });
  oddsStatus.backfilled++;
  return history.length;
}

// Background: the leading outcome of up to `perRun` markets per crawl, busiest first.
export async function backfillOdds(markets, { perRun = 8, now = Date.now() } = {}) {
  const todo = [...markets]
    .sort((a, b) => b.volume24h - a.volume24h)
    .map((m) => [m, m.outcomes[0]])
    .filter(([m, o]) => o && !done.has(key(m.id, o.label)))
    .slice(0, perRun);
  const { errors } = await pool(todo, 2, ([m, o]) => backfillOne(m, o, now));
  oddsStatus.backfillErrors += errors.length;
  if (errors.length) oddsStatus.lastError = errors[0].error;
}

// On demand, for the expanded chart: the market's other outcomes too.
export async function backfillMarket(market, now = Date.now()) {
  const todo = market.outcomes.slice(0, 4).filter((o) => !done.has(key(market.id, o.label)));
  await pool(todo, 2, (o) => backfillOne(market, o, now));
}

// Test helper.
export function resetOdds() {
  last = null;
  done.clear();
}
