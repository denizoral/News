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

-- Stable story ids. Stories are re-clustered constantly and their lead
-- article can change, so every article ever in a story maps to the id the
-- story first had; a link to the story keeps working after it leaves the feed.
CREATE TABLE IF NOT EXISTS story_ids (
  item_url TEXT PRIMARY KEY,
  sid TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS story_ids_sid ON story_ids(sid);
CREATE TABLE IF NOT EXISTS story_log (
  sid TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  url TEXT,
  summary TEXT,
  image TEXT,
  section TEXT,
  topics TEXT,                   -- JSON arrays
  entities TEXT,
  markets TEXT,                  -- market ids
  first_at INTEGER,
  last_at INTEGER,
  sources INTEGER,
  seen_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS story_log_seen ON story_log(seen_at DESC);

-- Sentence embeddings of articles and posts (title + start of summary), for
-- semantic search and related coverage. v = float32 scale + 384 int8.
CREATE TABLE IF NOT EXISTS doc_vecs (
  seq INTEGER PRIMARY KEY,       -- load order, so readers can pick up only new rows
  doc_id INTEGER NOT NULL UNIQUE,
  v BLOB NOT NULL
);

-- Polymarket odds over time: one row per outcome whenever its price moves
-- (and at least every 30 minutes), plus hourly history backfilled from
-- Polymarket's public price history.
CREATE TABLE IF NOT EXISTS odds (
  market TEXT NOT NULL,          -- pm:<event id>
  outcome TEXT NOT NULL,         -- outcome label
  ts INTEGER NOT NULL,           -- ms
  yes REAL NOT NULL,
  PRIMARY KEY (market, outcome, ts)
) WITHOUT ROWID;

-- One row per crawler fetch, for the dashboard's crawl log. Trimmed by retention.
CREATE TABLE IF NOT EXISTS crawl_log (
  id INTEGER PRIMARY KEY,
  at INTEGER NOT NULL,
  url TEXT NOT NULL,
  host TEXT NOT NULL,
  kind TEXT,
  http_status INTEGER,
  outcome TEXT NOT NULL,      -- indexed | updated | skipped | duplicate | blocked | error | not-modified | sitemap | hub | followed
  reason TEXT,
  ms INTEGER,
  bytes INTEGER,
  depth INTEGER,
  via TEXT
);
CREATE INDEX IF NOT EXISTS crawl_log_at ON crawl_log(at DESC);
CREATE INDEX IF NOT EXISTS crawl_log_host ON crawl_log(host, at DESC);
CREATE INDEX IF NOT EXISTS crawl_log_outcome ON crawl_log(outcome, at DESC);

-- Runtime settings edited from the admin dashboard (JSON values).
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT
);

CREATE TABLE IF NOT EXISTS admin_users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  pw_hash TEXT NOT NULL,
  role TEXT NOT NULL,                       -- owner | admin | editor | viewer
  totp_secret TEXT,                         -- encrypted at rest
  totp_enabled INTEGER NOT NULL DEFAULT 0,
  totp_last_step INTEGER NOT NULL DEFAULT 0,  -- blocks code replay
  recovery_codes TEXT,                      -- JSON array of SHA-256 hashes
  disabled INTEGER NOT NULL DEFAULT 0,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  failed_logins INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  created_by TEXT,
  last_login_at INTEGER,
  password_changed_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS admin_sessions (
  id_hash TEXT PRIMARY KEY,                 -- SHA-256 of the cookie token; the token itself is never stored
  user_id INTEGER NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  csrf TEXT NOT NULL,
  mfa_ok INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  ip TEXT,
  ua TEXT
);
CREATE INDEX IF NOT EXISTS admin_sessions_user ON admin_sessions(user_id);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  at INTEGER NOT NULL,
  user_id INTEGER,
  username TEXT,
  action TEXT NOT NULL,
  target TEXT,
  detail TEXT,
  ip TEXT,
  ua TEXT
);
CREATE INDEX IF NOT EXISTS audit_at ON audit_log(at DESC);
CREATE INDEX IF NOT EXISTS audit_action ON audit_log(action, at DESC);
`;

let db = null;

export function openDb(file = path.resolve(process.env.DATA_DIR || 'data', 'wire.db')) {
  if (db) return db;
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000; PRAGMA temp_store = MEMORY; PRAGMA cache_size = -64000;');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

// Columns added after the first release. SQLite has no ADD COLUMN IF NOT EXISTS.
function migrate(d) {
  const cols = new Set(d.prepare('PRAGMA table_info(docs)').all().map((c) => c.name));
  const add = (name, ddl) => { if (!cols.has(name)) d.exec(`ALTER TABLE docs ADD COLUMN ${ddl}`); };
  add('hidden', 'hidden INTEGER NOT NULL DEFAULT 0');   // removed from the site and search by a moderator
  add('pinned', 'pinned INTEGER NOT NULL DEFAULT 0');   // kept at the top of the feed
  add('locked', 'locked INTEGER NOT NULL DEFAULT 0');   // edited by a person; crawlers must not overwrite title/description
  add('edited_at', 'edited_at INTEGER');
  add('edited_by', 'edited_by TEXT');
  d.exec('CREATE INDEX IF NOT EXISTS docs_moderation ON docs(hidden, pinned, locked)');
  // The few moderated docs, read on every feed rebuild (an OR can't use the index above: 345 ms scan).
  d.exec('CREATE INDEX IF NOT EXISTS docs_moderated ON docs(url) WHERE hidden = 1 OR pinned = 1 OR locked = 1');
  // Recently crawled articles per site, for the spider's hub discovery (4.7 s through the hidden index).
  d.exec('CREATE INDEX IF NOT EXISTS docs_fetched ON docs(fetched_at, type, hidden, site)');
  d.exec('PRAGMA foreign_keys = ON');
}

export function getDb() {
  return db || openDb();
}

// Test helper: swap in a fresh in-memory database.
export function resetDb() {
  db = null;
  return openDb(':memory:');
}

// Folds the write-ahead log back into the database and truncates it. Without
// this, a busy crawler can grow the WAL to tens of MB, and the next start
// after an unclean stop spends seconds replaying it.
export function checkpoint() {
  try {
    return getDb().prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
  } catch {
    return null; // busy readers: try again next time
  }
}

export function closeDb() {
  if (!db) return;
  checkpoint();
  db.close();
  db = null;
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
