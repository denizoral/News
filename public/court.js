// Courtroom (#court?d=<defendant>&t=<theme>): the lawsuits, rulings and
// settlements around AI companies. Monthly filings, rulings and outcomes as
// stacked columns, who is being sued over what as a matrix that filters, and
// each case with its timeline. Server side: src/index/court.js.

const dayFmt = (t) => new Date(t).toLocaleDateString('en', { month: 'short', day: 'numeric', year: 'numeric' });
const monFmt = (m) => new Date(`${m}-15T00:00:00Z`).toLocaleDateString('en', { month: 'short' });
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
const fav = (h) => `https://www.google.com/s2/favicons?domain=${encodeURIComponent(h || 'example.com')}&sz=32`;
const money = (v) => (v >= 1e9 ? `$${+(v / 1e9).toFixed(1)}B` : `$${Math.round(v / 1e6)}M`);
const STATUS = { filed: 'Filed', ongoing: 'Ongoing', ruling: 'Ruling', dismissed: 'Dismissed', settled: 'Settled', verdict: 'Verdict' };
const KIND = { filed: 'Filed', hearing: 'Hearing', ruling: 'Ruling', dismissed: 'Dismissed', settled: 'Settled', verdict: 'Verdict' };
const SERIES = [['filed', 'Filed'], ['rulings', 'Rulings'], ['outcomes', 'Settled, dismissed or decided']];

