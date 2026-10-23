import { settings } from './settings.js';
import { fetchFeeds, fetchGoogleNews, fetchScraped } from './sources/rss.js';
import { fetchHackerNews, fetchReddit, fetchBluesky } from './sources/community.js';
import { fetchX, xStatus, embedStatus } from './sources/x.js';
import { fetchPolymarket } from './sources/polymarket.js';
import { fetchTech, techStatus } from './sources/tech.js';
import { fetchReleases } from './sources/releases.js';
import { fetchUptime } from './sources/uptime.js';
import { fetchHuggingFace, fetchGitHub, fetchProductHunt, fetchShowHN, fetchOpenRouter } from './sources/builds.js';
import { ingestAggregatorItems, ingestMarkets } from './index/documents.js';
import { recordRun } from './status.js';
import { recordOdds, attachSparks, backfillOdds } from './pipeline/odds.js';

// The spider (optional) receives every URL the aggregator finds.
let spider = null;
export function attachSpider(s) {
  spider = s;
}

export const SOURCES = {
  x: fetchX,
  polymarket: fetchPolymarket,
  hackernews: fetchHackerNews,
  reddit: fetchReddit,
  bluesky: fetchBluesky,
  googlenews: fetchGoogleNews,
  rss: fetchFeeds,
  scraped: fetchScraped,
  openrouter: fetchOpenRouter,
  huggingface: fetchHuggingFace,
  github: fetchGitHub,
  producthunt: fetchProductHunt,
  showhn: fetchShowHN,
  tech: fetchTech,
  releases: fetchReleases,
  uptime: fetchUptime,
};

// Bluesky is a backup for X: it only runs while X has been failing, and its
// posts are dropped again once X comes back.
const X_GRACE_MS = 15 * 60e3;
function xHealthy(store) {
  const x = store.sourceStatus.x;
  if (x?.ok && x.count > 0) store.xLastGood = x.lastRun;
  return Date.now() - (store.xLastGood || 0) < X_GRACE_MS;
}

export async function runSource(store, name) {
  const started = Date.now();
  if (name === 'bluesky' && xHealthy(store)) {
    let dropped = 0;
    for (const [id, it] of store.items) if (it.platform === 'bluesky') store.items.delete(id), dropped++;
    store.sourceStatus.bluesky = { ok: true, count: 0, added: 0, errors: 0, error: null, standby: true, lastRun: Date.now(), ms: 0 };
    if (dropped) console.log(`[crawl] bluesky     standby (X is up), dropped ${dropped} posts`);
    return;
  }
  try {
    const out = await SOURCES[name]();
    // A Polymarket outage (every request failing) must not blank the
    // markets: keep the last good list until a crawl returns some.
    if (name === 'polymarket' && !out.markets.length && out.errors?.length) {
      out.markets = store.markets || [];
      out.stale = true;
    } else if (name === 'polymarket') {
      try {
        recordOdds(out.markets);
        attachSparks(out.markets);
        backfillOdds(out.markets).then(() => attachSparks(out.markets)).catch((err) => console.warn(`[odds] backfill: ${err.message}`));
      } catch (err) {
        console.warn(`[odds] ${err.message}`);
      }
      store.setMarkets(out.markets);
    }
    if (out.releases) store.setReleases(out.releases);
    const added = out.items ? store.ingest(name, out.items) : 0;
    // Everything also goes into the permanent search index.
    try {
      if (out.items?.length) ingestAggregatorItems(out.items);
      if (out.markets?.length && !out.stale) ingestMarkets(out.markets);
      if (spider && out.items?.length) spider.enqueueFromItems(out.items.filter((i) => (i.section || 'news') === 'news'));
    } catch (err) {
      console.warn(`[index] ${name}: ${err.message}`);
    }
    const count = out.count ?? out.markets?.length ?? out.releases?.length ?? out.items?.length ?? 0;
    const ok = !out.stale && (count > 0 || !out.errors?.length);
    store.sourceStatus[name] = {
      ok,
      count,
      added: out.added ?? added,
      errors: out.errors?.length || 0,
      error: ok ? null : out.errors?.[0]?.error,
      ...(out.stale ? { stale: true } : {}),
      lastRun: Date.now(),
      ms: Date.now() - started,
      ...(name === 'tech' ? { classifier: { ...techStatus } } : {}),
      ...(name === 'x' ? { strategy: xStatus.strategy, ...(xStatus.strategy !== 'api' ? embedStatus() : {}) } : {}),
    };
    if (process.env.DEBUG && out.errors?.length) console.warn(`[${name}]`, out.errors.slice(0, 3));
  } catch (err) {
    store.sourceStatus[name] = { ok: false, count: 0, error: err.message, lastRun: Date.now(), ms: Date.now() - started };
  }
  const s = store.sourceStatus[name];
  recordRun(name, s);
  console.log(`[crawl] ${name.padEnd(11)} ${s.ok ? 'ok ' : 'ERR'} ${String(s.count).padStart(4)} items  +${s.added || 0} new  ${s.ms}ms${s.error ? '  ' + s.error.slice(0, 100) : ''}`);
}

export async function crawlAll(store) {
  // Markets first so the first rebuild can already correlate.
  const on = (n) => settings.get(`sources.${n}.enabled`);
  if (on('polymarket')) await runSource(store, 'polymarket');
  await Promise.all(Object.keys(SOURCES).filter((n) => n !== 'polymarket' && on(n)).map((n) => runSource(store, n)));
  store.prune();
  store.rebuild();
}

// Each source runs on its own timer. Interval and on/off come from settings,
// read before every run, so dashboard changes apply without a restart.
const timers = new Map();

export function startScheduler(store) {
  for (const name of Object.keys(SOURCES)) scheduleNext(store, name, Math.random() * 10e3);
  setInterval(() => {
    store.prune();
    try {
      store.save();
    } catch (e) {
      console.warn('[store] save failed', e.message);
    }
  }, 60e3).unref();
  // Settings changes take effect on the next run; shorten a pending wait if the new interval is shorter.
  settings.on('change', (changes) => {
    for (const c of changes) {
      const m = c.key.match(/^sources\.(\w+)\.(enabled|intervalSec)$/);
      if (m && SOURCES[m[1]]) scheduleNext(store, m[1], 1000);
    }
  });
}

function scheduleNext(store, name, delay) {
  clearTimeout(timers.get(name));
  const t = setTimeout(async () => {
    if (settings.get(`sources.${name}.enabled`)) {
      await runSource(store, name);
      store.scheduleRebuild();
    } else {
      store.sourceStatus[name] = { ...(store.sourceStatus[name] || {}), ok: true, paused: true };
    }
    scheduleNext(store, name, settings.get(`sources.${name}.intervalSec`) * 1000 + Math.random() * 5e3);
  }, delay);
  t.unref();
  timers.set(name, t);
}

// "Run now" from the dashboard.
export async function runNow(store, name) {
  if (!SOURCES[name]) return false;
  await runSource(store, name);
  store.scheduleRebuild();
  return true;
}
