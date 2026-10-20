// Reading response bodies safely: a byte cap (a page can't exhaust memory) and
// charset detection in the order browsers use: byte-order mark, HTTP header,
// then <meta charset> / http-equiv / XML declaration in the first few KB.

import zlib from 'node:zlib';

export async function readBody(res, limit) {
  const chunks = [];
  let size = 0;
  let truncated = false;
  for await (const chunk of res.body) {
    if (size + chunk.length > limit) {
      chunks.push(chunk.subarray(0, limit - size));
      size = limit;
      truncated = true;
      break;
    }
    size += chunk.length;
    chunks.push(chunk);
  }
  if (truncated) res.body?.cancel?.().catch(() => {});
  return { buf: Buffer.concat(chunks), truncated };
}

export function sniffCharset(buf, contentType = '') {
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return 'utf-8';
  if (buf[0] === 0xff && buf[1] === 0xfe) return 'utf-16le';
  if (buf[0] === 0xfe && buf[1] === 0xff) return 'utf-16be';
  const header = contentType.match(/charset\s*=\s*["']?([\w.:-]+)/i)?.[1];
  if (header) return header.toLowerCase();
  const head = buf.subarray(0, 4096).toString('latin1');
  const meta = head.match(/<meta[^>]+charset\s*=\s*["']?\s*([\w.:-]+)/i)?.[1] || head.match(/<\?xml[^>]+encoding\s*=\s*["']([\w.:-]+)/i)?.[1];
  return (meta || 'utf-8').toLowerCase();
}

// Node's TextDecoder treats windows-1252 as plain Latin-1, so curly quotes,
// dashes and the euro sign (bytes 0x80-0x9F) come out as control characters.
// Browsers decode all of these labels as Windows-1252 (WHATWG Encoding).
const CP1252_LABELS = new Set(['windows-1252', 'cp1252', 'iso-8859-1', 'iso8859-1', 'latin1', 'l1', 'ascii', 'us-ascii', 'x-cp1252']);
const CP1252_HIGH = '\u20ac\u0081\u201a\u0192\u201e\u2026\u2020\u2021\u02c6\u2030\u0160\u2039\u0152\u008d\u017d\u008f\u0090\u2018\u2019\u201c\u201d\u2022\u2013\u2014\u02dc\u2122\u0161\u203a\u0153\u009d\u017e\u0178';

// Latin-1 decoding is native and fast; only 0x80-0x9F differ in Windows-1252.
function decodeCp1252(buf) {
  return buf.toString('latin1').replace(/[\x80-\x9f]/g, (c) => CP1252_HIGH[c.charCodeAt(0) - 0x80]);
}

export function decode(buf, contentType) {
  const charset = sniffCharset(buf, contentType);
  if (CP1252_LABELS.has(charset)) return decodeCp1252(buf);
  try {
    return new TextDecoder(charset, { fatal: false }).decode(buf);
  } catch {
    return new TextDecoder('utf-8').decode(buf); // unknown label
  }
}

// Sitemaps are often gzip files (sitemap.xml.gz). That isn't Content-Encoding,
// which fetch already undoes, so inflate here, under the same size cap so a
// small compressed file can't expand to fill memory. A cut-off stream still
// yields what decoded before the cut.
export function gunzipCapped(buf, limit) {
  return new Promise((resolve) => {
    const out = [];
    let size = 0;
    let truncated = false;
    const z = zlib.createGunzip({ finishFlush: zlib.constants.Z_SYNC_FLUSH });
    z.on('data', (c) => {
      if (truncated) return;
      if (size + c.length > limit) {
        out.push(c.subarray(0, limit - size));
        size = limit;
        truncated = true;
        z.destroy();
      } else {
        out.push(c);
        size += c.length;
      }
    });
    const finish = () => resolve({ buf: Buffer.concat(out), truncated });
    z.on('end', finish);
    z.on('close', finish);
    z.on('error', finish);
    z.end(buf);
  });
}

const isGzip = (buf) => buf[0] === 0x1f && buf[1] === 0x8b;

export async function readText(res, limit) {
  let { buf, truncated } = await readBody(res, limit);
  const bytes = buf.length;
  if (isGzip(buf)) {
    const inflated = await gunzipCapped(buf, limit);
    buf = inflated.buf;
    truncated ||= inflated.truncated;
  }
  return { text: decode(buf, res.headers.get('content-type') || ''), bytes, truncated };
}
