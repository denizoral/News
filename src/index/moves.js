// Market moves and the news before them. A prediction market's odds jump
// when traders learn something; this finds the jumps in the stored odds
// history and the articles and posts that came out just before each one.
//
// A jump is a change of at least 7 points within three hours that holds: the
// median price for the three hours after it still differs from the median of
// the six hours before by 6 points or more, so a spike that snaps back, or a
// thin market's bid-ask bounce, doesn't count.
//
// A jump is credited to the stored documents published from six hours before
// it to an hour into it that are close in meaning to the market (bge-small,
// with the query instruction) and name what it is about: the outcome that
// moved ("Google") on a multi-outcome market, otherwise a distinctive word of
// the question ("Sol" in "Next GPT Sol released by…?"). Most jumps on quiet
// markets have no such story and are reported as unexplained.
//
// ~100 markets take ~150 ms in the history worker, cached for 10 minutes.

import { tokens, canonicalUrl } from '../pipeline/text.js';
import { headKey } from './topics.js';
import { cachedJob } from './offload.js';
import { embedTexts } from './vectors.js';

const HOUR = 3600e3;
const DAY = 24 * HOUR;
const DIM = 384;
const TTL_MS = 10 * 60e3;
const DAYS = 7;
const MIN_MOVE = 0.07;
const HOLD_MOVE = 0.06;
const SPAN = 3 * HOUR;
const BEFORE = 6 * HOUR;
const MIN_SCORE = 0.62;
const MIN_VOLUME = 20000;

const median = (pts) => {
  const v = pts.map((p) => p[1]).sort((a, b) => a - b);
  return v.length ? v[v.length >> 1] : null;
};

// points: [[ts, yes], ...] oldest first. Returns [{ start, end, from, to, change }].
export function detectJumps(points, { now = Date.now(), minMove = MIN_MOVE, holdMove = HOLD_MOVE, span = SPAN } = {}) {
  const out = [];
  let i = 0;
  const biggest = (i) => {
    let best = null;
    for (let j = i + 1; j < points.length && points[j][0] - points[i][0] <= span; j++) {
      const d = points[j][1] - points[i][1];
      if (Math.abs(d) >= minMove && (!best || Math.abs(d) > Math.abs(best.d))) best = { j, d };
    }
    return best;
  };
  while (i < points.length) {
    let best = biggest(i);
    if (!best) { i++; continue; }
    // Start where the price last stood still, so a move in two steps is one jump.
    let k = i;
    while (k + 1 < best.j && Math.abs(points[k + 1][1] - points[i][1]) < 0.015) k++;
    if (k > i) { i = k; best = biggest(i) || best; }
    const [t0] = points[i];
    const [t1] = points[best.j];
    const before = median(points.filter(([t]) => t <= t0 && t >= t0 - 2 * span));
    const afterPts = points.filter(([t]) => t >= t1 && t <= t1 + span);
    const after = median(afterPts);
    // Too recent to know whether it held: give it an hour.
    const settled = now - t1 >= HOUR;
    const held = before != null && after != null && Math.sign(after - before) === Math.sign(best.d) && Math.abs(after - before) >= holdMove && settled && afterPts.length >= 2;
    if (!held) { i++; continue; }
    out.push({ start: t0, end: t1, from: points[i][1], to: points[best.j][1], change: +best.d.toFixed(3) });
    i = best.j + 1;
  }
  return out;
}

// Words that say nothing about what a market is about.
const STOP = new Set(('which what who will when where how the and for with from into than that this by of on in at to be is are was has have its it ' +
  'next new release released releases launch launches launched announce announces announced end score highest lowest best top first second third ' +
  'company companies lab labs model models price prices output input token tokens debut hit reach above below before after between more less over under ' +
  'january february march april may june july august september october november december 2025 2026 2027 2028 ' +
  'style control text week weeks yes not like any another again ai rank ranked ranking market cap higher lower one two three per million billion trillion').split(' '));

const keysOf = (text) => [...new Set(tokens(text).flatMap((t) => [t, ...(t.includes('-') ? t.split('-') : [])]).filter((t) => /[a-z]/.test(t) && t.length >= 2 && !STOP.has(t)))];

