// Early signals: what X is talking about that the press hasn't covered yet.
// Every AI post from the tracked X accounts in the last 48 hours is compared
// by meaning (bge-small embeddings) with every article stored in the last
// three days. A post with no close article is a signal; posts about the same
// thing (close to each other) are grouped, and a group counts more when more
// accounts post it. Posts whose story the press then picked up are listed
// too, with how long the press took.

import { isAiRelated } from '../pipeline/classify.js';
import { splitOutlet } from '../pipeline/text.js';
import { cachedJob } from './offload.js';

const HOUR = 3600e3;
const TTL_MS = 10 * 60e3;
export const POST_HOURS = 48;
// Cosine (bge-small, title + start of summary) for "the same story".
export const COVERED = 0.8;
export const SAME = 0.82;
// Market accounts post every kind of news; only their AI posts count.
const MARKETS = new Set(['polymarket', 'kalshi']);

export function computeSignals(db, { vi, now = Date.now() } = {}) {
  const posts = db.prepare(`SELECT id, title, url, meta, published_at AS at FROM docs INDEXED BY docs_type_pub
    WHERE type = 'post' AND published_at >= ? AND published_at <= ? AND hidden = 0 AND url LIKE 'https://x.com/%'`).all(now - POST_HOURS * HOUR, now + 5 * 60e3)
    .map((r) => {
      let m = {};
      try { m = JSON.parse(r.meta || '{}'); } catch {}
      return { ...r, handle: m.handle || '', avatar: m.avatar || null, row: vi?.rowOf(r.id) ?? null };
    })
    .filter((p) => p.row != null && p.title && isAiRelated(p.title));
  const articles = db.prepare(`SELECT id, title, url, source, site, published_at AS at FROM docs INDEXED BY docs_type_pub
    WHERE type = 'article' AND published_at >= ? AND published_at <= ? AND hidden = 0`).all(now - (POST_HOURS + 24) * HOUR, now + 5 * 60e3)
    .map((a) => ({ ...a, row: vi?.rowOf(a.id) ?? null }))
    .filter((a) => a.row != null);

  // Each post's closest article, by meaning.
  for (const p of posts) {
    let best = null;
    let sim = 0;
    for (const a of articles) {
      const s = vi.dot(p.row, a.row);
      if (s > sim) { sim = s; best = a; }
    }
    p.match = best;
    p.sim = sim;
  }

  // Not in the press: grouped by meaning, oldest post first in each group.
  const loose = posts.filter((p) => p.sim < COVERED).sort((a, b) => a.at - b.at);
  const groups = [];
  for (const p of loose) {
    const g = groups.find((x) => vi.dot(p.row, x.lead.row) >= SAME);
    if (g) g.posts.push(p);
    else groups.push({ lead: p, posts: [p] });
  }
  const signals = groups.map((g) => {
    const handles = [...new Set(g.posts.map((p) => p.handle))];
    return {
      id: `x-${g.lead.id}`,
      at: g.lead.at,
      last: Math.max(...g.posts.map((p) => p.at)),
      text: g.lead.title,
      url: g.lead.url,
      handle: g.lead.handle,
      avatar: g.lead.avatar,
      accounts: handles.length,
      handles: handles.slice(0, 6),
      posts: g.posts.slice(0, 6).map((p) => ({ text: p.title, url: p.url, handle: p.handle, at: p.at })),
      // How close the nearest article came; lower means further from anything covered.
      nearest: g.lead.match ? { title: splitOutlet(g.lead.match.title).title, url: g.lead.match.url, sim: Math.round(g.lead.sim * 100) / 100 } : null,
      markets: g.posts.every((p) => MARKETS.has(p.handle.toLowerCase())),
    };
  })
    // More accounts first, then the newest.
    .sort((a, b) => b.accounts - a.accounts || b.last - a.last);

  // Caught up: an article close to the post, published after it. One entry
  // per story: the earliest post, with the first article that followed.
  const caughtPosts = posts.filter((p) => p.sim >= COVERED && p.match.at > p.at).sort((a, b) => a.at - b.at);
  const kept = [];
  for (const p of caughtPosts) {
    if (kept.some((k) => vi.dot(p.row, k.row) >= SAME || k.match.url === p.match.url || vi.dot(p.match.row, k.match.row) >= SAME)) continue;
    kept.push(p);
  }
  const firsts = kept.map((p) => ({ text: p.title, url: p.url, handle: p.handle, avatar: p.avatar, at: p.at, article: { title: splitOutlet(p.match.title).title, url: p.match.url, source: splitOutlet(p.match.title).outlet || p.match.source || p.match.site, at: p.match.at }, lead: Math.round((p.match.at - p.at) / 60e3) }))
    .sort((a, b) => b.article.at - a.article.at);

  const accounts = new Map();
  for (const c of firsts) accounts.set(c.handle, (accounts.get(c.handle) || 0) + 1);
  const leads = firsts.map((c) => c.lead).sort((a, b) => a - b);
  return {
    generatedAt: now,
    hours: POST_HOURS,
    posts: posts.length,
    articles: articles.length,
    signals: signals.slice(0, 40),
    caught: firsts.slice(0, 30),
    ahead: [...accounts].map(([handle, n]) => ({ handle, n })).sort((a, b) => b.n - a.n).slice(0, 10),
    stats: {
      signals: signals.length,
      multi: signals.filter((s) => s.accounts >= 2).length,
      uncovered: loose.length / Math.max(1, posts.length),
      caught: firsts.length,
      medianLead: leads.length ? leads[Math.floor(leads.length / 2)] : null,
    },
  };
}

export const signalsQuery = () => cachedJob('signals', { kind: 'signals' }, TTL_MS);
