// The X tab: every X post we hold (not just the 80 in the snapshot), filterable
// by account group, handle and text, newest first, paged with a time cursor.

import { X_ACCOUNTS } from './config.js';
import { xAvatar } from './sources/x.js';
import { TAXONOMIES } from './pipeline/labeler.js';

const X_CATS = Object.values(TAXONOMIES.x.labels);

export const X_GROUPS = [
  ['lab', 'Labs'],
  ['people', 'People'],
  ['scoops', 'Scoops'],
  ['markets', 'Markets'],
];
const GROUP_OF = new Map(X_ACCOUNTS.map((a) => [a.handle.toLowerCase(), a.group]));
const MAX_LIMIT = 100;

// Sorted posts and per-account stats, rebuilt only when the store changes.
let memo = { version: -1 };
function index(store) {
  if (memo.version === store.version && memo.size === store.items.size) return memo;
  const posts = [];
  for (const it of store.items.values()) {
    if (it.platform !== 'x' || store.modFor(it)?.hidden) continue;
    posts.push(it);
  }
  posts.sort((a, b) => b.publishedAt - a.publishedAt);

  const accounts = new Map();
  for (const a of X_ACCOUNTS) accounts.set(a.handle.toLowerCase(), { handle: a.handle, name: a.handle, avatar: null, group: a.group, count: 0, latest: 0 });
  for (const p of posts) {
    const key = p.handle.toLowerCase();
    const acct = accounts.get(key) || { handle: p.handle, group: p.group || 'people', count: 0, latest: 0 };
    acct.count++;
    if (p.publishedAt > acct.latest) {
      acct.latest = p.publishedAt;
      acct.name = p.author || acct.handle;
      if (p.avatar) acct.avatar = p.avatar;
    }
    acct.avatar ||= p.avatar || null;
    accounts.set(key, acct);
  }
  for (const a of accounts.values()) a.avatar ||= xAvatar(a.handle);
  memo = { version: store.version, size: store.items.size, posts, accounts: [...accounts.values()] };
  return memo;
}

const groupOf = (p) => GROUP_OF.get(p.handle.toLowerCase()) || p.group || 'people';

// Posts stored before avatars and unescaped media URLs existed get both here.
const cleanUrl = (u) => u && u.replace(/&amp;/g, '&');

function shape(p) {
  return {
    id: p.id,
    url: p.url,
    linkUrl: p.linkUrl || null,
    text: p.summary || p.title,
    author: p.author,
    handle: p.handle,
    avatar: p.avatar || xAvatar(p.handle),
    image: cleanUrl(p.image) || null,
    group: groupOf(p),
    cats: p.cats || [],
    publishedAt: p.publishedAt,
    likes: p.engagement?.score || 0,
    replies: p.engagement?.comments || 0,
  };
}

export function xFeed(store, { group = 'all', cat = 'all', handle = '', q = '', before = '', limit = 40 } = {}) {
  const { posts, accounts } = index(store);
  const want = handle.toLowerCase();
  const needle = q.trim().toLowerCase();
  const cursor = Number(before) || Infinity;
  const n = Math.min(MAX_LIMIT, Math.max(1, Number(limit) || 40));

  const matches = (p) =>
    (group === 'all' || groupOf(p) === group) &&
    (cat === 'all' || (p.cats || []).includes(cat)) &&
    (!want || p.handle.toLowerCase() === want) &&
    (!needle || `${p.title} ${p.summary} ${p.author} ${p.handle}`.toLowerCase().includes(needle));

  const page = [];
  for (const p of posts) {
    if (p.publishedAt >= cursor || !matches(p)) continue;
    page.push(shape(p));
    if (page.length > n) break;
  }
  const more = page.length > n;
  if (more) page.pop();

  const counts = { all: posts.length };
  for (const p of posts) counts[groupOf(p)] = (counts[groupOf(p)] || 0) + 1;
  const catCounts = {};
  for (const p of posts) for (const c of p.cats || []) catCounts[c] = (catCounts[c] || 0) + 1;
  const status = store.sourceStatus.x || {};

  return {
    posts: page,
    nextBefore: more ? page[page.length - 1].publishedAt : null,
    groups: [['all', 'All', counts.all], ...X_GROUPS.map(([k, l]) => [k, l, counts[k] || 0])],
    cats: [['all', 'All', posts.length], ...X_CATS.map((c) => [c, c, catCounts[c] || 0]).filter(([, , n]) => n).sort((a, b) => b[2] - a[2])],
    accounts: accounts
      .filter((a) => group === 'all' || a.group === group)
      .sort((a, b) => b.latest - a.latest),
    status: { ok: !!status.ok, strategy: status.strategy || null, lastRun: status.lastRun || null, error: status.ok ? null : status.error || null },
  };
}
