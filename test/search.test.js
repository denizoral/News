import test from 'node:test';
import assert from 'node:assert/strict';
import { resetDb } from '../src/db.js';
import { upsertDoc, addInlinks } from '../src/index/documents.js';
import { search, suggest, parseQuery, toMatch, searchImages } from '../src/index/search.js';
import { parseRobots, isAllowed, crawlDelay } from '../src/spider/robots.js';
import { extractPage, looksLikeArticleUrl } from '../src/spider/extract.js';
import { parseSitemap } from '../src/spider/sitemaps.js';
import { imageInfo } from '../src/spider/media.js';
import { q } from '../src/db.js';

test('robots.txt: longest match wins, wildcards, crawl-delay, sitemaps', () => {
  const r = parseRobots(`
User-agent: *
Disallow: /private
Allow: /private/public
Disallow: /*.pdf$
Crawl-delay: 4
Sitemap: https://e.com/news-sitemap.xml

User-agent: BadBot
Disallow: /`);
  assert.equal(isAllowed(r, 'https://e.com/private/x'), false);
  assert.equal(isAllowed(r, 'https://e.com/private/public/y'), true);
  assert.equal(isAllowed(r, 'https://e.com/doc.pdf'), false);
  assert.equal(isAllowed(r, 'https://e.com/doc.pdf?x=1'), true);
  assert.equal(isAllowed(r, 'https://e.com/news/a'), true);
  assert.equal(crawlDelay(r), 4);
  assert.deepEqual(r.sitemaps, ['https://e.com/news-sitemap.xml']);
  assert.equal(isAllowed(r, 'https://e.com/a', 'BadBot/1.0'), false);
});

test('extractPage reads metadata, article text, links and images', () => {
  const html = `<html lang="en"><head>
    <title>Fallback</title>
    <meta property="og:title" content="OpenAI ships GPT-6">
    <meta name="description" content="The new model is faster.">
    <meta property="article:published_time" content="2026-10-15T10:00:00Z">
    <meta property="og:image" content="/img/hero.jpg">
    <link rel="canonical" href="https://news.example.com/2026/10/15/openai-ships-gpt-6?utm_source=x">
  </head><body><nav><a href="/login">Log in</a><a href="/category/ai">AI</a></nav>
    <article><h1>OpenAI ships GPT-6</h1>
    ${'<p>OpenAI released GPT-6 today, a large language model with better reasoning and agents. </p>'.repeat(20)}
    <figure><img src="/img/chart.png" width="800" height="400" alt="Benchmark chart"><figcaption>Scores on SWE-bench</figcaption></figure>
    <a href="https://other.com/2026/10/15/anthropic-responds-to-gpt-6-launch">Anthropic responds</a>
    <img src="/pixel.gif" width="1" height="1">
    </article></body></html>`;
  const p = extractPage(html, 'https://news.example.com/2026/10/15/openai-ships-gpt-6');
  assert.equal(p.title, 'OpenAI ships GPT-6');
  assert.equal(p.url, 'https://news.example.com/2026/10/15/openai-ships-gpt-6');
  assert.equal(p.published_at, Date.parse('2026-10-15T10:00:00Z'));
  assert.ok(p.text.includes('better reasoning'));
  assert.ok(p.isArticle);
  assert.ok(p.links.some((l) => l.url.startsWith('https://other.com/') && l.text === 'Anthropic responds'));
  assert.ok(!p.links.some((l) => l.url.includes('/login')));
  assert.equal(p.images[0].url, 'https://news.example.com/img/hero.jpg');
  assert.ok(p.images.some((i) => i.alt === 'Benchmark chart' && i.caption === 'Scores on SWE-bench'));
  assert.ok(!p.images.some((i) => i.url.includes('pixel')));
});

test('article URL heuristic', () => {
  assert.ok(looksLikeArticleUrl('https://e.com/2026/10/15/some-story'));
  assert.ok(looksLikeArticleUrl('https://e.com/news/openai-releases-a-new-model-today'));
  assert.ok(!looksLikeArticleUrl('https://e.com/category/ai'));
  assert.ok(!looksLikeArticleUrl('https://e.com/'));
});

