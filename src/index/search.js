// Search over the permanent index.
//
// Query language (Google-style):
//   openai gpt          all words (stemmed: "models" matches "model")
//   "open weights"      exact phrase
//   -rumor              exclude a word
//   gemini OR claude    either
//   site:theverge.com   one site (and its subdomains)
//   type:news           news | posts | builds | models | markets
//   intitle:agent       word must be in the title
//
// Ranking: BM25 (title weighted 10×, description 4×, body 1×), then reranked by
// inbound links from other sites, engagement and freshness.

import { q } from '../db.js';
import { settings } from '../settings.js';

const copiesOn = () => settings.get('storage.cachedCopies');

const TYPE_ALIASES = { news: 'article', article: 'article', articles: 'article', posts: 'post', post: 'post', social: 'post', builds: 'build', build: 'build', projects: 'build', models: 'model', model: 'model', markets: 'market', market: 'market' };
const TIME = { day: 86400e3, week: 7 * 86400e3, month: 30 * 86400e3, year: 365 * 86400e3 };

const quote = (s) => `"${s.replace(/"/g, '""')}"`;

export function parseQuery(input = '', { prefix = false } = {}) {
  const out = { terms: [], phrases: [], exclude: [], site: null, type: null, intitle: [], or: false, raw: input.trim() };
  const re = /(-?)(?:(\w+):)?(?:"([^"]*)"|(\S+))/g;
  let m;
  while ((m = re.exec(input))) {
    const [, neg, op, phrase, word] = m;
    const value = (phrase ?? word ?? '').trim();
    if (!value) continue;
    const opl = op?.toLowerCase();
    if (opl === 'site') out.site = value.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
    else if (opl === 'type') out.type = TYPE_ALIASES[value.toLowerCase()] || null;
    else if (opl === 'intitle') out.intitle.push(value);
    else if (op) out.terms.push(`${op} ${value}`.split(/\s+/).join(' ')); // unknown operator: treat as words
    else if (value === 'OR' && !neg) out.or = true;
    else if (neg) out.exclude.push(value);
    else if (phrase != null) out.phrases.push(value);
    else out.terms.push(value);
  }
  // Strip characters FTS5 treats as syntax inside bare words.
  out.terms = out.terms.flatMap((t) => t.split(/[^\p{L}\p{N}.+#-]+/u)).map((t) => t.replace(/^[.+-]+|[.+-]+$/g, '')).filter(Boolean);
  out.prefix = prefix && !/\s$/.test(input) && out.terms.length > 0;
  return out;
}

export function toMatch(p, { loose = false } = {}) {
  const parts = [];
  p.terms.forEach((t, i) => parts.push(quote(t) + (p.prefix && i === p.terms.length - 1 ? '*' : '')));
  for (const ph of p.phrases) parts.push(quote(ph));
  for (const t of p.intitle) parts.push(`title : ${quote(t)}`);
  if (!parts.length) return null;
  let expr = parts.join(p.or || loose ? ' OR ' : ' ');
  if (p.or || loose) expr = `(${expr})`;
  for (const x of p.exclude) expr += ` NOT ${quote(x)}`;
  return expr;
}

function esc(s = '') {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// FTS snippets come back with \u0002/\u0003 around hits; turn them into safe <b>.
function markSnippet(s) {
  return esc(s || '').replace(/\u0002/g, '<b>').replace(/\u0003/g, '</b>').replace(/\s+/g, ' ').trim();
}

function filters(p, opts, { skipType = false } = {}) {
  // Moderated (hidden) documents never reach the public site.
  const where = opts.includeHidden ? [] : ['d.hidden = 0'];
  const args = [];
  const type = skipType ? null : p.type || TYPE_ALIASES[opts.type] || null;
  if (type) {
    where.push('d.type = ?');
    args.push(type);
  } else if (!skipType && opts.excludeMarkets) {
    where.push("d.type != 'market'");
  }
  if (p.site) {
    where.push('(d.site = ? OR d.site LIKE ?)');
    args.push(p.site, `%.${p.site}`);
  }
  if (TIME[opts.time]) {
    where.push('COALESCE(d.published_at, d.first_seen) >= ?');
    args.push(Date.now() - TIME[opts.time]);
  }
  return { where, args };
}

function shape(r, now) {
  let meta = null;
  try {
    meta = r.meta ? JSON.parse(r.meta) : null;
  } catch { /* ignore */ }
  const snippet = [r.snip_body, r.snip_desc].find((s) => s && s.includes('\u0002')) || r.snip_desc || r.snip_body || '';
  return {
    id: r.id,
    url: r.url,
    type: r.type,
    title: r.title,
    snippet: markSnippet(snippet),
    site: r.site,
    source: r.source,
    author: r.author || null,
    // Only real publish dates are shown; first sight is used for ranking only.
    publishedAt: r.published_at || null,
    image: r.image_hash ? `media/${r.image_hash}` : r.image_url || null,
    words: r.word_count,
    crawled: !!r.fetched_at,
    cached: !!r.fetched_at && !r.noarchive && copiesOn(),
    inlinks: r.inlinks || 0,
    meta,
    _age: (now - (r.published_at || r.first_seen)) / 86400e3,
  };
}

// Snippets are the costly part of a query (~300 ms for 400 candidates), so
// they're built only for the page actually returned.
const SNIPPETS = `snippet(docs_fts, 2, char(2), char(3), '…', 28) AS snip_body,
        snippet(docs_fts, 1, char(2), char(3), '…', 28) AS snip_desc`;

const SELECT = `SELECT d.id, d.url, d.type, d.title, d.site, d.source, d.author, d.published_at, d.first_seen, d.image_hash, d.image_url,
  d.engagement, d.meta, d.word_count, d.fetched_at, d.noarchive, COALESCE(i.n, 0) AS inlinks`;

export function search(input, opts = {}) {
  const started = performance.now();
  const now = Date.now();
  const page = Math.max(1, Number(opts.page) || 1);
  const perPage = Math.min(50, Number(opts.perPage) || 20);
  const sort = opts.sort === 'date' ? 'date' : 'relevance';
  const p = parseQuery(input, { prefix: !!opts.instant });
  const f = filters(p, opts);

  let match = toMatch(p);
  if (!match) return browse(p, f, { page, perPage, started });

  const run = (expr) => {
    const where = ['docs_fts MATCH ?', ...f.where].join(' AND ');
    const args = [expr, ...f.args];
    // Per-type counts for the tabs ignore the type filter itself.
    const ff = filters(p, opts, { skipType: true });
    const facets = q(`SELECT d.type, COUNT(*) AS n FROM docs_fts JOIN docs d ON d.id = docs_fts.rowid WHERE ${['docs_fts MATCH ?', ...ff.where].join(' AND ')} GROUP BY d.type`)
      .all(expr, ...ff.args);
    const type = p.type || TYPE_ALIASES[opts.type];
    const total = facets.filter((x) => !type || x.type === type).reduce((a, b) => a + b.n, 0);
    if (sort === 'date') {
      // The page first, by date alone; columns, inlinks and snippets only for
      // its rows (scoring every match first took ~1 s on common words).
      const rows = q(`${SELECT}, 0 AS rank FROM docs d LEFT JOIN inlinks i ON i.url = d.url
        WHERE d.id IN (SELECT d.id FROM docs_fts JOIN docs d ON d.id = docs_fts.rowid WHERE ${where} ORDER BY COALESCE(d.published_at, d.first_seen) DESC LIMIT ? OFFSET ?)
        ORDER BY COALESCE(d.published_at, d.first_seen) DESC`).all(...args, perPage, (page - 1) * perPage);
      return { rows, total, facets };
    }
    const rows = q(`${SELECT}, bm25(docs_fts, 10.0, 4.0, 1.0, 2.0, 2.0) AS rank, NULL AS snip_body, NULL AS snip_desc
      FROM docs_fts JOIN docs d ON d.id = docs_fts.rowid LEFT JOIN inlinks i ON i.url = d.url
      WHERE ${where} ORDER BY rank LIMIT 400`).all(...args);
    return { rows, total, facets };
  };

  let res;
  try {
    res = run(match);
  } catch (err) {
    return { query: p.raw, error: `Couldn't read that query: ${err.message}`, results: [], total: 0, facets: {}, tookMs: 0 };
  }
  let loosened = false;
  if (!res.rows.length && p.terms.length > 1 && !p.or) {
    // Nothing has every word: fall back to any word, ranked by how many match.
    match = toMatch(p, { loose: true });
    res = run(match);
    loosened = res.rows.length > 0;
  }

  let results = res.rows.map((r) => ({ ...shape(r, now), _rank: -r.rank, _eng: r.engagement }));
  if (sort === 'relevance') {
    for (const r of results) {
      const authority = 1 + 0.18 * Math.log1p(r.inlinks);
      const engagement = 1 + 0.04 * Math.log1p(r._eng || 0);
      const fresh = r.type === 'market' || r.type === 'model' ? 1 : 0.55 + 0.45 * Math.exp(-r._age / 10);
      const depth = r.crawled ? 1.08 : 1;
      r._score = r._rank * authority * engagement * fresh * depth;
    }
    results.sort((a, b) => b._score - a._score);
    // Collapse identical headlines from mirrors and syndication.
    const seen = new Set();
    results = results.filter((r) => {
      const k = r.title.toLowerCase().replace(/\W+/g, ' ').trim();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    results = results.slice((page - 1) * perPage, page * perPage);
  }
  // Snippets only for the page returned.
  if (results.length) {
    const ids = results.map((r) => r.id);
    const snips = new Map(q(`SELECT rowid AS id, ${SNIPPETS} FROM docs_fts WHERE docs_fts MATCH ? AND rowid IN (${ids.map(() => '?').join(',')})`)
      .all(match, ...ids).map((x) => [x.id, x]));
    const raw = new Map(res.rows.map((r) => [r.id, r]));
    results = results.map((r) => ({ ...r, snippet: shape({ ...raw.get(r.id), ...snips.get(r.id) }, now).snippet }));
  }

  return {
    query: p.raw,
    parsed: { site: p.site, type: p.type, phrases: p.phrases, exclude: p.exclude },
    loosened,
    total: res.total,
    facets: Object.fromEntries(res.facets.map((x) => [x.type, x.n])),
    page,
    perPage,
    results: results.map(({ _age, _rank, _eng, _score, ...r }) => r),
    tookMs: +(performance.now() - started).toFixed(1),
  };
}

// No words, only filters (e.g. "site:openai.com"): newest first.
function browse(p, f, { page, perPage, started }) {
  const where = f.where.length ? `WHERE ${f.where.join(' AND ')}` : '';
  const rows = q(`${SELECT}, NULL AS snip_body, d.description AS snip_desc FROM docs d LEFT JOIN inlinks i ON i.url = d.url ${where}
    ORDER BY COALESCE(d.published_at, d.first_seen) DESC LIMIT ? OFFSET ?`).all(...f.args, perPage, (page - 1) * perPage);
  const total = q(`SELECT COUNT(*) AS n FROM docs d ${where}`).get(...f.args).n;
  const now = Date.now();
  return {
    query: p.raw, parsed: { site: p.site, type: p.type }, total, facets: {}, page, perPage,
    results: rows.map((r) => { const { _age, ...x } = shape(r, now); return x; }),
    tookMs: +(performance.now() - started).toFixed(1),
  };
}

export function searchImages(input, opts = {}) {
  const started = performance.now();
  const page = Math.max(1, Number(opts.page) || 1);
  const perPage = Math.min(80, Number(opts.perPage) || 40);
  const p = parseQuery(input);
  const match = toMatch(p);
  const where = ["im.status = 'stored'", 'NOT EXISTS (SELECT 1 FROM docs dd WHERE dd.id = im.doc_id AND dd.hidden = 1)'];
  const args = [];
  if (p.site) {
    where.push('(im.site = ? OR im.site LIKE ?)');
    args.push(p.site, `%.${p.site}`);
  }
  if (TIME[opts.time]) {
    where.push('COALESCE(im.published_at, im.discovered_at) >= ?');
    args.push(Date.now() - TIME[opts.time]);
  }
  let rows;
  let total;
  if (match) {
    rows = q(`SELECT im.*, bm25(images_fts, 4.0, 3.0, 2.0, 1.0) AS rank FROM images_fts JOIN images im ON im.id = images_fts.rowid
      WHERE images_fts MATCH ? AND ${where.join(' AND ')} ORDER BY rank LIMIT ? OFFSET ?`).all(match, ...args, perPage * 3, (page - 1) * perPage);
    total = q(`SELECT COUNT(*) AS n FROM images_fts JOIN images im ON im.id = images_fts.rowid WHERE images_fts MATCH ? AND ${where.join(' AND ')}`).get(match, ...args).n;
  } else {
    rows = q(`SELECT im.* FROM images im WHERE ${where.join(' AND ')} ORDER BY im.fetched_at DESC LIMIT ? OFFSET ?`).all(...args, perPage * 3, (page - 1) * perPage);
    total = q(`SELECT COUNT(*) AS n FROM images im WHERE ${where.join(' AND ')}`).get(...args).n;
  }
  // The same picture often appears on several pages; show it once.
  const seen = new Set();
  const results = [];
  for (const r of rows) {
    // Same bytes, or the same page's untitled variants (og:image plus inline copy).
    const variant = `${r.page_url}|${r.alt || ''}`;
    if (seen.has(r.hash) || seen.has(variant)) continue;
    seen.add(r.hash);
    seen.add(variant);
    results.push({ id: r.id, src: `media/${r.hash}.${r.ext}`, original: r.url, width: r.width, height: r.height, alt: r.alt || r.caption || r.page_title, pageUrl: r.page_url, pageTitle: r.page_title, site: r.site, publishedAt: r.published_at });
    if (results.length >= perPage) break;
  }
  return { query: p.raw, total, page, perPage, results, tookMs: +(performance.now() - started).toFixed(1) };
}

// Instant suggestions: headlines whose title matches what's typed so far.
export function suggest(input, limit = 8) {
  const p = parseQuery(input, { prefix: true });
  if (!p.terms.length && !p.phrases.length) return [];
  const parts = [...p.terms.map((t, i) => quote(t) + (p.prefix && i === p.terms.length - 1 ? '*' : '')), ...p.phrases.map(quote)];
  const expr = `title : (${parts.join(' ')})`;
  try {
    return q(`SELECT d.id, d.title, d.url, d.type, d.site FROM docs_fts JOIN docs d ON d.id = docs_fts.rowid
      WHERE docs_fts MATCH ? AND d.hidden = 0 ORDER BY bm25(docs_fts, 10.0, 1.0, 0.0, 0.0, 0.0) + (COALESCE(d.published_at, d.first_seen) < ?) LIMIT ?`)
      .all(expr, Date.now() - 14 * 86400e3, limit)
      .map((r) => ({ id: r.id, title: r.title, url: r.url, type: r.type, site: r.site }));
  } catch {
    return [];
  }
}

export function getDoc(id) {
  const r = q('SELECT d.*, COALESCE(i.n, 0) AS inlinks FROM docs d LEFT JOIN inlinks i ON i.url = d.url WHERE d.id = ?').get(Number(id));
  if (!r || r.hidden) return null;
  const allowCopy = copiesOn() && !r.noarchive && r.fetched_at;
  const images = q("SELECT hash, ext, alt, caption, width, height FROM images WHERE doc_id = ? AND status = 'stored' LIMIT 8").all(r.id)
    .map((i) => ({ src: `media/${i.hash}.${i.ext}`, alt: i.alt, caption: i.caption, width: i.width, height: i.height }));
  return {
    id: r.id, url: r.url, type: r.type, title: r.title, description: r.description, site: r.site, source: r.source, author: r.author,
    publishedAt: r.published_at || r.first_seen, fetchedAt: r.fetched_at, words: r.word_count, inlinks: r.inlinks,
    image: r.image_hash ? `media/${r.image_hash}` : r.image_url, images,
    body: allowCopy ? r.body : null,
    copyAvailable: !!allowCopy,
  };
}

// The "All" tab: web results, with markets and images in their own boxes
// above them (like a universal results page), so neither crowds out articles.
export function universal(input, opts = {}) {
  const p = parseQuery(input);
  const typed = p.type || TYPE_ALIASES[opts.type];
  if (typed) return search(input, opts);
  const main = search(input, { ...opts, excludeMarkets: true });
  if (!main.query || (Number(opts.page) || 1) > 1) return main;
  const markets = search(input, { ...opts, type: 'market', perPage: 3 }).results;
  const images = p.terms.length || p.phrases.length ? searchImages(input, { ...opts, perPage: 8 }).results : [];
  return { ...main, boxes: { markets, images } };
}
