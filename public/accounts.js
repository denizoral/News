// X account pages: #accounts (every account, ranked by how often it's ahead of
// the press), #account/<handle> (cadence, posting hours, topics, the posts
// that led the news) and #account/<a>/vs/<b> (two side by side).
// Server side: src/index/accounts.js.

const GROUPS = [['all', 'All'], ['lab', 'Labs'], ['people', 'People'], ['scoops', 'Scoops'], ['markets', 'Markets']];
const SORTS = [['ahead', 'Ahead of the press'], ['posts', 'Most active'], ['stories', 'In stories']];
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const GROUP_NAME = { lab: 'Lab', people: 'Person', scoops: 'Scoops', markets: 'Markets' };

export function createAccounts({ $, esc, time, setHtml, store, state, reducedMotion, followBtn }) {
  const dir = { data: null, error: null, pending: false, at: 0 };
  const cache = new Map(); // 'h' or 'a|b' -> { data, error, pending, at }
  const view = { handle: null, vs: null, group: store.get('fw.acgroup', 'all'), sort: store.get('fw.acsort', 'ahead') };
  const shown = new Set();

  const lead = (m) => (m == null ? '' : m < 60 ? `${m} min` : m < 24 * 60 ? `${Math.floor(m / 60)}h${m % 60 >= 10 ? ` ${m % 60}m` : ''}` : `${Math.round(m / 60)}h`);
  const narrow = () => innerWidth < 640;
  const href = (h) => `#account/${encodeURIComponent(h)}`;

  function route(hash) {
    const m = /^#account\/(\w{1,15})(?:\/vs\/(\w{1,15}))?$/.exec(hash);
    if (m) {
      view.handle = m[1];
      view.vs = m[2] || null;
      return 'account';
    }
    if (hash === '#accounts') return 'accounts';
    return null;
  }

  async function get(url, entry, done) {
    if (entry.pending || (entry.data && Date.now() - entry.at < 120e3) || (entry.error && Date.now() - entry.at < 30e3)) return;
    entry.pending = true;
    try {
      const r = await fetch(url);
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || r.statusText);
      entry.data = d;
      entry.error = null;
    } catch (err) {
      entry.error = err.message;
    }
    entry.at = Date.now();
    entry.pending = false;
    done();
  }
  const loadDir = () => get('/api/accounts', dir, () => state.view === 'accounts' && renderDirectory());
  function loadAccount(h, vs) {
    const k = vs ? `${h.toLowerCase()}|${vs.toLowerCase()}` : h.toLowerCase();
    if (!cache.has(k)) cache.set(k, { data: null });
    const entry = cache.get(k);
    get(`/api/account?handle=${encodeURIComponent(h)}${vs ? `&vs=${encodeURIComponent(vs)}` : ''}`, entry, () => state.view === 'account' && view.handle === h && view.vs === vs && renderAccount());
    return entry;
  }

  // ---- Small charts ----
  function sparkBars(values, { w = 84, h = 22 } = {}) {
    const max = Math.max(1, ...values);
    const bw = w / values.length;
    return `<svg class="ac-spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true">${values.map((v, i) => {
      const bh = v ? Math.max(2, (v / max) * (h - 1)) : 1;
      return `<rect x="${(i * bw + 0.5).toFixed(1)}" y="${(h - bh).toFixed(1)}" width="${Math.max(1, bw - 1.5).toFixed(1)}" height="${bh.toFixed(1)}" rx="1"${v ? '' : ' class="z"'}/>`;
    }).join('')}</svg>`;
  }

  const niceMax = (v) => {
    if (v <= 4) return 4;
    const p = 10 ** Math.floor(Math.log10(v));
    return [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].map((m) => m * p).find((m) => m >= v);
  };
  const dayLabel = (day, o = { month: 'short', day: 'numeric' }) => new Date(`${day}T12:00:00Z`).toLocaleDateString(undefined, o);
  // Bar top with 4px rounded corners, square at the baseline.
  const barPath = (x, y, bw, bh) => {
    const r = Math.min(4, bw / 2, bh);
    return `M${x},${y + bh}V${y + r}Q${x},${y} ${x + r},${y}H${x + bw - r}Q${x + bw},${y} ${x + bw},${y + r}V${y + bh}Z`;
  };

  // Posts per day over the window; `max` shares one scale between two accounts.
  function dailyChart(daily, { max = null, animate = false, label = '', wide = false } = {}) {
    const w = narrow() ? 360 : wide ? 1000 : 640, h = narrow() ? 150 : wide ? 180 : 160;
    const pad = { l: 28, r: 6, t: 10, b: 22 };
    const top = niceMax(max ?? Math.max(1, ...daily.map((d) => d.n)));
    const iw = w - pad.l - pad.r, ih = h - pad.t - pad.b;
    const slot = iw / daily.length;
    const bw = Math.max(2, slot - 2);
    const y = (v) => pad.t + ih - (v / top) * ih;
    const ticks = [0, top / 2, top];
    const bars = daily.map((d, i) => {
      const x = pad.l + i * slot + (slot - bw) / 2;
      const bh = (d.n / top) * ih;
      const tip = `${dayLabel(d.day, { weekday: 'short', month: 'short', day: 'numeric' })}: ${d.n} post${d.n === 1 ? '' : 's'}`;
      return `<g class="hit" data-tip="${esc(tip)}"><rect x="${(pad.l + i * slot).toFixed(1)}" y="${pad.t}" width="${slot.toFixed(1)}" height="${ih}" fill="transparent"/>${d.n ? `<path class="bar" style="--i:${i}" d="${barPath(+x.toFixed(1), +y(d.n).toFixed(1), +bw.toFixed(1), +bh.toFixed(1))}"/>` : ''}</g>`;
    }).join('');
    const xl = [0, Math.floor(daily.length / 2), daily.length - 1].map((i) => `<text class="ax" x="${(pad.l + i * slot + slot / 2).toFixed(1)}" y="${h - 6}" text-anchor="${i === 0 ? 'start' : i === daily.length - 1 ? 'end' : 'middle'}">${esc(dayLabel(daily[i].day))}</text>`).join('');
    return `<figure class="ac-chart${animate ? ' animate' : ''}"><svg viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(label || 'Posts per day')}">
      ${ticks.map((t) => `<line class="grid" x1="${pad.l}" x2="${w - pad.r}" y1="${y(t).toFixed(1)}" y2="${y(t).toFixed(1)}"/><text class="ax" x="${pad.l - 6}" y="${(y(t) + 4).toFixed(1)}" text-anchor="end">${t}</text>`).join('')}
      ${bars}${xl}</svg></figure>`;
  }

  // Posting hours in the reader's time zone: 7 days × 24 hours.
  function heatmap(grid) {
    const off = -new Date().getTimezoneOffset() / 60; // hours ahead of UTC
    const local = Array.from({ length: 7 }, () => new Array(24).fill(0));
    grid.forEach((row, d) => row.forEach((n, hr) => {
      const t = (((d * 24 + hr + Math.round(off)) % 168) + 168) % 168;
      local[Math.floor(t / 24)][t % 24] += n;
    }));
    const max = Math.max(1, ...local.flat());
    const cell = narrow() ? 12 : 11, gap = 2, padL = 30, padT = 4;
    const w = padL + 24 * (cell + gap), h = padT + 7 * (cell + gap) + 16;
    const hourName = (hr) => new Date(2026, 0, 1, hr).toLocaleTimeString(undefined, { hour: 'numeric' });
    const cells = local.map((row, d) => row.map((n, hr) => {
      const lvl = n ? Math.max(1, Math.ceil((n / max) * 4)) : 0;
      return `<rect class="hm l${lvl}" x="${padL + hr * (cell + gap)}" y="${padT + d * (cell + gap)}" width="${cell}" height="${cell}" rx="2" data-tip="${esc(`${DAYS[d]} ${hourName(hr)}: ${n} post${n === 1 ? '' : 's'}`)}"/>`;
    }).join('')).join('');
    const days = DAYS.map((name, d) => `<text class="ax" x="${padL - 6}" y="${padT + d * (cell + gap) + cell - 2}" text-anchor="end">${name}</text>`).join('');
    const hours = [0, 6, 12, 18].map((hr) => `<text class="ax" x="${padL + hr * (cell + gap)}" y="${h - 2}">${esc(hourName(hr))}</text>`).join('');
    return `<figure class="ac-heat"><svg viewBox="0 0 ${w} ${h}" role="img" aria-label="Posts by weekday and hour, your time">${cells}${days}${hours}</svg>
      <figcaption><span>Fewer</span>${[0, 1, 2, 3, 4].map((l) => `<i class="hm l${l}"></i>`).join('')}<span>More</span><span class="tz">your time</span></figcaption></figure>`;
  }

  // Share of posts naming each company or theme.
  function shareBars(items) {
    if (!items.length) return '<p class="rail-note">No names come up often enough.</p>';
    const max = Math.max(...items.map((x) => x.count));
    return `<ul class="ac-bars">${items.map((x) => `<li><a href="#topic/${esc(x.key)}">${esc(x.label)}</a><span class="track"><i style="transform:scaleX(${(x.count / max).toFixed(3)})"></i></span><b>${Math.round(x.share * 100)}%</b></li>`).join('')}</ul>`;
  }

  // ---- Directory ----
  function rowHtml(a, i, max) {
    return `<li data-id="${esc(a.handle)}" style="--i:${Math.min(i, 14)}">
      <img class="ac-av" src="${esc(a.avatar || '')}" alt="" width="40" height="40" loading="lazy" data-fallback="remove">
      <div class="ac-who"><a class="ac-name" href="${href(a.handle)}">${esc(a.name)}</a><span class="tl-meta">@${esc(a.handle)} · ${esc(GROUP_NAME[a.group] || '')}${a.top.length ? ` · ${esc(a.top.join(', '))}` : ''}</span></div>
      <div class="ac-lead" title="Posts the press reported only later">
        <span class="track"><i style="transform:scaleX(${max ? (a.ahead / max).toFixed(3) : 0})"></i></span>
        <b>${a.ahead}</b><small>${a.ahead ? `ahead · median ${lead(a.medianLeadMin)}` : 'ahead'}</small>
      </div>
      <div class="ac-act">${sparkBars(a.spark)}<small>${a.posts} posts</small></div>
      ${followBtn('account', a.handle, a.name, { small: true })}
    </li>`;
  }

  function renderDirectory() {
    document.title = `X accounts · ${state.data?.site?.name || 'Frontier Wire'}`;
    loadDir();
    const d = dir.data;
    const animate = !!d && !shown.has('dir') && !reducedMotion();
    if (d) shown.add('dir');
    let list = (d?.accounts || []).filter((a) => view.group === 'all' || a.group === view.group);
    const key = { ahead: (a) => a.ahead * 1000 + a.aheadRate * 100, posts: (a) => a.posts, stories: (a) => a.inStories }[view.sort];
    list = [...list].sort((a, b) => key(b) - key(a));
    const max = Math.max(0, ...list.map((a) => a.ahead));
    const totalAhead = (d?.accounts || []).reduce((s, a) => s + a.ahead, 0);
    setHtml($('#accountsView'), `
      <header class="topic-head">
        <a class="back" href="#x">← On X</a>
        <p class="kicker">X accounts</p>
        <h1>Who’s first on X</h1>
        <p class="topic-sum">${d ? `${d.accounts.length} accounts over ${d.days} days. ${totalAhead} posts were ahead of the press: outlets reported the same thing only afterwards.` : dir.error ? `Accounts are unavailable: ${esc(dir.error)}` : 'Reading every post against the coverage that followed…'}</p>
      </header>
      <div class="ac-bar">
        <div class="chips chips-quiet" role="group" aria-label="Group">${GROUPS.map(([k, l]) => `<button class="chip" type="button" data-acgroup="${k}" aria-pressed="${view.group === k}">${l}</button>`).join('')}</div>
        <div class="chips chips-quiet" role="group" aria-label="Sort">${SORTS.map(([k, l]) => `<button class="chip" type="button" data-acsort="${k}" aria-pressed="${view.sort === k}">${l}</button>`).join('')}</div>
      </div>
      ${d ? `<ol class="ac-list${animate ? ' animate' : ''}">${list.map((a, i) => rowHtml(a, i, max)).join('')}</ol>` : '<div class="topic-chart loading" aria-busy="true"><i class="skeleton"></i></div>'}
      <p class="rail-note ac-note">“Ahead” compares each post with articles published from six hours before it to a day after. When stories that say the same thing (by sentence meaning) only appear afterwards, the post led them. Reddit and Hacker News relay links, so they don’t count as the press.</p>`);
  }

  // ---- One account ----
  function postHtml(p, { showLead = true } = {}) {
    const a = p.ahead;
    const meta = [
      a && showLead ? `<span class="ac-ahead">${lead(a.leadMin)} ahead</span> of <a href="${esc(a.first.url)}" target="_blank" rel="noopener">${esc(a.first.source)}</a>${a.followers > 1 ? ` and ${a.followers - 1} more` : ''}` : null,
      p.story?.sources > 1 ? `<a href="#story/${encodeURIComponent(p.story.sid)}">In a story with ${p.story.sources} sources</a>` : p.story ? `<a href="#story/${encodeURIComponent(p.story.sid)}">In the feed</a>` : null,
      `<a href="${esc(p.url)}" target="_blank" rel="noopener">${time(p.at)}</a>`,
    ].filter(Boolean).join(' · ');
    return `<li data-id="${esc(p.url)}"><p>${esc(p.text)}</p><p class="tl-meta">${meta}</p></li>`;
  }

  function statTiles(s) {
    const peak = s.peak ? (() => {
      const off = -new Date().getTimezoneOffset() / 60;
      const t = (((s.peak.weekday * 24 + s.peak.hour + Math.round(off)) % 168) + 168) % 168;
      return `${DAYS[Math.floor(t / 24)]} ${new Date(2026, 0, 1, t % 24).toLocaleTimeString(undefined, { hour: 'numeric' })}`;
    })() : '—';
    return `<dl class="ac-stats">
      <div><dt>Posts</dt><dd>${s.posts}</dd><small>${s.perDay} a day</small></div>
      <div><dt>Ahead of the press</dt><dd>${s.ahead}</dd><small>${s.ahead ? `median lead ${lead(s.medianLeadMin)}` : 'none in 30 days'}</small></div>
      <div><dt>In live stories</dt><dd>${s.inStories}</dd><small>${s.posts ? Math.round((s.inStories / s.posts) * 100) : 0}% of posts</small></div>
      <div><dt>Busiest</dt><dd class="sm">${esc(peak)}</dd><small>last post ${time(s.lastAt)}</small></div>
    </dl>`;
  }

  function compareSelect(handle) {
    const others = (dir.data?.accounts || []).filter((a) => a.handle.toLowerCase() !== handle.toLowerCase());
    if (!others.length) return '';
    return `<label class="ac-vs"><span>Compare with</span><select data-acvs="${esc(handle)}"><option value="">Choose…</option>${others.map((a) => `<option value="${esc(a.handle)}"${view.vs === a.handle ? ' selected' : ''}>@${esc(a.handle)}</option>`).join('')}</select></label>`;
  }

  function headHtml(a, { back = '#accounts', kicker = null } = {}) {
    return `<header class="topic-head ac-head">
      <a class="back" href="${back}">← ${back === '#accounts' ? 'All accounts' : 'Back'}</a>
      <div class="ac-id">
        <img class="ac-av lg" src="${esc(a.avatar || '')}" alt="" width="64" height="64" data-fallback="remove">
        <div>
          <p class="kicker">${kicker || esc(GROUP_NAME[a.group] || 'X account')}</p>
          <h1>${esc(a.name)}</h1>
          <p class="topic-sum"><a href="https://x.com/${encodeURIComponent(a.handle)}" target="_blank" rel="noopener">@${esc(a.handle)} on X ↗</a> · <a href="#x" data-xopen="${esc(a.handle)}">Latest posts</a></p>
        </div>
        <div class="ac-tools">${followBtn('account', a.handle, a.name)}${compareSelect(a.handle)}</div>
      </div>
    </header>`;
  }

  function renderOne(a, animate) {
    const ahead = a.ahead.length ? `<ol class="ac-posts">${a.ahead.map((p) => postHtml(p)).join('')}</ol>` : '<p class="rail-note">None of this account’s posts in the last 30 days came before the press covered the same thing.</p>';
    const best = a.best.filter((p) => !p.ahead);
    return `${headHtml(a)}
      ${statTiles(a.stats)}
      <section class="topic-card"><h2>Posts per day <small>last ${a.days} days</small></h2>${dailyChart(a.daily, { animate, wide: true, label: `${a.name}: posts per day, last ${a.days} days` })}</section>
      <div class="topic-grid">
        <div class="ac-main">
          <section class="topic-timeline"><h2>Ahead of the press</h2>${ahead}</section>
          ${best.length ? `<section class="topic-timeline"><h2>Most picked up</h2><ol class="ac-posts">${best.map((p) => postHtml(p)).join('')}</ol></section>` : ''}
          <section class="topic-timeline"><h2>Latest</h2><ol class="ac-posts">${a.recent.map((p) => postHtml(p)).join('')}</ol></section>
        </div>
        <aside class="topic-side">
          <section><h2>When they post</h2>${heatmap(a.grid)}</section>
          <section><h2>Talks about <small>share of posts</small></h2>${shareBars(a.entities)}</section>
          ${a.mentions.length ? `<section><h2>Mentions most</h2><ul class="ac-mentions">${a.mentions.map((m) => `<li><a href="${href(m.handle)}">@${esc(m.handle)}</a><small>${m.n}</small></li>`).join('')}</ul></section>` : ''}
        </aside>
      </div>`;
  }

  // Shared names as a butterfly: one account to the left, the other to the right.
  function butterfly(c) {
    if (!c.shared.length) return '<p class="rail-note">They don’t talk about the same companies.</p>';
    const max = Math.max(...c.shared.map((s) => Math.max(s.a / c.a.stats.posts, s.b / c.b.stats.posts)));
    const pct = (n, of) => Math.round((n / of) * 100);
    return `<div class="ac-fly"><div class="ac-fly-head"><span>@${esc(c.a.handle)}</span><span></span><span>@${esc(c.b.handle)}</span></div>${c.shared.slice(0, 8).map((s) => {
      const l = s.a / c.a.stats.posts / max, r = s.b / c.b.stats.posts / max;
      return `<div class="ac-fly-row"><span class="track l"><i style="transform:scaleX(${l.toFixed(3)})"></i><b>${pct(s.a, c.a.stats.posts)}%</b></span><a href="#topic/${esc(s.key)}">${esc(s.label)}</a><span class="track r"><i style="transform:scaleX(${r.toFixed(3)})"></i><b>${pct(s.b, c.b.stats.posts)}%</b></span></div>`;
    }).join('')}</div>`;
  }

  function renderCompare(c, animate) {
    const max = Math.max(1, ...c.a.daily.map((d) => d.n), ...c.b.daily.map((d) => d.n));
    const row = (label, fa, fb, better) => {
      const va = fa(c.a), vb = fb(c.b);
      const w = better ? better(c.a, c.b) : 0;
      return `<tr><th scope="row">${label}</th><td class="${w > 0 ? 'win' : ''}">${va}</td><td class="${w < 0 ? 'win' : ''}">${vb}</td></tr>`;
    };
    const s = (k) => (x) => x.stats[k];
    const cmp = (k, lowWins = false) => (A, B) => {
      const a = A.stats[k], b = B.stats[k];
      if (a == null || b == null || a === b) return 0;
      return (a > b) !== lowWins ? 1 : -1;
    };
    return `<header class="topic-head ac-head">
        <a class="back" href="${href(c.a.handle)}">← @${esc(c.a.handle)}</a>
        <p class="kicker">Compare</p>
        <h1 class="ac-vs-title"><img class="ac-av" src="${esc(c.a.avatar || '')}" alt="" width="40" height="40" data-fallback="remove">${esc(c.a.name)} <span>vs</span> <img class="ac-av" src="${esc(c.b.avatar || '')}" alt="" width="40" height="40" data-fallback="remove">${esc(c.b.name)}</h1>
        <p class="topic-sum">Last ${c.a.days} days. <a href="${href(c.b.handle)}/vs/${encodeURIComponent(c.a.handle)}">Swap sides</a></p>
      </header>
      <div class="topic-grid ac-cmp">
        <div>
          <section class="topic-card"><h2>@${esc(c.a.handle)} <small>posts per day</small></h2>${dailyChart(c.a.daily, { max, animate, label: `${c.a.name}: posts per day` })}</section>
          <section class="topic-card"><h2>@${esc(c.b.handle)} <small>posts per day, same scale</small></h2>${dailyChart(c.b.daily, { max, animate, label: `${c.b.name}: posts per day` })}</section>
          <section class="topic-card"><h2>Both talk about <small>share of each account’s posts</small></h2>${butterfly(c)}</section>
        </div>
        <aside class="topic-side">
          <section><h2>Head to head</h2><table class="ac-table"><thead><tr><th></th><th scope="col">@${esc(c.a.handle)}</th><th scope="col">@${esc(c.b.handle)}</th></tr></thead><tbody>
            ${row('Posts', s('posts'), s('posts'), cmp('posts'))}
            ${row('Per day', s('perDay'), s('perDay'), cmp('perDay'))}
            ${row('Ahead of the press', s('ahead'), s('ahead'), cmp('ahead'))}
            ${row('Median lead', (x) => lead(x.stats.medianLeadMin) || '—', (x) => lead(x.stats.medianLeadMin) || '—', cmp('medianLeadMin'))}
            ${row('In live stories', s('inStories'), s('inStories'), cmp('inStories'))}
            ${row('Days active', s('activeDays'), s('activeDays'), cmp('activeDays'))}
          </tbody></table></section>
          ${[c.a, c.b].map((x) => x.ahead.length ? `<section><h2>@${esc(x.handle)} led with</h2><ol class="ac-posts sm">${x.ahead.slice(0, 3).map((p) => postHtml(p)).join('')}</ol></section>` : '').join('')}
        </aside>
      </div>`;
  }

  function renderAccount() {
    const { handle, vs } = view;
    const entry = loadAccount(handle, vs);
    if (!dir.data) loadDir();
    const d = entry.data;
    const k = vs ? `${handle}|${vs}` : handle;
    const animate = !!d && !shown.has(k) && !reducedMotion();
    if (d) shown.add(k);
    document.title = `${vs ? `@${handle} vs @${vs}` : d?.name || `@${handle}`} · ${state.data?.site?.name || 'Frontier Wire'}`;
    const body = d ? (vs ? renderCompare(d, animate) : renderOne(d, animate))
      : `<header class="topic-head"><a class="back" href="#accounts">← All accounts</a><p class="kicker">X account</p><h1>@${esc(handle)}${vs ? ` vs @${esc(vs)}` : ''}</h1><p class="topic-sum">${entry.error ? esc(entry.error) : 'Reading 30 days of posts…'}</p></header>${entry.error ? '' : '<div class="topic-chart loading" aria-busy="true"><i class="skeleton"></i></div>'}`;
    setHtml($('#accountView'), `${body}<div class="ac-tip" role="tooltip" hidden></div>`);
  }

  // Tooltips on bars and heatmap cells (text only).
  function hover(e) {
    const tip = $('#accountView .ac-tip');
    if (!tip) return;
    const t = e.type === 'pointerleave' ? null : e.target.closest?.('[data-tip]');
    if (!t) { tip.hidden = true; return; }
    tip.textContent = t.dataset.tip;
    tip.hidden = false;
    const box = $('#accountView').getBoundingClientRect();
    const r = t.getBoundingClientRect();
    const x = Math.min(box.width - tip.offsetWidth - 4, Math.max(4, r.left - box.left + r.width / 2 - tip.offsetWidth / 2));
    tip.style.transform = `translate(${x}px, ${r.top - box.top - tip.offsetHeight - 8}px)`;
  }

  function onClick(t) {
    const d = t.dataset;
    if (d.acgroup) { view.group = d.acgroup; store.set('fw.acgroup', d.acgroup); renderDirectory(); return true; }
    if (d.acsort) { view.sort = d.acsort; store.set('fw.acsort', d.acsort); renderDirectory(); return true; }
    return false;
  }

  function onChange(el) {
    if (el.dataset.acvs == null) return false;
    if (el.value) location.hash = `${href(el.dataset.acvs)}/vs/${encodeURIComponent(el.value)}`;
    return true;
  }

  return { route, renderDirectory, renderAccount, hover, onClick, onChange };
}
