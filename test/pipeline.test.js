import test from 'node:test';
import assert from 'node:assert/strict';
import { clusterItems, matchMarkets, scoreStory } from '../src/pipeline/cluster.js';
import { canonicalUrl, splitOutlet } from '../src/pipeline/text.js';
import { isAiRelated, extractEntities, looksLikeBuild } from '../src/pipeline/classify.js';
import { parseFeed } from '../src/sources/rss.js';

const now = Date.now();
const item = (o) => ({ weight: 1, kind: 'press', platform: 'web', publishedAt: now - 3600e3, summary: '', ...o });

test('canonicalUrl strips tracking and normalizes hosts', () => {
  assert.equal(canonicalUrl('http://www.example.com/a/?utm_source=x&id=2#top'), 'https://example.com/a/?id=2');
  assert.equal(canonicalUrl('https://twitter.com/sama/status/1'), 'https://x.com/sama/status/1');
});

test('splitOutlet separates Google News outlet suffix', () => {
  assert.deepEqual(splitOutlet('OpenAI ships a thing - The Verge'), { title: 'OpenAI ships a thing', outlet: 'The Verge' });
});

test('relevance and entities', () => {
  assert.ok(isAiRelated('Anthropic releases a new Claude model'));
  assert.ok(!isAiRelated('Local bakery wins award'));
  const e = extractEntities('Sam Altman says ChatGPT will get ads');
  assert.equal(e.get('openai'), true);
  assert.ok(looksLikeBuild('I built a tool that turns PDFs into podcasts'));
});

test('same story from different outlets clusters into one', () => {
  const stories = clusterItems([
    item({ id: 'a', url: 'https://a.com/1', title: 'OpenAI releases GPT-6 with longer context window', source: 'A' }),
    item({ id: 'b', url: 'https://b.com/2', title: 'OpenAI releases GPT-6 with a much longer context window today', source: 'B' }),
    item({ id: 'c', url: 'https://c.com/3', title: 'Nvidia earnings beat expectations on datacenter demand', source: 'C' }),
    item({ id: 'd', url: 'https://reddit.com/r/x/1', linkUrl: 'https://c.com/3', title: 'Nvidia crushes it again', source: 'r/x', platform: 'reddit', kind: 'community' }),
  ]);
  assert.equal(stories.length, 2);
  const gpt = stories.find((s) => s.title.includes('GPT-6'));
  assert.equal(gpt.sources.length, 2);
  assert.ok(scoreStory(gpt) > 0);
});

test('market matching needs more than a shared company name', () => {
  const [s1] = clusterItems([item({ id: 'x', url: 'https://x.com/1', title: 'Anthropic valuation soars after new funding round', source: 'X' })]);
  const [s2] = clusterItems([item({ id: 'y', url: 'https://y.com/1', title: 'Anthropic opens a new office in Tokyo', source: 'Y' })]);
  const markets = [{ id: 'm1', title: "Will Anthropic's valuation hit $1T by December 31?", outcomes: [{ label: 'Yes', yes: 0.3 }], entities: ['anthropic', 'funding'], volume24h: 1000 }];
  matchMarkets([s1, s2], markets);
  assert.equal(s1.markets[0]?.id, 'm1');
  assert.equal(s2.markets.length, 0);
});

test('parseFeed reads RSS and Atom', () => {
  const rss = parseFeed('<rss><channel><item><title>Hello &amp; AI</title><link>https://e.com/1</link><pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate><description>&lt;p&gt;Body&lt;/p&gt;</description></item></channel></rss>');
  assert.equal(rss[0].title, 'Hello & AI');
  assert.equal(rss[0].summary, 'Body');
  const atom = parseFeed('<feed><entry><title>T</title><link rel="alternate" href="https://e.com/2"/><updated>2024-01-01T00:00:00Z</updated></entry></feed>');
  assert.equal(atom[0].url, 'https://e.com/2');
});

