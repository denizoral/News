// Tech: general technology news that isn't about AI. General tech feeds and
// the Hacker News front page are fetched; anything the AI filter claims is left
// to the News tab, and the rest goes to the local topic classifier
// (classifier/server.py), which keeps the headlines it reads as technology.
// Only unseen items are classified; verdicts are cached by id.

import { getJSON, getText, pool } from '../http.js';
import { TECH_FEEDS, TECH_CLASSIFIER } from '../config.js';
import { isAiRelated } from '../pipeline/classify.js';
import { clip, stripHtml } from '../pipeline/text.js';
import { parseFeed } from './rss.js';

const { url: CLASSIFIER_URL, labels: LABELS, techLabels, minScore, batch: BATCH } = TECH_CLASSIFIER;
const TECH = new Set(techLabels);
// Short display names for the tab's filter chips.
export const TECH_TOPIC = {
  technology: 'General', software: 'Software', cybersecurity: 'Security', 'consumer electronics': 'Gadgets',
  'internet platforms': 'Platforms', 'artificial intelligence': 'AI',
};

const verdicts = new Map(); // id -> { label, score }
const MAX_VERDICTS = 20000;
export const techStatus = { ok: null, classified: 0, kept: 0, lastMs: null, error: null };

async function classify(items) {
  const fresh = items.filter((i) => !verdicts.has(i.id));
  for (let i = 0; i < fresh.length; i += BATCH) {
    const chunk = fresh.slice(i, i + BATCH);
    const res = await fetch(`${CLASSIFIER_URL}/classify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ texts: chunk.map((c) => `${c.title}. ${c.summary || ''}`.trim()), labels: LABELS }),
      signal: AbortSignal.timeout(60000),
    });
    if (!res.ok) throw new Error(`classifier HTTP ${res.status}`);
    const { results, ms } = await res.json();
    chunk.forEach((c, j) => verdicts.set(c.id, results[j] || { label: null, score: 0 }));
    techStatus.classified += chunk.length;
    techStatus.lastMs = Math.round(ms / chunk.length);
  }
  if (verdicts.size > MAX_VERDICTS) for (const k of [...verdicts.keys()].slice(0, verdicts.size - MAX_VERDICTS)) verdicts.delete(k);
}

export const isTech = (v) => !!v && TECH.has(v.label) && v.score >= minScore;

// The model often prefers the catch-all "technology"; a specific tech label
// close behind it makes a better topic.
export function topicOf(v) {
  const specific = (v.top || [v]).find((t) => t.label !== 'technology' && TECH.has(t.label) && t.score >= 0.5);
  return TECH_TOPIC[specific?.label || v.label] || 'General';
}

async function fromFeeds() {
  const { results, errors } = await pool(TECH_FEEDS, 6, async (feed) =>
    parseFeed(await getText(feed.url)).filter((e) => e.title && e.url).slice(0, 30).map((e) => ({
      id: `rss:${e.url}`,
      url: e.url,
      title: e.title,
      summary: e.summary,
      image: e.image,
      author: e.author,
      publishedAt: e.publishedAt,
      source: feed.name,
      kind: 'press',
      platform: 'web',
      weight: feed.weight,
    })),
  );
  return { items: results.flat(), errors };
}

async function fromHackerNews() {
  const { hits } = await getJSON('https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=60');
  return hits.filter((h) => h.title && !/^(show|ask|launch) hn|is hiring/i.test(h.title)).map((h) => ({
    id: `hn:${h.objectID}`,
    url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
    discussionUrl: `https://news.ycombinator.com/item?id=${h.objectID}`,
    title: h.title,
    summary: h.story_text ? clip(stripHtml(h.story_text), 280) : '',
    author: h.author,
    publishedAt: h.created_at_i * 1000,
    source: 'Hacker News',
    kind: 'community',
    platform: 'hn',
    weight: 1.0,
    engagement: { score: h.points || 0, comments: h.num_comments || 0 },
  }));
}

export async function fetchTech() {
  const [feeds, hn] = await Promise.allSettled([fromFeeds(), fromHackerNews()]);
  const errors = [...(feeds.value?.errors || [])];
  if (feeds.status === 'rejected') errors.push({ item: 'feeds', error: feeds.reason.message });
  if (hn.status === 'rejected') errors.push({ item: 'hackernews', error: hn.reason.message });

  const seen = new Set();
  const candidates = [...(feeds.value?.items || []), ...(hn.value || [])].filter((i) => {
    if (seen.has(i.id) || isAiRelated(`${i.title} ${i.summary || ''}`)) return false;
    seen.add(i.id);
    return true;
  });

  try {
    await classify(candidates);
    techStatus.ok = true;
    techStatus.error = null;
  } catch (err) {
    // Classifier down: keep what was already judged, try the rest next run.
    techStatus.ok = false;
    techStatus.error = err.message;
    errors.push({ item: 'classifier', error: err.message });
  }

  const items = candidates
    .filter((i) => isTech(verdicts.get(i.id)))
    .map((i) => ({ ...i, id: `tech:${i.id}`, section: 'tech', topic: topicOf(verdicts.get(i.id)) }));
  techStatus.kept = items.length;
  return { items, errors };
}
