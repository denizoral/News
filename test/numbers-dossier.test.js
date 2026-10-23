import test from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, getDb } from '../src/db.js';
import { upsertDoc } from '../src/index/documents.js';
import { parseNumber, parseNumbers, computeNumbers } from '../src/index/numbers.js';
import { buildDossier } from '../src/index/dossier.js';

const DAY = 86400e3;

test('numbers: company, metric, the amount nearest its word, period, outlook', () => {
  const a = parseNumber('Anthropic boasts revenue run rate of $30 billion as the Claude developer expands');
  assert.deepEqual([a.company, a.metric, a.value], ['anthropic', 'runrate', 30e9]);
  const b = parseNumber('Amazon hikes 2026 capex to $220 billion due to higher memory costs');
  assert.deepEqual([b.metric, b.value, b.period], ['capex', 220e9, '2026']);
  const c = parseNumber('ChatGPT now has 1.2 billion weekly users, OpenAI says.');
  assert.deepEqual([c.company, c.metric, c.value, c.period], ['openai', 'users', 1.2e9, 'weekly']);
  assert.deepEqual(parseNumbers('OpenAI tripled revenue to $5.7 billion in Q1 but burned through $3.7 billion').map((p) => [p.metric, p.value]), [['loss', 3.7e9], ['revenue', 5.7e9]]);
  assert.equal(parseNumber('Microsoft Azure tops $100B in annual revenue as record AI spending cuts into cash flow').metric, 'revenue');
  assert.equal(parseNumber('Cursor has reportedly surpassed $2B in annualized revenue').reported, true);
  assert.equal(parseNumber('Microsoft is creating a $700 billion moat with its AI spend through 2030').outlook, true);
  // An IPO bid, a bond sale, a gap, a figure that belongs to someone else.
  assert.equal(parseNumber('Anthropic revenue jumps 46% ahead of $2 trillion IPO bid'), null);
  assert.equal(parseNumber('Alphabet taps $20B bond sale to fund AI capex'), null);
  assert.equal(parseNumber("OpenAI's revenue is reportedly $20 billion lower than thought"), null);
  assert.equal(parseNumber("OpenAI's revenue misses. Nvidia just lost $170 billion"), null);
});

test('numbers: the same figure across outlets is one point; the board keeps actuals', () => {
  resetDb();
  const now = Date.now();
  let n = 0;
  const add = (title, source, daysAgo) => upsertDoc({ url: `https://${source}.com/${n++}`, type: 'article', title, description: '', body: '', site: `${source}.com`, source, published_at: now - daysAgo * DAY });
  add('Anthropic boasts revenue run rate of $30 billion', 'reuters', 5);
  add('Anthropic hits a $30 billion annualized revenue run rate', 'ft', 4);
  add('Anthropic run rate reached $14 billion', 'verge', 120);
  add('Anthropic expects a run rate of $70 billion by 2028', 'info', 2);
  const d = computeNumbers(getDb(), now);
  const rr = d.board.find((b) => b.metric === 'runrate').companies.find((c) => c.company === 'anthropic');
  assert.equal(rr.latest.value, 30e9, 'the latest actual, not the outlook');
  assert.equal(rr.latest.outlets, 2);
  assert.deepEqual(rr.history.map((p) => p.value), [14e9, 30e9, 70e9]);
});

test('dossier: other pages filtered to one company and merged into a timeline', () => {
  const now = Date.now();
  const parts = {
    shipped: { entries: [{ at: now - DAY, product: 'claude', kind: 'feature', title: 'Claude can now build dashboards', url: 'u1', source: 'verge', outlets: 2 }, { at: now - DAY, product: 'chatgpt', kind: 'feature', title: 'ChatGPT adds locks', url: 'u2', source: 'tc', outlets: 1 }], labels: { kinds: { feature: 'New feature' } } },
    incidents: { incidents: [{ at: now - 3 * DAY, product: { key: 'claude' }, kind: 'agents', title: 'Claude agent deletes a database', url: 'u3', source: 'wired', outlets: 3 }], labels: { kinds: { agents: 'Agents gone wrong' } } },
    numbers: { points: [{ at: now - 2 * DAY, company: 'anthropic', metric: 'runrate', title: 'Anthropic run rate $30B', url: 'u4', source: 'ft' }], board: [{ metric: 'runrate', label: 'Run-rate revenue', companies: [{ company: 'anthropic', latest: { value: 30e9 }, history: [] }] }], labels: { metrics: { runrate: 'Run-rate revenue' } } },
    mood: { companies: [{ key: 'anthropic', mood90: -11.9, moodPrev: -3.6, moodWeek: -8.6, weeks: [], good: [], bad: [] }], series: [] },
    ahead: { items: [{ kind: 'retire', title: 'Claude Sonnet 4.5 retires on November 30', date: '2026-11-30' }, { kind: 'retire', title: 'GPT-4o leaves the API', date: '2027-01-14' }] },
    deals: null, topic: null, open: null, court: null, jobs: null,
  };
  const d = buildDossier('anthropic', parts, now);
  assert.deepEqual(d.timeline.map((x) => x.type), ['shipped', 'figure', 'incident']);
  assert.equal(d.figures[0].latest.value, 30e9);
  assert.equal(d.mood.mood90, -11.9);
  assert.deepEqual(d.ahead.map((x) => x.title), ['Claude Sonnet 4.5 retires on November 30']);
  assert.equal(d.stats.shipped30, 1);
  assert.equal(buildDossier('nobody', parts), null);
});

test('numbers: a figure for one product is marked part and doesn’t stand for the company', async () => {
  const { parseNumber } = await import('../src/index/numbers.js');
  assert.equal(parseNumber('Anthropic’s Claude Code hits a $2.5B run rate').part, true);
  assert.equal(parseNumber('Anthropic boasts revenue run rate of $30 billion').part, false);
});
