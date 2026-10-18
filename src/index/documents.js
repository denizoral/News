// Writing documents into the permanent index. Two writers feed it: the
// aggregator (headlines, posts, builds, markets) and the spider (full pages).
// Upserts merge, so a later full-page crawl enriches an earlier headline.

import { q, tx } from '../db.js';
import { canonicalUrl, hostOf } from '../pipeline/text.js';

const MAX_BODY = 60000;

export function upsertDoc(doc) {
  const url = canonicalUrl(doc.url);
  const now = Date.now();
  const prev = q('SELECT id, title, description, body, published_at, image_url, image_hash, author, fetched_at, engagement, type, hidden, locked FROM docs WHERE url = ?').get(url);
  const body = (doc.body || '').slice(0, MAX_BODY);
  if (!prev) {
    const r = q(`INSERT INTO docs (url, type, title, description, body, site, source, author, lang, image_url, image_hash, published_at, first_seen,
      fetched_at, word_count, content_hash, engagement, noarchive, meta) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      url, doc.type, doc.title || '', doc.description || '', body, doc.site || hostOf(url), doc.source || null, doc.author || '', doc.lang || null,
      doc.image_url || null, doc.image_hash || null, doc.published_at || null, now, doc.fetched_at || null,
      doc.word_count || countWords(body), doc.content_hash || null, doc.engagement || 0, doc.noarchive ? 1 : 0, doc.meta ? JSON.stringify(doc.meta) : null,
    );
    return { id: Number(r.lastInsertRowid), created: true };
  }
  // Removed by a moderator: the tombstone stays so feeds can't bring it back.
  if (prev.hidden && prev.locked) return { id: prev.id, created: false };
  // Merge: keep the richer text, the earliest publish time, the best image.
  // Title and description edited by a person (locked) are never overwritten.
  const crawled = !!doc.fetched_at && !prev.locked;
  q(`UPDATE docs SET
      type = ?, title = ?, description = ?, body = ?, author = ?, image_url = ?, image_hash = COALESCE(?, image_hash),
      published_at = ?, fetched_at = COALESCE(?, fetched_at), word_count = ?, content_hash = COALESCE(?, content_hash),
      engagement = ?, noarchive = MAX(noarchive, ?), lang = COALESCE(?, lang), source = COALESCE(source, ?), meta = COALESCE(?, meta)
    WHERE id = ?`).run(
    prev.type === 'article' || doc.type === 'article' ? 'article' : doc.type,
    crawled && doc.title ? doc.title : prev.title || doc.title || '',
    prev.locked ? prev.description : doc.replace || (doc.description || '').length > prev.description.length ? doc.description || '' : prev.description,
    body.length > prev.body.length ? body : prev.body,
    prev.author || doc.author || '',
    prev.image_url || doc.image_url || null,
    doc.image_hash || null,
    minDefined(prev.published_at, doc.published_at),
    doc.fetched_at || null,
    countWords(body.length > prev.body.length ? body : prev.body),
    doc.content_hash || null,
    Math.max(prev.engagement || 0, doc.engagement || 0),
    doc.noarchive ? 1 : 0,
    doc.lang || null,
    doc.source || null,
    doc.meta ? JSON.stringify(doc.meta) : null,
    prev.id,
  );
  return { id: prev.id, created: false };
}

const minDefined = (a, b) => (a && b ? Math.min(a, b) : a || b || null);
const countWords = (s) => (s ? s.split(/\s+/).length : 0);

export function findByContentHash(hash) {
  return hash ? q('SELECT id, url FROM docs WHERE content_hash = ? LIMIT 1').get(hash) : null;
}

export function addInlinks(urls) {
  const s = q('INSERT INTO inlinks (url, n) VALUES (?, 1) ON CONFLICT(url) DO UPDATE SET n = n + 1');
  for (const u of urls) s.run(u);
}

const TYPE_OF = (it) => {
  if (it.section === 'builds') return 'build';
  if (it.section === 'models') return 'model';
  if (it.platform === 'x' || it.platform === 'bluesky') return 'post';
  if (it.platform === 'reddit' || it.platform === 'hn') return 'post';
  return 'article';
};

// Every aggregator item becomes a permanent, searchable document.
export function ingestAggregatorItems(items) {
  let created = 0;
  tx(() => {
    for (const it of items) {
      if (!it?.url || !it.title) continue;
      const type = TYPE_OF(it);
      const r = upsertDoc({
        url: it.url,
        type,
        title: it.title,
        description: it.summary || '',
        body: type === 'post' ? [it.title, it.summary].filter(Boolean).join('\n\n') : '',
        site: it.sourceHost || (it.platform === 'web' ? hostOf(it.url) : hostOf(it.url)),
        source: it.platform === 'x' ? `@${it.handle}` : it.source,
        author: it.author || '',
        image_url: it.image || null,
        published_at: it.publishedAt || null,
        engagement: (it.engagement?.score || 0) + (it.engagement?.comments || 0),
        meta: { platform: it.platform, discussionUrl: it.discussionUrl, linkUrl: it.linkUrl, avatar: it.avatar, handle: it.handle, emoji: it.emoji },
      });
      if (r.created) created++;
    }
  });
  return created;
}

export function ingestMarkets(markets) {
  tx(() => {
    for (const m of markets) {
      upsertDoc({
        url: m.url,
        type: 'market',
        replace: true,
        title: m.title,
        description: m.outcomes.slice(0, 4).map((o) => `${m.binary ? 'Yes' : o.label}: ${Math.round(o.yes * 100)}%`).join(' · '),
        body: m.outcomes.map((o) => o.question).join('\n'),
        site: 'polymarket.com',
        source: 'Polymarket',
        image_url: m.image || null,
        published_at: null,
        engagement: m.volume24h || 0,
        meta: { outcomes: m.outcomes.slice(0, 4), volume24h: m.volume24h, volume: m.volume, endDate: m.endDate, binary: m.binary },
      });
    }
  });
}
