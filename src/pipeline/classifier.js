// Client for the local zero-shot classifier (classifier/server.py).

import { TECH_CLASSIFIER } from '../config.js';

const BATCH = TECH_CLASSIFIER.batch;

// Classifies texts against labels. Returns, per text, the best label and the
// top three: { label, score, top: [{ label, score }] } (null if unscored).
export async function classifyTexts(texts, labels) {
  const out = [];
  for (let i = 0; i < texts.length; i += BATCH) {
    const res = await fetch(`${TECH_CLASSIFIER.url}/classify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ texts: texts.slice(i, i + BATCH), labels }),
      signal: AbortSignal.timeout(90000),
    });
    if (!res.ok) throw new Error(`classifier HTTP ${res.status}`);
    out.push(...(await res.json()).results);
  }
  return out;
}

export const itemText = (i) => `${i.title}. ${i.summary || ''}`.trim().slice(0, 400);
