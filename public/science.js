// AI in science (#science?g=<group>&k=<kind>&l=<lab>&e=<id>): a year of AI
// meeting research and medicine. Monthly events stacked by field group with
// hover, the latest discoveries as a timeline, labs by events with how many
// were discoveries, what happened as chips, and event cards with every
// report. Server side: src/index/science.js.

const dayFmt = (t) => new Date(t).toLocaleDateString('en', { month: 'short', day: 'numeric', year: 'numeric' });
const shortDay = (t) => new Date(t).toLocaleDateString('en', { month: 'short', day: 'numeric' });
const monFmt = (m) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en', { month: 'short', timeZone: 'UTC' });
const monLong = (m) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
const fav = (h) => `https://www.google.com/s2/favicons?domain=${encodeURIComponent(h || 'example.com')}&sz=32`;
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const GROUPS = ['life', 'health', 'physics', 'earth'];
const gcolor = (g) => `var(--s${GROUPS.indexOf(g) + 1}c)`;

export function createScience({ $, esc, setHtml, state, reducedMotion }) {
  const view = { g: '', k: '', l: '', e: '' };
  let data = { d: null, error: null, pending: false, at: 0 };
  let drawn = null;
  let scrolled = '';

  function route(hash) {
    const m = /^#science(?:\?(.*))?$/.exec(hash);
    if (!m) return null;
    const p = new URLSearchParams(m[1] || '');
    for (const k of ['g', 'k', 'l']) view[k] = (p.get(k) || '').replace(/[^a-z]/g, '').slice(0, 20);
    view.e = (p.get('e') || '').replace(/[^A-Za-z0-9-]/g, '').slice(0, 80);
    return 'science';
  }

  async function load() {
    if (data.pending || (data.d && Date.now() - data.at < 20 * 60e3) || (data.error && Date.now() - data.at < 20e3)) return;
    data.pending = true;
    try {
      const r = await fetch('/api/science');
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || r.statusText);
      data = { d, at: Date.now() };
    } catch (err) {
      data = { d: data.d, error: err.message, at: Date.now() };
    }
    if (state.view === 'science') render();
  }

  const href = (over = {}) => {
    const v = { ...view, e: '', ...over };
    const p = new URLSearchParams();
    for (const k of ['g', 'k', 'l', 'e']) if (v[k]) p.set(k, v[k]);
    const s = p.toString();
    return `#science${s ? `?${s}` : ''}`;
  };
  const matches = (x) => (!view.g || x.group === view.g) && (!view.k || x.kind === view.k) && (!view.l || x.lab?.key === view.l);

  function columns(d, narrow) {
    const W = narrow ? 360 : 620, H = 210, L = 28, R = 6, T = 10, B = 22;
    const max = Math.max(4, ...d.months.map((m) => m.n));
    const step = max > 40 ? 20 : max > 16 ? 10 : 4;
    const top = Math.ceil(max / step) * step;
    const y = (v) => T + (1 - v / top) * (H - T - B);
    const bw = (W - L - R) / d.months.length;
    const ticks = [];
    for (let v = 0; v <= top; v += step) ticks.push(v);
    const cols = d.months.map((m, i) => {
      let acc = 0;
      const segs = GROUPS.map((g) => {
        const v = m.groups[g];
        if (!v) return '';
        const y1 = y(acc), y0 = y(acc + v);
        acc += v;
        return `<rect class="sc-seg${view.g && view.g !== g ? ' dim' : ''}" style="fill:${gcolor(g)}" x="${(L + i * bw + bw * 0.18).toFixed(1)}" y="${(y0 + 1).toFixed(1)}" width="${(bw * 0.64).toFixed(1)}" height="${Math.max(1, y1 - y0 - 2).toFixed(1)}" rx="2"/>`;
      }).join('');
      return `<g class="sc-col" style="--i:${i}" data-m="${i}">${segs}<rect class="sc-hit" x="${(L + i * bw).toFixed(1)}" y="${T}" width="${bw.toFixed(1)}" height="${H - T - B}"/></g>
        ${i % (narrow ? 2 : 1) === 0 ? `<text class="lc-xt" x="${(L + i * bw + bw / 2).toFixed(1)}" y="${H - 6}" text-anchor="middle">${esc(monFmt(m.m))}</text>` : ''}`;
    }).join('');
    return `<section><h2 class="when">By field<span>events by month; tap the legend to filter</span></h2>
      <ul class="tr-legend">${d.groups.map((g) => `<li style="--c:${gcolor(g.key)}"><a class="sc-leg${view.g === g.key ? ' on' : ''}" href="${esc(href({ g: view.g === g.key ? '' : g.key }))}"><i class="sw"></i>${esc(g.label)}</a></li>`).join('')}</ul>
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(d.months.map((m) => `${monLong(m.m)}: ${plural(m.n, 'event')}`).join('; '))}">
        ${ticks.map((v) => `<g class="lc-tick"><line x1="${L}" x2="${W - R}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/><text x="${L - 6}" y="${y(v).toFixed(1)}" dy="0.32em" text-anchor="end">${v}</text></g>`).join('')}
        ${cols}
      </svg></section>`;
  }

  function discoveries(d) {
    const list = d.discoveries.filter((x) => (!view.g || x.group === view.g) && (!view.l || x.lab?.key === view.l)).slice(0, 8);
    if (!list.length) return '';
    return `<section class="sc-disc"><h2 class="when">Latest discoveries<span>results named by AI labs or carried by two or more outlets</span></h2><ol>${list.map((x, i) => `<li style="--i:${i}; --c:${gcolor(x.group)}"><time>${esc(shortDay(x.at))}</time><div><a href="${esc(href({ e: x.id }))}">${esc(x.title)}</a><small>${esc(d.labels.fields[x.field])}${x.lab ? ` · ${esc(x.lab.label)}` : ''}${x.outlets > 1 ? ` · ${x.outlets} outlets` : ''}</small></div></li>`).join('')}</ol></section>`;
  }

  function labs(d) {
    if (!d.labs.length) return '';
    const max = Math.max(1, ...d.labs.map((l) => l.n));
    return `<section class="sc-labs"><h2 class="when">Labs<span>events in a year, the darker part discoveries; tap to filter</span></h2><ol>${d.labs.map((l, i) => {
      const on = view.l === l.key;
      return `<li style="--i:${i}"><a href="${esc(href({ l: on ? '' : l.key }))}" class="${on ? 'on' : ''}${view.l && !on ? ' dim' : ''}" data-l="${esc(l.key)}">
        <span class="sc-name">${esc(l.label)}</span><span class="sc-bar" style="width:${((100 * l.n) / max).toFixed(1)}%"><i style="width:${((100 * l.discoveries) / l.n).toFixed(1)}%"></i></span><small>${l.n}</small></a></li>`;
    }).join('')}</ol></section>`;
  }

  function card(x, i) {
    const d = data.d;
    return `<li class="sc-card" id="sc-${esc(x.id)}" style="--i:${Math.min(i, 14)}">
      <details${view.e === x.id ? ' open' : ''}>
        <summary>
          <p class="ct-meta"><span class="sc-field" style="--c:${gcolor(x.group)}">${esc(d.labels.fields[x.field])}</span><span class="sc-kind">${esc(d.labels.kinds[x.kind])}</span>${x.lab ? `<a class="tl-chip" href="${esc(href({ l: x.lab.key }))}">${esc(x.lab.label)}</a>` : ''}</p>
          <h3>${esc(x.title)}</h3>
          <p class="ct-sub">${esc(dayFmt(x.at))} · ${plural(x.outlets, 'outlet')}</p>
        </summary>
        <ol class="ct-events">${x.reports.map((e) => `<li><p class="ct-ev-h">${esc(dayFmt(e.at))}</p>
          <p class="ct-ev-t"><img src="${esc(fav(hostOf(e.url)))}" alt="" width="14" height="14" loading="lazy" data-fallback="remove"><a href="${esc(e.url)}" target="_blank" rel="noopener">${esc(e.title)}</a> <small>${esc(e.source)}</small></p></li>`).join('')}</ol>
      </details>
    </li>`;
  }

  function page(d) {
    const narrow = innerWidth < 640;
    const list = d.events.filter(matches);
    list.sort((a, b) => (b.id === view.e) - (a.id === view.e) || b.at - a.at);
    const s = d.stats;
    const change = (a, b) => (b ? `${a >= b ? '+' : '−'}${Math.abs(Math.round(((a - b) / b) * 100))}% on the 90 days before` : 'none in the 90 days before');
    const mp = d.groups.find((g) => g.key === 'physics');
    const labels = [view.g && d.labels.groups[view.g], view.k && d.labels.kinds[view.k], view.l && d.labs.find((l) => l.key === view.l)?.label].filter(Boolean);
    return `<div class="tl-stats">
        <p><b>${s.n90}</b><span>AI-in-science events in the last 90 days (${esc(change(s.n90, s.prev90))})</span></p>
        <p><b>${s.discoveries90}</b><span>discoveries and results claimed in 90 days, ${s.concerns90} concerns</span></p>
        ${mp ? `<p><b>${mp.n90}</b><span>in maths and physics in 90 days, ${mp.prev90} the 90 before</span></p>` : ''}
        ${s.topLab ? `<p><b>${esc(s.topLab.label)}</b><span>named most: ${plural(s.topLab.n, 'event')}</span></p>` : ''}
      </div>
      <div class="sc-top">${columns(d, narrow)}${discoveries(d)}</div>
      ${labs(d)}
      <nav class="pd-chips ct-themes" aria-label="What happened"><a class="chip${view.k ? '' : ' on'}" href="${esc(href({ k: '' }))}">All</a>${d.kinds.filter((k) => k.n).map((k) => `<a class="chip${view.k === k.key ? ' on' : ''}" href="${esc(href({ k: view.k === k.key ? '' : k.key }))}">${esc(k.label)} <small>${k.n}</small></a>`).join('')}</nav>
      <section><h2 class="when">${esc(labels.length ? labels.join(' · ') : 'Events')}<span>${list.length}, newest first${narrow && list.length > 30 ? ', 30 shown' : ''}</span>${labels.length ? '<a class="tl-clear" href="#science">Show all</a>' : ''}</h2>
        <ol class="ct-cases">${list.slice(0, narrow ? 30 : 80).map(card).join('') || '<li class="rail-note">No events match.</li>'}</ol>
      </section>
      <p class="rail-note">From ${d.headlines} English headlines over the last year where AI meets research or medicine. A headline is read for its field, what happened (a discovery or result, a study, a new tool, a deal, a concern) and the lab when one is named; the same thing reported within five days is one event. Results are as claimed in headlines and many aren’t peer reviewed yet; open the reports before relying on one. Robots are on <a href="#robots">Robots</a>. <a href="/api/science">JSON</a></p>
      <div class="ac-tip sc-tip" role="tooltip" hidden></div>`;
  }

  function render() {
    const site = state.data?.site?.name || 'Frontier Wire';
    const host = $('#scienceView');
    document.title = `AI in science · ${site}`;
    const head = `<header class="topic-head sc-head"><p class="kicker">Science</p><h1>AI in science and health</h1>
      <p class="topic-sum">Proteins, proofs, diagnoses and drug candidates: what AI is finding, which labs claim it, and what’s raising concern.</p></header>`;
    if (state.mode !== 'api') {
      setHtml(host, `${head}<p class="rail-note">AI in science needs the live server.</p>`);
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
    setHtml(host, `${head}<div class="sc-page${animate ? ' animate' : ''}">${page(d)}</div>`);
    if (view.e && scrolled !== view.e) {
      scrolled = view.e;
      // After the router's scroll to the top.
      requestAnimationFrame(() => document.getElementById(`sc-${view.e}`)?.scrollIntoView({ block: 'center', behavior: reducedMotion() ? 'auto' : 'smooth' }));
    }
  }

  function hover(e) {
    const tip = $('#scienceView .sc-tip');
    const d = data.d;
    if (!tip || !d) return;
    const t = e.type === 'pointerleave' ? null : e.target;
    const col = t?.closest?.('.sc-col');
    const lab = t?.closest?.('.sc-labs a');
    let html = '';
    let el = null;
    if (col) {
      const m = d.months[+col.dataset.m];
      el = col;
      html = `<p class="tt-h">${esc(monLong(m.m))}</p><p><b>${plural(m.n, 'event')}</b>, ${m.discoveries} discoveries</p>${GROUPS.map((g) => (m.groups[g] ? `<p><i class="sw" style="--c:${gcolor(g)}"></i>${esc(d.labels.groups[g])}: <b>${m.groups[g]}</b></p>` : '')).join('')}`;
    } else if (lab) {
      const l = d.labs.find((x) => x.key === lab.dataset.l);
      if (l) {
        el = lab.querySelector('.sc-bar');
        html = `<p class="tt-h">${esc(l.label)}</p><p><b>${l.n}</b> events, ${l.discoveries} discoveries, ${l.n90} in 90 days</p>${Object.entries(l.fields).sort((a, b) => b[1] - a[1]).map(([k, n]) => `<p>${esc(d.labels.fields[k])}: <b>${n}</b></p>`).join('')}`;
      }
    }
    if (!el) { tip.hidden = true; return; }
    setHtml(tip, html);
    tip.hidden = false;
    const host = $('#scienceView').getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const w = tip.offsetWidth || 200;
    tip.style.left = `${Math.max(0, Math.min(host.width - w, r.left - host.left + r.width / 2 - w / 2))}px`;
    tip.style.top = `${Math.max(0, r.top - host.top - tip.offsetHeight - 8)}px`;
  }

  return { route, render, hover };
}
