import test from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, getDb } from '../src/db.js';
import { upsertDoc } from '../src/index/documents.js';
import { toneOf, signOf } from '../src/pipeline/tone.js';
import { computeMood } from '../src/index/mood.js';
import { clusterHeadlines, frameStory, shapeOf, outletKey, computeFraming } from '../src/index/framing.js';

const DAY = 86400e3;

test('tone: evaluative words, negation, and senses that aren’t evaluative', () => {
  assert.equal(signOf(toneOf('OpenAI sued over ChatGPT privacy breach')), -1);
  assert.equal(signOf(toneOf('Nvidia hits record as AI chip sales soar')), 1);
  assert.equal(signOf(toneOf('OpenAI launches a new model')), 0, 'news, not tone');
  assert.deepEqual(toneOf('Zuckerberg can fund AI without losing control').pos, ['not losing']);
  assert.equal(signOf(toneOf('How to fine-tune Llama on a free tier')), 0);
});

test('mood: weekly good-minus-bad points, companies, outlets and the week’s words', () => {
  resetDb();
  const now = Date.now();
  let n = 0;
  const add = (title, daysAgo, site = 'example.com') => upsertDoc({ url: `https://${site}/${n++}`, type: 'article', title, description: '', body: '', site, source: site, published_at: now - daysAgo * DAY });
  for (let i = 0; i < 25; i++) add(`OpenAI sued again in AI privacy case ${i}`, 2, 'gloomy.com');
  for (let i = 0; i < 25; i++) add(`Nvidia AI chip sales soar to record ${i}`, 3, 'sunny.com');
  for (let i = 0; i < 20; i++) add(`OpenAI launches AI tool number ${i}`, 40, 'gloomy.com');
  for (let i = 0; i < 20; i++) add(`Sunny take on the AI market ${i}`, 50, 'sunny.com');
  add('OpenAI sued again in AI privacy case 0', 2, 'copy.com');
  const d = computeMood(getDb(), now);
  assert.equal(d.series.length, 26);
  assert.equal(d.series.at(-1).n, 50, 'syndicated copies count once');
  assert.equal(d.series.at(-1).mood, 0);
  const openai = d.companies.find((c) => c.key === 'openai');
  assert.ok(openai.mood90 < 0);
  assert.ok(d.companies.find((c) => c.key === 'nvidia').mood90 > 0);
  assert.equal(d.outlets.warmest[0].name, 'sunny.com');
  assert.equal(d.outlets.coolest[0].name, 'gloomy.com');
  assert.ok(d.words.bad.some((w) => w.w === 'sued'));
});

test('framing: one story across outlets, shared and own words, tone against the pack', () => {
  const now = Date.now();
  const hl = [
    ['Barclays to cut 5,000 jobs as AI takes over back-office work', 'bbc.co.uk'],
    ['Barclays cutting 5,000 jobs as it leans on AI', 'bbc.com'],
    ['Barclays to cut 5,000 jobs as bank bosses hail AI productivity gains', 'theguardian.com'],
    ['Barclays is cutting 5,000 jobs in an AI push', 'businessinsider.com'],
    ['Barclays slashes 5,000 jobs in AI crackdown, unions fear worse to come', 'mirror.co.uk'],
    ['Apple unveils new AI features for the iPhone', 'verge.com'],
  ];
  const rows = hl.map(([title, site], i) => ({ id: i + 1, title, url: `https://${site}/${i}`, source: site, at: now - (10 - i) * 60e3 }));
  const groups = clusterHeadlines(rows, null);
  const story = groups.find((g) => g.items.length > 1);
  assert.equal(story.items.length, 4, 'bbc.co.uk and bbc.com are one outlet; Apple is another story');
  const f = frameStory(story);
  assert.ok(f.core.includes('barclays') && f.core.includes('jobs'));
  const mirror = f.headlines.find((h) => h.source === 'mirror.co.uk');
  assert.ok(mirror.tone < 0 && mirror.only.includes('unions'));
  assert.deepEqual(shapeOf('Why is Barclays cutting 5,000 jobs?'), ['question', 'number', 'explainer']);
  assert.equal(outletKey('www.bbc.co.uk'), outletKey('BBC'));

  resetDb();
  hl.forEach(([title, site], i) => upsertDoc({ url: `https://${site}/${i}`, type: 'article', title, description: '', body: '', site, source: site, published_at: now - (10 - i) * 60e3 }));
  const d = computeFraming(getDb(), { now });
  assert.equal(d.stories.length, 1);
  assert.equal(d.stories[0].outlets, 4);
});
