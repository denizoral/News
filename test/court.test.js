import test from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, getDb } from '../src/db.js';
import { upsertDoc } from '../src/index/documents.js';
import { makeCourtParser, computeCourt, kindOf, amountOf } from '../src/index/court.js';

const DAY = 86400e3;
const now = Date.parse('2026-10-22T12:00:00Z');

test('court headlines: who sued whom, over what, and what happened', () => {
  const parse = makeCourtParser();
  const a = parse('Apple sues OpenAI, accuses ex-employees of stealing trade secrets');
  assert.deepEqual([a.plaintiff.key, a.defendant.key, a.theme, a.kind], ['apple', 'openai', 'secrets', 'filed']);
  const b = parse('Judge orders OpenAI to turn over hiring records in Apple trade secrets case');
  assert.deepEqual([b.plaintiff?.key, b.defendant.key, b.kind], ['apple', 'openai', 'ruling'], 'the other party sits next to "case"');
  const c = parse('Elon Musk’s xAI used child porn to train Grok models, lawsuit says');
  assert.equal(c.defendant.key, 'xai');
  assert.notEqual(c.plaintiff?.key, 'elon-musk', 'the owner is not the plaintiff');
  assert.equal(parse('Canadian news publishers sue Anthropic for copyright infringement').plaintiff.key, 'news-publishers');
  assert.equal(parse('OpenAI CEO Sam Altman wins dismissal of sister\'s lawsuit').kind, 'dismissed');
  for (const t of ['Sundar Pichai: Why Google Won\'t Settle for Good-Enough Models', 'Microsoft Widens Mistral Deal to Court Regulated AI Buyers', 'Nvidia Patents a Self-Weighing Panel of AI Safety Judges', 'More Anthropic researchers warn of AI’s perils but Musk dismisses ‘psyop’', 'Fortnite is back on Apple\'s Australian App Store following court ruling']) assert.equal(parse(t), null, t);
  assert.equal(kindOf('Anthropic\'s landmark $1.5B copyright settlement is approved'), 'settled');
  assert.equal(kindOf('Round Hill isn’t looking to settle with Anthropic'), 'hearing');
  assert.equal(amountOf('Anthropic\'s landmark $1.5B copyright settlement'), 1.5e9);
});

test('courtroom: headlines become cases with timelines, months and defendants', () => {
  resetDb();
  let n = 0;
  const add = (title, source, daysAgo) => upsertDoc({ url: `https://${source}.com/${n++}`, type: 'article', title, description: '', body: '', site: `${source}.com`, source, published_at: now - daysAgo * DAY });
  add('Apple sues OpenAI over trade secrets taken by ex-employees', 'verge', 100);
  add('Apple sues OpenAI over trade secrets, ex-employees accused', 'wired', 100);
  add('OpenAI agrees not to use Apple trade secrets in ongoing lawsuit', 'reuters', 40);
  add('Judge orders OpenAI to turn over hiring records in Apple trade secrets case', 'techcrunch', 9);
  add('Authors sue Anthropic over pirated books used to train Claude', 'nyt', 300);
  add('Anthropic\'s $1.5B settlement with authors is approved by judge', 'techcrunch', 90);
  add('OpenAI launches a new model for lawyers', 'verge', 3);
  const d = computeCourt(getDb(), now);
  const apple = d.cases.find((c) => c.id === 'openai--apple');
  assert.ok(apple, 'Apple v. OpenAI');
  assert.equal(apple.title, 'Apple v. OpenAI');
  assert.equal(apple.events[0].outlets, 2, 'the same filing from two outlets is one event');
  assert.equal(apple.status, 'ruling');
  assert.ok(apple.events.some((e) => /agrees not to use/.test(e.title)), 'the headline without "sues" joins the case');
  const authors = d.cases.find((c) => c.defendant.key === 'anthropic');
  assert.equal(authors.status, 'settled');
  assert.equal(authors.amount, 1.5e9);
  assert.equal(d.stats.biggest.amount, 1.5e9);
  assert.equal(d.defendants[0].key, 'openai');
  assert.equal(d.months.length, 12);
  assert.equal(d.months.at(-1).rulings, 1);
});
