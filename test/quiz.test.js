import test from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, getDb } from '../src/db.js';
import { upsertDoc } from '../src/index/documents.js';
import { editionEnd, editionIds, nameQuestion, moneyQuestion, marketQuestion, buildQuiz, fmtUsd } from '../src/index/quiz.js';
import { recordAnswer, recordScore, publicQuiz, quizStats } from '../src/index/quizbook.js';

const DAY = 86400e3;
const rand = () => 0.42;

test('quiz editions end on Saturdays (UTC)', () => {
  assert.equal(new Date(editionEnd(Date.parse('2026-10-23T08:00:00Z'))).toISOString(), '2026-10-17T00:00:00.000Z');
  assert.equal(new Date(editionEnd(Date.parse('2026-10-24T00:00:00Z'))).toISOString(), '2026-10-24T00:00:00.000Z');
  assert.deepEqual(editionIds(Date.parse('2026-10-23T08:00:00Z'), 2), ['2026-10-17', '2026-10-10']);
});

test('quiz questions: a missing name, an amount, where a market ended', () => {
  const a = nameQuestion('Anthropic warns small AI models could copy themselves across smart TVs', new Map([['OpenAI', 3]]), rand);
  assert.equal(a.options[a.answer], 'Anthropic');
  assert.match(a.text, /^_____ warns/);
  assert.ok(a.options.includes('OpenAI'), 'names the week carried come first');
  // A related name in the headline gives the blank away.
  const b = nameQuestion('Anthropic says Claude can now run for days', new Map(), rand);
  assert.notEqual(b?.options[b.answer], 'Anthropic');
  assert.notEqual(b?.options[b.answer], 'Claude');
  const m = moneyQuestion("Anthropic's quarterly revenue leaps to $17 billion as IPO looms", rand);
  assert.equal(m.options[m.answer], '$17 billion');
  assert.equal(new Set(m.options).size, 4);
  assert.match(m.text, /\$_____ as IPO/);
  assert.equal(fmtUsd(1.25e9), '$1.3 billion');
  const k = marketQuestion({ title: 'OpenAI IPO in 2026?', url: 'https://polymarket.com/x' }, 0.34, 0.61, rand);
  assert.equal(k.options[k.answer], '61%');
  assert.ok(k.options.includes('34%'), 'where it started is an option');
  assert.match(k.prompt, /34% when the week began/);
  assert.equal(marketQuestion({ title: 'OpenAI resumes training by...?', outcomes: ['October 31'] }, 0.58, 0.34, rand).text, 'OpenAI resumes training by October 31?');
});

test('quiz: an edition from the week’s headlines, answers counted', () => {
  resetDb();
  const end = Date.parse('2026-10-17T00:00:00Z');
  let n = 0;
  const add = (title, source, daysAgo) => upsertDoc({ url: `https://${source}.com/${n++}`, type: 'article', title, description: '', body: '', site: `${source}.com`, source, published_at: end - daysAgo * DAY });
  for (const s of ['verge', 'cnbc', 'reuters']) add('Anthropic warns small AI models could soon copy themselves across smart TVs', s, 2);
  add('OpenAI launches always-on agents to rival Meta’s AI assistant', 'verge', 3);
  add('Nvidia launches a platform to quarantine rogue AI agents in milliseconds', 'wired', 4);
  add("Anthropic's quarterly AI revenue leaps to $17 billion as IPO looms", 'ft', 5);
  add('Microsoft adds AI agents to Excel and Word for every business user', 'zdnet', 6);
  add('Old AI story from Google about chatbots and search', 'old', 9);
  const e = buildQuiz(getDb(), { id: '2026-10-17' });
  assert.equal(e.questions[0].options[e.questions[0].answer], 'Anthropic', 'the most-carried story leads');
  assert.ok(e.questions.some((x) => x.type === 'money'));
  assert.ok(!e.questions.some((x) => /Old AI story/.test(x.text)), 'only the week');
  const pub = publicQuiz(e, Date.parse('2026-10-20T00:00:00Z'));
  assert.equal(pub.current, true);
  assert.ok(pub.questions.every((x) => !('answer' in x) && !('story' in x)), 'no answers before playing');
  const r = recordAnswer(e, 0, e.questions[0].answer);
  assert.equal(r.correct, true);
  assert.equal(r.story.sources, 3);
  recordAnswer(e, 0, (e.questions[0].answer + 1) % 4);
  assert.equal(recordAnswer(e, 0, 9), null);
  assert.equal(quizStats(e).questions[0].picks.reduce((a, b) => a + b, 0), 2);
  assert.equal(recordScore(e, 3).hist[3], 1);
  assert.equal(recordScore(e, 99), null);
});
