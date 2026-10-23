import test from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, getDb } from '../src/db.js';
import { upsertDoc } from '../src/index/documents.js';
import { parseScience, computeScience } from '../src/index/science.js';

const DAY = 86400e3;
const now = Date.parse('2026-10-22T12:00:00Z');

test('science headlines: field, what happened and the lab', () => {
  const a = parseScience('Microsoft says its AI tool is better than doctors at diagnosing diseases');
  assert.deepEqual([a.group, a.lab.key], ['health', 'microsoft']);
  const b = parseScience('How Claude designed protein binders against scorpion neurotoxins');
  assert.deepEqual([b.field, b.kind, b.lab.key], ['bio', 'discovery', 'anthropic']);
  assert.equal(parseScience('GPT-6-Astra solves 49 of 50 physics research problems at $2.40 apiece').group, 'physics');
  assert.equal(parseScience('OpenAI acquires Orchestra Bio to connect research AI with drug-development operations').kind, 'deal');
  assert.equal(parseScience('AI tool may support dermatologists in assessing skin lesions for cancer risk').kind !== 'concern', true, 'cancer risk is medicine, not a worry about AI');
  assert.equal(parseScience('AI scribes cut doctor paperwork but raise accuracy concerns').kind, 'concern');
  // Other senses of science.
  assert.equal(parseScience('From Data Scientist to AI Architect'), null);
  assert.equal(parseScience('Nvidia Just Wired Corporate Japan Into the Physical-AI Era'), null);
});

test('science: one result across outlets, groups by month, labs and discoveries', () => {
  resetDb();
  let n = 0;
  const add = (title, source, daysAgo) => upsertDoc({ url: `https://${source}.com/${n++}`, type: 'article', title, description: '', body: '', site: `${source}.com`, source, published_at: now - daysAgo * DAY });
  add('Microsoft says its AI tool is better than doctors at diagnosing diseases', 'verge', 3);
  add('Microsoft AI tool beats doctors at diagnosing diseases, it says', 'ft', 2);
  add('Claude finds quantum computation method in 53 hours', 'decoder', 10);
  add('New materials library could help AI design better sodium-ion batteries', 'nature', 40);
  add('From Data Scientist to AI Architect', 'medium', 5);
  const d = computeScience(getDb(), now);
  const ms = d.events.filter((x) => x.lab?.key === 'microsoft');
  assert.equal(ms.length, 1, 'one story');
  assert.equal(ms[0].outlets, 2);
  assert.equal(d.groups.find((g) => g.key === 'physics').n, 1);
  assert.deepEqual(d.labs.map((l) => l.key).sort(), ['anthropic', 'microsoft']);
  assert.ok(d.discoveries.some((x) => /quantum/.test(x.title)));
  assert.equal(d.months.length, 12);
  assert.ok(!d.events.some((x) => /Data Scientist/.test(x.title)));
});
