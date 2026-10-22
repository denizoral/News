// Power-user layer: the ⌘K command palette, the reading list (#saved) and
// keyboard shortcuts (j/k through any list, s to save, ? for help).
// Server side: /api/jump and /api/saved (src/index/jump.js).

import { looksLikeQuestion } from './ask.js';

const PAGES = [
  ['News', '#news', 'Top stories now'],
  ['For you', '#foryou', 'The live feed ranked for what you follow'],
  ['On X', '#x', 'Labs, researchers and markets as they post'],
  ['X accounts', '#accounts', 'Who is first on X: every account, ranked'],
  ['Tech', '#tech', 'Tech beyond AI'],
  ['This week', '#week', 'The weekly digest'],
  ['Connections', '#graph', 'Who is in the news together'],
  ['Releases', '#releases', 'Recent models'],
  ['Compare models', '#models', 'Price, context, coverage and reported scores side by side'],
  ['Built with AI', '#builds', 'Projects people shipped'],
  ['Markets', '#markets', 'Polymarket odds on AI'],
  ['Breaking', '#breaking', 'Stories breaking now, and alerts'],
  ['Saved', '#saved', 'Your reading list'],
  ['Ask the Wire', '#ask', 'A question answered with sentences from the coverage, with sources'],
  ['Deals', '#deals', 'Funding rounds, valuations and acquisitions'],
  ['Storylines', '#storylines', 'Stories that keep coming back, day after day'],
  ['Predictions', '#predictions', 'What people and companies say will happen, and by when'],
  ['Catch up', '#catchup', 'Everything since your last visit'],
  ['News map', '#map', 'Every story laid out by meaning'],
  ['Head to head', '#vs', 'Two labs, people or products side by side'],
  ['Who said what', '#quotes', 'Who is being quoted about AI, and the lines every outlet carried'],
  ['Any day', '#day', 'The front page of any day in the last year'],
  ['Outlets', '#outlets', 'Who covers AI and what each outlet covers most'],
  ['Trends', '#trends', 'How often any term comes up, since 2024'],
  ['Status', '#status', 'Every source hour by hour, server vitals, quiet X accounts'],
  ['API and feeds', '#developers', 'JSON API, RSS and JSON feeds for any topic, account or search'],
];
const KIND = { ask: 'Ask', page: 'Page', topic: 'Topic', name: 'Name', account: 'X account', release: 'Release', theme: 'Emerging', story: 'Story', market: 'Market', action: 'Action', search: 'Search', recent: 'Recent' };
const ICON = {
  page: '<path d="M4 4h12v12H4z" fill="none" stroke="currentColor" stroke-width="1.6"/>',
  topic: '<path d="M3 10h14M10 3v14" stroke="currentColor" stroke-width="1.6"/>',
  name: '<circle cx="5" cy="6" r="2.3" fill="currentColor"/><circle cx="15" cy="7" r="2.3" fill="currentColor"/><circle cx="9" cy="15" r="2.3" fill="currentColor"/><path d="M5 6l10 1-6 8z" fill="none" stroke="currentColor" stroke-width="1.2"/>',
  account: '<path d="M14.2 3h2.5l-5.4 6.2L17.6 17h-5l-3.9-5.1L4.3 17H1.8l5.8-6.6L1.5 3h5.1l3.5 4.6L14.2 3Z" fill="currentColor"/>',
  release: '<path d="M10 2l2.2 5.3L18 8l-4.3 3.8L15 18l-5-3-5 3 1.3-6.2L2 8l5.8-.7z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>',
  theme: '<path d="M3 15l4-5 3 3 6-8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
  story: '<path d="M4 4h12M4 8h12M4 12h8M4 16h10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
  market: '<path d="M3 16V9m5 7V5m5 11v-5m4 5V3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  action: '<path d="M11 2L4 11h5l-1 7 7-9h-5z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>',
  search: '<circle cx="8.5" cy="8.5" r="5.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="m13 13 4.5 4.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  recent: '<circle cx="10" cy="10" r="7" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M10 6v4l3 2" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
};
ICON.ask = '<path d="M4 4h12v9H9l-4 3v-3H4z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>';
const icon = (t) => `<svg viewBox="0 0 20 20" aria-hidden="true">${ICON[t] || ICON.page}</svg>`;

