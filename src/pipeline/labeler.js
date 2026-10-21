// Background labelling: AI news gets a sub-category (Models, Products,
// Research, ...), X posts get a subject (AI, World, Politics, Crypto, ...).
// Newest unlabelled items go first, a batch at a time, so fresh items are
// labelled within seconds and older ones drain in the background. Labels are
// stored on the item (item.cats) and persist with it.

import { classifyTexts, itemText } from './classifier.js';

// Classifier label -> chip name. Phrases are what the model reads; chips are
// what people see. Bump a taxonomy's version when its labels change and its
// items are relabelled. `second` is the score a runner-up needs to become a
// second chip (null: one chip only; AI news runners-up are too often noise).
export const TAXONOMIES = {
  ai: {
    version: 2,
    second: null,
    match: (i) => (i.section || 'news') === 'news' && i.platform !== 'x',
    labels: {
      'new AI model release': 'Models',
      'AI product or feature launch': 'Products',
      'AI research': 'Research',
      'AI funding, business and deals': 'Money',
      'AI policy, law and regulation': 'Policy',
      'AI safety and ethics': 'Safety',
      'AI chips, compute and data centers': 'Chips',
      // Plain "open-source AI" matched on the word "OpenAI"; "robotics" took software agents.
      'open-weight model or open-source code released publicly': 'Open source',
      'physical robots and self-driving vehicles': 'Robotics',
    },
  },
  x: {
    version: 1,
    second: 0.9,
    match: (i) => i.platform === 'x',
    labels: {
      'artificial intelligence': 'AI',
      technology: 'Tech',
      'world news': 'World',
      politics: 'Politics',
      cryptocurrency: 'Crypto',
      'stock market and investing': 'Stocks',
      business: 'Business',
      sports: 'Sports',
      science: 'Science',
      'entertainment and culture': 'Culture',
    },
  },
};

const BATCH = 32;
export const labelerStatus = { ok: null, labelled: 0, pending: 0, lastBatchMs: null, error: null };

function taxonomyOf(item) {
  for (const [name, t] of Object.entries(TAXONOMIES)) if (t.match(item)) return name;
  return null;
}

export function catsFrom(result, taxonomy) {
  if (!result) return [];
  const { labels: names, second } = TAXONOMIES[taxonomy];
  const [first, ...rest] = result.top || [result];
  const cats = [names[first.label]];
  const runnerUp = rest[0];
  if (second != null && runnerUp?.score >= second && names[runnerUp.label]) cats.push(names[runnerUp.label]);
  return cats.filter(Boolean);
}

const stamp = (name) => `${name}:${TAXONOMIES[name].version}`;
const needsLabel = (i) => {
  const name = taxonomyOf(i);
  return name && (!i.cats || i.catsV !== stamp(name));
};

async function tick(store) {
  const todo = [...store.items.values()].filter(needsLabel);
  labelerStatus.pending = todo.length;
  if (!todo.length) return false;
  todo.sort((a, b) => b.publishedAt - a.publishedAt);
  const batch = todo.slice(0, BATCH);
  const started = Date.now();
  for (const [name, t] of Object.entries(TAXONOMIES)) {
    const items = batch.filter((i) => taxonomyOf(i) === name);
    if (!items.length) continue;
    const results = await classifyTexts(items.map(itemText), Object.keys(t.labels));
    items.forEach((it, k) => {
      it.cats = catsFrom(results[k], name);
      it.catsV = stamp(name);
    });
    labelerStatus.labelled += items.length;
  }
  labelerStatus.lastBatchMs = Date.now() - started;
  labelerStatus.pending -= batch.length;
  return true;
}

export function startLabeler(store, { idleMs = 15e3, errorMs = 60e3 } = {}) {
  let lastRebuild = 0;
  const loop = async () => {
    let delay = idleMs;
    try {
      // Keep going straight away while there's a backlog, but republish at
      // most every 30 seconds while draining it.
      if (await tick(store)) {
        if (!labelerStatus.pending || Date.now() - lastRebuild > 30e3) {
          store.scheduleRebuild();
          lastRebuild = Date.now();
        }
        delay = 500;
      }
      labelerStatus.ok = true;
      labelerStatus.error = null;
    } catch (err) {
      labelerStatus.ok = false;
      labelerStatus.error = err.message;
      delay = errorMs;
    }
    setTimeout(loop, delay).unref();
  };
  setTimeout(loop, 5e3).unref();
}
