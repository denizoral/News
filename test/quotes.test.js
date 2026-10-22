import test from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, getDb } from '../src/db.js';
import { upsertDoc } from '../src/index/documents.js';
import { extractQuotes, personName, personKey, createQuoteIndex, refreshQuotes, computeQuotes, computePerson } from '../src/index/quotes.js';

const DAY = 86400e3;
const now = Date.parse('2026-10-22T12:00:00Z');

test('quotes: the common attribution shapes, surnames and roles', () => {
  const body = [
    'Nvidia reported results on Wednesday.',
    '“Demand for our AI chips keeps growing faster than we can build them,” said Jensen Huang, chief executive of Nvidia.',
    'Later in the call, Huang said: “Every data center will be rebuilt for accelerated computing over the next decade.”',
    '“We are watching the export rules very closely this year,” he said.',
    'OpenAI CEO Sam Altman said, "We need far more compute than anyone has planned for, and soon."',
    '“This is a short one,” said Jane Roe.',
    '“The company expects the deal to close in the first quarter next year,” the company said.',
  ].join('\n');
  const q = extractQuotes(body);
  assert.deepEqual(q.map((x) => x.name), ['Jensen Huang', 'Jensen Huang', 'Sam Altman']);
  assert.equal(q[0].role, 'chief executive of Nvidia');
  assert.match(q[1].text, /^Every data center/);
  assert.equal(q[2].role, 'OpenAI CEO');
  assert.equal(personName('German Chancellor Friedrich Merz').name, 'Friedrich Merz');
  assert.equal(personName('The Company'), null);
  assert.equal(personKey('José Álvarez'), 'jose-alvarez');
});

test('quotes: people, lines carried by several outlets, and a person page', () => {
  resetDb();
  let n = 0;
  const line = '“Open models are going to win the enterprise within two years,” said Ada Lovelace, CEO of Analytical AI.';
  const other = '“We will keep shipping open weights for every model we train,” Grace Hopper said.';
  for (const [site, at] of [['a.com', now - DAY], ['b.com', now - 2 * DAY], ['c.com', now - 3 * DAY]]) {
    upsertDoc({ url: `https://${site}/${n++}`, type: 'article', title: 'Analytical AI raises money for open models', description: 'An AI startup.', site, source: site, published_at: at, body: `Intro paragraph about the AI startup and its funding round.\n${line}\n${other}\n${'More words. '.repeat(40)}` });
  }
  upsertDoc({ url: 'https://d.com/x', type: 'article', title: 'Gardening tips for autumn', description: 'Roses.', site: 'd.com', source: 'd.com', published_at: now - DAY, body: `${'Soil. '.repeat(80)}\n“Prune your roses before the first frost of the year,” said Ada Lovelace.` });
  const idx = refreshQuotes(getDb(), createQuoteIndex(), { now });
  assert.equal(idx.quotes.length, 6, 'non-AI articles are skipped');
  const r = computeQuotes(idx, { now });
  assert.deepEqual(r.people.map((p) => p.key).sort(), ['ada-lovelace', 'grace-hopper']);
  assert.equal(r.lines[0].outlets, 3);
  assert.equal(r.lines[0].copies.length, 3);
  assert.equal(computeQuotes(idx, { now, q: 'hopper' }).people.length, 1);
  const p = computePerson(idx, { key: 'ada-lovelace', now });
  assert.equal(p.name, 'Ada Lovelace');
  assert.equal(p.role, 'CEO of Analytical AI');
  assert.equal(p.totals.outlets, 3);
  assert.equal(p.lines.length, 1);
  assert.deepEqual(p.alongside.map((a) => a.key), ['grace-hopper']);
  assert.equal(computePerson(idx, { key: 'nobody', now }), null);
  // A later pass only reads new rows.
  upsertDoc({ url: 'https://e.com/1', type: 'article', title: 'Open AI models news', description: 'AI.', site: 'e.com', source: 'e.com', published_at: now, body: `Intro text for this AI story here.\n${other}\n${'Filler. '.repeat(60)}` });
  refreshQuotes(getDb(), idx, { now });
  assert.equal(idx.quotes.length, 7);
});
