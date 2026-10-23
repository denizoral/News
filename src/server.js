// HTTP server: public site and API, admin dashboard, background jobs.
//
// Hardening for public traffic: security headers and CSP on every response,
// GET/HEAD only outside the admin API, per-IP rate limits on search, a short
// cache for repeated searches, caps on live connections, request timeouts,
// and no stack traces in responses. Static files are served from memory with
// ETags, Brotli and gzip.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Store, publicSnapshot } from './store.js';
import { marketHistory, backfillMarket, movers } from './pipeline/odds.js';
import { topicHistory, topicKeys, warmTopics } from './index/topics.js';
import { weeklyDigest, digestRss } from './index/digest.js';
import { releasesCoverage, coverageCounts } from './index/releases.js';
import { modelsTable } from './index/models.js';
import { trendsQuery, trendMomentQuery, parseTerms } from './index/trends.js';
import { ask } from './index/ask.js';
import { dealsQuery, companyDealsQuery, RANGES as DEAL_RANGES } from './index/deals.js';
import { dayQuery, calendarQuery, withMarkets, withReleases, isDay, dayOf } from './index/day.js';
import { outletsQuery, outletQuery, siteKey } from './index/outlets.js';
import { personKey, personQuery, quotesQuery } from './index/quotes.js';
import { storylineById, storylineList, storylineOf, storylinesData } from './index/storylines.js';
import { forecastsQuery, THEMES as FORECAST_THEMES } from './index/forecasts.js';
import { catchupQuery, windowOf, withLive } from './index/catchup.js';
import { MAP_WINDOWS, newsMapQuery } from './index/newsmap.js';
import { VERSUS_WINDOWS, versusQuery } from './index/versus.js';
import { rumorsQuery } from './index/rumors.js';
import { newNamesQuery } from './index/newnames.js';
import { benchmarksQuery } from './index/benchmarks.js';
import { uptimeQuery } from './index/uptime.js';
import { courtQuery } from './index/court.js';
import { buildoutQuery } from './index/buildout.js';
import { rulesQuery } from './index/rules.js';
import { jobsQuery } from './index/jobs.js';
import { incidentsQuery } from './index/incidents.js';
import { robotsQuery } from './index/robots.js';
import { openQuery } from './index/openweights.js';
import { termsQuery } from './index/terms.js';
import { chipsQuery } from './index/chips.js';
import { watchFor, normQuery, MAX_WATCHES } from './index/watch.js';
import { editionIds, isEditionId } from './index/quiz.js';
import { quizEdition, publicQuiz, recordAnswer, recordScore, quizStats } from './index/quizbook.js';
import { talentQuery } from './index/talent.js';
import { statusHistory, startVitals, noteRequest } from './status.js';
import { storyPage } from './index/storypage.js';
import { emergingThemes } from './index/emerging.js';
import { marketMoves, explainedMoves, readyMoves } from './index/moves.js';
import { entityGraph, entityDetail, WINDOWS } from './index/graph.js';
import { semanticSearch, relatedTo, keepVectorsWarm } from './index/semantic.js';
import { startEmbedder } from './index/vectors.js';
import { crawlAll, startScheduler, attachSpider, runNow, SOURCES } from './crawler.js';
import { openDb, checkpoint, closeDb, getDb } from './db.js';
import { settings } from './settings.js';
import { Spider } from './spider/engine.js';
import { MEDIA_DIR } from './spider/media.js';
import { universal, searchImages, suggest, getDoc } from './index/search.js';
import { startRetention } from './index/retention.js';
import { createAdminRouter } from './admin/routes.js';
import { pruneSessions } from './admin/auth.js';
import { accountRoute, isAccountPath } from './accounts/routes.js';
import { pruneUserSessions } from './accounts/users.js';
import { pushBreakingMobile, pushFollows, pushChangelog, pushSourceHealth, prunePushes, deviceCount } from './push/mobile.js';
import { contentEvents } from './admin/content.js';
import { RateLimiter } from './security/ratelimit.js';
import { clientIp, securityHeaders, readJson } from './security/httpkit.js';
import { startFileLog } from './logfile.js';
import { xFeed } from './xfeed.js';
import { startLabeler } from './pipeline/labeler.js';
import { breakingHistory } from './pipeline/breaking.js';
import { subscribe, unsubscribe, pushBreaking, alertStatus, subscriberCount } from './pipeline/alerts.js';
import { vapidKeys } from './pipeline/webpush.js';
import { buildIndex, jumpSearch, savedStatus } from './index/jump.js';
import { accountsDirectory, accountProfile, accountCompare, recentPosts } from './index/accounts.js';
import { forYou, parseFollows, followSuggestions } from './index/foryou.js';
import { topicFeed, breakingFeed, accountFeed, searchFeed, followsFeed, etagOf, renderRss, renderJsonFeed } from './feeds.js';
import { apiIndex } from './apicatalog.js';

const PROD = process.env.NODE_ENV === 'production';
const PUBLIC = path.resolve('public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8' };
const MAX_QUERY = 256;

// Brotli where the client takes it (every current browser over HTTPS and
// localhost); it is 15-25% smaller than gzip on our JSON and scripts.
export function pickEncoding(req) {
  const ae = req.headers['accept-encoding'] || '';
  return /\bbr\b/.test(ae) ? 'br' : /\bgzip\b/.test(ae) ? 'gzip' : null;
}

// A response body plus its compressed forms, each made on first request and
// kept, so a hot body is compressed once rather than on every hit.
export class Packed {
  constructor(data, brQuality = 11) {
    this.data = Buffer.isBuffer(data) ? data : Buffer.from(data);
    this.brQuality = brQuality;
  }
  get(enc) {
    if (enc === 'br') {
      this.br ??= zlib.brotliCompressSync(this.data, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: this.brQuality, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: this.data.length } });
      return this.br;
    }
    if (enc === 'gzip') return (this.gz ??= zlib.gzipSync(this.data));
    return this.data;
  }
}

// Small TTL cache for public API responses (search, suggest).
class TtlCache {
  constructor(max, ttlMs) {
    this.max = max;
    this.ttl = ttlMs;
    this.map = new Map();
  }
  get(k) {
    const e = this.map.get(k);
    if (!e) return null;
    if (Date.now() > e.exp) {
      this.map.delete(k);
      return null;
    }
    return e.v;
  }
  set(k, v) {
    if (this.map.size >= this.max) this.map.delete(this.map.keys().next().value);
    this.map.set(k, { v, exp: Date.now() + this.ttl });
  }
  clear() {
    this.map.clear();
  }
}

