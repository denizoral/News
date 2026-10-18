// Image store. Images are downloaded once, identified by the SHA-256 of their
// bytes (so the same picture used by ten articles is stored once), and written
// to data/media/ab/cd/<hash>.<ext>. A byte budget evicts the oldest files.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { get } from '../http.js';
import { q } from '../db.js';

export const MEDIA_DIR = path.resolve(process.env.DATA_DIR || 'data', 'media');
const MAX_IMAGE_BYTES = Number(process.env.MEDIA_MAX_IMAGE_MB || 2) * 1024 * 1024;
const BUDGET_BYTES = (Number(process.env.MEDIA_MAX_GB) || 5) * 1024 ** 3;

const MIME_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'image/avif': 'avif' };

export function mediaPath(hash, ext) {
  return path.join(MEDIA_DIR, hash.slice(0, 2), hash.slice(2, 4), `${hash}.${ext}`);
}

// Read dimensions from the first bytes of the common formats.
export function imageInfo(buf) {
  if (buf.length < 24) return null;
  if (buf[0] === 0x89 && buf.toString('ascii', 1, 4) === 'PNG') return { mime: 'image/png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  if (buf.toString('ascii', 0, 3) === 'GIF') return { mime: 'image/gif', width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = buf.toString('ascii', 12, 16);
    if (chunk === 'VP8X') return { mime: 'image/webp', width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
    if (chunk === 'VP8 ') return { mime: 'image/webp', width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    if (chunk === 'VP8L') {
      const b = buf.readUInt32LE(21);
      return { mime: 'image/webp', width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
    }
    return { mime: 'image/webp', width: null, height: null };
  }
  if (buf.toString('ascii', 4, 12) === 'ftypavif') return { mime: 'image/avif', width: null, height: null };
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      const len = buf.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { mime: 'image/jpeg', height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      }
      i += 2 + len;
    }
    return { mime: 'image/jpeg', width: null, height: null };
  }
  return null;
}

async function readLimited(res, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of res.body) {
    size += chunk.length;
    if (size > limit) throw new Error('image too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function downloadImage(row) {
  const res = await get(row.url, { timeout: 20000, retries: 0, headers: { accept: 'image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8', referer: row.page_url } });
  const buf = await readLimited(res, MAX_IMAGE_BYTES);
  const info = imageInfo(buf);
  if (!info) throw new Error('not a supported image');
  if (info.width && info.height && (info.width < 200 || info.height < 120)) {
    return { status: 'skipped', ...info, bytes: buf.length };
  }
  const hash = crypto.createHash('sha256').update(buf).digest('hex');
  const ext = MIME_EXT[info.mime];
  const file = mediaPath(hash, ext);
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, buf);
  }
  return { status: 'stored', hash, ext, ...info, bytes: buf.length };
}

export function storedBytes() {
  return q("SELECT COALESCE(SUM(bytes), 0) AS b FROM (SELECT DISTINCT hash, bytes FROM images WHERE status = 'stored')").get().b;
}

// Delete the oldest stored images until we're back under budget.
export function enforceBudget() {
  let total = storedBytes();
  if (total <= BUDGET_BYTES) return 0;
  let removed = 0;
  const oldest = q("SELECT hash, ext, MAX(bytes) AS bytes FROM images WHERE status = 'stored' GROUP BY hash ORDER BY MIN(fetched_at) ASC LIMIT 500").all();
  for (const r of oldest) {
    if (total <= BUDGET_BYTES * 0.9) break;
    try {
      fs.unlinkSync(mediaPath(r.hash, r.ext));
    } catch { /* already gone */ }
    q("UPDATE images SET status = 'evicted' WHERE hash = ?").run(r.hash);
    total -= r.bytes;
    removed++;
  }
  return removed;
}
