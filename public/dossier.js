// Company dossiers (#co/<key>, #co): everything the site tracks about one AI
// company. Tiles for coverage, mood, shipping, incidents and lawsuits; its
// share of coverage over 30 days, the mood of its headlines week by week and
// its valuations; the latest figures; dates ahead; and one timeline merging
// launches, figures, incidents, lawsuits, layoffs, deals and open releases.
// Server side: src/index/dossier.js.

const DAY = 86400e3;
const COMPANIES = [['openai', 'OpenAI'], ['anthropic', 'Anthropic'], ['google', 'Google'], ['meta', 'Meta'], ['microsoft', 'Microsoft'], ['xai', 'xAI'], ['nvidia', 'Nvidia'], ['amazon', 'Amazon'], ['apple', 'Apple'], ['deepseek', 'DeepSeek'], ['mistral', 'Mistral']];
const TYPES = { shipped: 'Shipped', figure: 'Figure', incident: 'Incident', court: 'Court', jobs: 'Jobs', deal: 'Money', open: 'Open weights' };
const dayFmt = (t) => new Date(t).toLocaleDateString('en', { month: 'short', day: 'numeric' });
const usd = (v) => (v >= 1e12 ? `$${+(v / 1e12).toPrecision(3)}T` : v >= 1e9 ? `$${+(v / 1e9).toPrecision(3)}B` : `$${Math.round(v / 1e6)}M`);
const fmt = (x) => (x.unit === 'people' ? (x.value >= 1e9 ? `${+(x.value / 1e9).toPrecision(3)}B` : `${+(x.value / 1e6).toPrecision(3)}M`) : usd(x.value));
const pts = (v) => (v == null ? '–' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(1)}`);

export function createDossier({ $, esc, setHtml, state, reducedMotion }) {
  const view = { key: '', t: '' };
  const cache = new Map();
  let drawn = '';

  function route(hash) {
    const m = /^#co(?:\/([a-z]+))?(?:\?(.*))?$/.exec(hash);
    if (!m) return null;
    view.key = COMPANIES.some(([k]) => k === m[1]) ? m[1] : '';
    view.t = (new URLSearchParams(m[2] || '').get('t') || '').replace(/[^a-z]/g, '').slice(0, 12);
    return 'co';
  }

  async function load(key) {
    const c = cache.get(key);
    if (c?.pending || (c?.d && Date.now() - c.at < 10 * 60e3) || (c?.error && Date.now() - c.at < 20e3)) return;
    cache.set(key, { ...c, pending: true });
    try {
      const r = await fetch(`/api/co?key=${key}`);
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || r.statusText);
      cache.set(key, { d, at: Date.now() });
    } catch (err) {
      cache.set(key, { d: c?.d, error: err.message, at: Date.now() });
    }
    if (state.view === 'co') render();
  }

  // Share of coverage, 30 days, as a filled line.
  function share(s) {
    if (!s?.series?.length) return '';
    const W = 320, H = 70, P = 3;
    const max = Math.max(...s.series.map((d) => d.share)) || 1;
    const x = (i) => P + (i / (s.series.length - 1)) * (W - 2 * P);
    const y = (v) => H - P - (v / max) * (H - 2 * P - 8);
    const line = s.series.map((d, i) => `${x(i).toFixed(1)},${y(d.share).toFixed(1)}`).join(' ');
    return `<section class="dz-card"><h3>Share of coverage<small>30 days</small></h3>
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(s.series.map((d) => `${d.day}: ${(d.share * 100).toFixed(1)}%`).join('; '))}"><polygon class="dz-area" points="${P},${H - P} ${line} ${W - P},${H - P}"/><polyline class="dz-line" points="${line}"/></svg>
      <p class="dz-note"><b>${(s.week * 100).toFixed(1)}%</b> of stored stories this week, ${(s.prevWeek * 100).toFixed(1)}% the week before</p></section>`;
  }

  // Mood by week around zero.
  function mood(m) {
    if (!m) return '';
    const vals = m.weeks.filter((v) => v != null);
    const W = 320, H = 70, mid = H / 2;
    const top = Math.max(10, ...vals.map(Math.abs));
    const bw = W / m.weeks.length;
    return `<section class="dz-card"><h3>Mood of its headlines<small>good minus bad, by week</small></h3>
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(m.weeks.map((v) => pts(v)).join(', '))}"><line class="dz-zero" x1="0" x2="${W}" y1="${mid}" y2="${mid}"/>${m.weeks.map((v, i) => (v == null ? '' : `<rect class="${v >= 0 ? 'dz-good' : 'dz-bad'}" x="${(i * bw + bw * 0.15).toFixed(1)}" y="${(v >= 0 ? mid - (v / top) * (mid - 2) : mid).toFixed(1)}" width="${(bw * 0.7).toFixed(1)}" height="${Math.max(1, (Math.abs(v) / top) * (mid - 2)).toFixed(1)}" rx="1.5"/>`)).join('')}</svg>
      <p class="dz-note"><b>${esc(pts(m.mood90))}</b> in 90 days (${esc(pts(m.moodPrev))} the 90 before), this week ${esc(pts(m.moodWeek))} · <a href="#mood?c=${esc(view.key)}">more</a></p></section>`;
  }

  // Valuations as a step chart.
  function money(m) {
    if (!m || !m.valuations?.length) return '';
    const v = m.valuations.slice(-8);
    const W = 320, H = 70, P = 4;
    const t0 = v[0].at, t1 = Math.max(v.at(-1).at, t0 + DAY);
    const max = Math.max(...v.map((x) => x.valuation));
    const x = (t) => P + ((t - t0) / (t1 - t0)) * (W - 2 * P - 40);
    const y = (val) => H - P - (val / max) * (H - 2 * P - 10);
    let d = `M${x(v[0].at).toFixed(1)},${y(v[0].valuation).toFixed(1)}`;
    for (let i = 1; i < v.length; i++) d += ` H${x(v[i].at).toFixed(1)} V${y(v[i].valuation).toFixed(1)}`;
    return `<section class="dz-card"><h3>Valuation<small>each round named</small></h3>
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(v.map((x2) => `${dayFmt(x2.at)}: ${usd(x2.valuation)}`).join('; '))}"><path class="dz-step" d="${d}"/>${v.map((p) => `<circle class="dz-dot" cx="${x(p.at).toFixed(1)}" cy="${y(p.valuation).toFixed(1)}" r="3"/>`).join('')}<text class="dz-last" x="${(x(v.at(-1).at) + 6).toFixed(1)}" y="${y(v.at(-1).valuation).toFixed(1)}" dy="0.32em">${esc(usd(v.at(-1).valuation))}</text></svg>
      <p class="dz-note"><b>${esc(usd(m.raised))}</b> raised in rounds named · <a href="#deals">Deals</a></p></section>`;
  }

  function figures(d) {
    if (!d.figures.length) return '';
    return `<section class="dz-figs"><h2 class="when">Figures<span>the latest of each, from <a href="#numbers?c=${esc(d.key)}">AI by the numbers</a></span></h2><ul>${d.figures.map((f) => `<li><small>${esc(f.label)}</small><b>${esc(fmt(f.latest))}</b><span>${f.latest.period ? `${esc(f.latest.period)} · ` : ''}${f.latest.outlook ? 'outlook · ' : ''}<a href="${esc(f.latest.url)}" target="_blank" rel="noopener">${esc(f.latest.source || 'source')}</a></span></li>`).join('')}</ul></section>`;
  }

  function ahead(d) {
    if (!d.ahead.length) return '';
    return `<section class="dz-ahead"><h2 class="when">Coming up<span>dates the news has put on it · <a href="#ahead">all dates</a></span></h2><ol>${d.ahead.map((x) => `<li><time>${esc(x.precision === 'day' ? new Date(`${x.date}T00:00:00Z`).toLocaleDateString('en', { month: 'short', day: 'numeric', timeZone: 'UTC' }) : new Date(`${x.date}T00:00:00Z`).toLocaleDateString('en', { month: 'short', year: 'numeric', timeZone: 'UTC' }))}</time><a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.title)}</a></li>`).join('')}</ol></section>`;
  }

  function timeline(d) {
    const list = d.timeline.filter((x) => !view.t || x.type === view.t);
    let last = '';
    const rows = [];
    list.slice(0, 60).forEach((x, i) => {
      const age = Math.floor((d.generatedAt - x.at) / (7 * DAY));
      const h = age === 0 ? 'This week' : age === 1 ? 'Last week' : age < 5 ? `${age} weeks ago` : new Date(x.at).toLocaleDateString('en', { month: 'long' });
      if (h !== last) { rows.push(`<li class="dz-h"><h3>${esc(h)}</h3></li>`); last = h; }
      rows.push(`<li class="dz-ev t-${x.type}" style="--i:${Math.min(i, 20)}"><span class="dz-type">${esc(TYPES[x.type] || x.type)}</span>
        <div><a href="${esc(x.url || '#')}" target="_blank" rel="noopener">${esc(x.title)}</a><small>${esc(x.detail || '')}${x.source ? ` · ${esc(x.source)}` : ''}${x.outlets > 1 ? ` · ${x.outlets} outlets` : ''} · ${esc(dayFmt(x.at))}</small></div></li>`);
    });
    const base = `#co/${d.key}`;
    return `<section class="dz-tl"><h2 class="when">What happened<span>launches, figures, incidents, lawsuits, layoffs, money and open releases, last 120 days</span></h2>
      <nav class="pd-chips ct-themes" aria-label="Kind"><a class="chip${view.t ? '' : ' on'}" href="${base}">All <small>${d.timeline.length}</small></a>${Object.entries(d.counts).sort((a, b) => b[1] - a[1]).map(([k, n]) => `<a class="chip${view.t === k ? ' on' : ''}" href="${base}${view.t === k ? '' : `?t=${k}`}">${esc(TYPES[k] || k)} <small>${n}</small></a>`).join('')}</nav>
      <ol>${rows.join('') || '<li class="rail-note">Nothing in the last 120 days.</li>'}</ol></section>`;
  }

  function page(d) {
    const s = d.stats;
    return `<nav class="dz-cos" aria-label="Companies">${COMPANIES.map(([k, l]) => `<a class="chip${k === d.key ? ' on' : ''}" href="#co/${k}">${esc(l)}</a>`).join('')}</nav>
      <div class="tl-stats">
        ${d.share ? `<p><b>${(d.share.week * 100).toFixed(1)}%</b><span>of stored stories mention it this week</span></p>` : ''}
        ${d.mood ? `<p><b>${esc(pts(d.mood.mood90))}</b><span>mood of its headlines in 90 days</span></p>` : ''}
        <p><b>${s.shipped30}</b><span>changes shipped in 30 days</span></p>
        <p><b>${s.incidents90}</b><span>incidents in 90 days, ${s.openCases} lawsuits open</span></p>
      </div>
      <div class="dz-cards">${share(d.share)}${mood(d.mood)}${money(d.money)}</div>
      <div class="dz-grid">${figures(d)}${ahead(d)}</div>
      ${timeline(d)}
      <p class="rail-note">Put together from the site’s other pages: <a href="#topic/${esc(d.key)}">topic coverage</a>, <a href="#mood">Mood</a>, <a href="#deals">Deals</a>, <a href="#numbers">Numbers</a>, <a href="#shipped">Shipped</a>, <a href="#incidents">AI incidents</a>, <a href="#court">Courtroom</a>, <a href="#jobs">AI and jobs</a>, <a href="#open">Open weights</a> and <a href="#ahead">What’s coming</a>; each reads headlines its own way, described on its page.${d.missing?.length ? ` Still computing: ${esc(d.missing.join(', '))}.` : ''} <a href="/api/co?key=${esc(d.key)}">JSON</a></p>`;
  }

  function index() {
    return `<p class="topic-sum">Pick a company.</p><nav class="dz-pick">${COMPANIES.map(([k, l], i) => `<a href="#co/${k}" style="--i:${i}">${esc(l)}</a>`).join('')}</nav>`;
  }

  function render() {
    const site = state.data?.site?.name || 'Frontier Wire';
    const host = $('#coView');
    const label = COMPANIES.find(([k]) => k === view.key)?.[1];
    document.title = `${label ? `${label} dossier` : 'Company dossiers'} · ${site}`;
    const head = `<header class="topic-head dz-head"><p class="kicker">Dossier</p><h1>${esc(label || 'Company dossiers')}</h1>
      ${label ? `<p class="topic-sum">Everything tracked about ${esc(label)}: coverage, mood, money, figures, launches, incidents, lawsuits and what’s next.</p>` : ''}</header>`;
    if (state.mode !== 'api') {
      setHtml(host, `${head}<p class="rail-note">Dossiers need the live server.</p>`);
      return;
    }
    if (!view.key) {
      setHtml(host, `${head}${index()}`);
      return;
    }
    load(view.key);
    const c = cache.get(view.key);
    if (!c?.d) {
      setHtml(host, `${head}${c?.error ? `<p class="rail-note">${esc(c.error)}</p>` : '<i class="skeleton" style="height:320px;display:block;margin:16px 0;border-radius:12px"></i>'}`);
      return;
    }
    const animate = drawn !== `${view.key}:${c.d.generatedAt}` && !reducedMotion();
    drawn = `${view.key}:${c.d.generatedAt}`;
    setHtml(host, `${head}<div class="dz-page${animate ? ' animate' : ''}">${page(c.d)}</div>`);
  }

  return { route, render };
}
