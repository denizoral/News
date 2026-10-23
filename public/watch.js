// Watchlists (#watch, #watch?add=<search>): searches kept in this browser
// and what's new for each since you last looked. Each card shows how many
// matches arrived since then, 14 days of matches by day with hover, and the
// newest headlines with the new ones marked; "Mark seen" moves your last look
// to now. Watches are added from the form, from suggestions, or from any
// search page ("Watch this search"). Server side: src/index/watch.js.

const KEY = 'fw.watch';
const MAX = 12;
const ago = (t) => {
  const m = Math.round((Date.now() - t) / 60e3);
  if (m < 60) return `${Math.max(1, m)}m ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
};
const dayLong = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
const SUGGEST = ['"open weights"', 'intitle:Rubin', 'humanoid', '"export controls"', 'Anthropic IPO', 'intitle:GPT-6', '"AI agents" -crypto', 'site:theverge.com OpenAI'];

export function createWatch({ $, esc, setHtml, state, reducedMotion }) {
  let data = { d: null, key: '', error: null, pending: false, at: 0 };
  let animated = false;
  let again = false;

  const read = () => {
    try {
      const v = JSON.parse(localStorage.getItem(KEY));
      return Array.isArray(v) ? v.filter((w) => typeof w?.q === 'string').slice(0, MAX) : [];
    } catch { return []; }
  };
  const write = (list) => {
    try { localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX))); } catch {}
  };
  const norm = (q) => String(q || '').replace(/\s+/g, ' ').trim().slice(0, 100);
  function add(q) {
    q = norm(q);
    if (!q) return false;
    const list = read();
    if (list.some((w) => w.q.toLowerCase() === q.toLowerCase())) return false;
    if (list.length >= MAX) list.pop();
    // A new watch counts the last day as new, so it starts with something to show.
    list.unshift({ q, seen: Date.now() - 86400e3, added: Date.now() });
    write(list);
    return true;
  }

  function route(hash) {
    const m = /^#watch(?:\?(.*))?$/.exec(hash);
    if (!m) return null;
    const a = new URLSearchParams(m[1] || '').get('add');
    if (a) {
      add(a);
      history.replaceState(null, '', '#watch');
    }
    return 'watch';
  }

  async function load(force = false) {
    const list = read();
    const key = list.map((w) => `${w.q}\u0000${w.seen}`).join('\u0001');
    if (!list.length) { data = { d: null, key, at: Date.now() }; return; }
    if (data.pending) { again ||= force; return; }
    if ((!force && data.key === key && data.d && Date.now() - data.at < 2 * 60e3) || (data.error && data.key === key && Date.now() - data.at < 20e3)) return;
    data.pending = true;
    try {
      const p = new URLSearchParams();
      for (const w of list) { p.append('q', w.q); p.append('s', String(w.seen || 0)); }
      const r = await fetch(`/api/watch?${p}`);
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || r.statusText);
      data = { d, key, at: Date.now() };
    } catch (err) {
      data = { d: data.d, key, error: err.message, at: Date.now() };
    }
    if (again) { again = false; return load(true); }
    if (state.view === 'watch') render();
  }

  // Fourteen days of matches as columns; the days after your last look are marked.
  function days(w, seen) {
    const W = 220, H = 46, B = 2;
    const max = Math.max(1, ...w.days.map((d) => d.n));
    const bw = W / w.days.length;
    const seenDay = new Date(seen).toISOString().slice(0, 10);
    return `<svg class="wt-days" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(w.days.map((d) => `${dayLong(d.d)}: ${d.n}`).join('; '))}">
      ${w.days.map((d, i) => {
        const h = (d.n / max) * (H - B - 4);
        return `<g class="wt-day${d.d >= seenDay ? ' new' : ''}" data-q="${esc(w.q)}" data-i="${i}" style="--i:${i}">${d.n ? `<rect x="${(i * bw + bw * 0.15).toFixed(1)}" y="${(H - B - h).toFixed(1)}" width="${(bw * 0.7).toFixed(1)}" height="${Math.max(1, h).toFixed(1)}" rx="1.5"/>` : ''}<rect class="wt-hit" x="${(i * bw).toFixed(1)}" y="0" width="${bw.toFixed(1)}" height="${H}"/></g>`;
      }).join('')}
      <line class="wt-base" x1="0" x2="${W}" y1="${H - B + 0.5}" y2="${H - B + 0.5}"/></svg>`;
  }

  function card(w, mine, i) {
    if (w.error) {
      return `<li class="wt-card err" style="--i:${i}"><div class="wt-h"><h3>${esc(w.q)}</h3><button type="button" class="wt-x" data-wremove="${esc(w.q)}" aria-label="Stop watching ${esc(w.q)}">✕</button></div><p class="rail-note">${esc(w.error)}</p></li>`;
    }
    const searchHref = `#search?q=${encodeURIComponent(w.q).replace(/%20/g, '%20')}`;
    return `<li class="wt-card${w.fresh ? ' has-new' : ''}" style="--i:${i}">
      <div class="wt-h"><h3><a href="${esc(searchHref)}">${esc(w.q)}</a></h3>
        <span class="wt-new${w.fresh ? '' : ' none'}">${w.fresh ? `<b>${w.fresh.toLocaleString('en')}</b> new` : 'Nothing new'}</span>
        <button type="button" class="wt-x" data-wremove="${esc(w.q)}" aria-label="Stop watching ${esc(w.q)}">✕</button></div>
      <p class="wt-sub">${w.total.toLocaleString('en')} in 14 days · last look ${esc(ago(mine?.seen || Date.now()))}</p>
      ${days(w, mine?.seen || Date.now())}
      ${w.items.length ? `<ol class="wt-items">${w.items.slice(0, 5).map((it) => `<li class="${it.fresh ? 'fresh' : ''}"><a href="${esc(it.url)}" target="_blank" rel="noopener">${esc(it.title)}</a><small>${it.fresh ? '<span class="wt-dot" aria-label="New"></span>' : ''}${esc(it.source || '')} · ${esc(ago(it.at))}</small></li>`).join('')}</ol>` : '<p class="rail-note">No matches in the last 14 days.</p>'}
      <p class="wt-acts">${w.fresh ? `<button type="button" class="wt-btn" data-wseen="${esc(w.q)}">Mark seen</button>` : ''}<a class="wt-btn ghost" href="${esc(searchHref)}">All results</a></p>
    </li>`;
  }

  function form(list) {
    const left = SUGGEST.filter((s) => !list.some((w) => w.q.toLowerCase() === s.toLowerCase())).slice(0, 6);
    return `<form class="wt-form" data-wform autocomplete="off">
        <label for="wt-q">Watch a search</label>
        <div class="wt-row"><input id="wt-q" name="q" type="search" maxlength="100" placeholder="A company, a model, a phrase in quotes…" ${list.length >= MAX ? 'disabled' : ''}><button type="submit" class="wt-btn"${list.length >= MAX ? ' disabled' : ''}>Watch</button></div>
        <p class="wt-hint">${list.length >= MAX ? `You’re watching the most there’s room for (${MAX}). Remove one to add another.` : 'Works like site search: "exact phrase", -leave out, OR, intitle:, site:. Kept in this browser.'}</p>
      </form>
      ${left.length && list.length < MAX ? `<p class="wt-sugg"><span>Try</span>${left.map((s) => `<button type="button" class="chip" data-wadd="${esc(s)}">${esc(s)}</button>`).join('')}</p>` : ''}`;
  }

  function render() {
    const site = state.data?.site?.name || 'Frontier Wire';
    const host = $('#watchView');
    const list = read();
    const fresh = data.d?.watches?.reduce((a, w) => a + (w.fresh || 0), 0) || 0;
    document.title = `${fresh ? `(${fresh > 999 ? '999+' : fresh}) ` : ''}Watchlist · ${site}`;
    const head = `<header class="topic-head wt-head"><p class="kicker">Watchlist</p><h1>Your watchlist</h1>
      <p class="topic-sum">Keep any search and see what’s new since you last looked: a company, a model, a phrase, an outlet.</p></header>`;
    if (state.mode !== 'api') {
      setHtml(host, `${head}<p class="rail-note">Watchlists need the live server.</p>`);
      return;
    }
    load();
    let body;
    if (!list.length) body = '<p class="wt-empty">Nothing watched yet. Add a search above, or open any search and choose “Watch this search”.</p>';
    else if (!data.d) body = data.error ? `<p class="rail-note">${esc(data.error)}</p>` : '<i class="skeleton" style="height:260px;display:block;margin:16px 0;border-radius:12px"></i>';
    else {
      const byQ = new Map(list.map((w) => [w.q.toLowerCase(), w]));
      const watches = data.d.watches.filter((w) => byQ.has(w.q.toLowerCase()));
      body = `${fresh ? `<p class="wt-all"><b>${fresh.toLocaleString('en')}</b> new across your watches <button type="button" class="wt-btn ghost" data-wseen="*">Mark all seen</button></p>` : ''}
        <ol class="wt-list">${watches.map((w, i) => card(w, byQ.get(w.q.toLowerCase()), i)).join('')}</ol>`;
    }
    const animate = !animated && !reducedMotion() && !!data.d;
    if (data.d) animated = true;
    setHtml(host, `${head}${form(list)}<div class="wt-page${animate ? ' animate' : ''}">${body}</div>
      <p class="rail-note">Matches are headlines and summaries of articles and posts from the last 14 days. “New” counts what arrived after your last look at each watch, to within ten minutes. Your watches never leave this browser except as the searches themselves. <a href="/api/watch?q=%22open%20weights%22">JSON</a></p>
      <div class="ac-tip wt-tip" role="tooltip" hidden></div>`);
  }

  function onSubmit(e) {
    if (!e.target.matches?.('[data-wform]')) return false;
    e.preventDefault();
    if (add(e.target.q.value)) {
      e.target.q.value = '';
      load(true);
    }
    render();
    return true;
  }

  function onClick(e) {
    const a = e.target.closest('[data-wadd]');
    const rm = e.target.closest('[data-wremove]');
    const seen = e.target.closest('[data-wseen]');
    if (a) {
      add(a.dataset.wadd);
      load(true);
      render();
    } else if (rm) {
      write(read().filter((w) => w.q !== rm.dataset.wremove));
      render();
    } else if (seen) {
      const q = seen.dataset.wseen;
      write(read().map((w) => (q === '*' || w.q === q ? { ...w, seen: Date.now() } : w)));
      load(true);
      render();
    }
  }

  function hover(e) {
    const tip = $('#watchView .wt-tip');
    const d = data.d;
    if (!tip || !d) return;
    const t = e.type === 'pointerleave' ? null : e.target;
    const day = t?.closest?.('.wt-day');
    const w = day && d.watches.find((x) => x.q === day.dataset.q);
    const x = w?.days?.[+day.dataset.i];
    if (!x) { tip.hidden = true; return; }
    setHtml(tip, `<p class="tt-h">${esc(dayLong(x.d))}</p><p><b>${x.n.toLocaleString('en')}</b> ${x.n === 1 ? 'match' : 'matches'}</p>`);
    tip.hidden = false;
    const host = $('#watchView').getBoundingClientRect();
    const r = day.getBoundingClientRect();
    const tw = tip.offsetWidth || 120;
    tip.style.left = `${Math.max(0, Math.min(host.width - tw, r.left - host.left + r.width / 2 - tw / 2))}px`;
    tip.style.top = `${Math.max(0, r.top - host.top - tip.offsetHeight - 8)}px`;
  }

  return { route, render, onSubmit, onClick, hover };
}
