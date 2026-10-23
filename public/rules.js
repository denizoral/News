// AI rules (#rules?j=<jurisdiction>&t=<topic>): the bills, laws, orders and
// regulations being written about AI. Monthly activity by how far it got as
// stacked columns, jurisdictions as stacked bars of where their measures
// stand (tap to filter), subject chips, and each measure with a stage rail
// and its timeline. Server side: src/index/rules.js.

const dayFmt = (t) => new Date(t).toLocaleDateString('en', { month: 'short', day: 'numeric', year: 'numeric' });
const monFmt = (m) => new Date(`${m}-15T00:00:00Z`).toLocaleDateString('en', { month: 'short' });
const monLong = (m) => new Date(`${m}-15T00:00:00Z`).toLocaleDateString('en', { month: 'long', year: 'numeric' });
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
const fav = (h) => `https://www.google.com/s2/favicons?domain=${encodeURIComponent(h || 'example.com')}&sz=32`;
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

// Four groups of stage, in a fixed colour order.
const SERIES = [['proposed', 'Proposed'], ['moving', 'Advancing or passed'], ['enacted', 'Signed or in force'], ['blocked', 'Blocked or delayed']];
const GROUP = { proposed: 'proposed', advancing: 'moving', passed: 'moving', signed: 'enacted', inforce: 'enacted', blocked: 'blocked' };
const STAGE = { proposed: 'Proposed', advancing: 'Advancing', passed: 'Passed', signed: 'Signed', inforce: 'In force', blocked: 'Blocked or delayed' };
const RAIL = ['proposed', 'advancing', 'passed', 'signed', 'inforce'];

