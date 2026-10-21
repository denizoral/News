import test from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, getDb } from '../src/db.js';
import { upsertDoc } from '../src/index/documents.js';
import { nameMatcher, releaseCoverage, computeReleaseCoverage } from '../src/index/releases.js';

const DAY = 86400e3;
const launch = Date.parse('2026-10-01T12:00:00Z');

test('release names match whole versions only', () => {
  const re = nameMatcher('Claude Opus 5');
  assert.ok(re.test('Anthropic ships Claude Opus 5 today'));
  assert.ok(re.test('claude-opus-5 benchmarks'));
  assert.ok(!re.test('Claude Opus 5.5 is here'), 'a newer point release is another model');
  assert.ok(!re.test('Claude Opus 50'));
  assert.ok(nameMatcher('GPT-6 Astra').test('GPT 6 Astra vs Gemini'));
  assert.ok(nameMatcher('Qwen3.8 27B').test('Testing Qwen3.8-27B on a laptop'));
});

test('release coverage: since launch, deduped, no repo pages, first reporter credited', () => {
  resetDb();
  const doc = (url, title, at, extra = {}) => upsertDoc({ url, type: 'article', title, published_at: at, ...extra });
  doc('https://techcrunch.com/a', 'Lab releases Nova 3, its fastest model', launch + 3600e3, { engagement: 50 });
  doc('https://theverge.com/b', 'Lab releases Nova 3, its fastest model', launch + 7200e3);
  doc('https://wired.com/c', 'Hands on with Nova 3', launch + 2 * DAY);
  doc('https://huggingface.co/lab/Nova-3', 'lab/Nova-3 · Hugging Face', launch);
  doc('https://openrouter.ai/lab/nova-3', 'Lab: Nova 3 is now available on OpenRouter', launch);
  doc('https://old.com/d', 'Rumours about Nova 3', launch - 10 * DAY);
  doc('https://news.com/e', 'Nova 3.5 leaks', launch + DAY);
  doc('https://unite.ai/sv/e', 'Lab släpper Nova 3', launch + 3 * 3600e3, { lang: 'sv' });
  upsertDoc({ url: 'https://x.com/lab/status/1', type: 'post', title: 'Nova 3 is out now', published_at: launch + 600e3 });

  const c = releaseCoverage(getDb(), { name: 'Nova 3', provider: 'Lab', date: launch }, { now: launch + 5 * DAY });
  assert.equal(c.n, 3, 'two headlines and the X post; copies, translations, repo pages, old rumours and 3.5 left out');
  assert.equal(c.outlets, 4);
  assert.equal(c.first.site, 'techcrunch.com', 'the earliest article, not the lab post');
  assert.equal(c.items[0].outlets, 2, 'the headline most outlets ran comes first');
  assert.equal(c.items.find((i) => i.platform === 'x').site, 'x.com');
  assert.equal(c.series.length, 7, 'the day before launch through today');
  assert.equal(c.series.reduce((s, d) => s + d.n, 0), 3);
});

test('a plain-word release name needs the lab named too', () => {
  resetDb();
  upsertDoc({ url: 'https://a.com/1', type: 'article', title: 'How to extract text from PDFs', published_at: launch + DAY });
  upsertDoc({ url: 'https://a.com/2', type: 'article', title: 'ScaleDown launches Extract for agents', published_at: launch + DAY });
  const all = computeReleaseCoverage(getDb(), [{ id: 'r1', name: 'Extract', provider: 'ScaleDown', date: launch }], { now: launch + 3 * DAY });
  assert.equal(all.r1.n, 1);
  assert.match(all.r1.items[0].title, /ScaleDown/);
});

test('a roundup that mentions the model in passing is not credited as first', () => {
  resetDb();
  upsertDoc({ url: 'https://roundup.com/1', type: 'article', title: 'Monday links', description: 'Also: Nova 3 is out', published_at: launch });
  upsertDoc({ url: 'https://wired.com/2', type: 'article', title: 'Qwen 3.8 and Nova 3 tested', published_at: launch + 3600e3 });
  const c = releaseCoverage(getDb(), { name: 'Nova 3', provider: 'Lab', date: launch }, { now: launch + DAY });
  assert.equal(c.first.site, 'wired.com');
  assert.equal(c.items[0].site, 'wired.com', 'headline mentions rank first');
  assert.ok(nameMatcher('Qwen3.8').test('Qwen 3.8 and Nova 3 tested'));
});
