// Enforces the storage limits set in the dashboard: document age, total
// document count, and the image budget. Pinned and hand-edited documents are
// never deleted. Runs hourly and on demand.

import fs from 'node:fs';
import { q, tx, getDb } from '../db.js';
import { settings } from '../settings.js';
import { enforceBudget, mediaPath } from '../spider/media.js';

const BATCH = 5000;

function deleteDocs(where, args) {
  let total = 0;
  for (;;) {
    const ids = q(`SELECT id FROM docs WHERE pinned = 0 AND locked = 0 AND ${where} LIMIT ${BATCH}`).all(...args).map((r) => r.id);
    if (!ids.length) break;
    tx(() => {
      const del = q('DELETE FROM docs WHERE id = ?');
      for (const id of ids) del.run(id);
    });
    total += ids.length;
    if (ids.length < BATCH) break;
  }
  return total;
}

// Images whose document is gone. Files are removed once nothing else uses them.
function deleteOrphanImages() {
  const orphans = q('SELECT id, hash, ext FROM images WHERE doc_id IS NOT NULL AND doc_id NOT IN (SELECT id FROM docs) LIMIT 20000').all();
  let files = 0;
  tx(() => {
    for (const o of orphans) q('DELETE FROM images WHERE id = ?').run(o.id);
  });
  for (const o of orphans) {
    if (!o.hash) continue;
    if (q("SELECT 1 FROM images WHERE hash = ? AND status = 'stored' LIMIT 1").get(o.hash)) continue;
    try {
      fs.unlinkSync(mediaPath(o.hash, o.ext));
      files++;
    } catch { /* already gone */ }
  }
  return { rows: orphans.length, files };
}

export function runRetention() {
  const started = Date.now();
  const out = { byAge: 0, byCount: 0, images: { rows: 0, files: 0 }, evicted: 0 };
  const days = settings.get('storage.docRetentionDays');
  if (days > 0) out.byAge = deleteDocs('COALESCE(published_at, first_seen) < ?', [Date.now() - days * 86400e3]);
  const max = settings.get('storage.maxDocs');
  if (max > 0) {
    const n = q('SELECT COUNT(*) AS n FROM docs').get().n;
    if (n > max) {
      // Find the cut-off date that leaves `max` documents, then delete older ones.
      const cut = q('SELECT COALESCE(published_at, first_seen) AS t FROM docs ORDER BY t DESC LIMIT 1 OFFSET ?').get(max);
      if (cut) out.byCount = deleteDocs('COALESCE(published_at, first_seen) <= ?', [cut.t]);
    }
  }
  out.images = deleteOrphanImages();
  out.evicted = enforceBudget();
  out.ms = Date.now() - started;
  return out;
}

export function optimizeIndex() {
  const d = getDb();
  d.exec("INSERT INTO docs_fts(docs_fts) VALUES('optimize'); INSERT INTO images_fts(images_fts) VALUES('optimize'); PRAGMA optimize;");
}

let timer = null;
export function startRetention() {
  timer = setInterval(() => {
    try {
      const r = runRetention();
      if (r.byAge || r.byCount || r.images.rows || r.evicted) console.log('[retention]', JSON.stringify(r));
    } catch (e) {
      console.warn('[retention] failed', e.message);
    }
  }, 3600e3);
  timer.unref();
}