test('sitemaps keep recent entries', () => {
  const now = Date.parse('2026-10-17T00:00:00Z');
  const xml = `<urlset xmlns:news="http://www.google.com/schemas/sitemap-news/0.9">
    <url><loc>https://e.com/new</loc><news:news><news:publication_date>2026-10-16T00:00:00Z</news:publication_date><news:title>AI story</news:title></news:news></url>
    <url><loc>https://e.com/old</loc><lastmod>2025-01-01</lastmod></url></urlset>`;
  const s = parseSitemap(xml, { now });
  assert.deepEqual(s.urls.map((u) => u.url), ['https://e.com/new']);
  assert.equal(s.urls[0].title, 'AI story');
});

test('image header sniffing', () => {
  const png = Buffer.alloc(32);
  png[0] = 0x89; png.write('PNG', 1); png.writeUInt32BE(640, 16); png.writeUInt32BE(480, 20);
  assert.deepEqual(imageInfo(png), { mime: 'image/png', width: 640, height: 480 });
});

test('query language', () => {
  const p = parseQuery('"open weights" llama -rumor site:www.TheVerge.com type:news');
  assert.deepEqual(p.phrases, ['open weights']);
  assert.deepEqual(p.terms, ['llama']);
  assert.deepEqual(p.exclude, ['rumor']);
  assert.equal(p.site, 'theverge.com');
  assert.equal(p.type, 'article');
  assert.equal(toMatch(p), '"llama" "open weights" NOT "rumor"');
  assert.equal(toMatch(parseQuery('claude OR gemini')), '("claude" OR "gemini")');
  assert.equal(toMatch(parseQuery('gpt-6 "unclosed')), '"gpt-6" "unclosed"');
});

test('search ranks, filters, snippets, suggests', () => {
  resetDb();
  const now = Date.now();
  const a = upsertDoc({ url: 'https://a.com/claude-launch', type: 'article', title: 'Anthropic launches Claude Opus', description: 'A new frontier model', body: 'Anthropic today launched Claude Opus, its most capable model for agents and coding.', site: 'a.com', published_at: now - 3600e3, fetched_at: now });
  upsertDoc({ url: 'https://b.com/old-claude', type: 'article', title: 'A look back at Claude', description: '', body: 'Claude was first released years ago.', site: 'b.com', published_at: now - 400 * 86400e3 });
  upsertDoc({ url: 'https://c.com/gemini', type: 'article', title: 'Gemini gets faster', description: '', body: 'Google says Gemini is faster.', site: 'c.com', published_at: now - 7200e3 });
  upsertDoc({ url: 'https://x.com/sama/status/1', type: 'post', title: 'Claude is good, says a rival', body: 'Claude is good', site: 'x.com', published_at: now - 600e3 });
  addInlinks(['https://a.com/claude-launch', 'https://a.com/claude-launch']);

  const r = search('claude');
  assert.equal(r.total, 3);
  assert.equal(r.results[0].url, 'https://a.com/claude-launch');
  assert.ok(r.results[0].snippet.includes('<b>Claude</b>'));
  assert.deepEqual(r.facets, { article: 2, post: 1 });

  assert.equal(search('claude', { type: 'posts' }).results.length, 1);
  assert.equal(search('claude site:b.com').results[0].url, 'https://b.com/old-claude');
  assert.equal(search('claude', { time: 'week' }).total, 2);
  assert.equal(search('claude -opus').total, 2);
  assert.equal(search('models').results[0].url, 'https://a.com/claude-launch'); // stemming: models -> model
  const loose = search('claude gemini');
  assert.ok(loose.loosened && loose.total >= 3);
  assert.equal(search('<script>').results.length, 0);

  assert.equal(suggest('anthro')[0].title, 'Anthropic launches Claude Opus');

  // Upsert merges: an aggregator headline later enriched by a crawl keeps one row.
  upsertDoc({ url: 'https://a.com/claude-launch?utm_source=feed', type: 'article', title: 'Anthropic launches Claude Opus', description: 'Short', site: 'a.com' });
  assert.equal(search('claude').total, 3);
  assert.ok(a.id > 0);

  q("INSERT INTO images (url, page_url, alt, page_title, site, hash, ext, status, discovered_at) VALUES ('https://a.com/i.jpg', 'https://a.com/claude-launch', 'Claude logo on stage', 'Anthropic launches Claude Opus', 'a.com', 'ab', 'jpg', 'stored', ?)").run(now);
  assert.equal(searchImages('stage').results[0].alt, 'Claude logo on stage');
});
