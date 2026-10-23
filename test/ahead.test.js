import test from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, getDb } from '../src/db.js';
import { upsertDoc } from '../src/index/documents.js';
import { datesIn, computeAhead, aheadIcs } from '../src/index/ahead.js';

const pub = Date.parse('2026-10-20T12:00:00Z'); // a Tuesday

test('what’s coming: future dates named in a headline, resolved against its day', () => {
  assert.deepEqual(datesIn('GPT-4o and GPT-4.1 Leave OpenAI’s API on January 14, 2027', pub), [{ date: '2027-01-14', precision: 'day' }]);
  assert.deepEqual(datesIn('Claude Haiku 4.5 leaves the model selector on October 29', pub), [{ date: '2026-10-29', precision: 'day' }]);
  assert.deepEqual(datesIn('Apple Intelligence reportedly coming to China in December', pub), [{ date: '2026-12-01', precision: 'month' }]);
  assert.deepEqual(datesIn('Walmart will let AI agents shop starting next month', pub), [{ date: '2026-11-01', precision: 'month' }]);
  assert.deepEqual(datesIn('NVIDIA RTX 5080 24 GB Reportedly Planned For Q1 2027', pub), [{ date: '2027-01-01', precision: 'quarter' }]);
  assert.deepEqual(datesIn('Anthropic May Launch Opus 6 Next Week', pub), [{ date: '2026-10-26', precision: 'week' }]);
  // Back-references to the past aren't plans.
  assert.deepEqual(datesIn('OpenAI’s rogue AI tried to hack another company in May', pub), []);
  assert.deepEqual(datesIn('Top AI spenders cut costs by nearly 10 percent in August', pub), []);
});

test('what’s coming: grouped across outlets, kinds, markets by day, iCalendar', () => {
  resetDb();
  const now = Date.parse('2026-10-23T12:00:00Z');
  let n = 0;
  const add = (title, source) => upsertDoc({ url: `https://${source}.com/${n++}`, type: 'article', title, description: '', body: '', site: `${source}.com`, source, published_at: pub });
  add('Claude Sonnet 4.5 retires on November 30, Anthropic says AI users should switch', 'verge');
  add('Anthropic will retire Claude Sonnet 4.5 AI model on November 30', 'tc');
  add('UK ICO gives AI agent firms until November 20 to submit evidence', 'bbc');
  add('OpenAI’s rogue AI tried to hack another company in May', 'wired');
  const markets = [
    { id: 'pm:1', title: 'Best AI model end of 2026?', url: 'https://polymarket.com/a', volume: 9, endDate: '2027-01-01T04:59:00Z', binary: false, outcomes: [{ label: 'Anthropic', yes: 0.46 }, { label: 'Google', yes: 0.3 }] },
    { id: 'pm:2', title: 'OpenAI IPO in 2026?', url: 'https://polymarket.com/b', volume: 5, endDate: '2027-01-01T04:59:00Z', binary: true, outcomes: [{ label: 'OpenAI IPO in 2026?', yes: 0.1 }] },
  ];
  const d = computeAhead(getDb(), { now, markets });
  const sonnet = d.items.filter((x) => /Sonnet/.test(x.title));
  assert.equal(sonnet.length, 1, 'one date across outlets');
  assert.deepEqual([sonnet[0].date, sonnet[0].kind, sonnet[0].outlets], ['2026-11-30', 'retire', 2]);
  assert.equal(d.items.find((x) => /ICO/.test(x.title)).kind, 'deadline');
  const mk = d.items.find((x) => x.kind === 'market');
  assert.deepEqual([mk.date, mk.marketCount, mk.markets[0].lead.label], ['2026-12-31', 2, 'Anthropic'], 'New York time, biggest first');
  assert.ok(!d.items.some((x) => /rogue/.test(x.title)));
  const ics = aheadIcs(d, { ids: new Set([sonnet[0].id]) });
  assert.match(ics, /BEGIN:VEVENT[\s\S]*DTSTART;VALUE=DATE:20261130[\s\S]*END:VEVENT/);
  assert.equal(ics.match(/BEGIN:VEVENT/g).length, 1);
  assert.ok(ics.split('\r\n').every((l) => l.length <= 75));
});
