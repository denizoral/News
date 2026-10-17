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