test('embed timeline parsing skips replies and retweets', async () => {
  const { parseEmbedTimeline, embedQueue } = await import('../src/sources/x.js');
  const tweet = (id, extra = {}) => ({ content: { tweet: { id_str: id, full_text: `New open-weight model released today with strong reasoning ${id}`, created_at: 'Sat Oct 17 12:00:00 +0000 2026', favorite_count: 10, retweet_count: 2, user: { screen_name: 'karpathy', name: 'Andrej Karpathy' }, entities: {}, ...extra } } });
  const data = { props: { pageProps: { timeline: { entries: [tweet('1'), tweet('2', { in_reply_to_status_id_str: '9' }), tweet('3', { retweeted_status: {} })] } } } };
  const html = `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(data)}</script></html>`;
  const items = parseEmbedTimeline(html, 'karpathy');
  assert.deepEqual(items.map((i) => i.id), ['x:1']);
  assert.equal(items[0].url, 'https://x.com/karpathy/status/1');
  assert.throws(() => parseEmbedTimeline('<html></html>', 'x'));
  assert.ok(embedQueue().length > 0);
});

test('RSSHub list feed entries take the handle from each status URL', async () => {
  const { feedEntryToItem } = await import('../src/sources/x.js');
  const xml = `<rss><channel>
    <item><title>Odds on the new model release just moved</title><link>https://x.com/Polymarket/status/111</link>
      <description><![CDATA[Odds on the new model release just moved<br><a href="https://polymarket.com/event/abc">polymarket.com/event/abc</a><img src="https://pbs.twimg.com/media/a?format=jpg&amp;name=orig">]]></description>
      <pubDate>Tue, 20 Oct 2026 12:00:00 GMT</pubDate><author>Polymarket</author></item>
    <item><title>RT @someone: not ours</title><link>https://x.com/sama/status/222</link><description>x</description></item>
  </channel></rss>`;
  const items = parseFeed(xml).map((e) => feedEntryToItem(e, 'listid')).filter(Boolean);
  assert.equal(items.length, 1);
  assert.equal(items[0].handle, 'Polymarket');
  assert.equal(items[0].url, 'https://x.com/Polymarket/status/111');
  assert.equal(items[0].linkUrl, 'https://polymarket.com/event/abc');
  assert.equal(items[0].image, 'https://pbs.twimg.com/media/a?format=jpg&name=medium');
});

test('X feed filters by group, handle and text, and pages by time', async () => {
  const { xFeed } = await import('../src/xfeed.js');
  const post = (id, handle, t, text = `post ${id}`) => [`x:${id}`, { id: `x:${id}`, platform: 'x', handle, author: handle, title: text, summary: '', publishedAt: t, url: `https://x.com/${handle}/status/${id}` }];
  const store = {
    version: 1,
    items: new Map([post(1, 'Polymarket', 3000, 'BREAKING: odds move'), post(2, 'OpenAI', 2000), post(3, 'karpathy', 1000), ['n:1', { id: 'n:1', platform: 'rss', title: 'not x' }]]),
    modFor: () => null,
    sourceStatus: { x: { ok: true, strategy: 'rsshub', lastRun: 5 } },
  };
  const all = xFeed(store, { limit: 2 });
  assert.deepEqual(all.posts.map((p) => p.id), ['x:1', 'x:2']);
  assert.equal(all.nextBefore, 2000);
  assert.deepEqual(xFeed(store, { before: all.nextBefore }).posts.map((p) => p.id), ['x:3']);
  assert.deepEqual(xFeed(store, { group: 'markets' }).posts.map((p) => p.handle), ['Polymarket']);
  assert.deepEqual(xFeed(store, { handle: 'openai' }).posts.map((p) => p.id), ['x:2']);
  assert.deepEqual(xFeed(store, { q: 'odds' }).posts.map((p) => p.id), ['x:1']);
  assert.equal(all.groups.find(([k]) => k === 'markets')[2], 1);
  assert.equal(all.status.strategy, 'rsshub');
  store.items.get('x:1').cats = ['Politics'];
  store.version++;
  assert.deepEqual(xFeed(store, { cat: 'Politics' }).posts.map((p) => p.id), ['x:1']);
  assert.deepEqual(xFeed(store).cats.find(([k]) => k === 'Politics'), ['Politics', 'Politics', 1]);
});

