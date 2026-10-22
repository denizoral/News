// Small SVG charts shared by Trends and Status: lines with a crosshair, and
// bars (stacked when there is more than one series). Each builder returns the
// SVG and a `meta` the page keeps by chart id; hoverChart() reads it to move
// the crosshair and fill the tooltip, so the chart itself carries no data.

const PAD = { l: 44, r: 14, t: 14, b: 26 };

// 0, then three or four round steps up to at least `max`.
export function niceTicks(max, n = 4) {
  if (!(max > 0)) return [0, 1];
  const raw = max / n;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  const out = [];
  for (let v = 0; v < max + step * 0.999; v += step) out.push(+v.toFixed(10));
  return out;
}

export const compact = (v) => (v == null ? '—' : v >= 1e6 ? `${+(v / 1e6).toFixed(1)}M` : v >= 1e4 ? `${Math.round(v / 1e3)}K` : v >= 1e3 ? `${+(v / 1e3).toFixed(1)}K` : `${+v.toFixed(v < 10 ? 1 : 0)}`);

// Month (or day) labels at the start of each period, thinned to fit.
export function timeTicks(xs, { days = false, max = 7 } = {}) {
  const out = [];
  let prev = null;
  xs.forEach((t, i) => {
    const d = new Date(t);
    const k = days ? `${d.getUTCMonth()}-${d.getUTCDate()}` : `${d.getUTCFullYear()}-${d.getUTCMonth()}`;
    if (k !== prev) out.push(i);
    prev = k;
  });
  const every = Math.ceil(out.length / max);
  return out.filter((_, j) => j % every === 0);
}

function frame({ W, H, ticks, y, yFmt, xs, x, xTicks, xFmt }) {
  const grid = ticks.map((v) => `<g class="lc-tick"><line x1="${PAD.l}" x2="${W - PAD.r}" y1="${y(v)}" y2="${y(v)}"/><text x="${PAD.l - 8}" y="${y(v)}" dy="0.32em" text-anchor="end">${yFmt(v)}</text></g>`).join('');
  const xl = xTicks.map((i) => `<text class="lc-xt" x="${x(i)}" y="${H - 6}" text-anchor="${i === 0 ? 'start' : 'middle'}">${xFmt(xs[i], i)}</text>`).join('');
  return `${grid}${xl}`;
}

