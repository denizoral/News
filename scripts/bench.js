// Micro-benchmarks for the CPU-bound hot paths, runnable under Node and Bun:
//   node scripts/bench.js      bun scripts/bench.js
// Uses the items in data/state.json when present (a real crawl), otherwise a
// synthetic set. Prints median ms per operation; see docs/PERFORMANCE.md.

import fs from 'node:fs';
import zlib from 'node:zlib';
import { clusterItems, scoreStory } from '../src/pipeline/cluster.js';
import { isAiRelated, extractEntities } from '../src/pipeline/classify.js';
import { tokens, canonicalUrl, stripHtml } from '../src/pipeline/text.js';
import { parseFeed } from '../src/sources/rss.js';

function loadItems() {
  try {
    const state = JSON.parse(fs.readFileSync('data/state.json', 'utf8'));
    const items = (state.items || []).map((x) => (Array.isArray(x) ? x[1] : x)).filter((i) => i?.title);
    if (items.length > 100) return items;
  } catch { /* synthetic below */ }
  const words = 'OpenAI Anthropic Gemini Claude model release agents open weights benchmark Nvidia chips DeepSeek reasoning launch funding startup coding'.split(' ');
  return Array.from({ length: 900 }, (_, i) => ({
    id: `s:${i}`,
    url: `https://example${i % 40}.com/2026/10/${i}`,
    title: Array.from({ length: 9 }, (_, k) => words[(i * 7 + k * 3) % words.length]).join(' ') + ` ${i % 97}`,
    summary: 'A synthetic summary about AI models and agents.',
    publishedAt: Date.now() - (i % 48) * 3600e3,
    source: `Source ${i % 30}`, kind: 'press', platform: 'web', weight: 1,
  }));
}

function feedXml(n) {
  const items = Array.from({ length: n }, (_, i) => `<item><title>OpenAI ships model ${i} &amp; more</title><link>https://e.com/a/${i}?utm_source=x</link><pubDate>Mon, 20 Oct 2026 10:00:00 GMT</pubDate><description>&lt;p&gt;Body text for ${i} with &lt;b&gt;markup&lt;/b&gt; and an &lt;img src="https://e.com/i${i}.png"&gt; image.&lt;/p&gt;</description><dc:creator>Writer ${i}</dc:creator></item>`).join('');
  return `<?xml version="1.0"?><rss version="2.0"><channel><title>T</title>${items}</channel></rss>`;
}

function bench(name, fn, { minMs = 400, maxRuns = 200 } = {}) {
  fn(); // warm up
  const times = [];
  const start = performance.now();
  while (times.length < maxRuns && (performance.now() - start < minMs || times.length < 5)) {
    const t = performance.now();
    fn();
    times.push(performance.now() - t);
  }
  times.sort((a, b) => a - b);
  const med = times[times.length >> 1];
  results[name] = med;
  console.log(`${name.padEnd(34)} ${med.toFixed(3).padStart(9)} ms  (${times.length} runs)`);
}

const results = {};
const items = loadItems();
const news = items.filter((i) => (i.section || 'news') === 'news');
const xml = feedXml(200);
const titles = items.map((i) => `${i.title} ${i.summary || ''}`);
const now = Date.now();

console.log(`runtime: ${typeof Bun !== 'undefined' ? `bun ${Bun.version}` : `node ${process.versions.node}`} · ${news.length} news items`);
bench('clusterItems + scoreStory', () => { for (const s of clusterItems(news)) scoreStory(s, now); });
bench('parseFeed (200-item RSS)', () => parseFeed(xml));
bench('isAiRelated + extractEntities', () => { for (const t of titles) { isAiRelated(t); extractEntities(t); } });
bench('tokens + canonicalUrl', () => { for (const i of items) { tokens(i.title); canonicalUrl(i.url); } });
bench('stripHtml (200 bodies)', () => { for (let i = 0; i < 200; i++) stripHtml(`<p>Hello <b>world</b> &amp; more ${i}</p><script>x</script>`.repeat(20)); });
const snapJson = JSON.stringify({ items });
bench('JSON.stringify state', () => JSON.stringify({ items }));
bench('JSON.parse state', () => JSON.parse(snapJson));
bench('gzip state', () => zlib.gzipSync(snapJson), { maxRuns: 30 });
bench('brotli q6 state', () => zlib.brotliCompressSync(snapJson, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 6 } }), { maxRuns: 30 });

if (process.argv.includes('--json')) console.log(JSON.stringify(results));
