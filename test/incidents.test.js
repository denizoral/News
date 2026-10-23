import test from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, getDb } from '../src/db.js';
import { upsertDoc } from '../src/index/documents.js';
import { parseIncident, computeIncidents } from '../src/index/incidents.js';

const DAY = 86400e3;
const now = Date.parse('2026-10-22T12:00:00Z');

test('incident headlines: kind, product, response and lab or world', () => {
  const a = parseIncident('48,000 files deleted in 103 seconds: Claude Code just destroyed a developer’s work');
  assert.deepEqual([a.kind, a.product.key], ['agents', 'claude']);
  const b = parseIncident('Several countries investigate Elon Musk\'s Grok after sexualized deepfakes on women and children');
  assert.deepEqual([b.kind, b.product.key, b.responses], ['images', 'grok', ['probe']]);
  const c = parseIncident('Father sues Google, claiming Gemini chatbot drove son into fatal delusion');
  assert.deepEqual([c.kind, c.product.key, c.responses], ['harm', 'gemini', ['lawsuit']]);
  assert.equal(parseIncident('Scammers use AI to clone Florida sheriff’s captain’s voice in fake arrest warrant calls').kind, 'scams');
  assert.equal(parseIncident('Researchers used Claude to hack OpenAI').lab, true);
  assert.equal(parseIncident('Waymo robotaxi hits a cyclist in San Francisco').product.key, 'waymo');
  // Defence, advice, deals and other senses aren't incidents.
  assert.equal(parseIncident('AI helped find a critical security flaw affecting 70% of the internet'), null);
  assert.equal(parseIncident('How to protect yourself from AI deepfake scams'), null);
  assert.equal(parseIncident('Activist charged after giving border agent a code that wiped his phone'), null);
  assert.equal(parseIncident('ChatGPT, Claude, Gemini down: what we know about the outages'), null);
});

test('incidents: one story across outlets is one incident, with months, products and responses', () => {
  resetDb();
  let n = 0;
  const add = (title, source, daysAgo) => upsertDoc({ url: `https://${source}.com/${n++}`, type: 'article', title, description: '', body: '', site: `${source}.com`, source, published_at: now - daysAgo * DAY });
  add('OpenAI says its rogue AI agents leaked user images', 'verge', 5);
  add('OpenAI pauses its most capable models after rogue agents leak data', 'fortune', 4);
  add('Rogue OpenAI agents leaked 53 images from ChatGPT users', 'cnbc', 4);
  add('Hackers use Claude in AI-assisted attacks on banks', 'reuters', 30);
  add('AI deepfake of a mayor spreads before election', 'ap', 200);
  add('AI deepfake of a mayor spreads before election day', 'bbc', 200);
  add('Best AI stocks after the hack', 'fool', 2);
  const d = computeIncidents(getDb(), now);
  const rogue = d.incidents.filter((x) => x.kind === 'agents');
  assert.equal(rogue.length, 1, 'one incident');
  assert.deepEqual([rogue[0].product.key, rogue[0].outlets, rogue[0].responses], ['chatgpt', 3, ['paused']]);
  assert.equal(d.incidents.length, 3);
  assert.equal(d.stats.n90, 2);
  assert.equal(d.stats.agents90, 1);
  assert.equal(d.products[0].key, 'chatgpt');
  assert.equal(d.months.length, 12);
  assert.equal(d.months.reduce((s, m) => s + m.n, 0), 3);
  assert.equal(d.kinds.find((k) => k.key === 'security').n, 1);
});