export function createPalette({ $, $$, esc, time, setHtml, store, state, reducedMotion, actions }) {
  const dlg = $('#palette');
  const input = $('#palInput');
  const list = $('#palList');
  let rows = [];
  let active = 0;
  let ctrl = null;
  let timer = null;
  let lastFocus = null;

  // ---- Reading list ----
  let saved = store.get('fw.saved', []).filter((x) => x?.sid);
  const savedPage = { data: null, at: 0, pending: false, error: null };
  const isSaved = (sid) => saved.some((x) => x.sid === sid);
  function persist() {
    store.set('fw.saved', saved.slice(0, 200));
    updateSavedBtn();
    keepOffline();
  }
  function toggleSave(story) {
    if (!story?.sid) return false;
    if (isSaved(story.sid)) saved = saved.filter((x) => x.sid !== story.sid);
    else saved.unshift({ sid: story.sid, title: story.title, url: story.url, source: story.source || story.lead?.source || null, sources: story.sources?.length ?? story.sources ?? 1, savedAt: Date.now() });
    savedPage.at = 0;
    persist();
    toast(isSaved(story.sid) ? 'Saved to your reading list' : 'Removed from your reading list');
    return true;
  }
  function updateSavedBtn() {
    const b = $('#savedBtn');
    if (!b) return;
    b.hidden = !saved.length;
    $('span', b).textContent = saved.length;
    b.setAttribute('aria-label', `Reading list: ${saved.length} saved`);
    for (const el of $$('[data-save]')) {
      const on = isSaved(el.dataset.save);
      el.setAttribute('aria-pressed', on);
      el.lastChild.textContent = on ? 'Saved' : 'Save';
    }
  }
  // Ask the service worker to keep each saved story page for offline reading.
  function keepOffline() {
    navigator.serviceWorker?.controller?.postMessage({ type: 'keep', urls: saved.map((x) => `/api/story?id=${encodeURIComponent(x.sid)}`) });
  }

  async function loadSaved() {
    if (state.mode !== 'api' || savedPage.pending || !saved.length || Date.now() - savedPage.at < 60e3) return;
    savedPage.pending = true;
    try {
      const res = await fetch(`api/saved?ids=${saved.slice(0, 100).map((x) => encodeURIComponent(x.sid)).join(',')}`);
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || res.statusText);
      savedPage.data = new Map(d.stories.map((s) => [s.sid, s]));
      savedPage.error = null;
    } catch (err) {
      savedPage.error = navigator.onLine === false ? 'You’re offline; showing what was saved.' : err.message;
    }
    savedPage.at = Date.now();
    savedPage.pending = false;
    if (state.view === 'saved') renderSaved();
  }

  function renderSaved() {
    document.title = `Saved · ${state.data?.site?.name || 'Frontier Wire'}`;
    loadSaved();
    const now = savedPage.data;
    const rowsHtml = saved.map((x, i) => {
      const s = now?.get(x.sid);
      const added = s && !s.gone ? s.sources - (x.sources || 0) : 0;
      const status = !s ? '' : s.gone ? '<span class="sv-tag">No longer available</span>'
        : s.breaking ? '<span class="sv-tag hot">Breaking now</span>'
        : added > 0 ? `<span class="sv-tag new">+${added} ${added === 1 ? 'source' : 'sources'} since you saved it</span>`
        : !s.live ? '<span class="sv-tag">Left the live feed</span>' : '';
      return `<li data-id="${esc(x.sid)}" style="--i:${Math.min(i, 12)}">
        <div><a href="#story/${encodeURIComponent(x.sid)}">${esc(s?.title || x.title)}</a>
        <span class="tl-meta">${x.source ? `${esc(x.source)} · ` : ''}saved ${time(x.savedAt)}${s && !s.gone ? ` · ${s.sources} ${s.sources === 1 ? 'source' : 'sources'}` : ''}${status}</span></div>
        <button class="sv-x" type="button" data-unsave="${esc(x.sid)}" aria-label="Remove from reading list">×</button>
      </li>`;
    }).join('');
    const offline = 'serviceWorker' in navigator && window.isSecureContext;
    setHtml($('#savedView'), `
      <header class="topic-head">
        <a class="back" href="#news">← News</a>
        <p class="kicker">Reading list</p>
        <h1>Saved stories</h1>
        <p class="topic-sum">${saved.length ? `${saved.length} saved in this browser.${offline ? ' Story pages you save are kept for reading offline.' : ''}` : 'Nothing saved yet.'}</p>
      </header>
      ${savedPage.error ? `<p class="rail-note">${esc(savedPage.error)}</p>` : ''}
      ${saved.length ? `<ol class="sv-list">${rowsHtml}</ol>` : `<div class="sv-empty"><p>Save a story from its page with <b>Save</b>, or press <kbd>s</kbd> on any story while moving through the feed with <kbd>j</kbd> and <kbd>k</kbd>. Saved stories stay in this browser and show what changed since you saved them.</p></div>`}`);
  }

  // ---- Palette ----
  const recent = () => store.get('fw.jumps', []);
  function remember(r) {
    if (r.type === 'action' || r.type === 'search' || r.type === 'ask') return;
    const list2 = [{ ...r, type: r.type === 'recent' ? r.was : r.type }].concat(recent().filter((x) => x.href !== r.href || x.label !== r.label)).slice(0, 6);
    store.set('fw.jumps', list2);
  }

  function baseRows(qv) {
    const ql = qv.toLowerCase();
    const pages = PAGES.filter(([l, , sub]) => !ql || l.toLowerCase().includes(ql) || sub.toLowerCase().includes(ql)).map(([label, href, sub]) => ({ type: 'page', label, href, sub }));
    const acts = [
      { type: 'action', label: 'Toggle dark mode', run: 'theme', sub: 'Switch between light and dark' },
      { type: 'action', label: 'Keyboard shortcuts', run: 'help', sub: 'j, k, s, / and more' },
      ...(state.view === 'story' && state.storyId ? [{ type: 'action', label: isSaved(state.storyId) ? 'Remove this story from saved' : 'Save this story', run: 'save', sub: 'Reading list' }] : []),
      { type: 'action', label: 'Breaking alerts', href: '#breaking', sub: 'Get a notification when a story breaks' },
    ].filter((a) => !ql || a.label.toLowerCase().includes(ql));
    if (!ql) return [...recent().map((r) => ({ ...r, was: r.type, type: 'recent' })), ...pages, ...acts];
    return [...pages.slice(0, 3), ...acts.slice(0, 2)];
  }

  function draw() {
    if (!rows.length) {
      setHtml(list, '<li class="pal-empty">No matches.</li>');
      return;
    }
    let group = null;
    setHtml(list, rows.map((r, i) => {
      const g = r.type === 'recent' ? 'Recent' : r.type === 'page' ? 'Go to' : r.type === 'action' ? 'Actions' : r.type === 'search' || r.type === 'ask' ? '' : 'Jump to';
      const head = g !== group ? (group = g, g ? `<li class="pal-group" role="presentation">${g}</li>` : '') : '';
      const t = r.type === 'recent' ? r.was : r.type;
      return `${head}<li role="option" id="pal-${i}" class="pal-row${i === active ? ' on' : ''}${r.breaking ? ' hot' : ''}" data-pal="${i}" aria-selected="${i === active}">
        ${r.avatar ? `<img src="${esc(r.avatar)}" alt="" width="20" height="20" loading="lazy" data-fallback="remove">` : `<span class="pal-ic">${icon(t)}</span>`}
        <span class="pal-txt"><b>${esc(r.label)}</b>${r.sub ? `<small>${esc(r.sub)}</small>` : ''}</span>
        <span class="pal-kind">${r.breaking ? 'Breaking' : KIND[t] || ''}${r.external ? ' ↗' : ''}</span>
      </li>`;
    }).join(''));
    input.setAttribute('aria-activedescendant', `pal-${active}`);
    $(`#pal-${active}`)?.scrollIntoView({ block: 'nearest' });
  }

  // Search, and for a question, Ask the Wire (first when it reads as one).
  function tail(qv) {
    const askRow = { type: 'ask', label: `Ask the Wire: “${qv}”`, q: qv };
    const searchRow = { type: 'search', label: `Search everything for “${qv}”`, q: qv };
    const rest = qv.length < 3 ? [searchRow] : looksLikeQuestion(qv) ? [askRow, searchRow] : [searchRow, askRow];
    const d = dateIn(qv);
    return d ? [{ type: 'page', label: `Any day: ${new Date(`${d}T00:00:00Z`).toLocaleDateString('en', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' })}`, href: `#day/${d}`, sub: 'That day’s front page' }, ...rest] : rest;
  }

  // "2026-03-10", "March 10 2026", "Mar 10": a past day, as YYYY-MM-DD.
  function dateIn(qv) {
    if (!/\d/.test(qv) || !/^(?:\d{4}-\d{1,2}-\d{1,2}|[a-z]{3,9}\.? \d{1,2}(?:,? \d{4})?|\d{1,2} [a-z]{3,9}(?: \d{4})?)$/i.test(qv)) return null;
    let t = Date.parse(/^\d{4}-/.test(qv) ? `${qv}T00:00:00Z` : `${qv}${/\d{4}$/.test(qv) ? '' : ` ${new Date().getUTCFullYear()}`} UTC`);
    if (Number.isNaN(t)) return null;
    if (t > Date.now() && !/\d{4}/.test(qv)) t = Date.parse(`${new Date(t).toISOString().slice(0, 10).replace(/^\d{4}/, (y) => y - 1)}T00:00:00Z`);
    return t <= Date.now() && t > Date.now() - 400 * 86400e3 ? new Date(t).toISOString().slice(0, 10) : null;
  }

  async function query() {
    const qv = input.value.trim();
    rows = baseRows(qv);
    active = 0;
    if (!qv) return draw();
    rows.push(...tail(qv));
    draw();
    if (state.mode !== 'api') return;
    ctrl?.abort();
    ctrl = new AbortController();
    try {
      const res = await fetch(`api/jump?q=${encodeURIComponent(qv)}`, { signal: ctrl.signal });
      if (!res.ok || input.value.trim() !== qv) return;
      const { results } = await res.json();
      const base = baseRows(qv);
      rows = looksLikeQuestion(qv) ? [...tail(qv), ...results, ...base] : [...results, ...base, ...tail(qv)];
      active = 0;
      draw();
    } catch { /* aborted or offline: the local rows stay */ }
  }

  function open() {
    if (dlg.open) return;
    lastFocus = document.activeElement;
    input.value = '';
    rows = baseRows('');
    active = 0;
    draw();
    dlg.showModal();
    dlg.classList.toggle('anim', !reducedMotion());
    input.focus();
  }
  function close() {
    if (dlg.open) dlg.close();
  }

  function go(r) {
    if (!r) return;
    remember(r);
    close();
    if (r.type === 'search') return actions.search(r.q);
    if (r.type === 'ask') { location.hash = `#ask?q=${encodeURIComponent(r.q)}`; return; }
    if (r.run === 'theme') return actions.theme();
    if (r.run === 'help') return help();
    if (r.run === 'save') return actions.saveCurrent();
    if ((r.type === 'account' || r.was === 'account') && r.handle) return actions.account(r.handle);
    if (r.external) return window.open(r.href, '_blank', 'noopener');
    if (location.hash === r.href) return actions.rerender();
    location.hash = r.href;
  }

  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(query, 70);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || (e.key === 'n' && e.ctrlKey)) { e.preventDefault(); active = Math.min(rows.length - 1, active + 1); draw(); }
    else if (e.key === 'ArrowUp' || (e.key === 'p' && e.ctrlKey)) { e.preventDefault(); active = Math.max(0, active - 1); draw(); }
    else if (e.key === 'Enter') { e.preventDefault(); go(rows[active]); }
  });
  list.addEventListener('click', (e) => {
    const li = e.target.closest('[data-pal]');
    if (li) go(rows[Number(li.dataset.pal)]);
  });
  list.addEventListener('pointermove', (e) => {
    const li = e.target.closest('[data-pal]');
    if (li && Number(li.dataset.pal) !== active) { active = Number(li.dataset.pal); draw(); }
  });
  dlg.addEventListener('click', (e) => { if (e.target === dlg) close(); });
  dlg.addEventListener('close', () => lastFocus?.focus?.());

  // ---- Shortcuts ----
  const help = () => $('#keysDialog').showModal();
  const LISTS = {
    news: '.lead h1 a, .rising .story h3 a, #river .story h3 a',
    tech: '#techRiver .story h3 a',
    x: '#xFeed > li a.x-text, #xFeed > li .x-body a',
    search: '#searchResults > li a',
    saved: '.sv-list > li > div > a',
    foryou: '.fy-list > li h3 a',
    accounts: '.ac-list > li .ac-name',
    models: '.md-table tbody th a',
    breaking: '.bk-card h2 a, .bk-list > li > div > a',
    week: '.wk-top li a',
  };
  function move(dir) {
    const sel = LISTS[state.view];
    if (!sel) return false;
    const links = $$(sel).filter((a) => a.offsetParent);
    if (!links.length) return false;
    const cur = links.findIndex((a) => a === document.activeElement || a.closest('li, article')?.classList.contains('kb-on'));
    const next = links[cur < 0 ? 0 : Math.max(0, Math.min(links.length - 1, cur + dir))];
    for (const el of $$('.kb-on')) el.classList.remove('kb-on');
    const card = next.closest('article, li');
    card?.classList.add('kb-on');
    next.focus({ preventScroll: true });
    card?.scrollIntoView({ block: 'center', behavior: reducedMotion() ? 'auto' : 'smooth' });
    return true;
  }
  // The story under the keyboard focus, for s.
  function focusedStory() {
    const card = document.activeElement?.closest?.('article.story') || $('.kb-on');
    const id = card?.dataset.id;
    if (!id) return null;
    return [...(state.data?.stories || []), ...(state.data?.tech || [])].find((s) => s.id === id || s.sid === id) || null;
  }

  function onKey(e) {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      dlg.open ? close() : open();
      return true;
    }
    const typing = /input|textarea|select/i.test(document.activeElement?.tagName) || document.activeElement?.isContentEditable;
    if (typing || e.metaKey || e.ctrlKey || e.altKey || dlg.open) return false;
    if (e.key === 'j' || e.key === 'k') { if (move(e.key === 'j' ? 1 : -1)) e.preventDefault(); return true; }
    if (e.key === 's') {
      const s = state.view === 'story' ? { sid: state.storyId, ...actions.currentStory() } : focusedStory();
      if (s) { toggleSave(s); return true; }
      return false;
    }
    if (e.key === '?') { help(); return true; }
    if (e.key === 'g') { location.hash = '#news'; return true; }
    if (e.key === 'b') { location.hash = '#breaking'; return true; }
    return false;
  }

  function onClick(t) {
    const d = t.dataset;
    if (t.id === 'cmdBtn') { open(); return true; }
    if (d.save) { toggleSave({ sid: d.save, ...actions.currentStory() }); return true; }
    if (d.unsave) { saved = saved.filter((x) => x.sid !== d.unsave); persist(); renderSaved(); return true; }
    return false;
  }

  let toastTimer;
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.hidden = false;
    el.classList.remove('show');
    void el.offsetWidth;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 2200);
  }

  updateSavedBtn();
  navigator.serviceWorker?.ready.then(keepOffline).catch(() => {});
  return { open, onKey, onClick, renderSaved, isSaved, updateSavedBtn, toast };
}
