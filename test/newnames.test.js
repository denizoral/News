import test from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, getDb } from '../src/db.js';
import { upsertDoc } from '../src/index/documents.js';
import { bestDefinition, computeNewNames, definitionsIn, kindOf, nameRuns } from '../src/index/newnames.js';

const DAY = 86400e3;
const now = Date.parse('2026-10-22T12:00:00Z');

test('name runs: capitalised and numbered words, without the generic dressing', () => {
  const runs = nameRuns('Anthropic launches Claude Duet AI, and MiniMax M3.1 Flash tops a chart in October');
  assert.ok(runs.has('claude duet') && runs.has('minimax m3.1 flash'));
  assert.ok(!runs.has('claude duet ai'), '"AI" at the end is dressing');
  assert.ok(![...runs.keys()].some((k) => k.includes('october')), 'months are not names');
  assert.ok(nameRuns('OpenAI picks Jalapeño').has('jalapeño'), 'accented names survive');
});

test('definitions: appositives, "is a" and "called", in the articles’ own words', () => {
  const body = 'Anthropic introduced Claude Duet, a proactive AI agent that reaches out first. Later, TorchTPU is an open-source backend for TPUs. Google also showed a new chip called Argon. Claude Duet, the company said, is popular.';
  assert.deepEqual(definitionsIn(body, 'Claude Duet'), ['a proactive AI agent that reaches out first']);
  assert.deepEqual(definitionsIn(body, 'TorchTPU'), ['an open-source backend for TPUs']);
  assert.deepEqual(definitionsIn(body, 'Argon'), ['a new chip']);
  const best = bestDefinition([
    { text: 'a proactive AI agent that reaches out first', source: 'A', at: 1 },
    { text: 'an agent for your inbox', source: 'B', at: 2 },
    { text: 'a big deal for Anthropic', source: 'C', at: 3 },
  ]);
  assert.equal(best.agree, 2, 'two outlets call it an agent');
  assert.equal(kindOf(best.text, 'Claude Duet'), 'agent');
  assert.equal(kindOf('a 35-year-old engineer who joined in July', 'Jo Doe'), 'person');
});

test('new names: first seen lately, carried by outlets, not known before, with owner and definition', () => {
  resetDb();
  let n = 0;
  const add = (title, description, site, daysAgo, body = '') => upsertDoc({ url: `https://${site}/${n++}`, type: 'article', title, description, body, site, source: site, published_at: now - daysAgo * DAY });
  for (let i = 0; i < 8; i++) add(`Anthropic’s Claude Duet gets update ${i}`, `Anthropic said Claude Duet now handles mail ${i}.`, `o${i}.com`, 1 + i, i < 3 ? `Anthropic launched Claude Duet, a proactive AI agent that works like a chief of staff. More ${i}.` : '');
  // Old name: in the archive long before the window.
  for (let i = 0; i < 8; i++) add(`Widget Pro gets update ${i}`, `Widget Pro is popular ${i}.`, `o${i}.com`, 2 + i);
  for (let i = 0; i < 6; i++) add(`Widget Pro review ${i}`, `Widget Pro launched ${i}.`, `old${i}.com`, 200 + i);
  // A title-case headline phrase that is lower case mid-sentence isn't a name.
  for (let i = 0; i < 8; i++) add(`Regulators Probe Chatbots ${i}`, `regulators probe chatbots over safety ${i}.`, `o${i}.com`, 3 + i);
  const d = computeNewNames(getDb(), { now });
  const duet = d.names.find((x) => x.name === 'Claude Duet');
  assert.ok(duet, 'Claude Duet is new');
  assert.equal(duet.owner?.label, 'Anthropic');
  assert.match(duet.definition.text, /proactive AI agent/);
  assert.equal(duet.kind, 'agent');
  assert.equal(duet.mentions, 8);
  assert.equal(duet.series.length, d.days);
  assert.ok(!d.names.some((x) => /widget/i.test(x.name)), 'known before the window');
  assert.ok(!d.names.some((x) => /probe/i.test(x.name)), 'not a name');
});
