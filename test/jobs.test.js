import test from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, getDb } from '../src/db.js';
import { upsertDoc } from '../src/index/documents.js';
import { parseJobs, countOf, shareOf, companyOf, computeJobs } from '../src/index/jobs.js';

const DAY = 86400e3;
const now = Date.parse('2026-10-22T12:00:00Z');

test('jobs headlines: company, headcount or share, and why AI comes into it', () => {
  const a = parseJobs('Snap is cutting 1,000 jobs, citing AI. Read the memo to staff.');
  assert.deepEqual([a.kind, a.company.key, a.count, a.reason, a.planned], ['cut', 'snap', 1000, 'replaced', false]);
  const b = parseJobs('Atlassian slashes 10% of workforce to \'self-fund\' investments in AI and enterprise sales');
  assert.deepEqual([b.company.label, b.share, b.reason], ['Atlassian', 10, 'funding']);
  const c = parseJobs('Intuit to lay off over 3,000 employees to refocus on AI');
  assert.deepEqual([c.count, c.reason, c.planned], [3000, 'refocus', true]);
  assert.equal(parseJobs('\'Fortnite\' maker Epic Games is laying off 1,000 employees. Its CEO says AI isn\'t to blame.').reason, 'denied');
  // A boss named in place of the company.
  assert.equal(companyOf('Block CEO Jack Dorsey lays off nearly half of his staff because of AI'), 'Block');
  assert.equal(shareOf('Block lays off nearly half its staff because of AI'), 45);
  assert.equal(countOf('Amazon cuts its workforce by 14,000 in further embrace of AI'), 14000);
  assert.equal(countOf('The 2026 jobs AI will change'), null, 'a year is not a headcount');
  // The argument, not a cut.
  const d = parseJobs('Nvidia\'s Jensen Huang says CEOs who blame AI for layoffs are giving a \'lazy\' excuse');
  assert.deepEqual([d.kind, d.stance], ['debate', 'skeptic']);
  assert.equal(parseJobs('AI could displace one in 11 workers, Goldman says').stance, 'alarm');
  // Other senses of the words.
  assert.equal(parseJobs('Google adds webhooks to the Gemini API for long-running AI jobs'), null);
  assert.equal(parseJobs('Steve Jobs would have hated AI'), null);
  assert.equal(parseJobs('As AI Surges, Layoffs Hit Worst Moment Since 2009')?.company ?? null, null);
});

test('jobs: a round of cuts is one event across outlets, with months, companies and the debate', () => {
  resetDb();
  let n = 0;
  const add = (title, source, daysAgo) => upsertDoc({ url: `https://${source}.com/${n++}`, type: 'article', title, description: '', body: '', site: `${source}.com`, source, published_at: now - daysAgo * DAY });
  add('Barclays to cut 5,000 jobs as it turns to AI to improve efficiency', 'reuters', 3);
  add('Barclays is cutting 5,000 jobs in an AI push', 'ft', 2);
  add('Barclays plans 5,000 job cuts as AI push reshapes operations', 'bbc', 1);
  add('Cisco cuts nearly 4,000 jobs to spend more on AI', 'cnbc', 160);
  add('Companies are beginning to rehire after AI layoffs', 'wsj', 20);
  add('Vanishing entry-level jobs are the real impact of AI on the workforce', 'axios', 10);
  const d = computeJobs(getDb(), now);
  const barclays = d.cuts.filter((c) => c.company.key === 'barclays');
  assert.equal(barclays.length, 1, 'one round of cuts');
  assert.deepEqual([barclays[0].count, barclays[0].outlets, barclays[0].reason], [5000, 3, 'refocus']);
  assert.equal(d.companies[0].key, 'barclays');
  assert.equal(d.stats.jobs, 9000);
  assert.equal(d.stats.jobs90, 5000);
  assert.equal(d.months.length, 12);
  assert.equal(d.months.reduce((s, m) => s + m.rounds, 0), 2);
  assert.equal(d.debate.skeptic.length, 1);
  assert.equal(d.debate.alarm.length, 1);
  assert.equal(d.roles.find((r) => r.key === 'entry').n, 1);
});
