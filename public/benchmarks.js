// Benchmarks (#benchmarks/<key>): who leads each benchmark people quote,
// read from coverage. A chart of every confirmed claim over time with the
// state of the art as a step line, and a leaderboard (confirmed scores, then
// claims only one outlet made). Server side: src/index/benchmarks.js.

const dayFmt = (t) => new Date(t).toLocaleDateString('en', { month: 'short', day: 'numeric', year: 'numeric' });
const monFmt = (t) => new Date(t).toLocaleDateString('en', { month: 'short', year: '2-digit' });
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
const fav = (h) => `https://www.google.com/s2/favicons?domain=${encodeURIComponent(h || 'example.com')}&sz=32`;
const score = (v) => `${+v.toFixed(1)}%`;

export function createBenchmarks({ $, esc, setHtml, state, reducedMotion }) {
  const view = { key: null };
  let data = { d: null, error: null, pending: false, at: 0 };
  let drawn = null;
  let pts = []; // chart points for hover: { x, y, m }

  function route(hash) {
    const m = /^#benchmarks(?:\/([\w-]+))?$/.exec(hash);
    if (!m) return null;
    view.key = m[1] || null;
    return 'benchmarks';
  }

  async function load() {
    if (data.pending || (data.d && Date.now() - data.at < 20 * 60e3) || (data.error && Date.now() - data.at < 20e3)) return;
    data.pending = true;
    try {
      const r = await fetch('/api/benchmarks');
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || r.statusText);
      data = { d, at: Date.now() };
    } catch (err) {
      data = { d: data.d, error: err.message, at: Date.now() };
    }
    if (state.view === 'benchmarks') render();
  }

  // Every confirmed claim as a dot (x: when first reported, y: score), and
  // the state of the art as a step line that only ever goes up.
  function chart(b, narrow) {
    const W = narrow ? 360 : 760, H = narrow ? 220 : 260, L = 36, R = 14, T = 14, B = 26;
    const conf = b.models.filter((m) => m.confirmed);
    if (conf.length < 2) return '';
    const t0 = Math.min(...conf.map((m) => m.at)), t1 = Math.max(...conf.map((m) => m.at), t0 + 86400e3);
    const lo = Math.max(0, Math.floor((Math.min(...conf.map((m) => m.score)) - 5) / 10) * 10);
    const x = (t) => L + ((t - t0) / (t1 - t0)) * (W - L - R);
    const y = (v) => T + (1 - (v - lo) / (100 - lo)) * (H - T - B);
    const ticks = [];
    for (let v = lo; v <= 100; v += lo >= 60 ? 10 : 20) ticks.push(v);
    // Month ticks, thinned.
    const months = [];
    const d = new Date(t0);
    d.setUTCDate(1);
    for (let m = new Date(d); m.getTime() <= t1; m.setUTCMonth(m.getUTCMonth() + 1)) if (m.getTime() >= t0) months.push(m.getTime());
    const every = Math.ceil(months.length / (narrow ? 3 : 6));
    let step = '';
    b.sota.forEach((s, i) => {
      const px = x(s.at), py = y(s.score);
      step += i ? ` H${px.toFixed(1)} V${py.toFixed(1)}` : `M${px.toFixed(1)} ${py.toFixed(1)}`;
    });
    if (b.sota.length) step += ` H${(W - R).toFixed(1)}`;
    pts = conf.map((m) => ({ x: x(m.at), y: y(m.score), m }));
    const lead = b.sota[b.sota.length - 1];
    return `<figure class="bm-chart">
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(`${b.label}: confirmed scores over time; state of the art ${lead ? `${lead.model} ${score(lead.score)}` : ''}`)}" data-chart="bm">
        ${ticks.map((v) => `<g class="lc-tick"><line x1="${L}" x2="${W - R}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/><text x="${L - 6}" y="${y(v).toFixed(1)}" dy="0.32em" text-anchor="end">${v}%</text></g>`).join('')}
        ${months.filter((_, i) => i % every === 0).map((t) => `<text class="lc-xt" x="${x(t).toFixed(1)}" y="${H - 6}" text-anchor="middle">${esc(monFmt(t))}</text>`).join('')}
        <path class="bm-step" d="${step}" pathLength="1"/>
        ${pts.map((p, i) => `<circle class="bm-dot${b.sota.some((s) => s.model === p.m.model && s.score === p.m.score) ? ' sota' : ''}" cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${b.sota.some((s) => s.model === p.m.model && s.score === p.m.score) ? 6 : 4.5}" style="--i:${i}"/>`).join('')}
        ${lead ? `<text class="bm-lead" x="${Math.min(W - R - 4, x(lead.at) + 8).toFixed(1)}" y="${(y(lead.score) - 10).toFixed(1)}" text-anchor="${x(lead.at) > W - 160 ? 'end' : 'start'}">${esc(lead.model)} · ${score(lead.score)}</text>` : ''}
      </svg>
      <figcaption><span class="bm-key sota"></span>State of the art (each new best) <span class="bm-key"></span>Other confirmed scores</figcaption>
    </figure>`;
  }

  function row(m, i, top) {
    return `<li class="bm-row${m.confirmed ? '' : ' once'}" style="--i:${i}">
      <details>
        <summary>
          <span class="bm-rank">${m.confirmed ? i + 1 : '·'}</span>
          <span class="bm-model">${esc(m.model)}</span>
          <span class="bm-track"><i style="--w:${Math.max(1, (m.score / Math.max(top, 1)) * 100).toFixed(1)}%"></i></span>
          <b class="bm-score">${score(m.score)}</b>
        </summary>
        <div class="bm-more">
          <blockquote>${esc(m.quote)}</blockquote>
          <p><img src="${esc(fav(hostOf(m.url)))}" alt="" width="14" height="14" loading="lazy" data-fallback="remove"><a href="${esc(m.url)}" target="_blank" rel="noopener">${esc(m.source)}</a> · ${esc(dayFmt(m.at))} · ${m.outlets === 1 ? 'one outlet' : `${m.outlets} outlets`}${m.others.length ? ` · also reported: ${m.others.map((o) => score(o.score)).join(', ')}` : ''}</p>
        </div>
      </details>
    </li>`;
  }

  function page(d, b) {
    const narrow = innerWidth < 640;
    const conf = b.models.filter((m) => m.confirmed);
    const once = b.models.filter((m) => !m.confirmed);
    const top = 100; // scores are percentages: bars against the whole scale
    const lead = b.sota[b.sota.length - 1];
    return `<nav class="pd-chips bm-tabs" aria-label="Benchmark">${d.benchmarks.map((x) => `<a class="chip${x.key === b.key ? ' on' : ''}" href="#benchmarks/${esc(x.key)}">${esc(x.label)}</a>`).join('')}</nav>
      <section class="bm-intro">
        <div><h2>${esc(b.label)}</h2><p>${esc(b.about)}</p></div>
        ${lead ? `<p class="bm-leader"><small>Leading</small><b>${esc(lead.model)}</b><span>${score(lead.score)} · since ${esc(dayFmt(lead.at))}</span></p>` : ''}
      </section>
      ${chart(b, narrow)}
      <section class="bm-board">
        <h2 class="when">Leaderboard<span>scores reported by two or more outlets</span></h2>
        <ol class="bm-list">${conf.map((m, i) => row(m, i, top)).join('')}</ol>
        ${once.length ? `<details class="bm-once"><summary>${once.length} more reported by one outlet only</summary><ol class="bm-list">${once.map((m, i) => row(m, i, top)).join('')}</ol></details>` : ''}
      </section>
      <p class="rail-note bm-how">Read from ${b.articles} articles. A score counts when an article says a model got it on this benchmark; scores from research papers about other people’s models, human baselines and before/after comparisons are left out. Labs report their own numbers under their own conditions, so treat these as claims. <a href="/api/benchmarks">JSON</a></p>
      <div class="ac-tip tr-tip" role="tooltip" hidden></div>`;
  }

  function render() {
    const site = state.data?.site?.name || 'Frontier Wire';
    const host = $('#benchmarksView');
    const head = (b) => `<header class="topic-head bm-head"><p class="kicker">Benchmarks</p><h1>Who leads, on what</h1>
      <p class="topic-sum">The scores models are reported to get on the benchmarks people quote, from the coverage, and when each new best arrived.</p></header>`;
    if (state.mode !== 'api') {
      setHtml(host, `${head()}<p class="rail-note">Benchmarks need the live server.</p>`);
      return;
    }
    load();
    const d = data.d;
    if (!d) {
      document.title = `Benchmarks · ${site}`;
      setHtml(host, `${head()}${data.error ? `<p class="rail-note">${esc(data.error)}</p>` : '<i class="skeleton" style="height:280px;display:block;margin:16px 0;border-radius:12px"></i><i class="skeleton" style="height:320px;display:block;border-radius:12px"></i>'}`);
      return;
    }
    const b = d.benchmarks.find((x) => x.key === view.key) || d.benchmarks[0];
    if (!b) {
      setHtml(host, `${head()}<p class="rail-note">No benchmark has enough reported scores yet.</p>`);
      return;
    }
    document.title = `${b.label} · Benchmarks · ${site}`;
    const key = `${d.generatedAt}:${b.key}`;
    const animate = drawn !== key && !reducedMotion();
    drawn = key;
    setHtml(host, `${head(b)}<div class="bm-page${animate ? ' animate' : ''}">${page(d, b)}</div>`);
  }

  // Nearest dot under the pointer: model, score, date, outlets.
  function hover(e) {
    const tip = $('#benchmarksView .ac-tip');
    const svg = e.target.closest?.('svg[data-chart="bm"]');
    if (!tip) return;
    if (!svg || e.type === 'pointerleave') { tip.hidden = true; return; }
    const r = svg.getBoundingClientRect();
    const vb = svg.viewBox.baseVal;
    const px = ((e.clientX - r.left) / r.width) * vb.width;
    const py = ((e.clientY - r.top) / r.height) * vb.height;
    let best = null, bd = Infinity;
    for (const p of pts) {
      const dd = Math.hypot(p.x - px, p.y - py);
      if (dd < bd) { bd = dd; best = p; }
    }
    if (!best || bd > 40) { tip.hidden = true; return; }
    setHtml(tip, `<p class="tt-h">${esc(best.m.model)}</p><p><b>${score(best.m.score)}</b> · ${esc(dayFmt(best.m.at))}</p><p>${best.m.outlets} outlets · first ${esc(best.m.source)}</p>`);
    tip.hidden = false;
    const host = $('#benchmarksView').getBoundingClientRect();
    const left = r.left - host.left + (best.x / vb.width) * r.width;
    const top = r.top - host.top + (best.y / vb.height) * r.height;
    // Keep it inside the page: flip to the left of the point near the right edge.
    const w = tip.offsetWidth || 200;
    tip.style.left = `${Math.max(0, left + 12 + w > host.width ? left - 12 - w : left + 12)}px`;
    tip.style.top = `${Math.max(0, top - 86)}px`;
  }

  return { route, render, hover };
}