// series: [{ key, label, color, values }]; marks: [{ s, i, n }] numbered markers.
export function lineChart({ id, xs, series, W = 720, H = 260, yFmt = compact, xFmt, xTicks, marks = [], animate = false, endLabels = true, label = '' }) {
  const max = Math.max(1e-9, ...series.flatMap((s) => s.values.filter((v) => v != null)));
  const ticks = niceTicks(max);
  const top = ticks[ticks.length - 1];
  const right = endLabels && series.length > 1 ? 112 : PAD.r;
  const x = (i) => PAD.l + (xs.length > 1 ? (i / (xs.length - 1)) * (W - PAD.l - right) : 0);
  const y = (v) => PAD.t + (1 - v / top) * (H - PAD.t - PAD.b);
  const paths = series.map((s, si) => {
    let d = '';
    let pen = false;
    s.values.forEach((v, i) => {
      if (v == null) { pen = false; return; }
      d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`;
      pen = true;
    });
    return `<path class="lc-line" d="${d}" pathLength="1" style="stroke:${s.color};--i:${si}"/>`;
  }).join('');
  // Direct labels at the right end, nudged apart so they never overlap.
  let ends = '';
  if (endLabels && series.length > 1) {
    const pos = series.map((s, si) => {
      let i = s.values.length - 1;
      while (i > 0 && s.values[i] == null) i--;
      return { si, y: y(s.values[i] ?? 0), label: s.label, color: s.color };
    }).sort((a, b) => a.y - b.y);
    for (let k = 1; k < pos.length; k++) pos[k].y = Math.max(pos[k].y, pos[k - 1].y + 15);
    const over = pos.length ? pos[pos.length - 1].y - (H - PAD.b) : 0;
    if (over > 0) pos.forEach((p) => { p.y -= over; });
    ends = pos.map((p) => `<g class="lc-end"><circle cx="${x(xs.length - 1) + 10}" cy="${p.y}" r="3.5" style="fill:${p.color}"/><text x="${x(xs.length - 1) + 18}" y="${p.y}" dy="0.32em">${esc(p.label.length > 13 ? `${p.label.slice(0, 12)}…` : p.label)}</text></g>`).join('');
  }
  const mk = marks.map((m) => `<g class="lc-mark" data-mark="${m.s}:${m.i}" tabindex="0" role="button" aria-label="${esc(m.aria || '')}" transform="translate(${x(m.i)},${y(series[m.s].values[m.i])})"><circle r="9" style="fill:${series[m.s].color}"/><text dy="0.34em">${m.n}</text></g>`).join('');
  const hd = series.map((s, si) => `<circle class="lc-hd" data-s="${si}" r="4.5" style="fill:${s.color}"/>`).join('');
  const svg = `<svg class="lc${animate ? ' animate' : ''}" data-chart="${id}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}">
    ${frame({ W, H, ticks, y, yFmt, xs, x, xTicks: xTicks || timeTicks(xs), xFmt })}
    <g class="lc-x" visibility="hidden"><line y1="${PAD.t}" y2="${H - PAD.b}"/>${hd}</g>
    ${paths}${ends}${mk}
    <rect class="lc-hit" x="${PAD.l}" y="0" width="${W - PAD.l - right + 1}" height="${H - PAD.b}"/>
  </svg>`;
  return { svg, meta: { W, xPos: xs.map((_, i) => x(i)), yPos: series.map((s) => s.values.map((v) => (v == null ? null : y(v)))) } };
}

// stacks: [{ key, label, color, values }], drawn bottom to top with a 2px gap.
export function barChart({ id, xs, stacks, W = 720, H = 180, yFmt = compact, xFmt, xTicks, animate = false, label = '' }) {
  const sums = xs.map((_, i) => stacks.reduce((a, s) => a + (s.values[i] || 0), 0));
  const ticks = niceTicks(Math.max(1, ...sums));
  const top = ticks[ticks.length - 1];
  const step = (W - PAD.l - PAD.r) / xs.length;
  const bw = Math.max(1.5, step - Math.min(3, step * 0.25));
  const x = (i) => PAD.l + i * step + (step - bw) / 2;
  const y = (v) => PAD.t + (1 - v / top) * (H - PAD.t - PAD.b);
  const r = Math.min(3, bw / 2);
  let bars = '';
  xs.forEach((_, i) => {
    let base = 0;
    const segs = stacks.map((s, si) => ({ si, v: s.values[i] || 0 })).filter((s) => s.v > 0);
    segs.forEach((seg, k) => {
      const y0 = y(base);
      const y1 = y(base + seg.v);
      base += seg.v;
      const h = Math.max(0, y0 - y1 - (k ? 2 : 0));
      if (h <= 0) return;
      const x0 = x(i);
      const yt = y0 - (k ? 2 : 0) - h;
      // The top segment gets the rounded data-end.
      const d = k === segs.length - 1 && h > r
        ? `M${x0} ${y0 - (k ? 2 : 0)}V${yt + r}Q${x0} ${yt} ${x0 + r} ${yt}H${x0 + bw - r}Q${x0 + bw} ${yt} ${x0 + bw} ${yt + r}V${y0 - (k ? 2 : 0)}Z`
        : `M${x0} ${y0 - (k ? 2 : 0)}V${yt}H${x0 + bw}V${y0 - (k ? 2 : 0)}Z`;
      bars += `<path d="${d}" style="fill:${stacks[seg.si].color};--i:${i}"/>`;
    });
  });
  const svg = `<svg class="lc bc${animate ? ' animate' : ''}" data-chart="${id}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}">
    ${frame({ W, H, ticks, y, yFmt, xs, x: (i) => x(i) + bw / 2, xTicks: xTicks || timeTicks(xs, { days: true }), xFmt })}
    <rect class="lc-band" y="${PAD.t}" height="${H - PAD.t - PAD.b}" width="${step}" visibility="hidden"/>
    <g class="bc-bars">${bars}</g>
    <rect class="lc-hit" x="${PAD.l}" y="0" width="${W - PAD.l - PAD.r}" height="${H - PAD.b}"/>
  </svg>`;
  return { svg, meta: { W, bar: true, step, xPos: xs.map((_, i) => PAD.l + i * step + step / 2), yPos: [] } };
}

// Index of the point nearest the pointer, or -1 off the plot.
export function pointAt(svg, meta, clientX) {
  const rect = svg.getBoundingClientRect();
  const vx = ((clientX - rect.left) / rect.width) * meta.W;
  if (vx < meta.xPos[0] - (meta.step || 12) || vx > meta.xPos[meta.xPos.length - 1] + (meta.step || 12)) return -1;
  let best = 0;
  meta.xPos.forEach((px, i) => { if (Math.abs(px - vx) < Math.abs(meta.xPos[best] - vx)) best = i; });
  return best;
}

// Moves the crosshair (or bar band) to point i and places `tip` above it,
// inside `host`. `html` is the tooltip's content. i = -1 hides both.
export function showPoint(svg, meta, i, tip, host, html, setHtml) {
  const cross = svg.querySelector('.lc-x, .lc-band');
  if (i < 0) {
    cross?.setAttribute('visibility', 'hidden');
    if (tip) tip.hidden = true;
    return;
  }
  const px = meta.xPos[i];
  if (meta.bar) {
    cross.setAttribute('x', px - meta.step / 2);
  } else {
    cross.querySelector('line').setAttribute('x1', px);
    cross.querySelector('line').setAttribute('x2', px);
    cross.querySelectorAll('.lc-hd').forEach((c) => {
      const yy = meta.yPos[c.dataset.s][i];
      c.setAttribute('visibility', yy == null ? 'hidden' : 'visible');
      c.setAttribute('cx', px);
      c.setAttribute('cy', yy ?? 0);
    });
  }
  cross.setAttribute('visibility', 'visible');
  if (!tip) return;
  setHtml(tip, html);
  tip.hidden = false;
  const box = host.getBoundingClientRect();
  const r = svg.getBoundingClientRect();
  const cx = r.left - box.left + (px / meta.W) * r.width;
  const left = Math.min(box.width - tip.offsetWidth - 4, Math.max(4, cx - tip.offsetWidth / 2));
  tip.style.transform = `translate(${left}px, ${r.top - box.top - tip.offsetHeight - 6}px)`;
}

function esc(s = '') {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
