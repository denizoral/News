// Source-level crawler behavior: conditional GET, Reddit multireddit batching,
// feed category parsing, and stale-item filtering in the store.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { resetDb } from '../src/db.js';
import { settings } from '../src/settings.js';
import { getTextCached, conditionalStats } from '../src/http.js';
import { parseFeed, siteOf } from '../src/sources/rss.js';
import { redditJobs } from '../src/sources/community.js';
import { SUBREDDITS } from '../src/config.js';
import { Store } from '../src/store.js';

resetDb();
settings.load();

test('conditional GET reuses the stored body on 304', async () => {
  let full = 0;
  const server = http.createServer((req, res) => {
    if (req.headers['if-none-match'] === '"v1"') {
      res.writeHead(304).end();
      return;
    }
    full++;
    res.writeHead(200, { etag: '"v1"', 'content-type': 'application/rss+xml' }).end('<rss><channel><item><title>A</title><link>https://e.com/a</link></item></channel></rss>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/feed`;
  try {
    const hits = conditionalStats.hits;
    const a = await getTextCached(url);
    const b = await getTextCached(url);
    assert.equal(a, b);
    assert.equal(full, 1, 'second request answered with 304');
    assert.equal(conditionalStats.hits, hits + 1);
  } finally {
    server.close();
  }
});

test('anonymous Reddit runs batch subreddits into combined listings', () => {
  const anon = redditJobs();
  const total = SUBREDDITS.news.length + Math.min(4, SUBREDDITS.news.length) + SUBREDDITS.builds.length;
  assert.ok(anon.length < total / 3, `${anon.length} requests for ${total} listings`);
  assert.equal(anon.flatMap((j) => j.subs).length, total, 'every subreddit is still covered');
  assert.ok(anon.every((j) => j.subs.length <= 5));
  // OAuth keeps one listing per subreddit (per-sub limits, exact scores).
  assert.equal(redditJobs({ oauth: true }).length, total);
});

test('parseFeed exposes the Atom category term (multireddit subreddit)', () => {
  const [e] = parseFeed('<feed><entry><title>T</title><category term="LocalLLaMA" label="r/LocalLLaMA"/><link href="https://www.reddit.com/r/LocalLLaMA/comments/abc/t/"/></entry></feed>');
  assert.equal(e.category, 'LocalLLaMA');
  const [r] = parseFeed('<rss><channel><item><title>T</title><link>https://e.com/1</link><category>AI</category><category>Other</category></item></channel></rss>');
  assert.equal(r.category, 'AI');
  assert.equal(siteOf('https://www.cnbc.com/id/1/rss.html'), 'cnbc.com');
});

test('store skips news older than retention instead of re-adding it every run', () => {
  const store = new Store();
  const now = Date.now();
  const hours = settings.get('storage.feedRetentionHours');
  const added = store.ingest('rss', [
    { id: 'old', title: 'Old story', publishedAt: now - (hours + 5) * 3600e3 },
    { id: 'fresh', title: 'Fresh story', publishedAt: now - 3600e3 },
    { id: 'oldbuild', title: 'Old build', section: 'builds', publishedAt: now - (hours + 5) * 3600e3 },
  ]);
  assert.equal(added, 2);
  assert.ok(!store.items.has('old'));
  assert.ok(store.items.has('fresh') && store.items.has('oldbuild'));
});
