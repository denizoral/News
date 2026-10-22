// Model comparison (#models): every release from the last 90 days on one
// price chart and in one sortable table, with up to four side by side
// (#models/<id>+<id>). Server side: src/index/models.js.

const FILTERS = [
  ['notable', 'Major labs', (m) => m.notable],
  ['open', 'Open weights', (m) => m.open],
  ['api', 'API', (m) => m.api],
  ['all', 'Everything', () => true],
];
const YS = [['stories', 'Stories since launch'], ['context', 'Context window']];
const MAX_PICK = 4;

export function createModels({ $, esc, setHtml, store, state, reducedMotion, logo }) {
  const data = { d: null, error: null, pending: false, at: 0 };
  const view = {
    picks: [],
    filter: store.get('fw.mdfilter', 'notable'),
    y: store.get('fw.mdy', 'stories'),
    sort: { key: 'stories', dir: -1 },
    all: false,
  };
  let shown = null;

  const narrow = () => innerWidth < 640;
  const shortDate = (ts) => new Date(ts).toLocaleDateString('en', { month: 'short', day: 'numeric' });
  const money = (x) => (x == null ? '—' : x === 0 ? 'Free' : `$${x < 0.1 ? +x.toFixed(3) : x < 1 ? +x.toFixed(2) : +x.toFixed(1)}`);
  const ctx = (n) => (n == null ? '—' : n >= 1e6 ? `${+(n / 1e6).toFixed(n % 1e6 ? 2 : 0)}M` : `${Math.round(n / 1e3)}K`);
  const size = (p) => (p.total == null ? '—' : `${p.total >= 1000 ? `${+(p.total / 1000).toFixed(1)}T` : `${p.total}B`}${p.active != null ? ` · ${p.active}B active` : ''}`);
  const href = (ids) => `#models${ids.length ? `/${ids.map(encodeURIComponent).join('+')}` : ''}`;

  function route(hash) {
    const m = /^#models(?:\/(.+))?$/.exec(hash);
    if (!m) return null;
    view.picks = m[1] ? [...new Set(m[1].split('+').map((s) => { try { return decodeURIComponent(s); } catch { return ''; } }).filter(Boolean))].slice(0, MAX_PICK) : [];
    return 'models';
  }

  async function load() {
    if (data.pending || (data.d && Date.now() - data.at < 5 * 60e3) || (data.error && Date.now() - data.at < 30e3)) return;
    data.pending = true;
    try {
      const r = await fetch('/api/models');
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || r.statusText);
      data.d = d;
      data.error = null;
    } catch (err) {
      data.error = err.message;
    }
    data.at = Date.now();
    data.pending = false;
    if (state.view === 'models') render();
  }

  // ---- Price chart ----
  // x: blended price per million tokens (3:1 input to output), on a log scale,
  // with free models in their own strip at the left. y: stories since launch
  // (log) or the context window (log).
  const PRICE_TICKS = [0.01, 0.03, 0.1, 0.3, 1, 3, 10, 30, 100];
  const STORY_TICKS = [0, 1, 3, 10, 30, 100, 300, 1000];
  const CTX_TICKS = [8e3, 32e3, 128e3, 256e3, 1e6, 2e6, 4e6];

  function chart(models, { animate }) {
    const wide = innerWidth >= 1000;
    const W = wide ? 1000 : narrow() ? 360 : 640;
    const H = wide ? 360 : narrow() ? 300 : 320;
    const m = { l: narrow() ? 40 : 52, r: 14, t: 14, b: 36 };
    const yOf = view.y === 'stories' ? (x) => x.coverage.n : (x) => x.context;
    const pts = models.filter((x) => x.blended != null && yOf(x) != null);
    if (pts.length < 3) return `<p class="rail-note">Too few models with a price${view.y === 'context' ? ' and a context window' : ''} under this filter to chart.</p>`;
    const free = pts.some((x) => x.blended === 0);
    const freeW = free ? 46 : 0;
    const paid = pts.filter((x) => x.blended > 0).map((x) => x.blended);
    const lo = Math.log10(Math.min(...paid, 1) * 0.8);
    const hi = Math.log10(Math.max(...paid, 1) * 1.25);
    const x0 = m.l + freeW + (free ? 10 : 0);
    const X = (v) => (v === 0 ? m.l + freeW / 2 : x0 + ((Math.log10(v) - lo) / (hi - lo)) * (W - m.r - x0));
    const yt = view.y === 'stories' ? STORY_TICKS : CTX_TICKS;
    const tf = view.y === 'stories' ? (v) => Math.log10(v + 1) : (v) => Math.log2(v);
    const ys = pts.map(yOf);
    const ylo = tf(view.y === 'stories' ? 0 : Math.min(...ys) / 1.4);
    const yhi = tf(Math.max(...ys) * 1.3 + (view.y === 'stories' ? 1 : 0));
    const Y = (v) => H - m.b - ((tf(v) - ylo) / (yhi - ylo)) * (H - m.t - m.b);
    const xticks = PRICE_TICKS.filter((t) => Math.log10(t) >= lo && Math.log10(t) <= hi);
    const yticks = yt.filter((t) => tf(t) >= ylo - 1e-9 && tf(t) <= yhi);
    const grid = yticks.map((t) => `<line class="grid" x1="${m.l}" x2="${W - m.r}" y1="${Y(t).toFixed(1)}" y2="${Y(t).toFixed(1)}"/><text class="ax" x="${m.l - 8}" y="${(Y(t) + 4).toFixed(1)}" text-anchor="end">${view.y === 'stories' ? t : ctx(t)}</text>`).join('')
      + xticks.map((t) => `<text class="ax" x="${X(t).toFixed(1)}" y="${H - m.b + 18}" text-anchor="middle">${money(t)}</text>`).join('')
      + (free ? `<rect class="free" x="${m.l}" y="${m.t}" width="${freeW}" height="${H - m.t - m.b}" rx="6"/><text class="ax" x="${m.l + freeW / 2}" y="${H - m.b + 18}" text-anchor="middle">Free</text>` : '')
      + `<text class="ax ttl" x="${W - m.r}" y="${H - 4}" text-anchor="end">Blended price per million tokens →</text>`;

    // Direct labels: the most-covered models and the picked ones, skipping any
    // that would collide with one already placed.
    const placed = [];
    const want = new Set([...pts].sort((a, b) => b.coverage.n - a.coverage.n).slice(0, narrow() ? 3 : 7).map((x) => x.id).concat(view.picks));
    const labels = [];
    const dotBoxes = pts.map((p) => [X(p.blended) - 6, Y(yOf(p)) - 6, 12, 12, p.id]);
    const hits = (box, id) => placed.some((b) => box[0] < b[0] + b[2] && b[0] < box[0] + box[2] && box[1] < b[1] + b[3] && b[1] < box[1] + box[3])
      || dotBoxes.some((b) => b[4] !== id && box[0] < b[0] + b[2] && b[0] < box[0] + box[2] && box[1] < b[1] + b[3] && b[1] < box[1] + box[3]);
    for (const p of pts.filter((x) => want.has(x.id)).sort((a, b) => view.picks.includes(b.id) - view.picks.includes(a.id) || b.coverage.n - a.coverage.n)) {
      const x = X(p.blended);
      const y = Y(yOf(p));
      const w = p.name.length * 6.6;
      // Right, left, above, below: the first spot clear of labels and dots.
      const spots = [[x + 9, y + 4, 'start'], [x - 9, y + 4, 'end'], [x, y - 11, 'middle'], [x, y + 20, 'middle']];
      for (const [tx, ty, anchor] of spots) {
        const left = anchor === 'start' ? tx : anchor === 'end' ? tx - w : tx - w / 2;
        const box = [left, ty - 12, w, 15];
        if (left < m.l || left + w > W - m.r || box[1] < 0 || hits(box, p.id)) continue;
        placed.push(box);
        labels.push(`<text class="lbl" x="${tx.toFixed(1)}" y="${ty.toFixed(1)}" text-anchor="${anchor}">${esc(p.name)}</text>`);
        break;
      }
    }

    // Free models share one x; spread them a little so they don't stack.
    const jitter = new Map();
    pts.filter((x) => x.blended === 0).sort((a, b) => yOf(a) - yOf(b)).forEach((x, i) => jitter.set(x.id, ((i % 5) - 2) * 6));
    const dots = [...pts].sort((a, b) => view.picks.includes(a.id) - view.picks.includes(b.id)).map((p, i) => {
      const x = X(p.blended) + (jitter.get(p.id) || 0);
      const y = Y(yOf(p));
      const tip = `${p.name} · ${p.provider} — ${money(p.blended)}/M blended · ${view.y === 'stories' ? `${p.coverage.n} stories` : `${ctx(p.context)} context`}${p.open ? ' · open weights' : ''}`;
      const on = view.picks.includes(p.id);
      return `<g class="md-dot${p.open ? ' open' : ''}${on ? ' on' : ''}" data-mpick="${esc(p.id)}" data-tip="${esc(tip)}" style="--i:${Math.min(i, 60)}" role="button" tabindex="-1" aria-label="${esc(tip)}"><circle class="hit" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="12"/><circle class="pt" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${on ? 7 : 5.5}"/></g>`;
    }).join('');
    const legend = `<div class="md-legend"><span><i class="sw"></i>API only</span><span><i class="sw open"></i>Open weights</span><span class="md-hint">Click a dot to compare</span></div>`;
    return `${legend}<figure class="md-chart${animate ? ' animate' : ''}"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Price against ${view.y === 'stories' ? 'stories since launch' : 'context window'} for ${pts.length} models">${grid}<line class="base" x1="${m.l}" x2="${W - m.r}" y1="${H - m.b + 0.5}" y2="${H - m.b + 0.5}"/>${dots}${labels.join('')}</svg></figure>
      <p class="md-foot">${pts.length} models with an API price${models.length > pts.length ? `; ${models.length - pts.length} more (open weights without a hosted price, or no ${view.y === 'stories' ? 'price' : 'context'} listed) are in the table` : ''}.</p>`;
  }

  // ---- Table ----
  const COLS = [
    ['name', 'Model', (m) => m.name.toLowerCase(), 1],
    ['date', 'Released', (m) => m.date, -1],
    ['blended', 'Price', (m) => m.blended, 1],
    ['context', 'Context', (m) => m.context, -1],
    ['params', 'Size', (m) => m.params.total, -1],
    ['stories', 'Stories', (m) => m.coverage.n, -1],
  ];

  function sorted(models) {
    const [, , get] = COLS.find((c) => c[0] === view.sort.key) || COLS[5];
    const dir = view.sort.dir;
    return [...models].sort((a, b) => {
      const x = get(a);
      const y = get(b);
      if (x == null && y == null) return b.date - a.date;
      if (x == null) return 1; // missing values last either way
      if (y == null) return -1;
      return (x < y ? -1 : x > y ? 1 : 0) * dir || b.date - a.date;
    });
  }

  const scoreChips = (m, n = 2) => m.scores.slice(0, n).map((s) => `<a class="md-score" href="${esc(s.url)}" target="_blank" rel="noopener" title="${esc(`${s.label}: ${s.value}% as reported by ${s.site}${s.sources > 1 ? ` and ${s.sources - 1} more` : ''}${s.disputed ? ' (outlets differ)' : ''}`)}">${esc(s.label)} <b>${s.value}%</b></a>`).join('') + (m.scores.length > n ? `<span class="md-more">+${m.scores.length - n}</span>` : '');

  function table(models, { animate }) {
    const rows = sorted(models);
    const list = view.all ? rows : rows.slice(0, 30);
    const head = COLS.map(([k, l]) => {
      const on = view.sort.key === k;
      return `<th scope="col" class="c-${k}" aria-sort="${on ? (view.sort.dir === 1 ? 'ascending' : 'descending') : 'none'}"><button type="button" data-msort="${k}">${l}<i aria-hidden="true">${on ? (view.sort.dir === 1 ? '↑' : '↓') : ''}</i></button></th>`;
    }).join('');
    const body = list.map((m, i) => {
      const on = view.picks.includes(m.id);
      const full = !on && view.picks.length >= MAX_PICK;
      return `<tr data-id="${esc(m.id)}" class="${on ? 'on' : ''}" style="--i:${Math.min(i, 20)}">
        <th scope="row" class="c-name"><img src="${esc(logo(m))}" alt="" width="20" height="20" loading="lazy"><span><a href="${esc(m.url)}" target="_blank" rel="noopener" title="${esc(m.summary || m.name)}">${esc(m.name)}</a><small>${esc(m.provider)}${m.open ? ' · <em class="md-open">open</em>' : ''}</small></span></th>
        <td class="c-date">${shortDate(m.date)}</td>
        <td class="c-blended" title="${m.priceIn == null ? 'No hosted price' : `${money(m.priceIn)} in / ${money(m.priceOut)} out per million tokens`}">${money(m.blended)}</td>
        <td class="c-context">${ctx(m.context)}</td>
        <td class="c-params">${size(m.params)}</td>
        <td class="c-stories">${m.coverage.n || '—'}</td>
        <td class="c-scores">${scoreChips(m)}</td>
        <td class="c-pick"><button type="button" class="md-pick" data-mpick="${esc(m.id)}" aria-pressed="${on}"${full ? ' disabled title="Compare up to four"' : ''}>${on ? 'Added' : 'Compare'}</button></td>
      </tr>`;
    }).join('');
    return `<div class="md-table-wrap"><table class="md-table${animate ? ' animate' : ''}"><thead><tr>${head}<th scope="col" class="c-scores">Reported scores</th><th scope="col" class="c-pick"><span class="visually-hidden">Compare</span></th></tr></thead><tbody>${body}</tbody></table></div>
      ${rows.length > 30 && !view.all ? `<button class="more" type="button" data-mall>Show all ${rows.length}</button>` : ''}`;
  }

  // ---- Side by side ----
  function compare(all) {
    const picks = view.picks.map((id) => all.find((m) => m.id === id)).filter(Boolean);
    if (!picks.length) return '';
    if (picks.length === 1) return `<section class="topic-card md-compare"><h2>Compare</h2><p class="rail-note">${esc(picks[0].name)} is picked. Add another model from the chart or the table.</p></section>`;
    const best = (vals, dir) => {
      const v = vals.filter((x) => x != null);
      if (v.length < 2 || new Set(v).size < 2) return null;
      return dir > 0 ? Math.max(...v) : Math.min(...v);
    };
    const row = (label, get, fmt, dir = 0) => {
      const vals = picks.map(get);
      const b = dir ? best(vals, dir) : null;
      return `<tr><th scope="row">${label}</th>${vals.map((v) => `<td class="${b != null && v === b ? 'win' : ''}">${fmt(v)}</td>`).join('')}</tr>`;
    };
    const benches = [...new Map(picks.flatMap((m) => m.scores.map((s) => [s.key, s.label]))).entries()];
    const scoreOf = (m, k) => m.scores.find((s) => s.key === k)?.value ?? null;
    // Stories per day since launch, on one scale for all.
    const maxDay = Math.max(1, ...picks.flatMap((m) => m.coverage.series));
    const spark = (m) => {
      const s = m.coverage.series.slice(0, 31);
      if (!s.length) return '—';
      const w = 120;
      const h = 28;
      const bw = w / 31;
      return `<svg class="md-spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="${esc(`${m.name}: stories per day for ${s.length} days from launch`)}">${s.map((v, i) => {
        const bh = v ? Math.max(2, (v / maxDay) * (h - 1)) : 1;
        return `<rect x="${(i * bw).toFixed(1)}" y="${(h - bh).toFixed(1)}" width="${Math.max(1, bw - 1).toFixed(1)}" height="${bh.toFixed(1)}" rx="1"${v ? '' : ' class="z"'}><title>${shortDate(m.date - 86400e3 + i * 86400e3)}: ${v}</title></rect>`;
      }).join('')}</svg>`;
    };
    return `<section class="topic-card md-compare">
      <h2>Side by side</h2>
      <div class="md-table-wrap"><table class="ac-table md-vs">
        <thead><tr><th scope="col"><span class="visually-hidden">Measure</span></th>${picks.map((m) => `<th scope="col"><span class="md-vs-name"><img src="${esc(logo(m))}" alt="" width="18" height="18" loading="lazy"><a href="${esc(m.url)}" target="_blank" rel="noopener">${esc(m.name)}</a><button type="button" class="sv-x" data-mpick="${esc(m.id)}" aria-label="Remove ${esc(m.name)}">×</button></span><small>${esc(m.provider)}</small></th>`).join('')}</tr></thead>
        <tbody>
          ${row('Released', (m) => m.date, shortDate)}
          ${row('Input price', (m) => m.priceIn, (v) => (v == null ? '—' : `${money(v)}/M`), -1)}
          ${row('Output price', (m) => m.priceOut, (v) => (v == null ? '—' : `${money(v)}/M`), -1)}
          ${row('Blended (3:1)', (m) => m.blended, (v) => (v == null ? '—' : `${money(v)}/M`), -1)}
          ${row('Context', (m) => m.context, ctx, 1)}
          ${row('Parameters', (m) => m.params.total, (v) => (v == null ? '—' : v >= 1000 ? `${+(v / 1000).toFixed(1)}T` : `${v}B`))}
          ${row('Active', (m) => m.params.active, (v) => (v == null ? '—' : `${v}B`))}
          ${row('Weights', (m) => (m.open ? 'Open' : 'Closed'), (v) => v)}
          ${row('Stories since launch', (m) => m.coverage.n, (v) => v || '—', 1)}
          ${row('Outlets', (m) => m.coverage.outlets, (v) => v || '—', 1)}
          ${row('First week', (m) => m.coverage.week, (v) => v || '—', 1)}
          <tr><th scope="row">Stories per day</th>${picks.map((m) => `<td>${spark(m)}</td>`).join('')}</tr>
          ${row('First report', (m) => m.coverage.first, (f) => (f ? `<a href="${esc(f.url)}" target="_blank" rel="noopener">${esc(f.source)}</a>` : '—'))}
          ${benches.map(([k, l]) => row(esc(l), (m) => scoreOf(m, k), (v) => (v == null ? '—' : `${v}%`), 1)).join('')}
        </tbody>
      </table></div>
      ${benches.length ? '<p class="rail-note">Scores are as the press reported them for each model, not run here; versions of a benchmark aren’t mixed.</p>' : ''}
    </section>`;
  }

  function render() {
    const name = state.data?.site?.name || 'Frontier Wire';
    document.title = `Compare models · ${name}`;
    const nav = '<nav class="md-switch" aria-label="Releases"><a href="#releases">List</a><a href="#models" aria-current="page">Compare</a></nav>';
    if (state.mode !== 'api') {
      setHtml($('#modelsView'), `<header class="topic-head">${nav}<h1>Compare models</h1><p class="topic-sum">Model comparison needs the live server.</p></header>`);
      return;
    }
    load();
    const d = data.d;
    const head = `<header class="topic-head md-head">
        <div class="head-row"><p class="kicker">AI releases</p>${nav}</div>
        <h1>Compare models</h1>
        <p class="topic-sum">${d ? `${d.models.length} models from the last 90 days. Prices and context from OpenRouter, sizes from the listings, coverage from the wire, and benchmark scores as outlets reported them.` : 'Price, context, size, coverage and reported scores for every recent release.'}</p>
      </header>`;
    if (!d) {
      setHtml($('#modelsView'), `${head}${data.error ? `<p class="rail-note">Model comparison is unavailable: ${esc(data.error)}</p>` : '<div class="topic-chart loading" aria-busy="true"><i class="skeleton"></i></div>'}`);
      return;
    }
    const animate = shown !== d && !reducedMotion();
    shown = d;
    const keep = (FILTERS.find(([k]) => k === view.filter) || FILTERS[0])[2];
    const models = d.models.filter(keep);
    const chips = FILTERS.map(([k, l, f]) => `<button class="chip" type="button" data-mfilter="${k}" aria-pressed="${view.filter === k}">${l}<span class="n">${d.models.filter(f).length}</span></button>`).join('');
    const ys = YS.map(([k, l]) => `<button type="button" data-my="${k}" aria-pressed="${view.y === k}">${l}</button>`).join('');
    setHtml($('#modelsView'), `${head}
      <div class="md-bar"><div class="chips" role="group" aria-label="Filter models">${chips}</div><div class="seg" role="group" aria-label="Vertical axis">${ys}</div></div>
      ${compare(d.models)}
      <section class="topic-card md-chart-card"><h2>Price and ${view.y === 'stories' ? 'attention' : 'context'}</h2>${chart(models, { animate })}</section>
      <section class="md-list"><h2 class="when">All models<span>${models.length}</span></h2>${table(models, { animate })}</section>
      <div class="ac-tip" role="tooltip" hidden></div>`);
  }

  function setPicks(ids) {
    history.replaceState(null, '', href(ids));
    view.picks = ids;
    render();
  }

  function onClick(t) {
    const d = t.dataset;
    if (d.mpick) {
      const on = view.picks.includes(d.mpick);
      if (!on && view.picks.length >= MAX_PICK) return true;
      setPicks(on ? view.picks.filter((x) => x !== d.mpick) : [...view.picks, d.mpick]);
      if (!on && view.picks.length >= 2 && !reducedMotion()) $('#modelsView .md-compare')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      return true;
    }
    if (d.mfilter) {
      view.filter = d.mfilter;
      view.all = false;
      store.set('fw.mdfilter', view.filter);
      shown = null;
      render();
      return true;
    }
    if (d.my) {
      view.y = d.my;
      store.set('fw.mdy', view.y);
      shown = null;
      render();
      return true;
    }
    if (d.msort) {
      const col = COLS.find((c) => c[0] === d.msort);
      view.sort = view.sort.key === d.msort ? { key: d.msort, dir: -view.sort.dir } : { key: d.msort, dir: col[3] };
      render();
      return true;
    }
    if ('mall' in d) {
      view.all = true;
      render();
      return true;
    }
    return false;
  }

  function hover(e) {
    const tip = $('#modelsView .ac-tip');
    if (!tip) return;
    const t = e.type === 'pointerleave' ? null : e.target.closest?.('.md-dot[data-tip]');
    if (!t) { tip.hidden = true; return; }
    tip.textContent = t.dataset.tip;
    tip.hidden = false;
    const box = $('#modelsView').getBoundingClientRect();
    const r = t.querySelector('.pt').getBoundingClientRect();
    const x = Math.min(box.width - tip.offsetWidth - 4, Math.max(4, r.left - box.left + r.width / 2 - tip.offsetWidth / 2));
    tip.style.transform = `translate(${x}px, ${r.top - box.top - tip.offsetHeight - 10}px)`;
  }

  return { route, render, onClick, hover };
}
