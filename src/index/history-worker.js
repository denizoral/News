// Runs history queries (topic pages, the weekly digest, release coverage, model comparison, trends, deals, vector search, market moves, any-day pages, outlets, quotes, storylines, predictions, catch-up, the entity graph, X accounts, For you) off the main thread
// with its own read-only connection (see offload.js).

import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { computeTopic } from './topics.js';
import { computeDigest } from './digest.js';
import { similarDocs, vectorIndex } from './semantic.js';
import { askPassages } from './ask.js';
import { computeAccount, computeAccounts, compareAccounts } from './accounts.js';
import { tasteScores } from './foryou.js';
import { computeReleaseCoverage } from './releases.js';
import { computeModels } from './models.js';
import { computeEmerging } from './emerging.js';
import { computeMoves } from './moves.js';
import { computeGraph, graphDetail } from './graph.js';
import { computeTrends, trendMoment } from './trends.js';
import { computeDeals, companyDeals } from './deals.js';
import { computeDay, dayCalendar } from './day.js';
import { computeOutlets, computeOutlet, outletScan } from './outlets.js';
import { computePerson, computeQuotes, quoteIndex } from './quotes.js';
import { computeStorylines, storyDays } from './storylines.js';
import { computeForecasts, forecastIndex } from './forecasts.js';
import { computeCatchup } from './catchup.js';

const db = new DatabaseSync(workerData.file, { readOnly: true });
db.exec('PRAGMA busy_timeout = 5000; PRAGMA cache_size = -32000;');

const JOBS = {
  topic: ({ key }) => computeTopic(db, key),
  digest: () => computeDigest(db),
  similar: (job) => similarDocs(db, job),
  releases: ({ releases }) => computeReleaseCoverage(db, releases),
  models: ({ releases }) => computeModels(db, releases),
  emerging: ({ stories }) => computeEmerging(db, stories),
  moves: ({ markets, vectors }) => computeMoves(db, markets, vectors),
  graph: ({ days }) => computeGraph(db, { days }),
  graphDetail: ({ days, a, b }) => graphDetail(db, { days, a, b }),
  account: ({ handle }) => computeAccount(db, vectorIndex(db), handle),
  accounts: () => computeAccounts(db, vectorIndex(db)),
  compare: ({ a, b }) => compareAccounts(db, vectorIndex(db), a, b),
  taste: (job) => tasteScores(db, job),
  trends: ({ q, range }) => computeTrends(db, { q, range }),
  trendMoment: (job) => trendMoment(db, job),
  askPassages: (job) => askPassages(db, { ...job, similar: (o) => similarDocs(db, o) }),
  deals: ({ range }) => computeDeals(db, { range }),
  companyDeals: ({ key }) => companyDeals(db, { key }),
  day: ({ day }) => computeDay(db, { day }),
  dayCalendar: () => dayCalendar(db),
  outlets: () => computeOutlets(db, { scan: outletScan(db) }),
  outlet: ({ site }) => computeOutlet(db, { site, scan: outletScan(db) }),
  quotes: ({ q }) => computeQuotes(quoteIndex(db), { q }),
  person: ({ key }) => {
    const d = computePerson(quoteIndex(db), { key });
    if (d) d.predictions = computeForecasts(forecastIndex(db), { who: key, limit: 6 }).forecasts;
    return d;
  },
  storyDays: () => storyDays(db),
  storylines: ({ chapters }) => computeStorylines(vectorIndex(db), { chapters }),
  forecasts: ({ theme, year, who }) => computeForecasts(forecastIndex(db), { theme, year, who }),
  catchup: ({ since }) => computeCatchup(db, { since }),
};

parentPort.on('message', ({ id, job }) => {
  try {
    parentPort.postMessage({ id, data: JOBS[job.kind](job) });
  } catch (err) {
    parentPort.postMessage({ id, error: err.message });
  }
});
