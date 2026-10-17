import { SCHEDULE } from './config.js';
import { fetchFeeds, fetchGoogleNews, fetchScraped } from './sources/rss.js';
import { fetchHackerNews, fetchReddit, fetchBluesky } from './sources/community.js';
import { fetchX, xStatus } from './sources/x.js';
import { fetchPolymarket } from './sources/polymarket.js';
import { fetchHuggingFace, fetchGitHub, fetchProductHunt, fetchShowHN, fetchOpenRouter } from './sources/builds.js';

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
};

export async function runSource(store, name) {
  const started = Date.now();
  try {
    const out = await SOURCES[name]();
    if (name === 'polymarket') store.setMarkets(out.markets);
    const added = out.items ? store.ingest(name, out.items) : 0;
    const count = out.markets?.length ?? out.items?.length ?? 0;
    const ok = count > 0 || !out.errors?.length;
    store.sourceStatus[name] = {
      ok,
      count,
      added,
      errors: out.errors?.length || 0,
      error: ok ? null : out.errors?.[0]?.error,
      lastRun: Date.now(),
      ms: Date.now() - started,
      ...(name === 'x' ? { strategy: xStatus.strategy } : {}),
    };
    if (process.env.DEBUG && out.errors?.length) console.warn(`[${name}]`, out.errors.slice(0, 3));
  } catch (err) {
    store.sourceStatus[name] = { ok: false, count: 0, error: err.message, lastRun: Date.now(), ms: Date.now() - started };
  }
  const s = store.sourceStatus[name];
  console.log(`[crawl] ${name.padEnd(11)} ${s.ok ? 'ok ' : 'ERR'} ${String(s.count).padStart(4)} items  +${s.added || 0} new  ${s.ms}ms${s.error ? '  ' + s.error.slice(0, 100) : ''}`);
}

export async function crawlAll(store) {
  // Markets first so the first rebuild can already correlate.
  await runSource(store, 'polymarket');
  await Promise.all(Object.keys(SOURCES).filter((n) => n !== 'polymarket').map((n) => runSource(store, n)));
  store.prune();
  store.rebuild();
}

export function startScheduler(store) {
  for (const [name, seconds] of Object.entries(SCHEDULE)) {
    if (!SOURCES[name]) continue;
    const jitter = Math.random() * 10e3;
    setInterval(async () => {
      await runSource(store, name);
      store.scheduleRebuild();
    }, seconds * 1000 + jitter).unref();
  }
  setInterval(() => {
    store.prune();
    try {
      store.save();
    } catch (e) {
      console.warn('[store] save failed', e.message);
    }
  }, 60e3).unref();
}
