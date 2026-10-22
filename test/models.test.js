import test from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, getDb } from '../src/db.js';
import { upsertDoc } from '../src/index/documents.js';
import { nameMatcher } from '../src/index/releases.js';
import { extractScores, releaseScores, computeModels, shapeModels, paramsOf, blendedPrice } from '../src/index/models.js';

const now = Date.parse('2026-10-22T12:00:00Z');
const DAY = 86400e3;

test('models: a score counts only beside a benchmark, in a sentence naming this model alone', () => {
  const re = nameMatcher('Claude Sonnet 5.5');
  assert.deepEqual(extractScores('Claude Sonnet 5.5 scores 70.6% on Terminal-Bench 4.0 and keeps its price.', re), [{ key: 'terminal-4.0', label: 'Terminal-Bench 4.0', value: 70.6 }]);
  assert.deepEqual(extractScores('Claude Sonnet 5.5 posts a SWE-bench Verified score of 81.2%, 74% on OSWorld-Verified.', re).map((s) => [s.key, s.value]), [['swe-verified', 81.2], ['osworld', 74]]);
  assert.deepEqual(extractScores('Claude Sonnet 5.5 beats GPT-6 Sol at 70.6% on Terminal-Bench 4.0.', re), [], 'a rival in the sentence');
  assert.deepEqual(extractScores('Claude Sonnet 5 scored 65% on Terminal-Bench 4.0.', re), [], 'another version');
  assert.deepEqual(extractScores('It scores 70.6% on Terminal-Bench 4.0.', re), [], 'no name');
  assert.deepEqual(extractScores('Claude Sonnet 5.5 is 30% faster on ARC-AGI-3 tasks.', re), [], 'a percentage that is not beside the benchmark');
  assert.deepEqual(extractScores('Claude Sonnet 5.5 hits 97.5% on ARC-AGI-3.', re).map((s) => s.label), ['ARC-AGI-3']);
});

test('models: parameters, blended price', () => {
  assert.deepEqual(paramsOf({ name: 'Beam 1.0 501B A23B' }), { total: 501, active: 23 });
  assert.deepEqual(paramsOf({ name: 'Flint', summary: 'about 2.5B active parameters out of 40B total' }), { total: 40, active: 2.5 });
  assert.deepEqual(paramsOf({ name: 'Qwen 4', sizes: ['Qwen/Qwen4-8B', 'Qwen/Qwen4-235B-A22B'] }), { total: 235, active: 22 });
  assert.deepEqual(paramsOf({ name: 'Mercury 3', summary: 'raised $2B' }), { total: null, active: null });
  assert.equal(blendedPrice({ priceIn: 2, priceOut: 10 }), 4);
  assert.equal(blendedPrice({ priceIn: null, priceOut: null }), null);
});

test('models: outlets vote on a score; coverage and the table', () => {
  resetDb();
  const r = { id: 'or:a/s', name: 'Claude Sonnet 5.5', provider: 'Anthropic', date: now - 5 * DAY };
  const art = (site, n, body, at = r.date + n * 3600e3) => upsertDoc({ url: `https://${site}/${n}`, type: 'article', title: `Anthropic ships Claude Sonnet 5.5 (${site})`, description: '', body, site, source: site, published_at: at });
  art('a.example', 1, 'Long intro. Claude Sonnet 5.5 scores 70.6% on Terminal-Bench 4.0, Anthropic says.');
  art('b.example', 2, 'Claude Sonnet 5.5 reaches 70.6% on Terminal-Bench 4.0.');
  art('c.example', 3, 'Claude Sonnet 5.5 reaches 71% on Terminal-Bench 4.0.');
  art('d.example', 4, 'Claude Sonnet 5.5 scores 99% on Terminal-Bench 4.0.', r.date - 10 * DAY); // before launch: not counted
  const { scores } = releaseScores(getDb(), r, { now });
  assert.equal(scores.length, 1);
  assert.equal(scores[0].value, 70.6);
  assert.equal(scores[0].sources, 2);
  assert.equal(scores[0].disputed, true);
  assert.equal(scores[0].url, 'https://a.example/1');

  const extra = computeModels(getDb(), [r], { now });
  assert.equal(extra[r.id].n, 3);
  const t = shapeModels([{ ...r, priceIn: 2, priceOut: 10, api: true, open: false }], extra);
  assert.equal(t.models[0].blended, 4);
  assert.equal(t.models[0].coverage.outlets, 3);
  assert.deepEqual(t.benchmarks, [{ key: 'terminal-4.0', label: 'Terminal-Bench 4.0', models: 1 }]);
});
