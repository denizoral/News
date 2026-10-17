import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { Store } from './store.js';
import { crawlAll, startScheduler } from './crawler.js';

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC = path.resolve('public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };

const store = new Store();
store.load();

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