// What a document must name to be about the market (see above).
export function marketKeys(title, label, binary) {
  const fromLabel = binary ? [] : keysOf(label || '').filter((t) => t.length >= 3);
  return fromLabel.length ? { need: fromLabel, also: keysOf(title), byLabel: true } : { need: keysOf(title), also: [], byLabel: false };
}

function score(v, vec) {
  const sc = new DataView(v.buffer, v.byteOffset, 4).getFloat32(0, true);
  let d = 0;
  for (let i = 0; i < DIM; i++) d += ((v[4 + i] << 24) >> 24) * sc * vec[i];
  return d;
}

const wordsOf = (title) => new Set(tokens(title).flatMap((t) => [t, ...t.split('-')]));

// English articles and posts in a time range, indexed by title word, with
// their vectors read only when a jump asks for them.
export function docWindow(db, since, until) {
  const docs = [];
  const st = db.prepare(`SELECT id, url, title, site, source, type, lang, published_at AS at, meta FROM docs INDEXED BY docs_type_pub
    WHERE type = ? AND published_at BETWEEN ? AND ? AND hidden = 0 AND title != ''`);
  for (const type of ['article', 'post']) for (const r of st.all(type, since, until)) if (!r.lang || /^en/.test(r.lang)) docs.push(r);
  const byWord = new Map();
  docs.forEach((d, i) => {
    d.words = wordsOf(d.title);
    for (const w of d.words) {
      if (!byWord.has(w)) byWord.set(w, []);
      byWord.get(w).push(i);
    }
  });
  const vecOf = db.prepare('SELECT v FROM doc_vecs WHERE doc_id = ?');
  const vecs = new Map();
  const vec = (d) => {
    if (!vecs.has(d.id)) vecs.set(d.id, vecOf.get(d.id)?.v || null);
    return vecs.get(d.id);
  };
  return { docs, byWord, vec };
}

