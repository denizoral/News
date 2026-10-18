// Editing what the site shows: fix a headline, hide or remove a story, pin it
// to the top. Hand edits lock the document so crawlers can't overwrite them;
// removals leave a tombstone so the next feed refresh can't bring them back.

import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { q, tx } from '../db.js';
import { parseQuery, toMatch } from '../index/search.js';
import { mediaPath } from '../spider/media.js';
import { HttpError } from '../security/httpkit.js';

export const contentEvents = new EventEmitter();

const TYPES = ['article', 'post', 'build', 'model', 'market'];
const STATES = {
  all: '1 = 1',
  visible: 'd.hidden = 0',
  hidden: 'd.hidden = 1',
  pinned: 'd.pinned = 1',
  edited: 'd.locked = 1 AND d.hidden = 0',
  crawled: 'd.fetched_at IS NOT NULL',
};

const COLS = `d.id, d.url, d.type, d.title, d.description, d.site, d.source, d.author, d.published_at, d.first_seen, d.fetched_at,
  d.word_count, d.hidden, d.pinned, d.locked, d.edited_at, d.edited_by, d.image_hash, d.image_url`;

const shape = (r) => ({
  id: r.id, url: r.url, type: r.type, title: r.title, description: r.description, site: r.site, source: r.source, author: r.author,
  publishedAt: r.published_at, firstSeen: r.first_seen, crawledAt: r.fetched_at, words: r.word_count,
  hidden: !!r.hidden, pinned: !!r.pinned, locked: !!r.locked, editedAt: r.edited_at, editedBy: r.edited_by,
  image: r.image_hash ? `media/${r.image_hash}` : r.image_url,
});

export function listContent({ search = '', type = '', state = 'all', page = 1 } = {}) {
  const per = 50;
  const off = (Math.max(1, Math.min(1000, Number(page) || 1)) - 1) * per;
  const where = [STATES[state] || STATES.all];
  const args = [];
  if (TYPES.includes(type)) {
    where.push('d.type = ?');
    args.push(type);
  }
  const match = search ? toMatch(parseQuery(String(search).slice(0, 256))) : null;
  if (match) {
    const rows = q(`SELECT ${COLS} FROM docs_fts JOIN docs d ON d.id = docs_fts.rowid WHERE docs_fts MATCH ? AND ${where.join(' AND ')}
      ORDER BY bm25(docs_fts, 10.0, 4.0, 1.0, 2.0, 2.0) LIMIT ? OFFSET ?`).all(match, ...args, per, off);
    const total = q(`SELECT COUNT(*) AS n FROM docs_fts JOIN docs d ON d.id = docs_fts.rowid WHERE docs_fts MATCH ? AND ${where.join(' AND ')}`).get(match, ...args).n;
    return { total, page: off / per + 1, perPage: per, items: rows.map(shape) };
  }
  const rows = q(`SELECT ${COLS} FROM docs d WHERE ${where.join(' AND ')} ORDER BY COALESCE(d.edited_at, 0) DESC, COALESCE(d.published_at, d.first_seen) DESC LIMIT ? OFFSET ?`).all(...args, per, off);
  const total = q(`SELECT COUNT(*) AS n FROM docs d WHERE ${where.join(' AND ')}`).get(...args).n;
  return { total, page: off / per + 1, perPage: per, items: rows.map(shape) };
}

export function getContent(id) {
  const r = q(`SELECT ${COLS}, d.body FROM docs d WHERE d.id = ?`).get(Number(id));
  if (!r) throw new HttpError(404, 'No document with that id.');
  return { ...shape(r), bodyPreview: (r.body || '').slice(0, 4000), images: q("SELECT id, url, hash, ext, alt, status FROM images WHERE doc_id = ? LIMIT 20").all(r.id) };
}

const clean = (s) => String(s).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();

export function updateContent(id, patch, actor) {
  const before = getContent(id);
  if (before.hidden && before.locked && patch.hidden !== false) throw new HttpError(409, 'This document was removed. Restore it before editing.');
  const sets = [];
  const args = [];
  const after = {};
  if ('title' in patch) {
    const t = clean(patch.title ?? '');
    if (t.length < 3 || t.length > 300) throw new HttpError(400, 'Titles are 3 to 300 characters.');
    sets.push('title = ?'); args.push(t); after.title = t;
  }
  if ('description' in patch) {
    const d = clean(patch.description ?? '');
    if (d.length > 1000) throw new HttpError(400, 'Descriptions are at most 1000 characters.');
    sets.push('description = ?'); args.push(d); after.description = d;
  }
  if ('type' in patch) {
    if (!TYPES.includes(patch.type)) throw new HttpError(400, `Type must be one of ${TYPES.join(', ')}.`);
    sets.push('type = ?'); args.push(patch.type); after.type = patch.type;
  }
  for (const flag of ['hidden', 'pinned']) {
    if (flag in patch) {
      if (typeof patch[flag] !== 'boolean') throw new HttpError(400, `${flag} must be true or false.`);
      sets.push(`${flag} = ?`); args.push(patch[flag] ? 1 : 0); after[flag] = patch[flag];
    }
  }
  if ('locked' in patch) {
    if (typeof patch.locked !== 'boolean') throw new HttpError(400, 'locked must be true or false.');
    sets.push('locked = ?'); args.push(patch.locked ? 1 : 0); after.locked = patch.locked;
  } else if ('title' in after || 'description' in after) {
    sets.push('locked = 1'); after.locked = true;
  }
  if (!sets.length) throw new HttpError(400, 'Nothing to change.');
  sets.push('edited_at = ?', 'edited_by = ?');
  args.push(Date.now(), actor);
  q(`UPDATE docs SET ${sets.join(', ')} WHERE id = ?`).run(...args, before.id);
  contentEvents.emit('change', { id: before.id });
  const changed = Object.fromEntries(Object.keys(after).map((k) => [k, { before: before[k], after: after[k] }]));
  return { doc: getContent(before.id), changed };
}

// Removes stored text and images but keeps a hidden, locked tombstone.
export function removeContent(id, actor) {
  const before = getContent(id);
  const imgs = q('SELECT id, hash, ext FROM images WHERE doc_id = ?').all(before.id);
  tx(() => {
    q("UPDATE docs SET hidden = 1, locked = 1, pinned = 0, body = '', description = '', image_url = NULL, image_hash = NULL, edited_at = ?, edited_by = ? WHERE id = ?").run(Date.now(), actor, before.id);
    q('DELETE FROM images WHERE doc_id = ?').run(before.id);
  });
  for (const im of imgs) {
    if (!im.hash || q("SELECT 1 FROM images WHERE hash = ? LIMIT 1").get(im.hash)) continue;
    try { fs.unlinkSync(mediaPath(im.hash, im.ext)); } catch { /* gone */ }
  }
  contentEvents.emit('change', { id: before.id });
  return { id: before.id, title: before.title, url: before.url, images: imgs.length };
}

export function contentCounts() {
  return q(`SELECT COUNT(*) AS total, SUM(hidden) AS hidden, SUM(pinned) AS pinned, SUM(CASE WHEN locked = 1 AND hidden = 0 THEN 1 ELSE 0 END) AS edited,
    SUM(CASE WHEN fetched_at IS NOT NULL THEN 1 ELSE 0 END) AS crawled FROM docs`).get();
}