export function createCourt({ $, esc, setHtml, state, reducedMotion }) {
  const view = { d: '', t: '' };
  let data = { d: null, error: null, pending: false, at: 0 };
  let drawn = null;

  function route(hash) {
    const m = /^#court(?:\?(.*))?$/.exec(hash);
    if (!m) return null;
    const p = new URLSearchParams(m[1] || '');
    view.d = (p.get('d') || '').replace(/[^a-z0-9-]/g, '');
    view.t = (p.get('t') || '').replace(/[^a-z]/g, '');
    return 'court';
  }

  async function load() {
    if (data.pending || (data.d && Date.now() - data.at < 20 * 60e3) || (data.error && Date.now() - data.at < 20e3)) return;
    data.pending = true;
    try {
      const r = await fetch('/api/court');
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || r.statusText);
      data = { d, at: Date.now() };
    } catch (err) {
      data = { d: data.d, error: err.message, at: Date.now() };
    }
    if (state.view === 'court') render();
  }

  const href = (d, t) => {
    const p = new URLSearchParams();
    if (d) p.set('d', d);
    if (t) p.set('t', t);
    const s = p.toString();
    return `#court${s ? `?${s}` : ''}`;
  };

  // Stacked columns, one per month; a 2px surface gap between segments.
  function months(d, narrow) {
    const W = narrow ? 360 : 560, H = 200, L = 28, R = 6, T = 10, B = 22;
    const tot = d.months.map((m) => m.filed + m.rulings + m.outcomes);
    const max = Math.max(4, ...tot);
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
        return `<rect class="ct-seg s${s + 1}" x="${(L + i * bw + bw * 0.18).toFixed(1)}" y="${(y0 + 1).toFixed(1)}" width="${(bw * 0.64).toFixed(1)}" height="${Math.max(1, y1 - y0 - 2).toFixed(1)}" rx="2"/>`;
      }).join('');
      return `<g class="ct-col" style="--i:${i}" data-m="${i}">${segs}<rect class="ct-hit" x="${(L + i * bw).toFixed(1)}" y="${T}" width="${bw.toFixed(1)}" height="${H - T - B}"/></g>
        ${i % (narrow ? 2 : 1) === 0 ? `<text class="lc-xt" x="${(L + i * bw + bw / 2).toFixed(1)}" y="${H - 6}" text-anchor="middle">${esc(monFmt(m.m))}</text>` : ''}`;
    }).join('');
    return `<section class="ct-months"><h2 class="when">Month by month<span>events in the cases below</span></h2>
      <ul class="tr-legend">${SERIES.map(([, l], s) => `<li style="--c:var(--s${s + 1}c)"><i class="sw"></i>${esc(l)}</li>`).join('')}</ul>
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(d.months.map((m) => `${m.m}: ${m.filed} filed, ${m.rulings} rulings, ${m.outcomes} outcomes`).join('; '))}" data-chart="ct">
        ${ticks.map((v) => `<g class="lc-tick"><line x1="${L}" x2="${W - R}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/><text x="${L - 6}" y="${y(v).toFixed(1)}" dy="0.32em" text-anchor="end">${v}</text></g>`).join('')}
        ${cols}
      </svg></section>`;
  }

  // Defendants down, kinds of claim across; dot area by number of cases.
  function matrix(d) {
    const themes = d.themes.filter((t) => t.key !== 'other').slice(0, 9);
    const defs = d.defendants.slice(0, 9);
    if (!themes.length || !defs.length) return '';
    const max = Math.max(1, ...defs.flatMap((x) => themes.map((t) => x.themes[t.key] || 0)));
    return `<section class="ct-matrix"><h2 class="when">Who is being sued over what<span>cases; tap to filter</span></h2>
      <div class="ct-mx-scroll"><table>
        <thead><tr><th scope="col"><span class="sr-only">Company</span></th>${themes.map((t) => `<th scope="col"><a href="${esc(href(view.d, view.t === t.key ? '' : t.key))}" class="${view.t === t.key ? 'on' : ''}">${esc(t.label)}</a></th>`).join('')}</tr></thead>
        <tbody>${defs.map((x) => `<tr class="${view.d === x.key ? 'on' : ''}"><th scope="row"><a href="${esc(href(view.d === x.key ? '' : x.key, view.t))}">${esc(x.label)}</a> <small>${x.n}</small></th>${themes.map((t) => {
          const n = x.themes[t.key] || 0;
          const on = (!view.d || view.d === x.key) && (!view.t || view.t === t.key);
          return `<td>${n ? `<a href="${esc(href(x.key, t.key))}" class="ct-dot${on ? '' : ' off'}" style="--r:${(8 + 18 * Math.sqrt(n / max)).toFixed(1)}px" title="${esc(`${x.label}, ${t.label}: ${n} case${n === 1 ? '' : 's'}`)}"><span>${n}</span></a>` : ''}</td>`;
        }).join('')}</tr>`).join('')}</tbody>
      </table></div></section>`;
  }

  function caseCard(c, i) {
    const last = c.events[c.events.length - 1];
    return `<li class="ct-case" style="--i:${Math.min(i, 14)}">
      <details>
        <summary>
          <p class="ct-meta"><span class="ct-status ${c.status}">${STATUS[c.status]}</span><a class="tl-chip" href="${esc(href(view.d, c.theme))}">${esc((data.d.themes.find((t) => t.key === c.theme) || {}).label || c.theme)}</a>${c.amount ? `<b class="ct-amt">${esc(money(c.amount))}</b>` : ''}</p>
          <h3>${esc(c.title)}</h3>
          <p class="ct-sub">${esc(dayFmt(c.first))} to ${esc(dayFmt(c.last))} · ${c.headlines} headline${c.headlines === 1 ? '' : 's'} from ${c.outlets} outlet${c.outlets === 1 ? '' : 's'}</p>
          <p class="ct-latest">${esc(last.title)}</p>
        </summary>
        <ol class="ct-events">${[...c.events].reverse().map((e) => `<li class="k-${e.kind}"><p class="ct-ev-h"><b>${KIND[e.kind]}</b> · ${esc(dayFmt(e.at))}${e.outlets > 1 ? ` · ${e.outlets} outlets` : ''}</p>
          <p class="ct-ev-t"><img src="${esc(fav(hostOf(e.url)))}" alt="" width="14" height="14" loading="lazy" data-fallback="remove"><a href="${esc(e.url)}" target="_blank" rel="noopener">${esc(e.title)}</a> <small>${esc(e.source)}</small></p></li>`).join('')}</ol>
      </details>
    </li>`;
  }

  function page(d) {
    const narrow = innerWidth < 640;
    const list = d.cases.filter((c) => (!view.d || c.defendant.key === view.d) && (!view.t || c.theme === view.t));
    const defLabel = d.defendants.find((x) => x.key === view.d)?.label || list[0]?.defendant.label;
    const thLabel = d.themes.find((t) => t.key === view.t)?.label;
    const big = d.stats.biggest;
    return `<div class="tl-stats">
        <p><b>${d.stats.cases}</b><span>cases in the last year</span></p>
        <p><b>${d.stats.filed30}</b><span>new filings in 30 days</span></p>
        <p><b>${d.stats.settled}</b><span>settled</span></p>
        ${big ? `<p><b>${esc(money(big.amount))}</b><span>largest: ${esc(big.title)}</span></p>` : ''}
      </div>
      <div class="ct-charts">${months(d, narrow)}${matrix(d)}</div>
      <nav class="pd-chips ct-themes" aria-label="Kind of claim"><a class="chip${view.t ? '' : ' on'}" href="${esc(href(view.d, ''))}">All</a>${d.themes.map((t) => `<a class="chip${view.t === t.key ? ' on' : ''}" href="${esc(href(view.d, t.key))}">${esc(t.label)} <small>${t.n}</small></a>`).join('')}</nav>
      <section><h2 class="when">${esc([view.d ? `Cases against ${defLabel}` : 'Cases', thLabel ? thLabel.toLowerCase() : ''].filter(Boolean).join(': '))}<span>${list.length}, latest activity first</span>${view.d || view.t ? `<a class="tl-clear" href="#court">Show all</a>` : ''}</h2>
        <ol class="ct-cases">${list.slice(0, 80).map(caseCard).join('') || '<li class="rail-note">No cases match.</li>'}</ol>
      </section>
      <p class="rail-note">From ${d.headlines} legal headlines in English over the last year. A headline is read for who is sued (the AI company), by whom, and what happened; the same parties make one case, and without a named plaintiff, the same company and kind of claim. Status is the latest decisive event. Amounts are as reported. <a href="/api/court">JSON</a></p>
      <div class="ac-tip ct-tip" role="tooltip" hidden></div>`;
  }

  function render() {
    const site = state.data?.site?.name || 'Frontier Wire';
    const host = $('#courtView');
    document.title = `Courtroom · ${site}`;
    const head = `<header class="topic-head ct-head"><p class="kicker">Courtroom</p><h1>AI on trial</h1>
      <p class="topic-sum">The lawsuits against AI companies, who brought them and over what, and every ruling, dismissal and settlement since.</p></header>`;
    if (state.mode !== 'api') {
      setHtml(host, `${head}<p class="rail-note">The courtroom needs the live server.</p>`);
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
    setHtml(host, `${head}<div class="ct-page${animate ? ' animate' : ''}">${page(d)}</div>`);
  }

  function hover(e) {
    const tip = $('#courtView .ct-tip');
    if (!tip || !data.d) return;
    const col = e.type === 'pointerleave' ? null : e.target.closest?.('.ct-col');
    if (!col) { tip.hidden = true; return; }
    const m = data.d.months[+col.dataset.m];
    setHtml(tip, `<p class="tt-h">${esc(new Date(`${m.m}-15T00:00:00Z`).toLocaleDateString('en', { month: 'long', year: 'numeric' }))}</p>${SERIES.map(([k, l], s) => `<p><i class="ct-sw s${s + 1}"></i>${esc(l)}: <b>${m[k]}</b></p>`).join('')}`);
    tip.hidden = false;
    const host = $('#courtView').getBoundingClientRect();
    const r = col.getBoundingClientRect();
    const w = tip.offsetWidth || 200;
    tip.style.left = `${Math.max(0, Math.min(host.width - w, r.left - host.left + r.width / 2 - w / 2))}px`;
    tip.style.top = `${Math.max(0, r.top - host.top - tip.offsetHeight - 6)}px`;
  }

  return { route, render, hover };
}
