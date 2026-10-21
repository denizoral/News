// GDELT (gdeltproject.org) lists news articles from outlets worldwide and
// publishes a new batch every 15 minutes, free and without a key. We read its
// Global Knowledge Graph file, which has each article's URL and page title,
// and queue the ones whose headline is about AI. The DOC search API is
// rate-limited per IP (and shared IPs are often over it); the raw files aren't.

import zlib from 'node:zlib';

export const LAST_UPDATE_URL = 'https://data.gdeltproject.org/gdeltv2/lastupdate.txt';
const MAX_UNZIPPED = 80 * 1024 * 1024;

// The latest GKG file named in lastupdate.txt ("size md5 url" per line).
export function latestGkgUrl(text) {
  const line = String(text).split('\n').find((l) => /\.gkg\.csv\.zip\s*$/.test(l));
  const url = line?.trim().split(/\s+/).pop();
  return url ? url.replace(/^http:/, 'https:') : null;
}

// The first file in a zip archive, read through the central directory (local
// headers may leave sizes blank). Inflated under a size cap.
export function unzipFirst(buf, maxBytes = MAX_UNZIPPED) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a zip file');
  const cd = buf.readUInt32LE(eocd + 16);
  if (cd + 46 > buf.length || buf.readUInt32LE(cd) !== 0x02014b50) throw new Error('Damaged zip directory');
  const method = buf.readUInt16LE(cd + 10);
  const size = buf.readUInt32LE(cd + 20);
  const local = buf.readUInt32LE(cd + 42);
  if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) throw new Error('Damaged zip entry');
  const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
  const data = buf.subarray(start, start + size);
  if (method === 0) return data.subarray(0, maxBytes);
  if (method !== 8) throw new Error(`Unsupported zip compression (${method})`);
  return zlib.inflateRawSync(data, { maxOutputLength: maxBytes });
}

const decodeXml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&');

// GKG 2.1 is tab-separated: column 4 is the article URL, column 26 an XML
// fragment with <PAGE_TITLE>.
export function parseGkg(text) {
  const out = [];
  for (const line of String(text).split('\n')) {
    const cols = line.split('\t');
    const url = cols[4];
    if (!url || !/^https?:\/\//.test(url)) continue;
    const title = decodeXml(cols[26]?.match(/<PAGE_TITLE>(.*?)<\/PAGE_TITLE>/)?.[1] || '').trim();
    out.push({ url, title, site: cols[3] || '' });
  }
  return out;
}