export function createApp({ store, spider }) {
  const admin = createAdminRouter({ store, spider, runNow: (name) => runNow(store, name), sourceNames: Object.keys(SOURCES) });
  const perMin = () => settings.get('limits.searchPerMinute');
  const searchLimiter = new RateLimiter({ capacity: perMin(), refillPerSec: perMin() / 60, maxKeys: 200000 });
  const cache = new TtlCache(5000, 30e3);
  const streams = new Map(); // ip -> count
  let streamTotal = 0;
  const clients = new Set();

  settings.on('change', (changes) => {
    if (changes.some((c) => c.key === 'limits.searchPerMinute')) searchLimiter.configure({ capacity: perMin(), refillPerSec: perMin() / 60 });
    cache.clear();
  });
  contentEvents.on('change', () => cache.clear());

  // Snapshot is pre-serialized and pre-compressed once per version.
  let snap = { version: -1 };
  const snapshot = () => {
    if (snap.version !== store.snapshot.version) {
      const json = JSON.stringify(publicSnapshot(store.snapshot));
      // Quality 6: the snapshot changes every few minutes, so compress fast.
      snap = { version: store.snapshot.version, body: new Packed(json, 6), etag: `"v${store.snapshot.version}-${crypto.createHash('sha1').update(json).digest('hex').slice(0, 10)}"` };
    }
    return snap;
  };
  store.on('update', (s) => {
    const msg = `event: update\ndata: ${JSON.stringify({ version: s.version, generatedAt: s.generatedAt })}\n\n`;
    for (const res of clients) res.write(msg);
  });

  // Static files, cached in memory (re-read in development).
  const statics = new Map();
  function staticFile(rel) {
    const hit = PROD && statics.get(rel);
    if (hit) return hit;
    const file = path.join(PUBLIC, rel);
    if (file !== PUBLIC && !file.startsWith(PUBLIC + path.sep)) return null;
    let data;
    try {
      if (!fs.statSync(file).isFile()) return null;
      data = fs.readFileSync(file);
    } catch {
      return null;
    }
    const type = TYPES[path.extname(file)] || 'application/octet-stream';
    const entry = { body: new Packed(data, PROD ? 11 : 4), type, compressible: /text|javascript|json|svg/.test(type), etag: `"${crypto.createHash('sha1').update(data).digest('hex').slice(0, 16)}"` };
    if (PROD) statics.set(rel, entry);
    return entry;
  }

  function send(req, res, status, body, type, extra = {}) {
    res.writeHead(status, { 'content-type': type, ...extra });
    res.end(req.method === 'HEAD' ? undefined : body);
  }

  // `obj` may be a Packed body (cached responses) or anything JSON-able.
  function json(req, res, status, obj, extra = {}) {
    const body = obj instanceof Packed ? obj : new Packed(typeof obj === 'string' ? obj : JSON.stringify(obj), 4);
    const enc = body.data.length > 1024 ? pickEncoding(req) : null;
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache', vary: 'Accept-Encoding', ...(enc ? { 'content-encoding': enc } : {}), ...extra });
    res.end(req.method === 'HEAD' ? undefined : body.get(enc));
  }

  function limited(req, res) {
    const r = searchLimiter.take(clientIp(req));
    if (r.ok) return false;
    json(req, res, 429, { error: 'Too many searches from your connection. Try again shortly.' }, { 'retry-after': String(r.retryAfter) });
    return true;
  }

  // Search-type endpoints share limits, input caps and the cache.
  function cachedApi(req, res, url, compute) {
    if (limited(req, res)) return;
    const qv = url.searchParams.get('q') || '';
    if (qv.length > MAX_QUERY) return json(req, res, 400, { error: `Searches can be at most ${MAX_QUERY} characters.` });
    const page = Number(url.searchParams.get('page') || 1);
    if (!Number.isInteger(page) || page < 1 || page > 50) return json(req, res, 400, { error: 'Page must be between 1 and 50.' });
    const key = url.pathname + url.search;
    let body = cache.get(key);
    if (!body) {
      body = new Packed(JSON.stringify(compute(Object.fromEntries(url.searchParams))), 5);
      cache.set(key, body);
    }
    json(req, res, 200, body, { 'cache-control': 'public, max-age=15' });
  }

  // Breaking alerts: a browser's push subscription in or out. Same-origin
  // JSON only, small bodies, and the search rate limit.
  function pushRoute(req, res, p) {
    if (limited(req, res)) return;
    const site = req.headers['sec-fetch-site'];
    if ((site && site !== 'same-origin') || !/^application\/json\b/.test(req.headers['content-type'] || '')) return json(req, res, 403, { error: 'Not allowed.' });
    readJson(req, { limit: 4096 })
      .then((body) => {
        if (p === '/api/push/unsubscribe') return json(req, res, 200, { ok: unsubscribe(body?.endpoint) });
        if (!subscribe(body)) return json(req, res, 400, { error: 'That is not a push subscription from a browser push service.' });
        json(req, res, 200, { ok: true });
      })
      .catch((err) => json(req, res, err.status || 400, { error: err.status === 413 ? 'Too large.' : 'Send the subscription as JSON.' }));
  }

  // The weekly quiz: an answer or a final score, counted anonymously. Same
  // checks as push subscriptions: same-origin JSON, small, rate limited.
  function quizRoute(req, res, p) {
    if (limited(req, res)) return;
    const site = req.headers['sec-fetch-site'];
    if ((site && site !== 'same-origin') || !/^application\/json\b/.test(req.headers['content-type'] || '')) return json(req, res, 403, { error: 'Not allowed.' });
    readJson(req, { limit: 1024 })
      .then(async (body) => {
        if (!isEditionId(body?.edition)) return json(req, res, 404, { error: 'No quiz for that week.' });
        const e = await quizEdition(store, body.edition);
        const out = p === '/api/quiz/answer' ? recordAnswer(e, body.n, body.choice) : recordScore(e, body.score);
        if (!out) return json(req, res, 400, { error: 'That is not an answer to this quiz.' });
        json(req, res, 200, out);
      })
      .catch((err) => json(req, res, err.status || 400, { error: err.status === 413 ? 'Too large.' : 'Send the answer as JSON.' }));
  }

  // The palette's index, rebuilt when the feed, the graph or the themes change.
  // Slow inputs are waited on briefly; the index fills in on a later query.
  let jump = { key: null, index: [] };
  // Feeds: built at most once a minute per URL, then served by ETag.
  const feedCache = new Map(); // path + query -> { at, feed }
  const healthCache = new Map(); // hours -> { at, data }
  const originOf = (req) => `${req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http'}://${/^[\w.:[\]-]+$/.test(req.headers.host || '') ? req.headers.host : 'localhost'}`;
  async function buildFeed(url, [, kind, topic, handle], origin) {
    if (topic) return topicKeys().includes(topic) ? topicFeed(store, topic, origin) : { error: [404, 'No topic with that name.'] };
    if (handle) {
      const posts = recentPosts(getDb(), handle);
      return posts.length ? accountFeed(posts, posts[0].handle, origin) : { error: [404, 'No recent posts from that account.'] };
    }
    if (kind === 'breaking') return breakingFeed(store, breakingHistory({ days: 7 }), origin);
    if (kind === 'search') {
      const q = (url.searchParams.get('q') || '').trim();
      if (!q || q.length > MAX_QUERY) return { error: [400, `Add a search with ?q= (at most ${MAX_QUERY} characters).`] };
      return searchFeed(universal(q, { sort: 'date', perPage: 40 }), q, origin);
    }
    const f = parseFollows(url.searchParams);
    if (!f.topics.length && !f.names.length && !f.accounts.length && !f.outlets.length) return { error: [400, 'Add follows with t=, n=, a= or o=.'] };
    return followsFeed(await forYou(store, f, { graph: await soon(entityGraph(30)) }), f, origin);
  }
  async function serveFeed(req, res, url, m) {
    if (m[1] === 'search' || m[1] === 'foryou') {
      if (limited(req, res)) return;
      if (url.search.length > 6000) return json(req, res, 414, { error: 'That feed address is too long.' });
    }
    const key = url.pathname + url.search;
    let hit = feedCache.get(key);
    if (!hit || Date.now() - hit.at > 60e3) {
      const feed = await buildFeed(url, m, originOf(req));
      if (feed.error) return json(req, res, feed.error[0], { error: feed.error[1] });
      if (feedCache.size > 500) feedCache.delete(feedCache.keys().next().value);
      hit = { at: Date.now(), feed, etag: etagOf(feed) };
      feedCache.set(key, hit);
    }
    const asJson = m[4] === 'json';
    const headers = { etag: `${hit.etag.slice(0, -1)}${asJson ? 'j' : 'x'}"`, 'cache-control': 'public, max-age=300', 'access-control-allow-origin': '*' };
    if (req.headers['if-none-match'] === headers.etag) return res.writeHead(304, headers).end();
    const self = `${originOf(req)}${key}`;
    if (asJson) return json(req, res, 200, renderJsonFeed(hit.feed, self), { ...headers, 'content-type': 'application/feed+json; charset=utf-8' });
    const body = new Packed(renderRss(hit.feed, self), 4);
    const enc = pickEncoding(req);
    res.writeHead(200, { 'content-type': 'application/rss+xml; charset=utf-8', vary: 'Accept-Encoding', ...(enc ? { 'content-encoding': enc } : {}), ...headers });
    res.end(req.method === 'HEAD' ? undefined : body.get(enc));
  }

  const soon = (p, ms = 250) => Promise.race([p.catch(() => null), new Promise((r) => setTimeout(r, ms, null).unref())]);
  async function jumpIndex() {
    const [graph, em, ac] = await Promise.all([soon(entityGraph(30)), soon(emergingThemes(store)), soon(accountsDirectory())]);
    const key = `${store.snapshot.version}|${graph?.generatedAt || 0}|${em?.generatedAt || 0}|${ac?.generatedAt || 0}`;
    if (jump.key !== key) {
      const sn = store.snapshot;
      jump = { key, index: buildIndex({ stories: sn.stories, releases: sn.releases, markets: store.markets, posts: sn.social, accounts: ac?.accounts || [], graph, themes: em?.themes || [], breaking: sn.breaking }) };
    }
    return jump.index;
  }

  function handle(req, res) {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
      decodeURIComponent(url.pathname); // reject malformed escapes up front
    } catch {
      res.writeHead(400, { 'content-type': 'text/plain' });
      return res.end('Bad request');
    }

    if (admin(req, res, url)) return;

    securityHeaders(res);
    if (req.method === 'POST' && (url.pathname === '/api/push/subscribe' || url.pathname === '/api/push/unsubscribe')) return pushRoute(req, res, url.pathname);
    // Reader accounts and app devices (the Android app).
    if (isAccountPath(url.pathname)) return accountRoute(req, res, url);
    if (req.method === 'POST' && (url.pathname === '/api/quiz/answer' || url.pathname === '/api/quiz/score')) return quizRoute(req, res, url.pathname);
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD', 'content-type': 'text/plain' });
      return res.end('Method not allowed');
    }

    const p = url.pathname;
    if (p === '/healthz') return json(req, res, 200, { ok: true, version: store.snapshot.version });
    // The Android apps, built from android/ (and /root/ProxmoxManager) into data/apps/ (not in git).
    if (p === '/apps/frontier-wire.apk' || p === '/apps/wire-admin.apk' || p === '/apps/clusterdeck.apk') {
      const file = path.resolve(process.env.DATA_DIR || 'data', 'apps', p.slice(6));
      return fs.stat(file, (err, st) => {
        if (err) return json(req, res, 404, { error: 'That app hasn’t been built yet.' });
        res.writeHead(200, { 'content-type': 'application/vnd.android.package-archive', 'content-length': st.size, 'content-disposition': `attachment; filename="${p.slice(6)}"`, 'cache-control': 'no-cache' });
        if (req.method === 'HEAD') return res.end();
        fs.createReadStream(file).pipe(res);
      });
    }
    if (p === '/api/snapshot') {
      const s = snapshot();
      if (req.headers['if-none-match'] === s.etag) return res.writeHead(304, { etag: s.etag }).end();
      const enc = pickEncoding(req);
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', etag: s.etag, 'cache-control': 'public, max-age=5', vary: 'Accept-Encoding', ...(enc ? { 'content-encoding': enc } : {}) });
      return res.end(req.method === 'HEAD' ? undefined : s.body.get(enc));
    }
    if (p === '/api/search' && url.searchParams.get('mode') === 'meaning') {
      if (limited(req, res)) return;
      const o = Object.fromEntries(url.searchParams);
      if ((o.q || '').length > MAX_QUERY) return json(req, res, 400, { error: `Searches can be at most ${MAX_QUERY} characters.` });
      return semanticSearch(o.q, o)
        .then((data) => json(req, res, 200, data, { 'cache-control': 'public, max-age=60' }))
        .catch((err) => json(req, res, 503, { error: `Search by meaning is unavailable: ${err.message}` }));
    }
    if (p === '/api/related') {
      if (limited(req, res)) return;
      const id = url.searchParams.get('id');
      const story = [...(store.snapshot.stories || []), ...(store.snapshot.tech || [])].find((s) => s.id === id);
      if (!story) return json(req, res, 404, { error: 'No story with that id.' });
      return relatedTo(story)
        .then((data) => json(req, res, 200, data, { 'cache-control': 'public, max-age=300' }))
        .catch((err) => json(req, res, 503, { error: `Related coverage is unavailable: ${err.message}` }));
    }
    if (p === '/api/search') return cachedApi(req, res, url, (o) => (o.type === 'images' ? searchImages(o.q || '', o) : universal(o.q || '', o)));
    if (p === '/api/x') return cachedApi(req, res, url, (o) => xFeed(store, o));
    if (p === '/api/suggest') return cachedApi(req, res, url, (o) => suggest(o.q || ''));
    if (p === '/api/doc') {
      if (limited(req, res)) return;
      const doc = getDoc(url.searchParams.get('id'));
      return doc ? json(req, res, 200, doc, { 'x-robots-tag': 'noindex' }) : json(req, res, 404, { error: 'No document with that id.' });
    }
    if (p === '/api/trending') {
      const hours = Number(url.searchParams.get('hours') || 6);
      if (![1, 3, 6, 12, 24].includes(hours)) return json(req, res, 400, { error: 'hours must be 1, 3, 6, 12 or 24.' });
      const etag = `"t${store.snapshot.version}-${hours}"`;
      if (req.headers['if-none-match'] === etag) return res.writeHead(304, { etag }).end();
      return json(req, res, 200, { version: store.snapshot.version, ...store.trending(hours) }, { etag, 'cache-control': 'public, max-age=15' });
    }
    if (p === '/api/odds') {
      if (limited(req, res)) return;
      const market = (store.markets || []).find((m) => m.id === url.searchParams.get('id'));
      if (!market) return json(req, res, 404, { error: 'No market with that id.' });
      return Promise.all([backfillMarket(market).catch(() => {}), readyMoves(store)])
        .then(([, mv]) => json(req, res, 200, { id: market.id, outcomes: marketHistory(market), moves: mv ? mv.moves.filter((m) => m.market === market.id) : null }, { 'cache-control': 'public, max-age=60' }));
    }
    if (p === '/api/topic') {
      if (limited(req, res)) return;
      const key = url.searchParams.get('key') || '';
      if (!topicKeys().includes(key)) return json(req, res, 404, { error: 'No topic with that name.' });
      return topicHistory(key)
        .then((data) => json(req, res, 200, data, { 'cache-control': 'public, max-age=300' }))
        .catch((err) => json(req, res, 503, { error: `Topic history is unavailable: ${err.message}` }));
    }
    if (p === '/api/emerging') {
      if (limited(req, res)) return;
      const id = url.searchParams.get('id');
      return emergingThemes(store)
        .then((d) => {
          if (!id) return json(req, res, 200, { ...d, themes: d.themes.map(({ stories, ...t }) => ({ ...t, stories: stories.slice(0, 3) })) }, { 'cache-control': 'public, max-age=120' });
          // A theme is keyed by its lead story; it may have regrouped since.
          const t = d.themes.find((x) => x.id === id) || d.themes.find((x) => x.stories.some((s) => s.sid === id));
          return t ? json(req, res, 200, { ...t, generatedAt: d.generatedAt, window: d.window }, { 'cache-control': 'public, max-age=120' }) : json(req, res, 404, { error: 'That theme is no longer rising.' });
        })
        .catch((err) => json(req, res, 503, { error: `Emerging themes are unavailable: ${err.message}` }));
    }
    // Odds jumps and the news before them: the explained ones across markets,
    // or every jump on one market.
    if (p === '/api/moves') {
      if (limited(req, res)) return;
      const id = url.searchParams.get('market');
      return marketMoves(store)
        .then((d) => json(req, res, 200, id ? { ...d, moves: d.moves.filter((m) => m.market === id) } : { ...d, moves: explainedMoves(d).slice(0, 24) }, { 'cache-control': 'public, max-age=120' }))
        .catch((err) => json(req, res, 503, { error: `Market moves are unavailable: ${err.message}` }));
    }
    // The co-mention network for 7, 30 or 90 days, or the headlines behind
    // one name or one link.
    if (p === '/api/graph' || p === '/api/graph/detail') {
      if (limited(req, res)) return;
      const days = Number(url.searchParams.get('days')) || 30;
      if (!WINDOWS.includes(days)) return json(req, res, 400, { error: `days must be one of ${WINDOWS.join(', ')}.` });
      const key = (k) => (url.searchParams.get(k) || '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 60);
      if (p === '/api/graph/detail' && !key('a')) return json(req, res, 400, { error: 'Name a node with ?a=.' });
      return (p === '/api/graph' ? entityGraph(days) : entityDetail(days, key('a'), key('b') || null))
        .then((d) => (d ? json(req, res, 200, d, { 'cache-control': 'public, max-age=300' }) : json(req, res, 404, { error: 'No such name in this window.' })))
        .catch((err) => json(req, res, 503, { error: `The graph is unavailable: ${err.message}` }));
    }
    if (p === '/api/story') {
      if (limited(req, res)) return;
      const id = (url.searchParams.get('id') || '').slice(0, 2000);
      return Promise.all([storyPage(store, id), storylinesData().catch(() => null)])
        .then(([d, lines]) => (d && lines ? { ...d, storyline: storylineOf(lines, d) } : d))
        .then((d) => (d ? json(req, res, 200, d, { 'cache-control': 'public, max-age=60' }) : json(req, res, 404, { error: 'No story with that id.' })))
        .catch((err) => json(req, res, 503, { error: `The story is unavailable: ${err.message}` }));
    }
    // Release coverage: counts for the whole list, or one release in full.
    if (p === '/api/releases/coverage' || p === '/api/release') {
      if (limited(req, res)) return;
      const releases = store.releases || [];
      const id = url.searchParams.get('id');
      if (p === '/api/release' && !releases.some((r) => r.id === id)) return json(req, res, 404, { error: 'No release with that id.' });
      return releasesCoverage(releases)
        .then((all) => json(req, res, 200, p === '/api/release' ? { id, ...(all[id] || { n: 0, outlets: 0, first: null, items: [], series: [] }) } : coverageCounts(all), { 'cache-control': 'public, max-age=300' }))
        .catch((err) => json(req, res, 503, { error: `Release coverage is unavailable: ${err.message}` }));
    }
    // Model comparison: every release with price, context, size, coverage and
    // reported benchmark scores.
    if (p === '/api/models') {
      if (limited(req, res)) return;
      return modelsTable(store.releases || [])
        .then((d) => json(req, res, 200, d, { 'cache-control': 'public, max-age=300' }))
        .catch((err) => json(req, res, 503, { error: `Model comparison is unavailable: ${err.message}` }));
    }
    // Trends: share of coverage per day or week for up to four terms, with peaks.
    if (p === '/api/trends') {
      if (limited(req, res)) return;
      const terms = url.searchParams.get('q') || '';
      if (!parseTerms(terms).length) return json(req, res, 400, { error: 'Give one to four terms, comma-separated, in q.' });
      return trendsQuery(terms, url.searchParams.get('range') || '1y')
        .then((d) => json(req, res, 200, d, { 'cache-control': 'public, max-age=600' }))
        .catch((err) => json(req, res, 503, { error: `Trends are unavailable: ${err.message}` }));
    }
    if (p === '/api/trends/moment') {
      if (limited(req, res)) return;
      const from = Number(url.searchParams.get('from'));
      const to = Number(url.searchParams.get('to'));
      if (!parseTerms(url.searchParams.get('q') || '').length || !(from > 0) || !(to > from) || to - from > 31 * 86400e3) return json(req, res, 400, { error: 'Give q, and from < to (ms, at most 31 days apart).' });
      return trendMomentQuery(url.searchParams.get('q'), from, to)
        .then((d) => json(req, res, 200, d, { 'cache-control': 'public, max-age=1800' }))
        .catch((err) => json(req, res, 503, { error: err.message }));
    }
    // Ask the Wire: an answer made of sentences from stored coverage, with sources.
    if (p === '/api/ask') {
      if (limited(req, res)) return;
      const question = (url.searchParams.get('q') || '').trim();
      if (question.length < 3 || question.length > 200) return json(req, res, 400, { error: 'Ask a question of 3 to 200 characters in q.' });
      return ask(question)
        .then((d) => json(req, res, 200, d, { 'cache-control': 'public, max-age=900' }))
        .catch((err) => json(req, res, 503, { error: `Answers are unavailable: ${err.message}` }));
    }
    // Deals: funding rounds, valuations and acquisitions read from headlines.
    if (p === '/api/deals') {
      if (limited(req, res)) return;
      const range = url.searchParams.get('range') || '1y';
      if (!DEAL_RANGES[range]) return json(req, res, 400, { error: `range must be one of ${Object.keys(DEAL_RANGES).join(', ')}.` });
      return dealsQuery(range)
        .then((d) => json(req, res, 200, d, { 'cache-control': 'public, max-age=600' }))
        .catch((err) => json(req, res, 503, { error: `Deals are unavailable: ${err.message}` }));
    }
    if (p === '/api/deals/company') {
      if (limited(req, res)) return;
      const key = (url.searchParams.get('key') || '').toLowerCase();
      if (!/^[\p{L}\p{N}-]{1,60}$/u.test(key)) return json(req, res, 400, { error: 'Give a company key, e.g. key=anthropic.' });
      return companyDealsQuery(key)
        .then((d) => (d ? json(req, res, 200, d, { 'cache-control': 'public, max-age=600' }) : json(req, res, 404, { error: 'No deals on record for that company.' })))
        .catch((err) => json(req, res, 503, { error: `Deals are unavailable: ${err.message}` }));
    }
    // Any day rebuilt from the archive, and the calendar of days.
    if (p === '/api/days') {
      if (limited(req, res)) return;
      return calendarQuery()
        .then((d) => json(req, res, 200, d, { 'cache-control': 'public, max-age=600' }))
        .catch((err) => json(req, res, 503, { error: `The calendar is unavailable: ${err.message}` }));
    }
    if (p === '/api/day') {
      if (limited(req, res)) return;
      const day = url.searchParams.get('d') || '';
      if (!isDay(day) || day > dayOf(Date.now()) || day < '2000-01-01') return json(req, res, 400, { error: 'Give a past day as d=YYYY-MM-DD (UTC).' });
      return dayQuery(day)
        .then((d) => json(req, res, 200, withReleases(withMarkets(d, store.markets || []), store.releases || []), { 'cache-control': `public, max-age=${d.partial ? 300 : 3600}` }))
        .catch((err) => json(req, res, 503, { error: `That day is unavailable: ${err.message}` }));
    }
    if (p === '/api/quotes') {
      if (limited(req, res)) return;
      const q = (url.searchParams.get('q') || '').trim().toLowerCase().slice(0, 60);
      return quotesQuery(q)
        .then((d) => json(req, res, 200, d, { 'cache-control': 'public, max-age=600' }))
        .catch((err) => json(req, res, 503, { error: `Quotes are unavailable: ${err.message}` }));
    }
    if (p === '/api/person') {
      if (limited(req, res)) return;
      const key = personKey(url.searchParams.get('name') || '').slice(0, 60);
      if (!key) return json(req, res, 400, { error: 'Give a name as name=sam-altman.' });
      return personQuery(key)
        .then((d) => (d ? json(req, res, 200, d, { 'cache-control': 'public, max-age=600' }) : json(req, res, 404, { error: 'Nobody by that name is quoted in the last 45 days.' })))
        .catch((err) => json(req, res, 503, { error: `Quotes are unavailable: ${err.message}` }));
    }
    if (p === '/api/storylines' || p === '/api/storyline') {
      if (limited(req, res)) return;
      const id = (url.searchParams.get('id') || '').replace(/[^a-f0-9]/g, '').slice(0, 10);
      if (p === '/api/storyline' && !id) return json(req, res, 400, { error: 'Give a storyline as id=.' });
      return storylinesData()
        .then((d) => {
          if (p === '/api/storylines') return json(req, res, 200, storylineList(d), { 'cache-control': 'public, max-age=600' });
          const s = storylineById(d, id);
          return s ? json(req, res, 200, { ...s, generatedAt: d.generatedAt }, { 'cache-control': 'public, max-age=600' }) : json(req, res, 404, { error: 'No storyline with that id (they are rebuilt every half hour).' });
        })
        .catch((err) => json(req, res, 503, { error: `Storylines are unavailable: ${err.message}` }));
    }
    if (p === '/api/predictions') {
      if (limited(req, res)) return;
      const theme = url.searchParams.get('theme') || '';
      if (theme && theme !== 'other' && !FORECAST_THEMES.some((t) => t.key === theme)) return json(req, res, 400, { error: `Unknown theme; use one of ${FORECAST_THEMES.map((t) => t.key).join(', ')}, other.` });
      const year = Number(url.searchParams.get('year')) || 0;
      if (year && (year < 2020 || year > 2100)) return json(req, res, 400, { error: 'Give a year like year=2030.' });
      const who = personKey(url.searchParams.get('who') || '').slice(0, 60);
      return forecastsQuery({ theme, year, who })
        .then((d) => json(req, res, 200, d, { 'cache-control': 'public, max-age=600' }))
        .catch((err) => json(req, res, 503, { error: `Predictions are unavailable: ${err.message}` }));
    }
    if (p === '/api/catchup') {
      if (limited(req, res)) return;
      const { since } = windowOf(url.searchParams.get('since'));
      // Storylines are cold for a while after a restart; don't wait on them.
      const lines = Promise.race([storylinesData().catch(() => null), new Promise((r) => setTimeout(r, 1500, null))]);
      return Promise.all([catchupQuery(since), readyMoves(store), lines])
        .then(([d, moves, storylines]) => json(req, res, 200, withLive(d, { breaking: breakingHistory({ days: 7 }), moves, releases: store.releases || [], storylines }), { 'cache-control': 'public, max-age=120' }))
        .catch((err) => json(req, res, 503, { error: `Catch-up is unavailable: ${err.message}` }));
    }
    // Stories laid out by meaning for the last 1, 3 or 7 days.
    if (p === '/api/map') {
      if (limited(req, res)) return;
      const days = Number(url.searchParams.get('days')) || 3;
      if (!MAP_WINDOWS.includes(days)) return json(req, res, 400, { error: `days must be one of ${MAP_WINDOWS.join(', ')}.` });
      return newsMapQuery(days)
        .then((d) => json(req, res, 200, d, { 'cache-control': 'public, max-age=600' }))
        .catch((err) => json(req, res, 503, { error: `The map is unavailable: ${err.message}` }));
    }
    // Two names from the graph side by side.
    if (p === '/api/versus') {
      if (limited(req, res)) return;
      const days = Number(url.searchParams.get('days')) || 30;
      if (!VERSUS_WINDOWS.includes(days)) return json(req, res, 400, { error: `days must be one of ${VERSUS_WINDOWS.join(', ')}.` });
      const key = (k, d) => (url.searchParams.get(k) || d).toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 60);
      const [a, b] = [key('a', 'openai'), key('b', 'anthropic')];
      return versusQuery({ a, b, days })
        .then((d) => json(req, res, d.missing ? 404 : 200, d.missing ? { error: a === b ? 'Pick two different names.' : 'One of those names isn’t in this window.', ...d } : d, { 'cache-control': 'public, max-age=600' }))
        .catch((err) => json(req, res, 503, { error: `Head to head is unavailable: ${err.message}` }));
    }
    // Reported before announced: hedged claims and whether they came true.
    if (p === '/api/rumors') {
      if (limited(req, res)) return;
      return rumorsQuery()
        .then((d) => json(req, res, 200, d, { 'cache-control': 'public, max-age=900' }))
        .catch((err) => json(req, res, 503, { error: `The rumor tracker is unavailable: ${err.message}` }));
    }
    // Benchmark scores read from coverage: leaderboards and state of the art over time.
    if (p === '/api/benchmarks') {
      if (limited(req, res)) return;
      return benchmarksQuery()
        .then((d) => json(req, res, 200, d, { 'cache-control': 'public, max-age=1800' }))
        .catch((err) => json(req, res, 503, { error: `Benchmarks are unavailable: ${err.message}` }));
    }
    // AI services' status page incidents: live state, history and coverage.
    if (p === '/api/uptime') {
      if (limited(req, res)) return;
      return uptimeQuery()
        .then((d) => json(req, res, 200, d, { 'cache-control': 'public, max-age=120' }))
        .catch((err) => json(req, res, 503, { error: `The status board is unavailable: ${err.message}` }));
    }
    // Lawsuits, rulings and settlements around AI companies, as cases.
    if (p === '/api/court') {
      if (limited(req, res)) return;
      return courtQuery()
        .then((d) => json(req, res, 200, d, { 'cache-control': 'public, max-age=1800' }))
        .catch((err) => json(req, res, 503, { error: `The courtroom is unavailable: ${err.message}` }));
    }
    // AI data center projects, power and the places pushing back.
    if (p === '/api/buildout') {
      if (limited(req, res)) return;
      return buildoutQuery()
        .then((d) => json(req, res, 200, d, { 'cache-control': 'public, max-age=1800' }))
        .catch((err) => json(req, res, 503, { error: `The buildout is unavailable: ${err.message}` }));
    }
    // Layoffs tied to AI, and the argument about whether AI is the reason.
    if (p === '/api/jobs') {
      if (limited(req, res)) return;
      return jobsQuery()
        .then((d) => json(req, res, 200, d, { 'cache-control': 'public, max-age=1800' }))
        .catch((err) => json(req, res, 503, { error: `AI and jobs is unavailable: ${err.message}` }));
    }
    // When AI went wrong: rogue agents, hacks, deepfakes, harm, made-up answers.
    if (p === '/api/incidents') {
      if (limited(req, res)) return;
      return incidentsQuery()
        .then((d) => json(req, res, 200, d, { 'cache-control': 'public, max-age=1800' }))
        .catch((err) => json(req, res, 503, { error: `AI incidents are unavailable: ${err.message}` }));
    }
    // Robots: money, launches, deployments and the race between regions.
    if (p === '/api/robots') {
      if (limited(req, res)) return;
      return robotsQuery()
        .then((d) => json(req, res, 200, d, { 'cache-control': 'public, max-age=1800' }))
        .catch((err) => json(req, res, 503, { error: `Robots are unavailable: ${err.message}` }));
    }
    // Open model releases: labs, sizes, licenses, derivatives, the US–China split.
    if (p === '/api/open') {
      if (limited(req, res)) return;
      return openQuery()
        .then((d) => json(req, res, 200, d, { 'cache-control': 'public, max-age=1800' }))
        .catch((err) => json(req, res, 503, { error: `Open weights are unavailable: ${err.message}` }));
    }
    // The compute race: chips, export controls, deals, shortages.
    if (p === '/api/chips') {
      if (limited(req, res)) return;
      return chipsQuery()
        .then((d) => json(req, res, 200, d, { 'cache-control': 'public, max-age=1800' }))
        .catch((err) => json(req, res, 503, { error: `The compute race is unavailable: ${err.message}` }));
    }
    // Watchlists: each q (with s, the reader's last look) and what's new since.
    if (p === '/api/watch') {
      if (limited(req, res)) return;
      const qs = url.searchParams.getAll('q');
      const ss = url.searchParams.getAll('s');
      const list = [];
      qs.forEach((raw, i) => {
        const q = normQuery(raw);
        if (q && !list.some((x) => x.q.toLowerCase() === q.toLowerCase()) && list.length < MAX_WATCHES) list.push({ q, since: Number(ss[i]) || 0 });
      });
      if (!list.length) return json(req, res, 400, { error: 'Add a search to watch.' });
      return watchFor(list)
        .then((watches) => json(req, res, 200, { generatedAt: Date.now(), watches }, { 'cache-control': 'private, no-store' }))
        .catch((err) => json(req, res, 503, { error: `Watchlists are unavailable: ${err.message}` }));
    }
    // AI words, explained, with how much of the coverage uses each.
    if (p === '/api/terms') {
      if (limited(req, res)) return;
      return termsQuery()
        .then((d) => json(req, res, 200, d, { 'cache-control': 'public, max-age=1800' }))
        .catch((err) => json(req, res, 503, { error: `AI words are unavailable: ${err.message}` }));
    }
    // The week in AI quiz: an edition without its answers, or (stats) how
    // readers did once you've played.
    if (p === '/api/quiz' || p === '/api/quiz/stats') {
      if (limited(req, res)) return;
      const id = url.searchParams.get('edition') || editionIds()[0];
      if (!isEditionId(id)) return json(req, res, 404, { error: 'No quiz for that week.' });
      return quizEdition(store, id)
        .then((e) => json(req, res, 200, p === '/api/quiz' ? publicQuiz(e) : quizStats(e), { 'cache-control': p === '/api/quiz' ? 'public, max-age=300' : 'no-cache' }))
        .catch((err) => json(req, res, 503, { error: `The quiz is unavailable: ${err.message}` }));
    }
    // AI bills, laws, orders and regulations, and how far each got.
    if (p === '/api/rules') {
      if (limited(req, res)) return;
      return rulesQuery()
        .then((d) => json(req, res, 200, d, { 'cache-control': 'public, max-age=1800' }))
        .catch((err) => json(req, res, 503, { error: `AI rules are unavailable: ${err.message}` }));
    }
    // Who joined, left or was hired away, and the flows between companies.
    if (p === '/api/talent') {
      if (limited(req, res)) return;
      return talentQuery()
        .then((d) => json(req, res, 200, d, { 'cache-control': 'public, max-age=1800' }))
        .catch((err) => json(req, res, 503, { error: `Talent moves are unavailable: ${err.message}` }));
    }
    // Models, products and projects that entered the news in the last 60 days.
    if (p === '/api/new-names') {
      if (limited(req, res)) return;
      return newNamesQuery()
        .then((d) => json(req, res, 200, d, { 'cache-control': 'public, max-age=1800' }))
        .catch((err) => json(req, res, 503, { error: `New names are unavailable: ${err.message}` }));
    }
    if (p === '/api/outlets') {
      if (limited(req, res)) return;
      return outletsQuery()
        .then((d) => json(req, res, 200, d, { 'cache-control': 'public, max-age=900' }))
        .catch((err) => json(req, res, 503, { error: `Outlets are unavailable: ${err.message}` }));
    }
    if (p === '/api/outlet') {
      if (limited(req, res)) return;
      const site = siteKey(url.searchParams.get('site'));
      if (!/^[a-z0-9.-]{3,80}$/.test(site)) return json(req, res, 400, { error: 'Give a site as site=example.com.' });
      return outletQuery(site)
        .then((d) => (d ? json(req, res, 200, d, { 'cache-control': 'public, max-age=900' }) : json(req, res, 404, { error: 'No profile for that site: it needs 20 AI articles in the last 90 days.' })))
        .catch((err) => json(req, res, 503, { error: `Outlets are unavailable: ${err.message}` }));
    }
    // Status page: source runs, arrivals, spider outcomes, vitals and X accounts per hour.
    if (p === '/api/health') {
      const hours = [24, 48, 168].includes(Number(url.searchParams.get('hours'))) ? Number(url.searchParams.get('hours')) : 48;
      const hit = healthCache.get(hours);
      if (!hit || Date.now() - hit.at > 60e3) healthCache.set(hours, { at: Date.now(), data: statusHistory({ hours, live: store.sourceStatus }) });
      return json(req, res, 200, healthCache.get(hours).data, { 'cache-control': 'public, max-age=60' });
    }
    if (p === '/api/digest' || p === '/digest.xml') {
      if (limited(req, res)) return;
      return weeklyDigest()
        .then((d) => {
          if (p === '/api/digest') return json(req, res, 200, { ...d, markets: movers(store.markets || []) }, { 'cache-control': 'public, max-age=300' });
          const origin = `${req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http'}://${/^[\w.:[\]-]+$/.test(req.headers.host || '') ? req.headers.host : 'localhost'}`;
          send(req, res, 200, digestRss(d, { origin, name: settings.publicSite()?.name || 'Frontier Wire' }), 'application/rss+xml; charset=utf-8', { 'cache-control': 'public, max-age=1800' });
        })
        .catch((err) => json(req, res, 503, { error: `The digest is unavailable: ${err.message}` }));
    }
    // Stories breaking now (with their coverage curves) and the past week's breaks.
    if (p === '/api/breaking') {
      const days = Number(url.searchParams.get('days')) || 7;
      if (![1, 7, 30].includes(days)) return json(req, res, 400, { error: 'days must be 1, 7 or 30.' });
      return json(req, res, 200, { active: store.breaking.active(), history: breakingHistory({ days }), version: store.snapshot.version }, { 'cache-control': 'public, max-age=30' });
    }
    // Command palette: pages, names, accounts, releases, stories and markets.
    if (p === '/api/jump') {
      if (limited(req, res)) return;
      const qv = (url.searchParams.get('q') || '').slice(0, 80);
      return jumpIndex()
        .then((index) => json(req, res, 200, { q: qv, results: jumpSearch(index, qv) }, { 'cache-control': 'public, max-age=30' }))
        .catch((err) => json(req, res, 503, { error: `Jump is unavailable: ${err.message}` }));
    }
    // The reading list: how each saved story looks now.
    if (p === '/api/saved') {
      if (limited(req, res)) return;
      const sids = [...new Set((url.searchParams.get('ids') || '').split(',').filter((x) => /^[\w-]{6,16}$/.test(x)))].slice(0, 100);
      return json(req, res, 200, { stories: savedStatus(store, sids) }, { 'cache-control': 'no-cache' });
    }
    // X accounts: the directory, one account, or two side by side.
    if (p === '/api/accounts') {
      if (limited(req, res)) return;
      return accountsDirectory()
        .then((d) => json(req, res, 200, d, { 'cache-control': 'public, max-age=120' }))
        .catch((err) => json(req, res, 503, { error: `Accounts are unavailable: ${err.message}` }));
    }
    if (p === '/api/account') {
      if (limited(req, res)) return;
      const h = url.searchParams.get('handle') || '';
      const vs = url.searchParams.get('vs') || '';
      if (!/^\w{1,15}$/.test(h) || (vs && !/^\w{1,15}$/.test(vs))) return json(req, res, 400, { error: 'Name an X handle with ?handle=.' });
      return (vs ? accountCompare(h, vs) : accountProfile(h))
        .then((d) => (d ? json(req, res, 200, d, { 'cache-control': 'public, max-age=120' }) : json(req, res, 404, { error: 'No posts from that account in the last 30 days.' })))
        .catch((err) => json(req, res, 503, { error: `The account is unavailable: ${err.message}` }));
    }
    // For you: the live feed ranked for follows sent in the query string.
    if (p === '/api/foryou') {
      if (limited(req, res)) return;
      if (url.search.length > 6000) return json(req, res, 414, { error: 'Too many follows.' });
      return soon(entityGraph(30))
        .then((graph) => forYou(store, parseFollows(url.searchParams), { graph }))
        .then((d) => json(req, res, 200, d, { 'cache-control': 'private, max-age=30' }))
        .catch((err) => json(req, res, 503, { error: `For you is unavailable: ${err.message}` }));
    }
    if (p === '/api/follow/suggest') {
      if (limited(req, res)) return;
      return Promise.all([soon(entityGraph(30)), soon(accountsDirectory(), 1500)])
        .then(([graph, accounts]) => json(req, res, 200, followSuggestions(store, { graph, accounts }), { 'cache-control': 'public, max-age=120' }));
    }
    // The API described, and feeds for a topic, account, search, follows or breaking.
    if (p === '/api' || p === '/api/') return json(req, res, 200, apiIndex(originOf(req)), { 'cache-control': 'public, max-age=3600', 'access-control-allow-origin': '*' });
    const feed = /^\/feeds\/(topic\/([a-z0-9-]{2,40})|account\/(\w{1,15})|search|foryou|breaking)\.(xml|json)$/.exec(p);
    if (feed) return serveFeed(req, res, url, feed).catch((err) => json(req, res, 503, { error: `That feed is unavailable: ${err.message}` }));
    if (p === '/api/push/key') return json(req, res, 200, { publicKey: vapidKeys().publicKey }, { 'cache-control': 'public, max-age=3600' });
    if (p === '/api/spider') return json(req, res, 200, spider.status(), { 'cache-control': 'public, max-age=10' });
    if (p === '/api/status') return json(req, res, 200, { ...store.status(), alerts: { ...alertStatus }, version: store.snapshot.version, generatedAt: store.snapshot.generatedAt });

    if (p === '/api/stream') {
      const ip = clientIp(req);
      const mine = streams.get(ip) || 0;
      if (mine >= settings.get('limits.streamPerIp') || streamTotal >= settings.get('limits.streamTotal')) {
        return json(req, res, 429, { error: 'Too many live connections.' }, { 'retry-after': '30' });
      }
      streams.set(ip, mine + 1);
      streamTotal++;
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
      res.write(`retry: 5000\nevent: hello\ndata: ${JSON.stringify({ version: store.snapshot.version })}\n\n`);
      clients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 25e3);
      req.on('close', () => {
        clearInterval(ping);
        clients.delete(res);
        streamTotal--;
        const n = (streams.get(ip) || 1) - 1;
        if (n) streams.set(ip, n);
        else streams.delete(ip);
      });
      return;
    }

    if (p.startsWith('/api/')) return json(req, res, 404, { error: 'Not found.' });

    if (p === '/robots.txt') {
      return send(req, res, 200, settings.get('site.robotsTxt'), 'text/plain; charset=utf-8', { 'cache-control': 'public, max-age=300' });
    }

    if (p.startsWith('/media/')) {
      const name = p.slice(7);
      if (!/^[a-f0-9]{64}\.(jpg|png|gif|webp|avif)$/.test(name)) return send(req, res, 404, 'Not found', 'text/plain');
      const file = path.join(MEDIA_DIR, name.slice(0, 2), name.slice(2, 4), name);
      const ext = name.split('.').pop();
      const stream = fs.createReadStream(file);
      stream.on('open', () => res.writeHead(200, { 'content-type': `image/${ext === 'jpg' ? 'jpeg' : ext}`, 'cache-control': 'public, max-age=31536000, immutable', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox" }));
      stream.on('error', () => { if (!res.headersSent) send(req, res, 404, 'Not found', 'text/plain'); else res.destroy(); });
      if (req.method === 'HEAD') return stream.on('open', () => { stream.destroy(); res.end(); });
      return stream.pipe(res);
    }

    // Static site. Unknown paths without an extension get the app shell.
    const rel = decodeURIComponent(p) === '/' ? 'index.html' : decodeURIComponent(p).replace(/^\/+/, '');
    let f = staticFile(rel);
    if (!f && !path.extname(rel)) f = staticFile('index.html');
    if (!f) return send(req, res, 404, 'Not found', 'text/plain; charset=utf-8');
    if (req.headers['if-none-match'] === f.etag) return res.writeHead(304, { etag: f.etag }).end();
    const enc = f.compressible ? pickEncoding(req) : null;
    res.writeHead(200, { 'content-type': f.type, etag: f.etag, 'cache-control': PROD && rel !== 'index.html' ? 'public, max-age=300' : 'no-cache', vary: 'Accept-Encoding', ...(enc ? { 'content-encoding': enc } : {}) });
    res.end(req.method === 'HEAD' ? undefined : f.body.get(enc));
  }

  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/api/')) {
      const t0 = performance.now();
      res.once('finish', () => noteRequest(performance.now() - t0));
    }
    try {
      handle(req, res);
    } catch (err) {
      console.error('[http]', err);
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end('Something went wrong');
      } else res.destroy();
    }
  });
  // Slow-loris and idle-connection protection.
  server.headersTimeout = 15000;
  server.requestTimeout = 30000;
  server.keepAliveTimeout = 5000;
  server.maxHeadersCount = 100;
  return server;
}

