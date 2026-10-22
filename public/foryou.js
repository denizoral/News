// "For you": follows kept in this browser, a Follow button for every page that
// has something to follow (topics, names, X accounts, outlets), and #foryou,
// the live feed ranked for them. Server side: src/index/foryou.js.

const KINDS = { topic: 'topics', name: 'names', account: 'accounts', outlet: 'outlets' };
const PARAM = { topics: 't', names: 'n', accounts: 'a', outlets: 'o' };
const TITLES = { topics: 'Topics', names: 'Names', accounts: 'X accounts', outlets: 'Outlets' };
const MAX_PER_KIND = 30;

export function createForYou({ $, $$, esc, time, setHtml, store, state, reducedMotion, toast, savedSids }) {
  // { topics: [{ key, label }], names: [...], accounts: [...], outlets: [...] }
  const load = () => {
    const raw = store.get('fw.follows', {}) || {};
    return Object.fromEntries(Object.values(KINDS).map((k) => [k, Array.isArray(raw[k]) ? raw[k].filter((x) => x?.key).slice(0, MAX_PER_KIND) : []]));
  };
  let follows = load();
  const page = { key: null, data: null, error: null, pending: false, at: 0 };
  let suggest = null; // { at, data }
  let shown = null;

  const count = () => Object.values(follows).reduce((s, l) => s + l.length, 0);
  const has = (kind, key) => follows[KINDS[kind]].some((x) => x.key.toLowerCase() === String(key).toLowerCase());

  function toggle(kind, key, label) {
    const list = KINDS[kind];
    if (!list) return false;
    const on = !has(kind, key);
    if (on && follows[list].length >= MAX_PER_KIND) {
      toast?.(`You can follow up to ${MAX_PER_KIND} ${TITLES[list].toLowerCase()}`);
      return has(kind, key);
    }
    follows[list] = on ? [...follows[list], { key, label: label || key }] : follows[list].filter((x) => x.key.toLowerCase() !== String(key).toLowerCase());
    store.set('fw.follows', follows);
    page.key = null; // refetch
    sync();
    return on;
  }

  // A Follow button; every copy on the page stays in step (sync()).
  function btn(kind, key, label, { small = false } = {}) {
    const on = has(kind, key);
    return `<button type="button" class="follow-btn${small ? ' sm' : ''}" data-follow="${kind}" data-fkey="${esc(key)}" data-flabel="${esc(label || key)}" aria-pressed="${on}" title="${on ? 'Following' : 'Follow'} ${esc(label || key)}"><i aria-hidden="true"></i><span>${on ? 'Following' : 'Follow'}</span></button>`;
  }

  function sync() {
    for (const b of $$('[data-follow]')) {
      const on = has(b.dataset.follow, b.dataset.fkey);
      if (b.getAttribute('aria-pressed') === String(on)) continue;
      b.setAttribute('aria-pressed', String(on));
      b.title = `${on ? 'Following' : 'Follow'} ${b.dataset.flabel}`;
      const span = b.querySelector('span');
      if (span) span.textContent = on ? 'Following' : 'Follow';
      if (on && !reducedMotion()) {
        b.classList.remove('pop');
        void b.offsetWidth;
        b.classList.add('pop');
      }
    }
    const n = count();
    const tab = $('.tabs a[data-view="foryou"]');
    if (tab) tab.dataset.count = n ? String(n) : '';
  }

  // ---- Data ----
  const query = () => {
    const p = new URLSearchParams();
    for (const [list, k] of Object.entries(PARAM)) if (follows[list].length) p.set(k, follows[list].map((x) => x.key).join(','));
    const s = savedSids();
    if (s.length) p.set('s', s.slice(0, 60).join(','));
    return p.toString();
  };

  async function fetchFeed() {
    const key = `${query()}|${state.data?.version || 0}`;
    if (page.pending || page.key === key) return;
    if (!count() && !savedSids().length) {
      page.key = key;
      page.data = null;
      return;
    }
    page.pending = true;
    try {
      const r = await fetch(`/api/foryou?${query()}`);
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || r.statusText);
      page.data = d;
      page.error = null;
    } catch (err) {
      page.error = err.message;
    }
    page.key = key;
    page.pending = false;
    if (state.view === 'foryou') renderPage();
  }

  async function fetchSuggest() {
    if (suggest?.pending || (suggest?.data && Date.now() - suggest.at < 5 * 60e3)) return;
    suggest = { ...suggest, pending: true };
    try {
      const r = await fetch('/api/follow/suggest');
      suggest = { at: Date.now(), data: r.ok ? await r.json() : null };
    } catch {
      suggest = { at: Date.now(), data: null };
    }
    if (state.view === 'foryou') renderPage();
  }

  // ---- Page ----
  const whyHtml = (w) => `<span class="fy-why k-${w.kind}">${w.kind === 'taste' ? '<i aria-hidden="true">≈</i>' : ''}${esc(w.label)}</span>`;

  function storyHtml(s, i) {
    return `<li data-id="${esc(s.sid)}" style="--i:${Math.min(i, 12)}">
      <div class="fy-whys">${s.why.map(whyHtml).join('')}${s.breaking ? '<span class="fy-why k-hot">Breaking</span>' : ''}</div>
      <h3><a href="#story/${encodeURIComponent(s.sid)}">${esc(s.title)}</a></h3>
      <p class="tl-meta">${esc(s.lead?.source || '')} · ${time(s.updatedAt || s.publishedAt)}${s.sources > 1 ? ` · ${s.sources} sources` : ''}</p>
      ${s.image ? `<img class="fy-thumb" src="${esc(s.image)}" alt="" loading="lazy" data-fallback="remove">` : ''}
    </li>`;
  }

  function pickerHtml(d, { onlyNew = false } = {}) {
    if (!d) return '<i class="skeleton"></i><i class="skeleton w80"></i>';
    const kinds = [['topics', 'topic'], ['names', 'name'], ['accounts', 'account'], ['outlets', 'outlet']];
    return kinds.map(([list, kind]) => {
      const items = (d[list] || []).filter((x) => !onlyNew || !has(kind, x.key)).slice(0, onlyNew ? 6 : 12);
      if (!items.length) return '';
      return `<div class="fy-group"><h3>${TITLES[list]}</h3><div class="fy-chips">${items.map((x) => `<button type="button" class="fy-chip" data-follow="${kind}" data-fkey="${esc(x.key)}" data-flabel="${esc(x.label)}" aria-pressed="${has(kind, x.key)}" title="${has(kind, x.key) ? 'Following' : 'Follow'} ${esc(x.label)}">${x.avatar ? `<img src="${esc(x.avatar)}" alt="" width="20" height="20" loading="lazy" data-fallback="remove">` : ''}<span>${esc(kind === 'account' ? `@${x.key}` : x.label)}</span><i aria-hidden="true"></i></button>`).join('')}</div></div>`;
    }).join('');
  }

  function followingHtml() {
    if (!count()) return '<p class="rail-note">Nothing yet.</p>';
    const href = (list, x) => (list === 'topics' ? `#topic/${encodeURIComponent(x.key)}` : list === 'names' ? `#graph/${encodeURIComponent(x.key)}` : list === 'accounts' ? `#account/${encodeURIComponent(x.key)}` : null);
    return Object.entries(follows).filter(([, l]) => l.length).map(([list, l]) => `<div class="fy-group"><h3>${TITLES[list]}</h3><ul class="fy-following">${l.map((x) => {
      const kind = Object.keys(KINDS).find((k) => KINDS[k] === list);
      const h = href(list, x);
      const label = esc(list === 'accounts' ? `@${x.key}` : x.label);
      return `<li data-id="${esc(`${kind}:${x.key}`)}">${h ? `<a href="${h}">${label}</a>` : `<span>${label}</span>`}<button type="button" class="sv-x" data-follow="${kind}" data-fkey="${esc(x.key)}" data-flabel="${esc(x.label)}" aria-pressed="true" aria-label="Unfollow ${label}">×</button></li>`;
    }).join('')}</ul></div>`).join('');
  }

  function renderPage() {
    const name = state.data?.site?.name || 'Frontier Wire';
    document.title = `For you · ${name}`;
    if (state.mode !== 'api') {
      setHtml($('#foryouView'), '<header class="topic-head"><p class="kicker">For you</p><h1>Your wire</h1><p class="topic-sum">For you needs the live server.</p></header>');
      return;
    }
    fetchFeed();
    fetchSuggest();
    const n = count();
    const saved = savedSids().length;
    const d = page.data;
    const animate = !!d && shown !== d && !reducedMotion();
    if (d) shown = d;
    const sum = !n && !saved
      ? 'Follow a few topics, names, accounts or outlets and the live feed is ranked for you. Nothing leaves this browser except the list itself, sent with each request.'
      : `Ranked from ${n ? `${n} follow${n === 1 ? '' : 's'}` : ''}${n && saved ? ' and ' : ''}${saved ? `${saved} saved stor${saved === 1 ? 'y' : 'ies'}` : ''}${d ? ` · ${d.matched} live ${d.matched === 1 ? 'story matches' : 'stories match'} a follow` : ''}.`;
    const feed = !n && !saved
      ? `<section class="topic-card fy-start"><h2>Start with a few follows</h2>${pickerHtml(suggest?.data)}</section>`
      : d?.stories?.length
        ? `<ol class="fy-list${animate ? ' animate' : ''}">${d.stories.map(storyHtml).join('')}</ol>`
        : d ? `<p class="sv-empty">Nothing in the live feed matches yet. Follow something busier, or check back as news comes in.</p>`
          : page.error ? `<p class="rail-note">For you is unavailable: ${esc(page.error)}</p>`
            : '<div class="topic-chart loading" aria-busy="true"><i class="skeleton"></i></div>';
    const posts = d?.posts?.length ? `<section><h2>From accounts you follow</h2><ul class="fy-posts">${d.posts.map((p) => `<li data-id="${esc(p.url)}">
        <img src="${esc(p.avatar || '')}" alt="" width="28" height="28" loading="lazy" data-fallback="remove">
        <div><p class="tl-meta"><a href="#account/${encodeURIComponent(p.handle)}">@${esc(p.handle)}</a> · ${time(p.publishedAt)}</p><a class="fy-ptext" href="${esc(p.url)}" target="_blank" rel="noopener">${esc((p.text || '').slice(0, 220))}</a></div></li>`).join('')}</ul></section>` : '';
    setHtml($('#foryouView'), `
      <header class="topic-head">
        <a class="back" href="#news">← News</a>
        <p class="kicker">For you</p>
        <h1>Your wire</h1>
        <p class="topic-sum">${sum}</p>
      </header>
      <div class="topic-grid">
        <div class="fy-main">${feed}</div>
        <aside class="topic-side">
          ${n ? `<section><h2>Following</h2>${followingHtml()}</section>` : ''}
          ${posts}
          ${n || saved ? `<section><h2>More to follow</h2>${pickerHtml(suggest?.data, { onlyNew: true }) || '<p class="rail-note">You follow all of today’s suggestions.</p>'}</section>` : ''}
          <section><h2>How it works</h2><p class="bk-how">A story matches when it’s tagged with a topic you follow, names a name, or carries a post from an account or an article from an outlet you follow. Your saved stories and those matches make a “taste” from their meaning (sentence embeddings), which also brings in close stories that name none of your follows (≈). Follows stay in this browser.</p></section>
        </aside>
      </div>`);
  }

  function onClick(t) {
    const d = t.dataset;
    if (d.follow) {
      const on = toggle(d.follow, d.fkey, d.flabel);
      toast?.(on ? `Following ${d.follow === 'account' ? `@${d.fkey}` : d.flabel}` : `Unfollowed ${d.follow === 'account' ? `@${d.fkey}` : d.flabel}`);
      if (state.view === 'foryou') renderPage();
      return true;
    }
    return false;
  }

  sync();
  return { btn, sync, renderPage, onClick, has, count };
}
