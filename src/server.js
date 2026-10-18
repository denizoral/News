import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { Store } from './store.js';
import { crawlAll, startScheduler, attachSpider } from './crawler.js';
import { openDb } from './db.js';
import { Spider } from './spider/engine.js';
import { MEDIA_DIR } from './spider/media.js';
import { universal, searchImages, suggest, getDoc } from './index/search.js';

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC = path.resolve('public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };

const store = new Store();
store.load();
openDb();

const spider = new Spider();
attachSpider(spider);
if (process.env.SPIDER !== 'off') spider.start();

const clients = new Set();
let gzCache = { version: -1, body: null };

function snapshotBody() {
  if (gzCache.version !== store.snapshot.version) {
    const json = JSON.stringify(store.snapshot);
    gzCache = { version: store.snapshot.version, json, body: zlib.gzipSync(json) };
  }
  return gzCache;
}

store.on('update', (snap) => {
  const msg = `event: update\ndata: ${JSON.stringify({ version: snap.version, generatedAt: snap.generatedAt })}\n\n`;
  for (const res of clients) res.write(msg);
});

function sendJSON(req, res, status, body, extra = {}) {
  const gz = /gzip/.test(req.headers['accept-encoding'] || '');
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...(gz ? { 'content-encoding': 'gzip' } : {}), ...extra });
  res.end(gz ? zlib.gzipSync(payload) : payload);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');

  if (url.pathname === '/api/snapshot') {
    const { json, body } = snapshotBody();
    const etag = `"v${store.snapshot.version}"`;
    if (req.headers['if-none-match'] === etag) return res.writeHead(304).end();
    if (/gzip/.test(req.headers['accept-encoding'] || '')) {
      res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip', etag, 'cache-control': 'no-cache' });
      return res.end(body);
    }
    res.writeHead(200, { 'content-type': 'application/json', etag, 'cache-control': 'no-cache' });
    return res.end(json);
  }

  // Search API. A bad query must never take the server down.
  try {
    if (url.pathname === '/api/search') {
      const p = Object.fromEntries(url.searchParams);
      const out = p.type === 'images' ? searchImages(p.q || '', p) : universal(p.q || '', p);
      return sendJSON(req, res, 200, out);
    }
    if (url.pathname === '/api/suggest') return sendJSON(req, res, 200, suggest(url.searchParams.get('q') || ''));
    if (url.pathname === '/api/doc') {
      const doc = getDoc(url.searchParams.get('id'));
      return doc ? sendJSON(req, res, 200, doc, { 'x-robots-tag': 'noindex' }) : sendJSON(req, res, 404, { error: 'No document with that id.' });
    }
    if (url.pathname === '/api/spider') return sendJSON(req, res, 200, spider.status());
  } catch (err) {
    return sendJSON(req, res, 400, { error: `Couldn't run that search: ${err.message}`, results: [], total: 0 });
  }

  if (url.pathname.startsWith('/media/')) {
    const name = url.pathname.slice(7);
    if (!/^[a-f0-9]{64}\.(jpg|png|gif|webp|avif)$/.test(name)) return res.writeHead(404).end();
    const file = path.join(MEDIA_DIR, name.slice(0, 2), name.slice(2, 4), name);
    return fs.readFile(file, (err, data) => {
      if (err) return res.writeHead(404).end();
      const ext = name.split('.').pop();
      res.writeHead(200, { 'content-type': `image/${ext === 'jpg' ? 'jpeg' : ext}`, 'cache-control': 'public, max-age=31536000, immutable' });
      res.end(data);
    });
  }

  if (url.pathname === '/api/status') return sendJSON(req, res, 200, { ...store.status(), version: store.snapshot.version, generatedAt: store.snapshot.generatedAt });

  if (url.pathname === '/api/stream') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write(`retry: 5000\nevent: hello\ndata: ${JSON.stringify({ version: store.snapshot.version })}\n\n`);
    clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 25e3);
    req.on('close', () => {
      clearInterval(ping);
      clients.delete(res);
    });
    return;
  }

  // Static files
  let file = path.join(PUBLIC, decodeURIComponent(url.pathname));
  if (!file.startsWith(PUBLIC)) return res.writeHead(403).end();
  if (url.pathname === '/' || !path.extname(file)) file = path.join(PUBLIC, 'index.html');
  fs.readFile(file, (err, data) => {
    if (err) return res.writeHead(404).end('Not found');
    const type = TYPES[path.extname(file)] || 'application/octet-stream';
    const compress = /text|javascript|json|svg/.test(type) && /gzip/.test(req.headers['accept-encoding'] || '');
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache', ...(compress ? { 'content-encoding': 'gzip' } : {}) });
    res.end(compress ? zlib.gzipSync(data) : data);
  });
});

server.listen(PORT, () => console.log(`Frontier Wire on http://localhost:${PORT}`));

crawlAll(store)
  .then(() => {
    store.save();
    startScheduler(store);
  })
  .catch((e) => console.error('initial crawl failed', e));