test('tech classifier keeps only confident technology labels', async () => {
  const { isTech, topicOf, TECH_TOPIC } = await import('../src/sources/tech.js');
  assert.equal(isTech({ label: 'software', score: 0.99 }), true);
  assert.equal(isTech({ label: 'cybersecurity', score: 0.96 }), true);
  assert.equal(isTech({ label: 'technology', score: 0.62 }), false);
  assert.equal(isTech({ label: 'politics', score: 1 }), false);
  assert.equal(isTech(null), false);
  assert.equal(TECH_TOPIC.cybersecurity, 'Security');
  assert.equal(topicOf({ label: 'technology', score: 0.99, top: [{ label: 'technology', score: 0.99 }, { label: 'software', score: 0.9 }] }), 'Software');
  assert.equal(topicOf({ label: 'technology', score: 0.99, top: [{ label: 'technology', score: 0.99 }, { label: 'business', score: 0.9 }] }), 'General');
});

test('labeler maps classifier results to chips, with a confident runner-up', async () => {
  const { catsFrom } = await import('../src/pipeline/labeler.js');
  const r = { label: 'cryptocurrency', score: 0.97, top: [{ label: 'cryptocurrency', score: 0.97 }, { label: 'stock market and investing', score: 0.85 }, { label: 'politics', score: 0.4 }] };
  assert.deepEqual(catsFrom(r, 'x'), ['Crypto']);
  assert.deepEqual(catsFrom({ ...r, top: [r.top[0], { label: 'stock market and investing', score: 0.95 }] }, 'x'), ['Crypto', 'Stocks']);
  assert.deepEqual(catsFrom({ label: 'new AI model release', score: 0.9, top: [{ label: 'new AI model release', score: 0.9 }, { label: 'AI research', score: 1 }] }, 'ai'), ['Models']);
  assert.deepEqual(catsFrom(null, 'ai'), []);
});

test('releases merge API and open-weight listings by model family', async () => {
  const { familyOf, mergeReleases } = await import('../src/sources/releases.js');
  assert.equal(familyOf('Qwen/Qwen4-235B-A22B-Instruct-2510'), 'qwen4');
  assert.equal(familyOf('deepseek-ai/DeepSeek-V4.1-Flash'), 'deepseek-v4.1-flash');
  const or = [{ id: 'or:qwen/qwen4-235b', name: 'Qwen4 235B', org: 'qwen', date: 2000, api: true, open: true, hf: 'Qwen/Qwen4-235B-A22B', priceIn: 0.2 }];
  const hf = [
    { id: 'hf:Qwen/Qwen4-8B', name: 'Qwen4 8B', org: 'qwen', date: 1000, api: false, open: true, hf: 'Qwen/Qwen4-8B', likes: 300 },
    { id: 'hf:Qwen/Qwen-Image-3', name: 'Qwen Image 3', org: 'qwen', date: 3000, api: false, open: true, hf: 'Qwen/Qwen-Image-3', likes: 50 },
  ];
  const out = mergeReleases(or, hf);
  assert.equal(out.length, 2);
  const qwen4 = out.find((r) => r.name === 'Qwen4 235B');
  assert.equal(qwen4.api && qwen4.open, true);
  assert.equal(qwen4.date, 1000, 'a family dates from its first release');
  assert.equal(qwen4.sizes.length, 2);
  assert.equal(out[0].name, 'Qwen Image 3', 'newest first');
});