export function createRules({ $, esc, setHtml, state, reducedMotion }) {
  const view = { j: '', t: '' };
  let data = { d: null, error: null, pending: false, at: 0 };
  let drawn = null;

  function route(hash) {
    const m = /^#rules(?:\?(.*))?$/.exec(hash);
    if (!m) return null;
    const p = new URLSearchParams(m[1] || '');
    view.j = (p.get('j') || '').replace(/[^a-z-]/g, '');
    view.t = (p.get('t') || '').replace(/[^a-z]/g, '');
    return 'rules';
  }

  async function load() {
    if (data.pending || (data.d && Date.now() - data.at < 20 * 60e3) || (data.error && Date.now() - data.at < 20e3)) return;
    data.pending = true;
    try {
      const r = await fetch('/api/rules');
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || r.statusText);
      data = { d, at: Date.now() };
    } catch (err) {
      data = { d: data.d, error: err.message, at: Date.now() };
    }
    if (state.view === 'rules') render();
  }

  const href = (j, t) => {
    const p = new URLSearchParams();
    if (j) p.set('j', j);
    if (t) p.set('t', t);
    const s = p.toString();
    return `#rules${s ? `?${s}` : ''}`;
  };

  function months(d, narrow) {
    const W = narrow ? 360 : 560, H = 200, L = 28, R = 6, T = 10, B = 22;
    const max = Math.max(4, ...d.months.map((m) => m.proposed + m.moving + m.enacted + m.blocked));
    const step = max > 40 ? 20 : max > 16 ? 10 : 5;
    const top = Math.ceil(max / step) * step;
    const y = (v) => T + (1 - v / top) * (H - T - B);
    const bw = (W - L - R) / d.months.length;
    const ticks = [];
    for (let v = 0; v <= top; v += step) ticks.push(v);
    const cols = d.months.map((m, i) => {
      let acc = 0;
      const segs = SERIES.map(([k], s) => {
        const v = m[k];
        if (!v) return '';
        const y1 = y(acc), y0 = y(acc + v);
        acc += v;
        return `<rect class="ru-seg s${s + 1}" x="${(L + i * bw + bw * 0.18).toFixed(1)}" y="${(y0 + 1).toFixed(1)}" width="${(bw * 0.64).toFixed(1)}" height="${Math.max(1, y1 - y0 - 2).toFixed(1)}" rx="2"/>`;
      }).join('');
      return `<g class="ru-col" style="--i:${i}" data-m="${i}">${segs}<rect class="ru-hit" x="${(L + i * bw).toFixed(1)}" y="${T}" width="${bw.toFixed(1)}" height="${H - T - B}"/></g>
        ${i % (narrow ? 2 : 1) === 0 ? `<text class="lc-xt" x="${(L + i * bw + bw / 2).toFixed(1)}" y="${H - 6}" text-anchor="middle">${esc(monFmt(m.m))}</text>` : ''}`;
    }).join('');
    return `<section class="ru-months"><h2 class="when">Month by month<span>steps in the measures below</span></h2>
      <ul class="tr-legend">${SERIES.map(([, l], s) => `<li style="--c:var(--s${s + 1}c)"><i class="sw"></i>${esc(l)}</li>`).join('')}</ul>
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(d.months.map((m) => `${m.m}: ${SERIES.map(([k, l]) => `${m[k]} ${l.toLowerCase()}`).join(', ')}`).join('; '))}">
        ${ticks.map((v) => `<g class="lc-tick"><line x1="${L}" x2="${W - R}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/><text x="${L - 6}" y="${y(v).toFixed(1)}" dy="0.32em" text-anchor="end">${v}</text></g>`).join('')}
        ${cols}
      </svg></section>`;
  }

  // One row per jurisdiction: its measures as a bar split by where they stand.
  function places(d) {
    const rows = d.jurisdictions.slice(0, 12);
    const max = Math.max(1, ...rows.map((j) => j.n));
    return `<section class="ru-places"><h2 class="when">Where<span>measures by where they stand; tap to filter</span></h2>
      <ol>${rows.map((j, i) => {
        const g = { proposed: 0, moving: 0, enacted: 0, blocked: 0 };
        for (const [k, n] of Object.entries(j.stages)) g[GROUP[k]] += n;
        const on = view.j === j.key;
        return `<li style="--i:${i}"><a href="${esc(href(on ? '' : j.key, view.t))}" class="${on ? 'on' : ''}${view.j && !on ? ' dim' : ''}" data-j="${esc(j.key)}">
          <span class="ru-pl">${esc(j.label)}</span>
          <span class="ru-bar" style="width:${((100 * j.n) / max).toFixed(1)}%">${SERIES.map(([k], s) => (g[k] ? `<i class="s${s + 1}" style="flex:${g[k]}"></i>` : '')).join('')}</span>
          <small>${j.n}</small></a></li>`;
      }).join('')}</ol></section>`;
  }

  function rail(m) {
    if (m.stage === 'blocked') {
      const at = RAIL.indexOf(m.reached);
      return `<span class="ru-rail x" aria-label="${esc(`Blocked or delayed after ${STAGE[m.reached].toLowerCase()}`)}">${RAIL.map((s, i) => `<i class="${i <= at ? 'on' : ''}"></i>`).join('')}</span>`;
    }
    const at = RAIL.indexOf(m.stage);
    return `<span class="ru-rail" aria-label="${esc(STAGE[m.stage])}">${RAIL.map((s, i) => `<i class="${i <= at ? 'on' : ''}" title="${esc(STAGE[s])}"></i>`).join('')}</span>`;
  }

  function card(m, i) {
    const last = m.events.at(-1);
    const topic = data.d.topics.find((t) => t.key === m.topic);
    return `<li class="ru-m" style="--i:${Math.min(i, 14)}">
      <details>
        <summary>
          <p class="ct-meta"><span class="ru-stage g-${GROUP[m.stage]}">${STAGE[m.stage]}</span>${rail(m)}</p>
          <h3>${m.named ? '' : `<span class="ru-where">${esc(m.where.label)}:</span> `}${esc(m.title)}</h3>
          <p class="ct-meta"><a class="tl-chip" href="${esc(href(m.where.key, view.t))}">${esc(m.where.label)}</a>${topic ? `<a class="tl-chip" href="${esc(href(view.j, m.topic))}">${esc(topic.label)}</a>` : ''}</p>
          <p class="ct-sub">${esc(dayFmt(m.first))}${m.last - m.first > 86400e3 ? ` to ${esc(dayFmt(m.last))}` : ''} · ${plural(m.headlines, 'headline')} from ${plural(m.outlets, 'outlet')}</p>
          <p class="ct-latest">${esc(last.title)}</p>
        </summary>
        <ol class="ct-events">${[...m.events].reverse().map((e) => `<li class="g-${GROUP[e.stage]}"><p class="ct-ev-h"><b>${STAGE[e.stage]}</b> · ${esc(dayFmt(e.at))}${e.outlets > 1 ? ` · ${e.outlets} outlets` : ''}</p>
          <p class="ct-ev-t"><img src="${esc(fav(hostOf(e.url)))}" alt="" width="14" height="14" loading="lazy" data-fallback="remove"><a href="${esc(e.url)}" target="_blank" rel="noopener">${esc(e.title)}</a> <small>${esc(e.source)}</small></p></li>`).join('')}</ol>
      </details>
    </li>`;
  }

  function page(d) {
    const narrow = innerWidth < 640;
    const list = d.measures.filter((m) => (!view.j || m.where.key === view.j) && (!view.t || m.topic === view.t));
    // Named measures (a bill, an act, an order) before the general coverage.
    list.sort((a, b) => b.named - a.named || b.last - a.last);
    const jLabel = d.jurisdictions.find((j) => j.key === view.j)?.label;
    const tLabel = d.topics.find((t) => t.key === view.t)?.label;
    return `<div class="tl-stats">
        <p><b>${d.stats.measures}</b><span>measures in the last year, ${d.stats.named} with a name</span></p>
        <p><b>${d.stats.enacted}</b><span>signed or in force</span></p>
        <p><b>${d.stats.blocked}</b><span>blocked, delayed or rolled back</span></p>
        <p><b>${d.stats.states}</b><span>US states with measures</span></p>
      </div>
      <div class="ct-charts">${months(d, narrow)}${places(d)}</div>
      <nav class="pd-chips ct-themes" aria-label="Subject"><a class="chip${view.t ? '' : ' on'}" href="${esc(href(view.j, ''))}">All</a>${d.topics.map((t) => `<a class="chip${view.t === t.key ? ' on' : ''}" href="${esc(href(view.j, view.t === t.key ? '' : t.key))}">${esc(t.label)} <small>${t.n}</small></a>`).join('')}</nav>
      <section><h2 class="when">${esc([jLabel || 'Measures', tLabel ? tLabel.replace(/^\w/, (c) => c.toLowerCase()) : ''].filter(Boolean).join(': '))}<span>${list.length}, named ones first</span>${view.j || view.t ? '<a class="tl-clear" href="#rules">Show all</a>' : ''}</h2>
        <ol class="ct-cases">${list.slice(0, 80).map(card).join('') || '<li class="rail-note">No measures match.</li>'}</ol>
      </section>
      <p class="rail-note">From ${d.headlines} AI policy headlines in English over the last year. A headline is read for where (Congress and the White House, a US state, the EU, the UK, China and others), what kind of rule and how far it got; headlines naming the same bill or act are one measure, and without a name the same place and subject. Where a measure stands is the furthest step it reached, unless it was blocked, delayed or rolled back since. <a href="/api/rules">JSON</a></p>
      <div class="ac-tip ru-tip" role="tooltip" hidden></div>`;
  }

  function render() {
    const site = state.data?.site?.name || 'Frontier Wire';
    const host = $('#rulesView');
    document.title = `AI rules · ${site}`;
    const head = `<header class="topic-head ru-head"><p class="kicker">AI rules</p><h1>Who is writing the rules for AI</h1>
      <p class="topic-sum">The bills, laws, executive orders and regulations on AI around the world, and how far each one got.</p></header>`;
    if (state.mode !== 'api') {
      setHtml(host, `${head}<p class="rail-note">AI rules need the live server.</p>`);
      return;
    }
    load();
    const d = data.d;
    if (!d) {
      setHtml(host, `${head}${data.error ? `<p class="rail-note">${esc(data.error)}</p>` : '<i class="skeleton" style="height:320px;display:block;margin:16px 0;border-radius:12px"></i>'}`);
      return;
    }
    const animate = drawn !== d.generatedAt && !reducedMotion();
    drawn = d.generatedAt;
    setHtml(host, `${head}<div class="ru-page${animate ? ' animate' : ''}">${page(d)}</div>`);
  }

  function hover(e) {
    const tip = $('#rulesView .ru-tip');
    const d = data.d;
    if (!tip || !d) return;
    const t = e.type === 'pointerleave' ? null : e.target;
    const col = t?.closest?.('.ru-col');
    const row = t?.closest?.('.ru-places a');
    let html = '';
    let el = null;
    if (col) {
      const m = d.months[+col.dataset.m];
      el = col;
      html = `<p class="tt-h">${esc(monLong(m.m))}</p>${SERIES.map(([k, l], s) => `<p><i class="ct-sw s${s + 1}"></i>${esc(l)}: <b>${m[k]}</b></p>`).join('')}`;
    } else if (row) {
      const j = d.jurisdictions.find((x) => x.key === row.dataset.j);
      const g = { proposed: 0, moving: 0, enacted: 0, blocked: 0 };
      for (const [k, n] of Object.entries(j.stages)) g[GROUP[k]] += n;
      el = row.querySelector('.ru-bar');
      html = `<p class="tt-h">${esc(j.label)}</p>${SERIES.map(([k, l], s) => (g[k] ? `<p><i class="ct-sw s${s + 1}"></i>${esc(l)}: <b>${g[k]}</b></p>` : '')).join('')}`;
    }
    if (!el) { tip.hidden = true; return; }
    setHtml(tip, html);
    tip.hidden = false;
    const host = $('#rulesView').getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const w = tip.offsetWidth || 200;
    tip.style.left = `${Math.max(0, Math.min(host.width - w, r.left - host.left + r.width / 2 - w / 2))}px`;
    tip.style.top = `${Math.max(0, r.top - host.top - tip.offsetHeight - 6)}px`;
  }

  return { route, render, hover };
}
