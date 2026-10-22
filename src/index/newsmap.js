// The news map: the last day, three days or week of stories laid out so
// stories about similar things sit together. Each story (clustered from the
// window the way the front page is) is the mean embedding of its items;
// t-SNE squeezes those 384 dimensions into two, starting from the first two
// principal components so the same data always gives the same picture.
// Regions are patches of the map itself: Ward clustering of the 2-D layout
// into a dozen or so compact groups (t-SNE keeps neighbours together, so a
// patch is about one thing, and it's a patch you can see and fly into).
// Each is named by the phrase its headlines share, placed at the median of
// its stories, and marked growing when its last quarter of the window holds
// more than the map's share of stories.
//
// ~600 stories take ~1 s in the history worker, cached.

import { clusterItems } from '../pipeline/cluster.js';
import { centralHeadline, dayItems, outletsOf } from './day.js';
import { themeName } from './emerging.js';
import { cachedJob } from './offload.js';

const DIM = 384;
const HOUR = 3600e3;
const DAY = 24 * HOUR;
export const MAP_WINDOWS = [1, 3, 7];
const MAX_POINTS = { 1: 360, 3: 520, 7: 640 };
const TTL_MS = 15 * 60e3;

// ---- t-SNE (exact; fine for a few hundred points) ----

// Affinities from a perplexity target: a binary search for each row's width.
function affinities(X, n, perplexity) {
  const D = new Float64Array(n * n);
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    let s = 0;
    const a = X[i];
    const b = X[j];
    for (let k = 0; k < DIM; k++) s += a[k] * b[k];
    D[i * n + j] = D[j * n + i] = Math.max(0, 2 - 2 * s);
  }
  const P = new Float64Array(n * n);
  const H = Math.log(perplexity);
  const row = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let lo = -Infinity;
    let hi = Infinity;
    let beta = 1;
    for (let t = 0; t < 60; t++) {
      let sum = 0;
      let dsum = 0;
      for (let j = 0; j < n; j++) {
        const p = j === i ? 0 : Math.exp(-D[i * n + j] * beta);
        row[j] = p;
        sum += p;
        dsum += p * D[i * n + j];
      }
      sum ||= 1e-12;
      const h = Math.log(sum) + (beta * dsum) / sum;
      for (let j = 0; j < n; j++) row[j] /= sum;
      if (Math.abs(h - H) < 1e-4) break;
      if (h > H) { lo = beta; beta = hi === Infinity ? beta * 2 : (beta + hi) / 2; } else { hi = beta; beta = lo === -Infinity ? beta / 2 : (beta + lo) / 2; }
    }
    for (let j = 0; j < n; j++) P[i * n + j] = row[j];
  }
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    const p = Math.max((P[i * n + j] + P[j * n + i]) / (2 * n), 1e-12);
    P[i * n + j] = P[j * n + i] = p;
  }
  return P;
}

// The first two principal components, by power iteration from fixed starts.
function pca2(X, n) {
  const mean = new Float64Array(DIM);
  for (const x of X) for (let k = 0; k < DIM; k++) mean[k] += x[k] / n;
  const C = X.map((x) => Float64Array.from(x, (v, k) => v - mean[k]));
  const comps = [];
  for (let c = 0; c < 2; c++) {
    let v = Float64Array.from({ length: DIM }, (_, k) => Math.sin(k * (c + 1) + 1));
    for (let it = 0; it < 60; it++) {
      const w = new Float64Array(DIM);
      for (const x of C) {
        let s = 0;
        for (let k = 0; k < DIM; k++) s += x[k] * v[k];
        for (let k = 0; k < DIM; k++) w[k] += s * x[k];
      }
      for (const u of comps) {
        let s = 0;
        for (let k = 0; k < DIM; k++) s += w[k] * u[k];
        for (let k = 0; k < DIM; k++) w[k] -= s * u[k];
      }
      let norm = 0;
      for (let k = 0; k < DIM; k++) norm += w[k] * w[k];
      norm = Math.sqrt(norm) || 1;
      v = w.map((x) => x / norm);
    }
    comps.push(v);
  }
  return C.map((x) => comps.map((u) => {
    let s = 0;
    for (let k = 0; k < DIM; k++) s += x[k] * u[k];
    return s;
  }));
}

