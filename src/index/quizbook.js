// The quiz's server side: editions built in the history worker (quiz.js) and
// frozen in kv once they have enough questions, so the answer key never
// changes; the public view without answers; and anonymous counts of what
// readers picked and scored, which come back with each answer.

import { q, tx } from '../db.js';
import { cachedJob } from './offload.js';
import { editionIds } from './quiz.js';

const DAY = 86400e3;
export const MIN_QUESTIONS = 5;
const frozen = new Map();

const marketsOf = (store) => (store?.markets || [])
  .filter((m) => m.binary && m.outcomes?.length)
  .map((m) => ({ id: m.id, title: m.title, url: m.url, binary: true, outcomes: m.outcomes.map((o) => o.label) }));

export async function quizEdition(store, id) {
  if (frozen.has(id)) return frozen.get(id);
  const row = q('SELECT v FROM kv WHERE k = ?').get(`quiz:${id}`);
  if (row) {
    const e = JSON.parse(row.v);
    frozen.set(id, e);
    return e;
  }
  const e = await cachedJob(`quiz:${id}`, { kind: 'quiz', id, markets: marketsOf(store) }, 60 * 60e3);
  if (e.questions.length >= MIN_QUESTIONS) {
    q('INSERT OR IGNORE INTO kv (k, v) VALUES (?, ?)').run(`quiz:${id}`, JSON.stringify(e));
    frozen.set(id, e);
  }
  return e;
}

const picksOf = (id, n, options) => {
  const picks = new Array(options).fill(0);
  for (const r of q('SELECT choice, n FROM quiz_answers WHERE edition = ? AND q = ?').all(id, n)) if (r.choice < options) picks[r.choice] = r.n;
  return picks;
};
const histOf = (id, max) => {
  const hist = new Array(max + 1).fill(0);
  for (const r of q('SELECT score, n FROM quiz_scores WHERE edition = ?').all(id)) if (r.score <= max) hist[r.score] = r.n;
  return hist;
};

// What a reader sees before answering.
export function publicQuiz(e, now = Date.now()) {
  const ids = editionIds(now);
  return {
    id: e.id,
    from: e.from,
    to: e.to,
    current: ids[0] === e.id,
    editions: ids.map((id) => ({ id, from: Date.parse(`${id}T00:00:00Z`) - 7 * DAY, to: Date.parse(`${id}T00:00:00Z`) })),
    players: histOf(e.id, e.questions.length).reduce((a, b) => a + b, 0),
    questions: e.questions.map(({ n, type, kind, prompt, text, options }) => ({ n, type, kind, prompt, text, options })),
  };
}

// One answer: counted, then the right option, the story behind it and how
// readers split.
export function recordAnswer(e, n, choice) {
  const qn = e.questions[n];
  if (!qn || !Number.isInteger(choice) || choice < 0 || choice >= qn.options.length) return null;
  q('INSERT INTO quiz_answers (edition, q, choice, n) VALUES (?, ?, ?, 1) ON CONFLICT(edition, q, choice) DO UPDATE SET n = n + 1').run(e.id, n, choice);
  return { n, choice, correct: choice === qn.answer, answer: qn.answer, story: qn.story || null, market: qn.market || null, picks: picksOf(e.id, n, qn.options.length) };
}

export function recordScore(e, score) {
  if (!Number.isInteger(score) || score < 0 || score > e.questions.length) return null;
  q('INSERT INTO quiz_scores (edition, score, n) VALUES (?, ?, 1) ON CONFLICT(edition, score) DO UPDATE SET n = n + 1').run(e.id, score);
  return quizStats(e);
}

// Every question's split and the score distribution, for a reader who has
// finished (answers included: they've seen them).
export function quizStats(e) {
  return tx(() => ({
    id: e.id,
    hist: histOf(e.id, e.questions.length),
    questions: e.questions.map((qn) => ({ n: qn.n, answer: qn.answer, story: qn.story || null, market: qn.market || null, picks: picksOf(e.id, qn.n, qn.options.length) })),
  }));
}
