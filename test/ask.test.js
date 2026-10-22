import test from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, getDb } from '../src/db.js';
import { upsertDoc } from '../src/index/documents.js';
import { questionTerms, ftsQuery, sentences, pickAnswer, confidenceOf, askPassages, ask } from '../src/index/ask.js';

test('ask: question words drop, sentences are cleaned and split', () => {
  assert.deepEqual(questionTerms('How much did Anthropic raise in its latest round?'), ['anthropic', 'raise', 'round']);
  assert.equal(ftsQuery(['eu', 'act']), '{title description body} : ("eu" OR "act")');
  assert.equal(ftsQuery([]), null);
  const s = sentences('Skip to content Feb 13, 2026 Anthropic has closed a $30 billion Series G funding round, bringing it to $380 billion.The company said demand for Claude keeps growing across every region. What does this mean for the rest of the industry? Short one. Subscribe to our newsletter for more stories like this one every week.');
  assert.deepEqual(s, [
    "Anthropic has closed a $30 billion Series G funding round, bringing it to $380 billion.",
    'The company said demand for Claude keeps growing across every region.',
  ]);
});

test('ask: MMR picks relevant sentences, skips near-copies, at most two per article', () => {
  const v = (x, y) => { const n = Math.hypot(x, y); return [x / n, y / n]; };
  const cands = [
    { d: 0, text: 'a', vec: v(1, 0), sim: 0.9, score: 0.9 },
    { d: 1, text: 'a copy', vec: v(1, 0.01), sim: 0.89, score: 0.89 },
    { d: 0, text: 'b', vec: v(0.8, 0.6), sim: 0.8, score: 0.8 },
    { d: 0, text: 'c', vec: v(0.6, 0.8), sim: 0.78, score: 0.78 },
    { d: 2, text: 'd', vec: v(0.7, 0.7), sim: 0.75, score: 0.75 },
    { d: 3, text: 'off', vec: v(0, 1), sim: 0.4, score: 0.4 },
  ];
  // 'c' adds the most that 'a' doesn't say; then 'b' and 'd' are too close to
  // what's chosen, the copy repeats 'a', and 'off' is below the floor.
  assert.deepEqual(pickAnswer(cands).map((c) => c.text), ['a', 'c']);
  assert.deepEqual(pickAnswer(cands, { dupe: 0.99, perDoc: 1 }).map((c) => c.d), [0, 2], 'one per article; the copy still repeats');
  assert.equal(confidenceOf(0.8), 'strong');
  assert.equal(confidenceOf(0.5), 'weak');
});

test('ask: passages from keyword matches, answer cites its sources in order', async () => {
  resetDb();
  const now = Date.now();
  upsertDoc({ url: 'https://a.example/1', type: 'article', title: 'Acme raises $50M for robot hands', body: 'Acme raised $50 million in a Series B round led by Sequoia this week. The robot hands can fold laundry and sort parcels at warehouse speed. Acme was founded in 2021 by two former researchers.', site: 'a.example', published_at: now - 86400e3 });
  upsertDoc({ url: 'https://b.example/2', type: 'article', title: 'Robot hands are having a moment', body: 'Investors poured money into robot hands this year, and Acme is the latest to raise a big round. Other startups are expected to follow soon with even larger rounds.', site: 'b.example', published_at: now - 2 * 86400e3 });
  upsertDoc({ url: 'https://huggingface.co/acme/hand', type: 'article', title: 'acme/hand model card', body: 'Acme hand model card with weights and a long description of how Acme trained it.', site: 'huggingface.co', published_at: now });
  const db = getDb();
  const p = askPassages(db, { vec: null, terms: ['acme', 'raise'], similar: () => ({ results: [] }) });
  assert.equal(p.docs.length, 2, 'model cards are not coverage');
  assert.ok(p.sentences.every((s) => s.text.length >= 50));
  // A fake embedder: the question and the funding sentence point the same way.
  const embed = async (texts) => texts.map((t) => (/Represent this|\$50 million/.test(t) ? [1, 0] : [0.6, 0.8]));
  const job = async (j) => askPassages(db, { ...j, similar: () => ({ results: [] }) });
  const r = await ask('How much did Acme raise?', { embed, job });
  assert.equal(r.confidence, 'strong');
  assert.match(r.answer[0].text, /\$50 million/);
  assert.equal(r.answer[0].cite, 1);
  assert.equal(r.sources[0].url, 'https://a.example/1');
  assert.ok(r.sources[0].cited);
  assert.equal(r.sources.length, 2);
  const again = await ask('how much did acme raise', { embed: () => { throw new Error('cached'); }, job });
  assert.equal(again, r);
});

test('ask: other languages and photo credits stay out of answers', () => {
  assert.deepEqual(sentences('Het Model Context Protocol (MCP) is een open standaard die AI-toepassingen verbindt met externe tools en data.'), []);
  assert.deepEqual(sentences('Model Context Protocol (MCP) là một tiêu chuẩn mở cho phép các ứng dụng AI kết nối với các công cụ.'), []);
  assert.deepEqual(sentences('Gerry Miller | CNBCAnthropic is in talks to raise a $3.5 billion funding round, CNBC has confirmed.'), ['Anthropic is in talks to raise a $3.5 billion funding round, CNBC has confirmed.']);
});
