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
import { semanticSearch, relatedTo, keepVectorsWarm } from './index/semantic.js';
import { startEmbedder } from './index/vectors.js';
import { crawlAll, startScheduler, attachSpider, runNow, SOURCES } from './crawler.js';
import { openDb, checkpoint, closeDb } from './db.js';
import { settings } from './settings.js';
import { Spider } from './spider/engine.js';
import { MEDIA_DIR } from './spider/media.js';
import { universal, searchImages, suggest, getDoc } from './index/search.js';
import { startRetention } from './index/retention.js';
import { createAdminRouter } from './admin/routes.js';
import { pruneSessions } from './admin/auth.js';
import { contentEvents } from './admin/content.js';
import { RateLimiter } from './security/ratelimit.js';
import { clientIp, securityHeaders } from './security/httpkit.js';
import { startFileLog } from './logfile.js';
import { xFeed } from './xfeed.js';
import { startLabeler } from './pipeline/labeler.js';

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
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD', 'content-type': 'text/plain' });
      return res.end('Method not allowed');
    }

    const p = url.pathname;
    if (p === '/healthz') return json(req, res, 200, { ok: true, version: store.snapshot.version });
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
      return backfillMarket(market)
        .catch(() => {})
        .then(() => json(req, res, 200, { id: market.id, outcomes: marketHistory(market) }, { 'cache-control': 'public, max-age=60' }));
    }
    if (p === '/api/topic') {
      if (limited(req, res)) return;
      const key = url.searchParams.get('key') || '';
      if (!topicKeys().includes(key)) return json(req, res, 404, { error: 'No topic with that name.' });
      return topicHistory(key)
        .then((data) => json(req, res, 200, data, { 'cache-control': 'public, max-age=300' }))
        .catch((err) => json(req, res, 503, { error: `Topic history is unavailable: ${err.message}` }));
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
    if (p === '/api/spider') return json(req, res, 200, spider.status(), { 'cache-control': 'public, max-age=10' });
    if (p === '/api/status') return json(req, res, 200, { ...store.status(), version: store.snapshot.version, generatedAt: store.snapshot.generatedAt });

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
    startEmbedder(); // independent of the first crawl (Reddit alone takes minutes)
    keepVectorsWarm();
    releasesCoverage(store.releases || []).catch(() => {}); // from the saved list; refreshed when it changes
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