export function tsne(X, { perplexity = 18, iters = 500, lr = Math.max(X.length / 48, 50) } = {}) {
  const n = X.length;
  if (n < 3) return X.map((_, i) => [i, 0]);
  const P = affinities(X, n, Math.min(perplexity, (n - 1) / 3));
  const init = pca2(X, n);
  const sd = Math.sqrt(init.reduce((s, p) => s + p[0] * p[0], 0) / n) || 1;
  const Y = new Float64Array(n * 2);
  init.forEach((p, i) => { Y[2 * i] = (p[0] / sd) * 1e-2; Y[2 * i + 1] = (p[1] / sd) * 1e-2; });
  const vel = new Float64Array(n * 2);
  const gains = new Float64Array(n * 2).fill(1);
  const num = new Float64Array(n * n);
  const grad = new Float64Array(n * 2);
  for (let it = 0; it < iters; it++) {
    const exag = it < 100 ? 12 : 1;
    const mom = it < 250 ? 0.5 : 0.8;
    let Z = 0;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      const dx = Y[2 * i] - Y[2 * j];
      const dy = Y[2 * i + 1] - Y[2 * j + 1];
      const q = 1 / (1 + dx * dx + dy * dy);
      num[i * n + j] = num[j * n + i] = q;
      Z += 2 * q;
    }
    grad.fill(0);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const q = num[i * n + j];
      const m = (exag * P[i * n + j] - q / Z) * q;
      grad[2 * i] += 4 * m * (Y[2 * i] - Y[2 * j]);
      grad[2 * i + 1] += 4 * m * (Y[2 * i + 1] - Y[2 * j + 1]);
    }
    for (let k = 0; k < 2 * n; k++) {
      gains[k] = Math.sign(grad[k]) === Math.sign(vel[k]) ? gains[k] * 0.8 : gains[k] + 0.2;
      if (gains[k] < 0.01) gains[k] = 0.01;
      vel[k] = mom * vel[k] - lr * gains[k] * grad[k];
      Y[k] += vel[k];
    }
  }
  return Array.from({ length: n }, (_, i) => [Y[2 * i], Y[2 * i + 1]]);
}

// Coordinates scaled into 0..1 on both axes, keeping the aspect ratio and
// clipping the few stragglers t-SNE flings far out.
export function normalise(pts) {
  const q = (arr, f) => [...arr].sort((a, b) => a - b)[Math.min(arr.length - 1, Math.max(0, Math.floor(f * (arr.length - 1))))];
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const [x0, x1, y0, y1] = [q(xs, 0.005), q(xs, 0.995), q(ys, 0.005), q(ys, 0.995)];
  const span = Math.max(x1 - x0, y1 - y0) || 1;
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const clamp = (v) => Math.min(1, Math.max(0, v));
  return pts.map(([x, y]) => [+clamp(0.5 + (x - cx) / span).toFixed(3), +clamp(0.5 + (y - cy) / span).toFixed(3)]);
}

// Ward's agglomerative clustering of 2-D points down to k clusters
// (Lance-Williams updates on squared distances). Returns a label per point.
export function ward(pts, k) {
  const n = pts.length;
  if (n <= k) return pts.map((_, i) => i);
  const D = new Float64Array(n * n);
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    const d = (pts[i][0] - pts[j][0]) ** 2 + (pts[i][1] - pts[j][1]) ** 2;
    D[i * n + j] = D[j * n + i] = d;
  }
  const size = new Array(n).fill(1);
  const alive = new Uint8Array(n).fill(1);
  const parent = pts.map((_, i) => i);
  // Each live cluster's nearest neighbour, refreshed only when it changes.
  const nn = new Int32Array(n);
  const nd = new Float64Array(n);
  const refresh = (i) => {
    let b = -1;
    let bd = Infinity;
    for (let j = 0; j < n; j++) if (j !== i && alive[j] && D[i * n + j] < bd) [b, bd] = [j, D[i * n + j]];
    nn[i] = b;
    nd[i] = bd;
  };
  for (let i = 0; i < n; i++) refresh(i);
  for (let left = n; left > k; left--) {
    let a = -1;
    for (let i = 0; i < n; i++) if (alive[i] && (a < 0 || nd[i] < nd[a])) a = i;
    const b = nn[a];
    for (let j = 0; j < n; j++) {
      if (!alive[j] || j === a || j === b) continue;
      const t = size[a] + size[b] + size[j];
      const d = ((size[a] + size[j]) * D[a * n + j] + (size[b] + size[j]) * D[b * n + j] - size[j] * D[a * n + b]) / t;
      D[a * n + j] = D[j * n + a] = d;
    }
    size[a] += size[b];
    alive[b] = 0;
    parent[b] = a;
    for (let i = 0; i < n; i++) if (alive[i] && (i === a || nn[i] === a || nn[i] === b)) refresh(i);
    // Distances to a only fell for some; anyone now closer to a takes it.
    for (let j = 0; j < n; j++) if (alive[j] && j !== a && D[a * n + j] < nd[j]) [nn[j], nd[j]] = [a, D[a * n + j]];
  }
  const root = (i) => { while (parent[i] !== i) i = parent[i]; return i; };
  const ids = new Map();
  return pts.map((_, i) => {
    const r = root(i);
    if (!ids.has(r)) ids.set(r, ids.size);
    return ids.get(r);
  });
}