// Documents that may explain one jump, best first: close in meaning and
// naming the market's subject (a weaker match needs a closer meaning).
export function explainJump(win, jump, { vec, keys, limit = 3 }) {
  const from = jump.start - BEFORE;
  const to = jump.start + Math.min(HOUR, jump.end - jump.start);
  const need = keys.need;
  const also = keys.also.filter((t) => !need.includes(t));
  const share = (t) => (win.byWord.get(t)?.length || 0) / Math.max(1, win.docs.length);
  const isRare = (t) => share(t) <= 0.005;
  const cands = new Set();
  for (const w of need) for (const i of win.byWord.get(w) || []) cands.add(i);
  const out = [];
  const seen = new Set();
  for (const i of cands) {
    const d = win.docs[i];
    if (d.at < from || d.at > to) continue;
    const namedKeys = need.filter((t) => d.words.has(t));
    const alsoKeys = also.filter((t) => d.words.has(t));
    const named = namedKeys.length;
    const alsoNamed = alsoKeys.length;
    const v = win.vec(d);
    if (!v) continue;
    let s = score(v, vec);
    // Multi-outcome: the outcome plus a word of the question, or a close meaning.
    // Otherwise: two words of the question, or one uncommon one and a close meaning.
    // A word in more than 0.5% of titles ("Google", "GPT") isn't enough on its own.
    const rare = namedKeys.some(isRare);
    const enough = keys.byLabel
      ? (alsoNamed > 0 ? s >= MIN_SCORE : s >= 0.68)
      : named >= Math.min(2, need.length) ? s >= MIN_SCORE : rare && s >= 0.68;
    if (!enough) continue;
    // Discussion threads trail the reporting they discuss.
    s += 0.02 * (named - 1) + 0.01 * alsoNamed - (d.site === 'reddit.com' ? 0.03 : 0);
    const k = headKey(d.title);
    if (seen.has(k)) continue;
    seen.add(k);
    let meta = {};
    try { meta = JSON.parse(d.meta || '{}') || {}; } catch {}
    // Names the outcome and a fairly uncommon word of the question ("Muse",
    // not "agent"), or two words of the question, one of them uncommon ("GPT
    // Sol", not "OpenAI GPT").
    const strong = keys.byLabel ? alsoKeys.some((t) => share(t) <= 0.015) : named >= 3 || (named >= 2 && rare);
    out.push({ url: d.url, title: d.title, site: d.site, source: meta.handle ? `@${meta.handle}` : d.source || d.site, type: d.type, at: d.at, lead: Math.round((jump.start - d.at) / 60e3), score: +s.toFixed(3), strong });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}

// The price from six hours before a jump to three after, on 25 even steps,
// for a small chart of the move: [[ts, yes], ...].
export function pathAround(points, jump, n = 25) {
  const a = jump.start - BEFORE;
  const b = jump.end + SPAN;
  const out = [];
  let j = 0;
  let cur = null;
  for (let i = 0; i < n; i++) {
    const t = a + ((b - a) * i) / (n - 1);
    while (j < points.length && points[j][0] <= t) cur = points[j++][1];
    if (cur != null) out.push([Math.round(t), cur]);
  }
  return out;
}

// markets: [{ id, title, url, image, binary, volume, outcomes: [label] }]
// vectors: { [market id]: number[] }
export function computeMoves(db, markets, vectors, { now = Date.now(), days = DAYS } = {}) {
  const series = db.prepare('SELECT ts, yes FROM odds WHERE market = ? AND outcome = ? AND ts >= ? ORDER BY ts');
  const sidOf = db.prepare('SELECT sid FROM story_ids WHERE item_url IN (?, ?, ?)');
  const win = docWindow(db, now - days * DAY - BEFORE, now);
  const moves = [];
  for (const m of markets) {
    const vec = vectors[m.id];
    for (const label of m.outcomes.slice(0, 3)) {
      const pts = series.all(m.id, label, now - days * DAY).map((r) => [r.ts, r.yes]);
      for (const j of detectJumps(pts, { now })) {
        const after = vec ? explainJump(win, j, { vec, keys: marketKeys(m.title, label, m.binary) }) : [];
        for (const a of after) {
          const u = new URL(a.url);
          a.sid = sidOf.get(a.url, `${u.protocol}//www.${u.host}${u.pathname}${u.search}`, `${a.url}/`)?.sid || null;
        }
        moves.push({ id: `${m.id}|${label}|${j.end}`, market: m.id, title: m.title, url: m.url, image: m.image || null, binary: !!m.binary, label, ...j, path: pathAround(pts, j), explained: isExplained(after), after });
      }
    }
  }
  // The same news moves several outcomes of one market; keep them all, newest first.
  moves.sort((a, b) => b.end - a.end);
  return { generatedAt: now, days, moves };
}

// ---- Main process ----

const vecCache = new Map(); // market id -> { title, vec }

async function marketVectors(markets) {
  const todo = markets.filter((m) => vecCache.get(m.id)?.title !== m.title);
  for (let i = 0; i < todo.length; i += 64) {
    const batch = todo.slice(i, i + 64);
    const vecs = await embedTexts(batch.map((m) => `Represent this sentence for searching relevant passages: ${m.title}`), { timeoutMs: 30000 });
    batch.forEach((m, k) => vecCache.set(m.id, { title: m.title, vec: vecs[k] }));
  }
  return Object.fromEntries(markets.map((m) => [m.id, vecCache.get(m.id)?.vec]).filter(([, v]) => v));
}

export async function marketMoves(store) {
  const markets = (store.markets || [])
    .filter((m) => m.volume >= MIN_VOLUME && m.outcomes?.length)
    .map((m) => ({ id: m.id, title: m.title, url: m.url, image: m.image, binary: m.binary, volume: m.volume, outcomes: m.outcomes.map((o) => o.label) }));
  // Without the classifier the jumps are still found, just not explained.
  let vectors = {};
  try { vectors = await marketVectors(markets); } catch {}
  return cachedJob('moves', { kind: 'moves', markets, vectors }, TTL_MS);
}

// Waits a moment for the moves, then goes on without them (cold start).
export const readyMoves = (store, ms = 1500) =>
  Promise.race([marketMoves(store).catch(() => null), new Promise((r) => setTimeout(r, ms, null))]);

// Jumps with a story before them that names the subject well, or is very
// close in meaning: the feed, story pages and chart notes show only these.
export const isExplained = (after) => !!after[0] && (after[0].strong ? after[0].score >= 0.65 : after[0].score >= 0.74);
export const explainedMoves = (all) => all.moves.filter((m) => m.explained);

// The moves a story's articles preceded, for its story page.
export function movesAfter(all, urls) {
  const mine = new Set(urls.map(canonicalUrl));
  return explainedMoves(all).filter((mv) => mv.after.some((a) => mine.has(canonicalUrl(a.url))));
}
