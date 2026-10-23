import test from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, getDb } from '../src/db.js';
import { upsertDoc } from '../src/index/documents.js';
import { claimsIn, computeBenchmarks, normModel } from '../src/index/benchmarks.js';
import { computeTalent, makeParser } from '../src/index/talent.js';
import { vocabNodes } from '../src/index/graph.js';

const DAY = 86400e3;
const now = Date.parse('2026-10-22T12:00:00Z');

test('benchmark claims: nearest score per mention, model from the sentence or headline', () => {
  assert.deepEqual(claimsIn('Claude Opus 5.5 scores 81.2% on SWE-bench Verified and 88% on GPQA Diamond.'), [
    { bench: 'swe-bench-verified', model: 'Claude Opus 5.5', score: 81.2 },
    { bench: 'gpqa', model: 'Claude Opus 5.5', score: 88 },
  ]);
  assert.deepEqual(claimsIn('Self-reported scores are 96.9% AIME 2025, 84.3% GPQA Diamond and 66.4% SWE-Bench Verified.', { titleModel: 'Qwen3.6' }).map((c) => [c.bench, c.score, c.model]),
    [['aime', 96.9, 'Qwen3.6'], ['gpqa', 84.3, 'Qwen3.6'], ['swe-bench-verified', 66.4, 'Qwen3.6']]);
  assert.deepEqual(claimsIn('SWE-bench Pro: GPT-6 Astra reaches 61.5%.').map((c) => c.bench), ['swe-bench-pro'], 'Pro is its own benchmark');
  assert.deepEqual(claimsIn('RL raised Qwen3.5-9B from 41.8% to 56.4% on SWE-bench Verified.'), [], 'research deltas are skipped');
  assert.deepEqual(claimsIn('Humans score 98% on ARC-AGI-2 while GPT-6 Astra gets 30%.').map((c) => c.score), [30], 'baselines are skipped');
  assert.deepEqual(claimsIn('A 9B model reaches 54.9% on SWE-bench Verified.'), [], 'no model, no claim');
  assert.equal(normModel('Gemini 3.0 Pro'), normModel('Gemini-3 pro'));
});

test('benchmarks: claims across outlets, confirmed first, state of the art over time', () => {
  resetDb();
  let n = 0;
  const add = (title, body, source, daysAgo) => upsertDoc({ url: `https://${source}.com/${n++}`, type: 'article', title, description: '', body, site: `${source}.com`, source, published_at: now - daysAgo * DAY });
  add('Claude Opus 5 launches', 'Claude Opus 5 scores 79.2% on SWE-bench Verified.', 'a', 30);
  add('Opus 5 is here', 'Anthropic says Claude Opus 5 hits 79.2% on SWE-bench Verified.', 'b', 29);
  add('GPT-6 Astra arrives', 'GPT-6 Astra reaches 84.1% on SWE-bench Verified.', 'c', 10);
  add('Astra benchmarks', 'On SWE-bench Verified, GPT-6 Astra scored 84.1%.', 'd', 9);
  add('A rumour', 'Gemini 4 Argon gets 99% on SWE-bench Verified, one blog claims.', 'e', 5);
  add('Older model', 'Gemini 3 Flash gets 78% on SWE-bench Verified.', 'f', 60);
  add('Older model again', 'Gemini 3 Flash scores 78% on SWE-bench Verified.', 'g', 59);
  const r = computeBenchmarks(getDb(), { now });
  const b = r.benchmarks.find((x) => x.key === 'swe-bench-verified');
  assert.deepEqual(b.models.map((m) => [m.model, m.score, m.confirmed]), [['GPT-6 Astra', 84.1, true], ['Claude Opus 5', 79.2, true], ['Gemini 3 Flash', 78, true], ['Gemini 4 Argon', 99, false]]);
  assert.deepEqual(b.sota.map((s) => s.model), ['Gemini 3 Flash', 'Claude Opus 5', 'GPT-6 Astra']);
  assert.equal(b.models[0].outlets, 2);
});

test('talent: joins, hires, departures and appointments from headlines', () => {
  const nodes = vocabNodes();
  const parse = makeParser(nodes.filter((x) => x.type === 'org'), nodes.filter((x) => x.type === 'person').flatMap((x) => x.aliases));
  const p = (t) => { const m = parse(t); return m && [m.kind, m.name || m.who, m.from, m.to]; };
  assert.deepEqual(p('Former Tesla AI boss Andrej Karpathy joins Anthropic.'), ['join', 'Andrej Karpathy', 'tesla', 'anthropic']);
  assert.deepEqual(p('OpenAI hires Brian McCarthy from SpaceX as its VP of worldwide sales'), ['hire', 'Brian McCarthy', 'spacex', 'openai']);
  assert.deepEqual(p('Google Gemini co-lead Noam Shazeer leaves for OpenAI'), ['leave', 'Noam Shazeer', 'google', 'openai']);
  assert.deepEqual(p('Google Deepmind loses another top AI researcher as Nobel laureate John Jumper leaves for Anthropic'), ['leave', 'John Jumper', 'deepmind', 'anthropic']);
  assert.deepEqual(p('Meta chief AI scientist Yann LeCun is leaving to create his own startup'), ['leave', 'Yann LeCun', 'meta', null]);
  assert.deepEqual(p('Apple names Johny Srouji as chief hardware officer'), ['appoint', 'Johny Srouji', null, 'apple']);
  for (const t of ['Bain Joins Anthropic’s Claude Partner Network at Global Premier Tier', "Anthropic's Claude Duet joins the race for always-on agents", 'Anthropic names Gorilla Logic as Claude services partner', 'Anthropic taps Elon Musk’s SpaceX for more AI compute power', 'ORCL Stock Gains After Google’s Gemini Joins Meta, OpenAI, xAI In Oracle’s AI Model Lineup']) assert.equal(parse(t), null, t);
});

test('talent: one move per person across outlets, flows and net per company', () => {
  resetDb();
  let n = 0;
  const add = (title, source, daysAgo) => upsertDoc({ url: `https://${source}.com/${n++}`, type: 'article', title, description: '', site: `${source}.com`, source, published_at: now - daysAgo * DAY });
  add('Yann LeCun leaves Meta to launch new AI startup', 'a', 20);
  add('Meta chief AI scientist Yann LeCun is leaving to create his own startup', 'b', 19);
  add('Google Gemini co-lead Noam Shazeer leaves for OpenAI', 'c', 10);
  add('Former Google researcher Ada Byron joins OpenAI', 'd', 5);
  add('Apple names Johny Srouji as chief hardware officer', 'e', 3);
  const r = computeTalent(getDb(), { now });
  assert.equal(r.total, 4);
  const lecun = r.moves.find((m) => m.name === 'Yann LeCun');
  assert.equal(lecun.outlets, 2);
  assert.deepEqual(r.flows.map((f) => [f.from, f.to, f.n]), [['google', 'openai', 2]]);
  const openai = r.orgs.find((o) => o.key === 'openai');
  assert.deepEqual([openai.arrivals, openai.departures, openai.net], [2, 0, 2]);
  assert.ok(!r.orgs.some((o) => o.key === 'apple'), 'appointments are not arrivals');
});