function meanVector(bufs) {
  const acc = new Float32Array(DIM);
  for (const v of bufs) {
    const sc = new DataView(v.buffer, v.byteOffset, 4).getFloat32(0, true);
    for (let i = 0; i < DIM; i++) acc[i] += ((v[4 + i] << 24) >> 24) * sc;
  }
  let n = 0;
  for (let i = 0; i < DIM; i++) n += acc[i] * acc[i];
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < DIM; i++) acc[i] /= n;
  return acc;
}

const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

export function computeNewsMap(db, { days = 3, now = Date.now(), maxPoints = MAX_POINTS[days] || 500, layout = {} } = {}) {
  const since = now - days * DAY;
  const items = dayItems(db, since, now + 5 * 60e3);
  const vecOf = db.prepare('SELECT v FROM doc_vecs WHERE doc_id = ?');
  const sidOf = db.prepare('SELECT sid FROM story_ids WHERE item_url = ?');
  const ranked = clusterItems(items)
    .filter((s) => s._group.some((it) => it.type === 'article'))
    .map((s) => ({ s, outlets: outletsOf(s) }))
    .sort((a, b) => b.outlets - a.outlets || b.s._group.length - a.s._group.length || b.s.publishedAt - a.s.publishedAt)
    .slice(0, maxPoints);
  const stories = [];
  for (const { s, outlets } of ranked) {
    const group = [...s._group].sort((a, b) => a.publishedAt - b.publishedAt);
    const bufs = group.map((it) => vecOf.get(Number(it.id))?.v).filter(Boolean);
    if (!bufs.length) continue;
    const lead = centralHeadline(group);
    const votes = new Map();
    for (const it of group) {
      const sid = sidOf.get(it.url)?.sid;
      if (sid) votes.set(sid, (votes.get(sid) || 0) + 1);
    }
    stories.push({
      v: meanVector(bufs),
      title: lead.title,
      url: lead.url,
      source: lead.source,
      sid: [...votes].sort((a, b) => b[1] - a[1])[0]?.[0] || null,
      at: group[0].publishedAt,
      outlets,
      items: group.length,
    });
  }
  const pts = normalise(tsne(stories.map((s) => s.v), layout));
  // Regions: looser groups than emerging themes, biggest stories first.
  const allTitles = stories.map((s) => s.title);
  const late = now - (days * DAY) / 4;
  const lateShare = Math.max(0.02, stories.filter((s) => s.at >= late).length / Math.max(1, stories.length));
  const labels = ward(pts, Math.min(16, Math.max(2, Math.round(stories.length / 36))));
  const byLabel = new Map();
  labels.forEach((l, i) => byLabel.set(l, [...(byLabel.get(l) || []), i]));
  // Biggest stories first within each region; small leftovers stay unnamed.
  const groups = [...byLabel.values()]
    .map((idx) => idx.sort((a, b) => stories[b].outlets - stories[a].outlets))
    .filter((idx) => idx.length >= Math.max(4, Math.round(stories.length / 80)))
    .sort((a, b) => b.length - a.length);
  const region = new Array(stories.length).fill(-1);
  const regions = groups.map((idx, r) => {
    for (const i of idx) region[i] = r;
    const recent = idx.filter((i) => stories[i].at >= late).length;
    const name = themeName(idx.map((i) => stories[i].title), allTitles);
    return {
      id: r,
      name: name[0] || stories[idx[0]].title.split(/\s+/).slice(0, 3).join(' '),
      alt: name[1] || null,
      x: +median(idx.map((i) => pts[i][0])).toFixed(4),
      y: +median(idx.map((i) => pts[i][1])).toFixed(4),
      n: idx.length,
      outlets: idx.reduce((s, i) => s + stories[i].outlets, 0),
      recent,
      // Share of the region's stories in the last quarter of the window
      // against the whole map's share there.
      growth: +((recent / idx.length) / lateShare).toFixed(2),
      top: idx.slice(0, 3).map((i) => stories[i].title),
    };
  });
  return {
    days,
    since,
    generatedAt: now,
    stories: stories.length,
    items: items.length,
    regions,
    points: stories.map((s, i) => ({ x: pts[i][0], y: pts[i][1], t: s.title.slice(0, 160), u: s.url, src: s.source, sid: s.sid, at: s.at, o: s.outlets, n: s.items, r: region[i] })),
  };
}

export const newsMapQuery = (days) => cachedJob(`newsmap:${days}`, { kind: 'newsmap', days }, TTL_MS);