function main() {
  const PORT = Number(process.env.PORT) || 3000;
  startFileLog();
  openDb();
  settings.load();
  const store = new Store();
  store.load();
  // Web-only processes (several on one machine, sharing the database file)
  // run with SPIDER=off AGGREGATOR=off; exactly one process should crawl.
  const background = process.env.AGGREGATOR !== 'off';
  const spider = new Spider();
  attachSpider(spider);
  if (process.env.SPIDER !== 'off') spider.start();
  contentEvents.on('change', () => store.scheduleRebuild());

  const server = createApp({ store, spider });
  server.listen(PORT, process.env.HOST || '0.0.0.0', () => console.log(`Frontier Wire on http://localhost:${PORT}`));

  setInterval(pruneSessions, 10 * 60e3).unref();
  setInterval(checkpoint, 5 * 60e3).unref();
  if (background) {
    startRetention();
    startVitals(() => store.status());
    startEmbedder(); // independent of the first crawl (Reddit alone takes minutes)
    keepVectorsWarm();
    releasesCoverage(store.releases || []).catch(() => {}); // from the saved list; refreshed when it changes
    setTimeout(() => modelsTable(store.releases || []).catch(() => {}), 20e3).unref();
    setTimeout(() => marketMoves(store).catch(() => {}), 30e3).unref();
    setTimeout(() => entityGraph(30).catch(() => {}), 45e3).unref();
    setTimeout(() => accountsDirectory().catch(() => {}), 60e3).unref();
    subscriberCount();
    store.on('breaking', (started) => pushBreaking(started, store.breaking).catch((err) => console.warn('[alerts]', err.message)));
    // The Android apps: breaking and followed stories, changelog and source health.
    deviceCount();
    store.on('breaking', (started) => pushBreakingMobile(started, store.snapshot.stories || []).catch((err) => console.warn('[push]', err.message)));
    store.on('update', (snap) => {
      pushFollows(snap.stories || []).catch((err) => console.warn('[push]', err.message));
      pushSourceHealth(snap.status?.sources || {}).catch((err) => console.warn('[push]', err.message));
    });
    setTimeout(() => pushChangelog().catch((err) => console.warn('[push]', err.message)), 15e3).unref();
    setInterval(() => { pruneUserSessions(); prunePushes(); }, 6 * 3600e3).unref();
    crawlAll(store)
      .then(() => {
        store.save();
        startScheduler(store);
        startLabeler(store);
        weeklyDigest().catch(() => {});
        warmTopics((store.snapshot.trending?.topics || []).slice(0, 6).map((t) => t.key));
      })
      .catch((e) => console.error('initial crawl failed', e));
  } else {
    // Pick up the feed the background process saves.
    setInterval(() => { store.load(); }, 30e3).unref();
  }

  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    console.log('Shutting down');
    spider.stop();
    try { store.save(); } catch { /* best effort */ }
    // Stop accepting, let in-flight requests finish, then cut long-lived
    // connections (live updates never end by themselves).
    server.close(() => {
      closeDb();
      process.exit(0);
    });
    server.closeIdleConnections();
    setTimeout(() => server.closeAllConnections(), 2000).unref();
    setTimeout(() => { closeDb(); process.exit(0); }, 5000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
