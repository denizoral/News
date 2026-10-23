// Search engine UI: instant suggestions in the header, a results page with
// tabs and filters, image results, and a reader view for stored pages.
// Needs the Node server; when hosted statically, app.js uses the box as a feed filter.

import { looksLikeQuestion } from './ask.js';

const $ = (s, el = document) => el.querySelector(s);

const TABS = [
  ['all', 'All', null],
  ['news', 'News', 'article'],
  ['images', 'Images', null],
  ['posts', 'Posts', 'post'],
  ['builds', 'Projects', 'build'],
  ['models', 'Models', 'model'],
  ['markets', 'Markets', 'market'],
];
const TIMES = [['any', 'Any time'], ['day', 'Past day'], ['week', 'Past week'], ['month', 'Past month'], ['year', 'Past year']];
const MEANING_TABS = new Set(['all', 'news', 'posts']);
const TYPE_LABEL = { post: 'Post', build: 'Project', model: 'Model', market: 'Market' };

export function createSearch({ esc, ago, time, fav, pct, compact }) {
  const s = { q: '', type: 'all', time: 'any', sort: 'relevance', mode: 'words', page: 1, results: [], data: null, loading: false, ctrl: null };
  const input = $('#q');
  const list = $('#suggest');
  let sugg = [];
  let active = -1;
  let sTimer;
  let sCtrl;

  // ---------- URL state ----------

  function fromHash(hash) {
    const params = new URLSearchParams(hash.split('?')[1] || '');
    s.q = params.get('q') || '';
    s.type = TABS.some(([k]) => k === params.get('type')) ? params.get('type') : 'all';
    s.time = TIMES.some(([k]) => k === params.get('time')) ? params.get('time') : 'any';
    s.sort = params.get('sort') === 'date' ? 'date' : 'relevance';
    s.mode = params.get('mode') === 'meaning' ? 'meaning' : 'words';
    // Meaning search covers news and posts only.
    if (s.mode === 'meaning' && !MEANING_TABS.has(s.type)) s.type = 'all';
    input.value = s.q;
  }

  function hashFor(patch = {}) {
    const n = { q: s.q, type: s.type, time: s.time, sort: s.sort, mode: s.mode, ...patch };
    const p = new URLSearchParams({ q: n.q });
    if (n.type !== 'all') p.set('type', n.type);
    if (n.time !== 'any') p.set('time', n.time);
    if (n.sort !== 'relevance') p.set('sort', n.sort);
    if (n.mode === 'meaning') p.set('mode', 'meaning');
    return `#search?${p.toString().replace(/\+/g, '%20')}`;
  }

  // ---------- Suggestions ----------

  function closeSuggest() {
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    active = -1;
  }

  function renderSuggest() {
    const q = input.value.trim();
    if (!q) return closeSuggest();
    const rows = [{ kind: 'query', title: q }, ...sugg.map((x) => ({ kind: 'doc', ...x }))];
    list.innerHTML = rows.map((r, i) => `<li role="option" id="sg-${i}" data-i="${i}" aria-selected="${i === active}">
      ${r.kind === 'query'
        ? `<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="m13 13 4.5 4.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg><span>Search for <b>${esc(r.title)}</b></span>`
        : `<img src="${esc(fav(r.site))}" alt="" width="16" height="16"><span>${esc(r.title)}</span><small>${esc(TYPE_LABEL[r.type] || r.site)}</small>`}
    </li>`).join('');
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    if (active >= 0) input.setAttribute('aria-activedescendant', `sg-${active}`);
    list._rows = rows;
  }

  async function loadSuggest() {
    const q = input.value.trim();
    if (q.length < 2) {
      sugg = [];
      return renderSuggest();
    }
    sCtrl?.abort();
    sCtrl = new AbortController();
    try {
      sugg = await (await fetch(`api/suggest?q=${encodeURIComponent(q)}`, { signal: sCtrl.signal })).json();
      active = -1;
      renderSuggest();
    } catch { /* aborted or offline */ }
  }

  function choose(i) {
    const row = list._rows?.[i];
    closeSuggest();
    if (!row || row.kind === 'query') return go(input.value.trim());
    window.open(row.url, '_blank', 'noopener');
  }

  function go(q) {
    if (!q) return;
    input.blur();
    location.hash = hashFor({ q, page: 1 });
  }

  input.addEventListener('input', () => {
    clearTimeout(sTimer);
    sTimer = setTimeout(loadSuggest, 110);
  });
  input.addEventListener('keydown', (e) => {
    const n = list._rows?.length || 0;
    if (e.key === 'ArrowDown' && !list.hidden) { e.preventDefault(); active = (active + 1) % n; renderSuggest(); }
    else if (e.key === 'ArrowUp' && !list.hidden) { e.preventDefault(); active = (active - 1 + n) % n; renderSuggest(); }
    else if (e.key === 'Enter') { e.preventDefault(); active >= 0 ? choose(active) : go(input.value.trim()); }
    else if (e.key === 'Escape') { closeSuggest(); }
  });
  input.addEventListener('blur', () => setTimeout(closeSuggest, 150));
  list.addEventListener('mousedown', (e) => {
    const li = e.target.closest('li');
    if (li) { e.preventDefault(); choose(+li.dataset.i); }
  });

  // ---------- Results ----------

  async function load({ append = false } = {}) {
    s.ctrl?.abort();
    s.ctrl = new AbortController();
    s.loading = true;
    if (!append) {
      s.page = 1;
      $('#searchResults').innerHTML = Array.from({ length: 6 }, () => '<li class="skeleton"></li>').join('');
      $('#searchBoxes').innerHTML = '';
    }
    const params = new URLSearchParams({ q: s.q, page: String(s.page), time: s.time, sort: s.sort });
    if (s.type !== 'all') params.set('type', s.type);
    if (s.mode === 'meaning') params.set('mode', 'meaning');
    try {
      const res = await fetch(`api/search?${params}`, { signal: s.ctrl.signal });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      s.data = append ? { ...data, boxes: s.data?.boxes, facets: s.data?.facets } : data;
      s.results = append ? [...s.results, ...data.results] : data.results;
      paint();
    } catch (err) {
      if (err.name !== 'AbortError') $('#searchResults').innerHTML = `<li class="empty">Search is unavailable: ${esc(err.message)}. Check that the server is running.</li>`;
    } finally {
      s.loading = false;
    }
  }

  function paintHead() {
    const d = s.data;
    const count = s.mode === 'meaning'
      ? (d.total ? `The ${d.total === 1 ? 'closest match' : `${d.total} closest matches`} in meaning` : 'Nothing close in meaning')
      : d.total ? `About ${d.total.toLocaleString()} ${d.total === 1 ? 'result' : 'results'}` : 'No results';
    const notes = [];
    if (d.loosened) notes.push('No page has every word, so these match some of them.');
    if (d.parsed?.site) notes.push(`Only results from ${esc(d.parsed.site)}.`);
    if (d.error) notes.push(esc(d.error));
    const trend = s.q && looksLikeQuestion(s.q) ? ` <a class="tr-link" href="#ask?q=${encodeURIComponent(s.q)}">Answer it from the coverage →</a>`
      : s.q && s.mode !== 'meaning' && s.q.length <= 60 && !/\w+:/.test(s.q) ? ` <a class="tr-link" href="#trends?q=${encodeURIComponent(s.q.replace(/,/g, ' '))}">How often it comes up →</a>` : '';
    $('#searchHead').innerHTML = `<h1>${s.q ? esc(s.q) : 'Everything in the index'}</h1><p>${count} <span class="took">(${d.tookMs} ms)</span>${notes.length ? ` ${notes.join(' ')}` : ''}${trend}${s.q && s.mode !== 'meaning' ? ` <a class="tr-link" href="#watch?add=${encodeURIComponent(s.q)}">Watch this search →</a>` : ''}</p>`;
    const facets = s.data.facets || {};
    const all = Object.values(facets).reduce((a, b) => a + b, 0);
    $('#searchTabs').innerHTML = TABS.filter(([k]) => s.mode !== 'meaning' || MEANING_TABS.has(k)).map(([k, label, t]) => {
      const n = s.mode === 'meaning' ? null : k === 'all' ? all : t ? facets[t] || 0 : null;
      return `<a class="chip" href="${hashFor({ type: k })}" aria-pressed="${s.type === k}">${label}${n != null && s.type !== 'images' ? `<span class="n">${compact(n)}</span>` : ''}</a>`;
    }).join('');
    const modes = s.type === 'images' ? '' : `<span class="seg seg-mode" role="group" aria-label="Match">${[['words', 'Words'], ['meaning', 'Meaning']].map(([k, l]) => `<a href="${hashFor({ mode: k })}" aria-pressed="${s.mode === k}" title="${k === 'meaning' ? 'Find stories about the same thing, even in different words' : 'Match the words you typed'}">${l}</a>`).join('')}</span><span class="sep"></span>`;
    $('#searchFilters').innerHTML = modes + TIMES.map(([k, l]) => `<a class="chip" href="${hashFor({ time: k })}" aria-pressed="${s.time === k}">${l}</a>`).join('') +
      (s.type === 'images' || s.mode === 'meaning' ? '' : `<span class="sep"></span>${[['relevance', 'Best match'], ['date', 'Newest']].map(([k, l]) => `<a class="chip" href="${hashFor({ sort: k })}" aria-pressed="${s.sort === k}">${l}</a>`).join('')}`);
  }

  function crumb(url) {
    try {
      const u = new URL(url);
      const path = u.pathname.split('/').filter(Boolean).slice(0, 3).map((p) => decodeURIComponent(p).slice(0, 28));
      return [u.hostname.replace(/^www\./, ''), ...path].join(' › ');
    } catch {
      return url;
    }
  }

  function marketBox(markets) {
    if (!markets?.length) return '';
    return `<section class="box"><h2>Prediction markets</h2><div class="box-markets">${markets.map((m) => {
      const o = m.meta?.outcomes?.[0];
      return `<a class="box-market" href="${esc(m.url)}" target="_blank" rel="noopener"><b>${esc(m.title)}</b>
        ${o ? `<span class="odd"><span class="odd-label">${esc(m.meta.binary ? 'Yes' : o.label)}</span><span class="pct">${pct(o.yes)}</span><span class="rule"><i style="width:${(o.yes * 100).toFixed(1)}%"></i></span></span>` : ''}
        <small>$${compact(m.meta?.volume24h)} traded today</small></a>`;
    }).join('')}</div></section>`;
  }

  function imageBox(images) {
    if (!images?.length) return '';
    return `<section class="box"><h2><a href="${hashFor({ type: 'images' })}">Images</a></h2><div class="box-images">${images.map((im) =>
      `<button type="button" class="thumb-btn" data-img="${im.id}"><img src="${esc(im.src)}" alt="${esc(im.alt || '')}" loading="lazy"></button>`).join('')}</div></section>`;
  }

  function resultHtml(r) {
    const label = TYPE_LABEL[r.type];
    const extra = [];
    if (label) extra.push(`<span class="r-type">${label}</span>`);
    if (r.source && r.source !== r.site) extra.push(`<span>${esc(r.source)}</span>`);
    if (r.author) extra.push(`<span>${esc(r.author.slice(0, 60))}</span>`);
    if (r.meta?.discussionUrl) extra.push(`<a href="${esc(r.meta.discussionUrl)}" target="_blank" rel="noopener">Discussion</a>`);
    if (r.cached) extra.push(`<a href="#doc/${r.id}">Stored copy</a>`);
    if (r.inlinks >= 3) extra.push(`<span title="Links from other sites">${r.inlinks} sites link here</span>`);
    const odds = r.type === 'market' && r.meta?.outcomes?.[0];
    return `<li class="result${r.image ? ' has-img' : ''}">
      <div class="r-main">
        <div class="r-site"><img src="${esc(fav(r.site))}" alt="" width="18" height="18" loading="lazy"><span><b>${esc(r.site)}</b><cite>${esc(crumb(r.url))}</cite></span></div>
        <h3><a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.title)}</a></h3>
        <p class="r-snip">${r.publishedAt ? `${time(r.publishedAt)} · ` : ''}${r.snippet || ''}</p>
        ${odds ? `<div class="odd"><span class="odd-label">${esc(r.meta.binary ? 'Yes' : odds.label)}</span><span class="pct">${pct(odds.yes)}</span><span class="rule"><i style="width:${(odds.yes * 100).toFixed(1)}%"></i></span></div>` : ''}
        ${extra.length ? `<div class="r-extra">${extra.join('')}</div>` : ''}
      </div>
      ${r.image ? `<img class="r-img" src="${esc(r.image)}" alt="" loading="lazy" data-fallback="remove">` : ''}
    </li>`;
  }

  function imageResultHtml(im) {
    return `<figure class="img-result"><button type="button" class="thumb-btn" data-img="${im.id}">
      <img src="${esc(im.src)}" alt="${esc(im.alt || '')}" loading="lazy" ${im.width && im.height ? `width="${im.width}" height="${im.height}"` : ''}></button>
      <figcaption><img src="${esc(fav(im.site))}" alt="" width="14" height="14"> ${esc(im.site)}<span>${esc(im.alt || im.pageTitle || '')}</span></figcaption></figure>`;
  }

  function paint() {
    paintHead();
    const d = s.data;
    const box = $('#searchBoxes');
    box.innerHTML = s.type === 'all' && d.page === 1 ? marketBox(d.boxes?.markets) + imageBox(d.boxes?.images) : '';
    const ol = $('#searchResults');
    ol.className = s.type === 'images' ? 'img-results' : 'results';
    if (!s.results.length) {
      ol.innerHTML = `<li class="empty">${s.mode === 'meaning' ? `Nothing in the index is close in meaning to <b>${esc(s.q)}</b>. Try describing it differently or widen the time filter.` : s.q ? `Nothing in the index matches <b>${esc(s.q)}</b>. Try fewer or different words, remove filters like <code>site:</code>, or <a href="${hashFor({ mode: 'meaning' })}">search by meaning</a>.` : 'The index is empty. The spider is still crawling; check back in a minute.'}</li>`;
    } else {
      ol.innerHTML = s.results.map(s.type === 'images' ? imageResultHtml : resultHtml).join('');
    }
    const more = $('#moreResults');
    more.hidden = s.results.length >= (d.total || 0) || d.results.length < d.perPage;
    s._images = [...(d.boxes?.images || []), ...(s.type === 'images' ? s.results : [])];
  }

  $('#moreResults').addEventListener('click', () => {
    s.page++;
    load({ append: true });
  });

  // Image preview
  const dialog = $('#imgDialog');
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-img]');
    if (!b) return;
    const im = s._images?.find((x) => String(x.id) === b.dataset.img);
    if (!im) return;
    $('#imgDialogBody').innerHTML = `<img src="${esc(im.src)}" alt="${esc(im.alt || '')}">
      <div><p>${esc(im.alt || im.pageTitle || '')}</p><p class="muted">${esc(im.site)}${im.width ? `, ${im.width}×${im.height}` : ''}${im.publishedAt ? `, ${ago(im.publishedAt)}` : ''}</p>
      <p><a href="${esc(im.pageUrl)}" target="_blank" rel="noopener">Open the page this image is from</a></p></div>`;
    dialog.showModal();
  });
  dialog.addEventListener('click', (e) => { if (e.target === dialog || e.target.closest('[data-close]')) dialog.close(); });

  // ---------- Stored copy ----------

  async function loadDoc(id) {
    const el = $('#docView');
    el.innerHTML = '<div class="skeleton"></div><div class="skeleton"></div>';
    try {
      const res = await fetch(`api/doc?id=${encodeURIComponent(id)}`);
      if (!res.ok) throw new Error('That page is not in the index.');
      const d = await res.json();
      const paras = (d.body || '').split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
      el.innerHTML = `<p class="doc-note">Stored copy from ${esc(d.site)}${d.fetchedAt ? `, saved ${ago(d.fetchedAt)}` : ''}. <a href="${esc(d.url)}" target="_blank" rel="noopener">Read the original</a></p>
        <h1>${esc(d.title)}</h1>
        <p class="doc-meta">${[d.source, d.author, d.publishedAt ? new Date(d.publishedAt).toLocaleDateString(undefined, { dateStyle: 'long' }) : null, d.words ? `${compact(d.words)} words` : null].filter(Boolean).map(esc).join(', ')}</p>
        ${d.images?.[0] ? `<figure><img src="${esc(d.images[0].src)}" alt="${esc(d.images[0].alt || '')}">${d.images[0].caption ? `<figcaption>${esc(d.images[0].caption)}</figcaption>` : ''}</figure>` : ''}
        ${paras.length ? paras.map((p) => `<p>${esc(p)}</p>`).join('') : `<p>${esc(d.description || '')}</p><p class="doc-note">The full text is stored but not shown. Set <code>CACHED_COPIES=on</code> on the server to show stored copies.</p>`}`;
    } catch (err) {
      el.innerHTML = `<p class="empty">${esc(err.message)}</p>`;
    }
  }

  return {
    route(hash) {
      if (hash.startsWith('#doc/')) {
        loadDoc(hash.slice(5));
        return 'doc';
      }
      fromHash(hash);
      document.title = s.q ? `${s.q} · Frontier Wire search` : 'Search · Frontier Wire';
      load();
      return 'search';
    },
    go,
  };
}

export async function spiderLine(compact) {
  try {
    const st = await (await fetch('api/spider')).json();
    const docs = Object.values(st.docs || {}).reduce((a, b) => a + b, 0);
    return `Search index: ${compact(docs)} documents, ${compact(st.crawledPages)} pages crawled in full, ${compact(st.images.stored)} images stored (${compact(st.images.bytes / 1048576)} MB), ${compact(st.frontier.queued || 0)} URLs queued, ${st.pagesPerMinute} pages a minute.`;
  } catch {
    return '';
  }
}
