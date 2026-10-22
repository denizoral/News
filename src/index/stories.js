// Stable story ids and a log of every story that reached the feed.
//
// The feed re-clusters items several times a minute and a story's lead
// article can change as coverage arrives, so the cluster's own id isn't a
// usable link. Instead every item URL that has ever been in a story maps to a
// short story id (sid) — the one its story had when it first appeared. A
// rebuilt cluster takes the sid most of its items already carry, so links
// survive new sources, lead changes and merges, and (through story_log and the
// stored documents) the story leaving the live feed.

import crypto from 'node:crypto';
import { q, tx } from '../db.js';

const DAY = 86400e3;
const LOG_EVERY_MS = 5 * 60e3;

export const sidOf = (seed) => crypto.createHash('sha1').update(String(seed)).digest('base64url').slice(0, 10);

export class StoryIds {
  constructor() {
    this.byUrl = new Map(); // item url -> sid
    this.logged = new Map(); // sid -> { at, sig } of the last story_log write
    this.loadedSince = null;
  }

  // Items in the live feed are at most a few days old; a week of links covers them.
  load(now = Date.now()) {
    if (this.loadedSince != null) return;
    this.loadedSince = now - 7 * DAY;
    for (const r of q('SELECT item_url, sid FROM story_ids WHERE at >= ?').all(this.loadedSince)) this.byUrl.set(r.item_url, r.sid);
  }

  // Sets `sid` on every story (each has `_group`, its items) and records new
  // links and changed stories. Returns the number of new links.
  assign(stories, { now = Date.now(), section = 'news' } = {}) {
    this.load(now);
    const links = [];
    const logs = [];
    for (const s of stories) {
      const urls = s._group.map((it) => it.url).filter(Boolean);
      // The sid most items already carry; ties go to the earliest item's.
      const votes = new Map();
      for (const it of [...s._group].sort((a, b) => (a.publishedAt || 0) - (b.publishedAt || 0))) {
        const sid = this.byUrl.get(it.url);
        if (sid) votes.set(sid, (votes.get(sid) || 0) + 1);
      }
      let sid = null;
      for (const [k, n] of votes) if (!sid || n > votes.get(sid)) sid = k;
      sid ||= sidOf(s.id);
      s.sid = sid;
      for (const u of urls) {
        if (this.byUrl.has(u)) continue;
        this.byUrl.set(u, sid);
        links.push([u, sid]);
      }
      const sig = `${s.title}|${s.sources.length}|${s.updatedAt}|${(s.markets || []).length}`;
      const last = this.logged.get(sid);
      if (!last || (last.sig !== sig && now - last.at > LOG_EVERY_MS)) {
        this.logged.set(sid, { at: now, sig });
        logs.push([sid, s, section]);
      }
    }
    if (links.length || logs.length) {
      const link = q('INSERT OR IGNORE INTO story_ids (item_url, sid, at) VALUES (?, ?, ?)');
      const log = q(`INSERT INTO story_log (sid, title, url, summary, image, section, topics, entities, markets, first_at, last_at, sources, seen_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(sid) DO UPDATE SET title = excluded.title, url = excluded.url, summary = excluded.summary, image = COALESCE(excluded.image, image),
          topics = excluded.topics, entities = excluded.entities, markets = excluded.markets, first_at = MIN(first_at, excluded.first_at),
          last_at = MAX(last_at, excluded.last_at), sources = MAX(sources, excluded.sources), seen_at = excluded.seen_at`);
      tx(() => {
        for (const [u, sid] of links) link.run(u, sid, now);
        for (const [sid, s, sec] of logs) {
          log.run(sid, s.title, s.url, s.summary || '', s.image || null, sec, JSON.stringify(s.topics || []), JSON.stringify(s.entities || []),
            JSON.stringify((s.markets || []).map((m) => m.id)), s.publishedAt, s.updatedAt, s.sources.length, now);
        }
      });
    }
    return links.length;
  }
}

// A logged story and the URLs of every item that was ever part of it.
export function loggedStory(sid) {
  const row = q('SELECT * FROM story_log WHERE sid = ?').get(sid);
  if (!row) return null;
  const parse = (s) => { try { return JSON.parse(s || '[]'); } catch { return []; } };
  return {
    sid,
    title: row.title,
    url: row.url,
    summary: row.summary,
    image: row.image,
    section: row.section,
    topics: parse(row.topics),
    entities: parse(row.entities),
    marketIds: parse(row.markets),
    publishedAt: row.first_at,
    updatedAt: row.last_at,
    urls: q('SELECT item_url FROM story_ids WHERE sid = ?').all(sid).map((r) => r.item_url),
  };
}

export function sidForUrl(url) {
  return q('SELECT sid FROM story_ids WHERE item_url = ?').get(url)?.sid || null;
}
