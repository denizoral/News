// History for the public status page: one row per source run, and every five
// minutes a few process vitals (event-loop delay, memory, API latency, the
// labeler and embedding queues). statusHistory() folds them into hourly
// slots with what arrived, what the spider did and which X accounts went quiet.

import { monitorEventLoopDelay } from 'node:perf_hooks';
import { q } from './db.js';
import { X_ACCOUNTS } from './config.js';

const HOUR = 3600e3;
const DAY = 24 * HOUR;
export const VITALS_EVERY = 5 * 60e3;
export const KEEP_DAYS = 30;

export function recordRun(name, s) {
  try {
    q('INSERT INTO source_runs (at, source, ok, count, added, ms, error) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(s.lastRun || Date.now(), name, s.ok ? 1 : 0, s.count || 0, s.added || 0, s.ms || 0, s.error ? String(s.error).slice(0, 300) : null);
  } catch (err) {
    console.warn(`[status] ${err.message}`);
  }
}

// API response times since the last vitals sample.
let apiTimes = [];
export function noteRequest(ms) {
  if (apiTimes.length < 50000) apiTimes.push(ms);
}

export const quantile = (xs, p) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};

let loop = null;
let timer = null;
// `getStatus` returns store.status(): queues come from there.
export function sampleVitals(getStatus, at = Date.now()) {
  const st = getStatus();
  const mem = process.memoryUsage();
  const v = {
    loop_p99: loop ? loop.percentile(99) / 1e6 : null,
    rss_mb: mem.rss / 2 ** 20,
    heap_mb: mem.heapUsed / 2 ** 20,
    api_p95: quantile(apiTimes, 0.95),
    api_n: apiTimes.length,
    embed_backlog: st.embeddings?.backlog ?? null,
    label_pending: st.labeler?.pending ?? null,
    x_cached: st.sources?.x?.accountsCached ?? null,
  };
  apiTimes = [];
  loop?.reset();
  const ins = q('INSERT OR REPLACE INTO vitals (key, at, v) VALUES (?, ?, ?)');
  for (const [k, val] of Object.entries(v)) if (val != null && Number.isFinite(val)) ins.run(k, at, Math.round(val * 10) / 10);
  return v;
}

export function startVitals(getStatus) {
  if (timer) return;
  loop = monitorEventLoopDelay({ resolution: 20 });
  loop.enable();
  timer = setInterval(() => { try { sampleVitals(getStatus); } catch (err) { console.warn(`[status] ${err.message}`); } }, VITALS_EVERY);
  timer.unref();
}

export function pruneStatus(now = Date.now()) {
  const cut = now - KEEP_DAYS * DAY;
  return Number(q('DELETE FROM source_runs WHERE at < ?').run(cut).changes) + Number(q('DELETE FROM vitals WHERE at < ?').run(cut).changes);
}

const SPIDER_KINDS = ['indexed', 'updated', 'not-modified', 'skipped', 'duplicate', 'blocked', 'error'];

export function statusHistory({ hours = 48, now = Date.now(), live = {} } = {}) {
  const from = Math.floor((now - hours * HOUR) / HOUR) * HOUR;
  const slots = Math.ceil((now - from) / HOUR);
  const slotOf = (t) => Math.min(slots - 1, Math.floor((t - from) / HOUR));

  // Sources: hourly runs, failures, median time and items added.
  const bySource = new Map();
  for (const r of q('SELECT at, source, ok, count, added, ms, error FROM source_runs WHERE at >= ? ORDER BY at').all(from)) {
    let s = bySource.get(r.source);
    if (!s) bySource.set(r.source, (s = { name: r.source, runs: 0, fails: 0, ms: [], slots: Array.from({ length: slots }, () => ({ runs: 0, fails: 0, ms: [], added: 0 })), lastError: null, lastErrorAt: null, last: null }));
    const slot = s.slots[slotOf(r.at)];
    s.runs++; slot.runs++;
    s.ms.push(r.ms); slot.ms.push(r.ms);
    slot.added += r.added;
    if (!r.ok) { s.fails++; slot.fails++; s.lastError = r.error; s.lastErrorAt = r.at; }
    s.last = r;
  }
  for (const name of Object.keys(live)) if (!bySource.has(name)) bySource.set(name, { name, runs: 0, fails: 0, ms: [], slots: [], lastError: null, lastErrorAt: null, last: null });
  const sources = [...bySource.values()].map((s) => {
    const now_ = live[s.name] || {};
    return {
      name: s.name,
      ok: now_.ok ?? (s.last ? !!s.last.ok : null),
      paused: !!(now_.paused || now_.standby),
      lastRun: now_.lastRun || s.last?.at || null,
      count: now_.count ?? s.last?.count ?? 0,
      runs: s.runs,
      uptime: s.runs ? Math.round(((s.runs - s.fails) / s.runs) * 1000) / 10 : null,
      p50: quantile(s.ms, 0.5),
      p95: quantile(s.ms, 0.95),
      lastError: s.lastError,
      lastErrorAt: s.lastErrorAt,
      slots: s.slots.map((x) => [x.runs, x.fails, quantile(x.ms, 0.5), x.added]),
    };
  }).sort((a, b) => (a.ok === b.ok ? a.name.localeCompare(b.name) : a.ok ? 1 : -1));

  // New documents in the index per hour.
  const ingest = new Array(slots).fill(0);
  for (const r of q('SELECT first_seen / 3600000 AS h, COUNT(*) AS n FROM docs INDEXED BY docs_seen WHERE first_seen >= ? GROUP BY h').all(from)) {
    const i = slotOf(r.h * HOUR);
    if (i >= 0) ingest[i] += r.n;
  }

  // What the spider did per hour.
  const spider = Array.from({ length: slots }, () => Object.fromEntries(SPIDER_KINDS.map((k) => [k, 0])));
  for (const r of q('SELECT at / 3600000 AS h, outcome, COUNT(*) AS n FROM crawl_log WHERE at >= ? GROUP BY h, outcome').all(from)) {
    const i = slotOf(r.h * HOUR);
    if (i < 0) continue;
    const k = SPIDER_KINDS.includes(r.outcome) ? r.outcome : 'skipped';
    spider[i][k] += r.n;
  }

  const vitals = {};
  for (const r of q('SELECT key, at, v FROM vitals WHERE at >= ? ORDER BY at').all(from)) (vitals[r.key] ||= []).push([r.at, r.v]);

  // X: when each followed account last posted, and how much this week.
  const seen = new Map();
  for (const r of q(`SELECT json_extract(meta, '$.handle') AS h, MAX(published_at) AS last, SUM(published_at >= ?) AS week FROM docs
    WHERE site = 'x.com' AND type = 'post' AND published_at >= ? GROUP BY h`).all(now - 7 * DAY, now - KEEP_DAYS * DAY)) {
    if (r.h) seen.set(r.h.toLowerCase(), r);
  }
  const x = X_ACCOUNTS.map((a) => {
    const r = seen.get(a.handle.toLowerCase());
    return { handle: a.handle, group: a.group, last: r?.last || null, week: r?.week || 0 };
  }).sort((a, b) => (a.last || 0) - (b.last || 0));

  return { from, hours, slots, now, sources, ingest, spider, spiderKinds: SPIDER_KINDS, vitals, x };
}
