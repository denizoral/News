// Permanent storage: one SQLite file (WAL mode) holding every document the site
// has seen, the crawl frontier, per-host politeness state, and image records.
// Full-text search runs on SQLite FTS5 with Porter stemming.

import fs from 'node:fs';
import path from 'node:path';

// node:sqlite prints an ExperimentalWarning on first use; it's stable enough for us.
const origEmit = process.emitWarning;
process.emitWarning = (w, ...a) => (String(w).includes('SQLite') ? undefined : origEmit.call(process, w, ...a));
const { DatabaseSync } = await import('node:sqlite');
process.emitWarning = origEmit;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS docs (
  id INTEGER PRIMARY KEY,
  url TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,            -- article | post | build | model | market
  title TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  site TEXT NOT NULL DEFAULT '',
  source TEXT,
  author TEXT NOT NULL DEFAULT '',
  lang TEXT,
  image_url TEXT,
  image_hash TEXT,
  published_at INTEGER,
  first_seen INTEGER NOT NULL,
  fetched_at INTEGER,            -- set when the spider fetched the page itself
  word_count INTEGER NOT NULL DEFAULT 0,
  content_hash TEXT,
  engagement REAL NOT NULL DEFAULT 0,
  noarchive INTEGER NOT NULL DEFAULT 0,
  meta TEXT
);
CREATE INDEX IF NOT EXISTS docs_type_pub ON docs(type, published_at DESC);
CREATE INDEX IF NOT EXISTS docs_pub ON docs(published_at DESC);
CREATE INDEX IF NOT EXISTS docs_site ON docs(site);
CREATE INDEX IF NOT EXISTS docs_hash ON docs(content_hash);

CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(
  title, description, body, site, author,
  content='docs', content_rowid='id',
  tokenize='porter unicode61 remove_diacritics 2', prefix='2 3 4'
);
CREATE TRIGGER IF NOT EXISTS docs_ai AFTER INSERT ON docs BEGIN
  INSERT INTO docs_fts(rowid, title, description, body, site, author) VALUES (new.id, new.title, new.description, new.body, new.site, new.author);
END;
CREATE TRIGGER IF NOT EXISTS docs_ad AFTER DELETE ON docs BEGIN
  INSERT INTO docs_fts(docs_fts, rowid, title, description, body, site, author) VALUES ('delete', old.id, old.title, old.description, old.body, old.site, old.author);
END;
CREATE TRIGGER IF NOT EXISTS docs_au AFTER UPDATE OF title, description, body, site, author ON docs BEGIN
  INSERT INTO docs_fts(docs_fts, rowid, title, description, body, site, author) VALUES ('delete', old.id, old.title, old.description, old.body, old.site, old.author);
  INSERT INTO docs_fts(rowid, title, description, body, site, author) VALUES (new.id, new.title, new.description, new.body, new.site, new.author);
END;

-- Links between hosts: inbound links from other sites are an authority signal.
CREATE TABLE IF NOT EXISTS inlinks (
  url TEXT PRIMARY KEY,
  n INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS frontier (
  url TEXT PRIMARY KEY,
  host TEXT NOT NULL,
  kind TEXT NOT NULL,            -- hub | article | sitemap
  priority REAL NOT NULL,
  depth INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'queued',  -- queued | fetching | done | error | blocked
  next_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  http_status INTEGER,
  etag TEXT,
  last_modified TEXT,
  discovered_at INTEGER NOT NULL,
  fetched_at INTEGER,
  via TEXT,
  error TEXT
);
CREATE INDEX IF NOT EXISTS frontier_ready ON frontier(status, next_at, priority DESC);
CREATE INDEX IF NOT EXISTS frontier_host ON frontier(host, status, priority DESC);

CREATE TABLE IF NOT EXISTS hosts (
  host TEXT PRIMARY KEY,
  robots TEXT,
  robots_status INTEGER,
  robots_fetched_at INTEGER,
  crawl_delay_ms INTEGER,
  next_allowed_at INTEGER NOT NULL DEFAULT 0,
  fetched_today INTEGER NOT NULL DEFAULT 0,
  day TEXT,
  pages INTEGER NOT NULL DEFAULT 0,
  errors INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS images (
  id INTEGER PRIMARY KEY,
  url TEXT NOT NULL UNIQUE,
  page_url TEXT NOT NULL,
  doc_id INTEGER,
  alt TEXT NOT NULL DEFAULT '',
  caption TEXT NOT NULL DEFAULT '',
  page_title TEXT NOT NULL DEFAULT '',
  site TEXT NOT NULL DEFAULT '',
  hash TEXT,
  ext TEXT,
  mime TEXT,
  width INTEGER,
  height INTEGER,
  bytes INTEGER,
  status TEXT NOT NULL DEFAULT 'queued',  -- queued | stored | skipped | error
  published_at INTEGER,
  discovered_at INTEGER NOT NULL,
  fetched_at INTEGER
);
CREATE INDEX IF NOT EXISTS images_status ON images(status, discovered_at);
CREATE INDEX IF NOT EXISTS images_hash ON images(hash);

CREATE VIRTUAL TABLE IF NOT EXISTS images_fts USING fts5(
  alt, caption, page_title, site,
  content='images', content_rowid='id',
  tokenize='porter unicode61 remove_diacritics 2', prefix='2 3'
);
CREATE TRIGGER IF NOT EXISTS images_ai AFTER INSERT ON images BEGIN
  INSERT INTO images_fts(rowid, alt, caption, page_title, site) VALUES (new.id, new.alt, new.caption, new.page_title, new.site);
END;
CREATE TRIGGER IF NOT EXISTS images_ad AFTER DELETE ON images BEGIN
  INSERT INTO images_fts(images_fts, rowid, alt, caption, page_title, site) VALUES ('delete', old.id, old.alt, old.caption, old.page_title, old.site);
END;
CREATE TRIGGER IF NOT EXISTS images_au AFTER UPDATE OF alt, caption, page_title, site ON images BEGIN
  INSERT INTO images_fts(images_fts, rowid, alt, caption, page_title, site) VALUES ('delete', old.id, old.alt, old.caption, old.page_title, old.site);
  INSERT INTO images_fts(rowid, alt, caption, page_title, site) VALUES (new.id, new.alt, new.caption, new.page_title, new.site);
END;

CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
`;

let db = null;

export function openDb(file = path.resolve(process.env.DATA_DIR || 'data', 'wire.db')) {
  if (db) return db;
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000; PRAGMA temp_store = MEMORY; PRAGMA cache_size = -64000;');
  db.exec(SCHEMA);
  return db;
}

export function getDb() {
  return db || openDb();
}

// Test helper: swap in a fresh in-memory database.
export function resetDb() {
  db = null;
  return openDb(':memory:');
}

export function tx(fn) {
  const d = getDb();
  d.exec('BEGIN');
  try {
    const out = fn(d);
    d.exec('COMMIT');
    return out;
  } catch (err) {
    d.exec('ROLLBACK');
    throw err;
  }
}

// Prepared statements are cached per SQL string.
const stmts = new Map();
export function q(sql) {
  const d = getDb();
  let s = stmts.get(sql);
  if (!s || s.__db !== d) {
    s = d.prepare(sql);
    s.__db = d;
    stmts.set(sql, s);
  }
  return s;
}
