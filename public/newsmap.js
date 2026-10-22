// The news map (#map): the last day, three days or week of stories laid out
// by meaning, so stories about the same things sit together. Dots are sized
// by how many outlets carried a story and shaded by how recent it is;
// regions are named by what their headlines share. Hover for the headline,
// click a dot for its story, click a region to fly into it, wheel or pinch
// to zoom, drag to pan, type to find. Server side: src/index/newsmap.js.

const HOUR = 3600e3;
const S = 1000; // map units per side
const PAD = 40;
const WINDOWS = [[1, 'A day'], [3, '3 days'], [7, 'A week']];
const ago = (t) => {
  const h = Math.round((Date.now() - t) / HOUR);
  return h < 1 ? 'under an hour ago' : h < 36 ? `${h} hour${h === 1 ? '' : 's'} ago` : `${Math.round(h / 24)} days ago`;
};
const clampK = (k) => Math.min(8, Math.max(1, k));

export function createNewsMap({ $, esc, setHtml, state, reducedMotion }) {
  const view = { days: 3, q: '', region: -1 };
  const cache = new Map(); // days -> { d, error, pending, at }
  let drawn = null;
  let cam = { x: 0, y: 0, k: 1 }; // top-left of the visible square, zoom
  let anim = 0;
  let drag = null;
  let hot = -1;
  let grow = 1; // labels and dots scale up on small screens, where 1000 units is ~360px

  function route(hash) {
    const m = /^#map(?:\?(.*))?$/.exec(hash);
    if (!m) return null;
    const p = new URLSearchParams(m[1] || '');
    const days = Number(p.get('days'));
    view.days = WINDOWS.some(([d]) => d === days) ? days : 3;
    view.q = (p.get('q') || '').slice(0, 60);
    return 'map';
  }

  async function load(days) {
    const hit = cache.get(days);
    if (hit?.pending || (hit?.d && Date.now() - hit.at < 10 * 60e3) || (hit?.error && Date.now() - hit.at < 20e3)) return;
    cache.set(days, { ...hit, pending: true });
    try {
      const r = await fetch(`/api/map?days=${days}`);
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || r.statusText);
      cache.set(days, { d, at: Date.now() });
    } catch (err) {
      cache.set(days, { d: hit?.d, error: err.message, at: Date.now() });
    }
    if (state.view === 'map' && view.days === days) render();
  }

  const px = (v) => PAD + v * (S - 2 * PAD);
  const radius = (p) => (3.2 + Math.sqrt(p.o) * 2.4) * grow;
  // Newer is darker: four steps of one hue over the window.
  const ageStep = (p, d) => Math.min(3, Math.floor(((d.generatedAt - p.at) / (d.generatedAt - d.since)) * 4));
  const matches = (p, q) => !q || p.t.toLowerCase().includes(q) || (p.src || '').toLowerCase().includes(q);

  // Region labels, biggest first, skipping any that would overlap one already placed.
  function labels(d) {
    const placed = [];
    const out = [];
    for (const r of [...d.regions].sort((a, b) => b.n - a.n)) {
      const text = r.alt && r.name.length + r.alt.length < 24 ? `${r.name} · ${r.alt}` : r.name;
      const size = Math.round(Math.min(30, 17 + Math.sqrt(r.n) * 1.2) * grow);
      const w = text.length * size * 0.56 + 16;
      const h = size * 1.5;
      // Kept inside the map so edge labels aren't cut off.
      const cx = Math.min(S - w / 2 - 4, Math.max(w / 2 + 4, px(r.x)));
      const box = { x: cx - w / 2, y: px(r.y) - h / 2, w, h };
      if (placed.some((b) => box.x < b.x + b.w && b.x < box.x + box.w && box.y < b.y + b.h && b.y < box.y + box.h)) continue;
      placed.push(box);
      out.push(`<g class="nm-region${r.growth >= 1.3 ? ' up' : ''}" data-r="${r.id}" tabindex="0" role="button" aria-label="${esc(`${text}: ${r.n} stories${r.growth >= 1.3 ? ', growing' : ''}`)}" transform="translate(${cx.toFixed(1)},${px(r.y).toFixed(1)})" style="--fs:${size}px">
        <text text-anchor="middle" dy="0.35em">${esc(text)}</text>${r.growth >= 1.3 ? `<text class="nm-up" text-anchor="middle" dy="${(size * 1.45).toFixed(0)}" style="--us:${(12 * grow).toFixed(0)}px">↑ ${r.growth >= 2 ? `${r.growth.toFixed(1)}×` : 'growing'}</text>` : ''}</g>`);
    }
    return out.join('');
  }

  // Each region's territory: its convex hull, drawn with a wide round stroke
  // so it reads as a soft patch around the dots.
  function hull(points) {
    const p = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    if (p.length < 3) return p;
    const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lower = [];
    for (const q of p) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop(); lower.push(q); }
    const upper = [];
    for (const q of p.reverse()) { while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop(); upper.push(q); }
    return [...lower.slice(0, -1), ...upper.slice(0, -1)];
  }

  function territories(d) {
    return d.regions.map((r) => {
      const pts = d.points.filter((p) => p.r === r.id).map((p) => [px(p.x), px(p.y)]);
      // Leave out the farthest tenth so one straggler doesn't stretch the patch.
      const cx = px(r.x), cy = px(r.y);
      const keep = pts.sort((a, b) => Math.hypot(a[0] - cx, a[1] - cy) - Math.hypot(b[0] - cx, b[1] - cy)).slice(0, Math.max(3, Math.ceil(pts.length * 0.9)));
      const h = hull(keep);
      if (!h.length) return '';
      return `<path class="nm-terr${view.region === r.id ? ' on' : ''}" data-t="${r.id}" d="M${h.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join('L')}Z"/>`;
    }).join('');
  }

  function dots(d, animate) {
    const q = view.q.toLowerCase();
    // Small dots on top so big ones don't hide them.
    const order = d.points.map((_, i) => i).sort((a, b) => d.points[b].o - d.points[a].o);
    return order.map((i, k) => {
      const p = d.points[i];
      const off = (q && !matches(p, q)) || (view.region >= 0 && p.r !== view.region);
      const delay = animate ? Math.round(Math.hypot(p.x - 0.5, p.y - 0.5) * 900 + (k % 7) * 12) : 0;
      return `<circle class="nm-dot a${ageStep(p, d)}${off ? ' off' : ''}" data-i="${i}" cx="${px(p.x).toFixed(1)}" cy="${px(p.y).toFixed(1)}" style="--r:${radius(p).toFixed(1)};--d:${delay}ms"/>`;
    }).join('');
  }

  function panel(d) {
    if (view.region >= 0) {
      const r = d.regions.find((x) => x.id === view.region);
      const pts = d.points.filter((p) => p.r === view.region).sort((a, b) => b.o - a.o || b.at - a.at);
      return `<div class="nm-panel-h"><button class="nm-back" type="button" data-act="all">← All regions</button></div>
        <h2 class="nm-rt">${esc(r.name)}${r.alt ? `<small> · ${esc(r.alt)}</small>` : ''}</h2>
        <p class="rail-note">${r.n} stories · ${r.outlets} outlet reports${r.growth >= 1.3 ? ` · <b class="nm-g">growing ${r.growth.toFixed(1)}×</b>` : ''}</p>
        <ol class="nm-stories">${pts.slice(0, 14).map((p, i) => `<li style="--i:${i}"><a href="${esc(p.sid ? `#story/${encodeURIComponent(p.sid)}` : p.u)}"${p.sid ? '' : ' target="_blank" rel="noopener"'} data-i="${d.points.indexOf(p)}">${esc(p.t)}</a><small>${esc(p.src || '')}${p.o > 1 ? ` · ${p.o} outlets` : ''} · ${esc(ago(p.at))}</small></li>`).join('')}</ol>`;
    }
    const max = Math.max(...d.regions.map((r) => r.n));
    return `<h2 class="when">Regions<span>by stories</span></h2>
      <ol class="nm-regions">${[...d.regions].sort((a, b) => b.n - a.n).map((r, i) => `<li style="--i:${i}"><button type="button" data-r="${r.id}"><span class="nm-rn">${esc(r.name)}${r.alt ? `<small> · ${esc(r.alt)}</small>` : ''}</span><b>${r.n}</b>${r.growth >= 1.3 ? '<em class="nm-g" title="More of its stories are recent than the map as a whole">↑</em>' : '<em></em>'}<span class="dy-bar"><i style="width:${Math.max(4, (r.n / max) * 100).toFixed(1)}%"></i></span></button></li>`).join('')}</ol>
      <p class="rail-note">Stories close together are about similar things. Bigger dots were carried by more outlets; fainter ones are older. Regions marked ↑ have more of their stories in the last quarter of the window than the map as a whole.</p>`;
  }

  function legend() {
    return `<ul class="nm-legend" aria-label="Legend">
      <li><span class="nm-ages"><i class="a3"></i><i class="a2"></i><i class="a1"></i><i class="a0"></i></span>older → newer</li>
      <li><span class="nm-sizes"><i style="--s:6px"></i><i style="--s:10px"></i><i style="--s:15px"></i></span>more outlets</li>
    </ul>`;
  }

  function render() {
    const name = state.data?.site?.name || 'Frontier Wire';
    const host = $('#mapView');
    document.title = `News map · ${name}`;
    const label = WINDOWS.find(([d]) => d === view.days)[1].toLowerCase();
    const head = `<header class="topic-head nm-head">
        <p class="kicker">News map</p>
        <h1>What ${view.days === 1 ? 'the last day was' : `the last ${esc(label)} were`} about</h1>
        <p class="topic-sum">Every story laid out by meaning: stories about similar things sit together, and the biggest clusters are named. Hover a dot for its headline, click to read, click a region to fly in.</p>
        <div class="nm-controls">
          <nav class="pd-chips" aria-label="Window">${WINDOWS.map(([d, l]) => `<a class="chip${view.days === d ? ' on' : ''}" href="#map?days=${d}${view.q ? `&q=${encodeURIComponent(view.q)}` : ''}">${l}</a>`).join('')}</nav>
          <label class="nm-find"><span class="visually-hidden">Find on the map</span><input type="search" id="nmFind" placeholder="Find on the map…" value="${esc(view.q)}" autocomplete="off"></label>
        </div>
      </header>`;
    if (state.mode !== 'api') {
      setHtml(host, `${head}<p class="rail-note">The map needs the live server.</p>`);
      return;
    }
    load(view.days);
    const hit = cache.get(view.days) || {};
    if (!hit.d) {
      setHtml(host, `${head}${hit.error ? `<p class="rail-note">The map is unavailable: ${esc(hit.error)}</p>` : '<div class="nm-wrap"><div class="nm-stage"><i class="skeleton nm-skel"></i></div><aside class="nm-panel" aria-busy="true"><i class="skeleton" style="width:80%;height:18px;display:block;margin:8px 0"></i><i class="skeleton" style="width:60%;height:18px;display:block;margin:8px 0"></i></aside></div>'}`);
      return;
    }
    const d = hit.d;
    grow = innerWidth < 640 ? 1.9 : 1;
    const fresh = drawn !== d;
    const animate = fresh && !reducedMotion();
    if (fresh) { view.region = -1; cam = { x: 0, y: 0, k: 1 }; }
    drawn = d;
    const q = view.q.toLowerCase();
    const found = q ? d.points.filter((p) => matches(p, q)).length : 0;
    // Keep focus and caret in the search box across re-renders.
    const active = document.activeElement?.id === 'nmFind' ? document.activeElement.selectionStart : null;
    setHtml(host, `${head}
      <p class="nm-meta">${d.stories.toLocaleString()} stories from ${d.items.toLocaleString()} articles and posts${q ? ` · <b>${found}</b> match “${esc(view.q)}”` : ''}</p>
      <div class="nm-wrap">
        <div class="nm-stage">
          <svg class="nm-svg${animate ? ' animate' : ''}${view.region >= 0 || q ? ' focus' : ''}" viewBox="${cam.x} ${cam.y} ${S / cam.k} ${S / cam.k}" style="--k:${cam.k}" role="img" aria-label="Map of ${d.stories} stories grouped by meaning">
            <g class="nm-terrs">${territories(d)}</g>
            <g class="nm-dots">${dots(d, animate)}</g>
            <g class="nm-labels">${labels(d)}</g>
            <circle class="nm-ring" r="0" cx="-99" cy="-99"/>
          </svg>
          <div class="nm-zoom"><button type="button" data-act="in" aria-label="Zoom in">+</button><button type="button" data-act="out" aria-label="Zoom out">−</button><button type="button" data-act="reset" aria-label="Show the whole map">⤢</button></div>
          ${legend()}
          <div class="ac-tip nm-tip" role="tooltip" hidden></div>
        </div>
        <aside class="nm-panel">${panel(d)}</aside>
      </div>`);
    if (active != null) {
      const el = $('#nmFind');
      el.focus();
      el.setSelectionRange(active, active);
    }
  }

  // ---- Camera ----

  function setCam(next, smooth = true) {
    const k = clampK(next.k);
    const size = S / k;
    const target = { k, x: Math.min(S - size, Math.max(0, next.x)), y: Math.min(S - size, Math.max(0, next.y)) };
    const svg = $('#mapView .nm-svg');
    if (!svg) return;
    cancelAnimationFrame(anim);
    const apply = (c) => {
      cam = c;
      svg.setAttribute('viewBox', `${c.x.toFixed(2)} ${c.y.toFixed(2)} ${(S / c.k).toFixed(2)} ${(S / c.k).toFixed(2)}`);
      svg.style.setProperty('--k', c.k.toFixed(3));
    };
    if (!smooth || reducedMotion()) return apply(target);
    const from = { ...cam };
    const t0 = performance.now();
    const step = (t) => {
      const u = Math.min(1, (t - t0) / 520);
      const e = 1 - (1 - u) ** 3;
      // Zoom in log space so it feels even.
      const k = Math.exp(Math.log(from.k) + (Math.log(target.k) - Math.log(from.k)) * e);
      const size = S / k;
      const cx = from.x + S / from.k / 2 + (target.x + S / target.k / 2 - (from.x + S / from.k / 2)) * e;
      const cy = from.y + S / from.k / 2 + (target.y + S / target.k / 2 - (from.y + S / from.k / 2)) * e;
      apply({ k, x: cx - size / 2, y: cy - size / 2 });
      if (u < 1) anim = requestAnimationFrame(step);
    };
    anim = requestAnimationFrame(step);
  }

  const zoomAt = (mx, my, k, smooth) => {
    const nk = clampK(k);
    // Keep the map point under the pointer where it is.
    const fx = (mx - cam.x) / (S / cam.k);
    const fy = (my - cam.y) / (S / cam.k);
    setCam({ k: nk, x: mx - fx * (S / nk), y: my - fy * (S / nk) }, smooth);
  };

  function toMap(svg, e) {
    const b = svg.getBoundingClientRect();
    const side = Math.min(b.width, b.height);
    const ox = b.left + (b.width - side) / 2;
    const oy = b.top + (b.height - side) / 2;
    return { x: cam.x + ((e.clientX - ox) / side) * (S / cam.k), y: cam.y + ((e.clientY - oy) / side) * (S / cam.k), scale: side / (S / cam.k) };
  }

  function flyToRegion(id) {
    const d = drawn;
    const pts = d.points.filter((p) => p.r === id);
    if (!pts.length) return;
    const xs = pts.map((p) => px(p.x));
    const ys = pts.map((p) => px(p.y));
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const size = Math.max(x1 - x0, y1 - y0) + 120;
    const k = clampK(S / size);
    setCam({ k, x: (x0 + x1) / 2 - S / k / 2, y: (y0 + y1) / 2 - S / k / 2 });
  }

  function selectRegion(id) {
    view.region = id;
    const panelEl = $('#mapView .nm-panel');
    if (panelEl) setHtml(panelEl, panel(drawn));
    const svg = $('#mapView .nm-svg');
    svg?.classList.toggle('focus', id >= 0 || !!view.q);
    for (const c of $('#mapView .nm-dots').children) c.classList.toggle('off', id >= 0 && drawn.points[c.dataset.i].r !== id);
    for (const t of $('#mapView .nm-terrs').children) t.classList.toggle('on', Number(t.dataset.t) === id);
    if (id >= 0) flyToRegion(id);
    else setCam({ x: 0, y: 0, k: 1 });
  }

  // ---- Pointer ----

  function nearest(svg, e) {
    const m = toMap(svg, e);
    let best = -1;
    let bestD = 16 / m.scale; // 16px reach
    drawn.points.forEach((p, i) => {
      if (view.region >= 0 && p.r !== view.region) return;
      const dd = Math.hypot(px(p.x) - m.x, px(p.y) - m.y) - radius(p) / cam.k;
      if (dd < bestD) [best, bestD] = [i, dd];
    });
    return best;
  }

  function showTip(i, e) {
    const tip = $('#mapView .nm-tip');
    const ring = $('#mapView .nm-ring');
    if (!tip || !ring) return;
    hot = i;
    if (i < 0) {
      tip.hidden = true;
      ring.setAttribute('r', '0');
      return;
    }
    const p = drawn.points[i];
    const r = drawn.regions.find((x) => x.id === p.r);
    setHtml(tip, `<p class="tt-h">${esc(p.t)}</p><p>${esc(p.src || '')}${p.o > 1 ? ` · <b>${p.o}</b> outlets` : ''} · ${esc(ago(p.at))}</p>${r ? `<p class="nm-tr">${esc(r.name)}</p>` : ''}`);
    tip.hidden = false;
    ring.setAttribute('cx', px(p.x));
    ring.setAttribute('cy', px(p.y));
    ring.setAttribute('r', (radius(p) + 4) / cam.k);
    const stage = $('#mapView .nm-stage').getBoundingClientRect();
    const tw = tip.offsetWidth;
    const left = Math.min(stage.width - tw - 8, Math.max(8, e.clientX - stage.left + 14));
    const top = e.clientY - stage.top + 16;
    tip.style.transform = `translate(${left}px, ${top > stage.height - 110 ? top - 120 : top}px)`;
  }

  function onPointer(e) {
    const svg = e.target.closest?.('.nm-svg');
    if (e.type === 'pointerdown' && svg) {
      drag = { x: e.clientX, y: e.clientY, cam: { ...cam }, moved: false, id: e.pointerId };
      return;
    }
    if (e.type === 'pointerup' || e.type === 'pointercancel') {
      if (drag) setTimeout(() => { drag = null; }, 0);
      return;
    }
    if (e.type === 'pointerleave') return showTip(-1);
    if (drag && e.buttons) {
      const s = $('#mapView .nm-svg');
      const m = toMap(s, e);
      const dx = (e.clientX - drag.x) / m.scale;
      const dy = (e.clientY - drag.y) / m.scale;
      if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 4) drag.moved = true;
      if (drag.moved) {
        setCam({ ...drag.cam, x: drag.cam.x - dx, y: drag.cam.y - dy }, false);
        showTip(-1);
      }
      return;
    }
    if (!svg || !drawn) return showTip(-1);
    const lab = e.target.closest('.nm-region');
    for (const t of $('#mapView .nm-terrs').children) t.classList.toggle('hot', !!lab && t.dataset.t === lab.dataset.r);
    if (lab) return showTip(-1);
    showTip(nearest(svg, e), e);
  }

  function onWheel(e) {
    const svg = e.target.closest?.('.nm-svg');
    if (!svg || !drawn || !(e.ctrlKey || e.metaKey || cam.k > 1 || e.deltaY < 0)) return;
    e.preventDefault();
    const m = toMap(svg, e);
    zoomAt(m.x, m.y, cam.k * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0022)), false);
  }

  function onClick(e) {
    if (!drawn) return;
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'in' || act === 'out') return zoomAt(cam.x + S / cam.k / 2, cam.y + S / cam.k / 2, cam.k * (act === 'in' ? 1.6 : 1 / 1.6));
    if (act === 'reset' || act === 'all') return selectRegion(-1);
    const reg = e.target.closest('[data-r]');
    if (reg) return selectRegion(Number(reg.dataset.r));
    const svg = e.target.closest('.nm-svg');
    if (!svg || drag?.moved) return;
    const i = nearest(svg, e);
    // On touch the first tap shows the headline, a second opens it.
    if (e.pointerType && e.pointerType !== 'mouse' && i !== hot) return showTip(i, e);
    if (i >= 0) {
      const p = drawn.points[i];
      if (p.sid) location.hash = `#story/${encodeURIComponent(p.sid)}`;
      else window.open(p.u, '_blank', 'noopener');
    }
  }

  function onKey(e) {
    if (e.target.id === 'nmFind') return;
    if (e.key === 'Enter' && e.target.closest?.('.nm-region')) selectRegion(Number(e.target.closest('.nm-region').dataset.r));
    if (e.key === 'Escape' && (view.region >= 0 || cam.k > 1)) selectRegion(-1);
  }

  let typing = 0;
  function onInput(e) {
    if (e.target.id !== 'nmFind') return;
    clearTimeout(typing);
    typing = setTimeout(() => {
      view.q = e.target.value.trim().slice(0, 60);
      history.replaceState(null, '', `#map?days=${view.days}${view.q ? `&q=${encodeURIComponent(view.q)}` : ''}`);
      // Restyle in place: no re-render, so the camera stays put.
      const q = view.q.toLowerCase();
      const svg = $('#mapView .nm-svg');
      svg?.classList.toggle('focus', view.region >= 0 || !!q);
      let found = 0;
      for (const c of $('#mapView .nm-dots')?.children || []) {
        const p = drawn.points[c.dataset.i];
        const hitQ = matches(p, q);
        if (q && hitQ) found++;
        c.classList.toggle('off', (q && !hitQ) || (view.region >= 0 && p.r !== view.region));
      }
      const meta = $('#mapView .nm-meta');
      if (meta) setHtml(meta, `${drawn.stories.toLocaleString()} stories from ${drawn.items.toLocaleString()} articles and posts${q ? ` · <b>${found}</b> match “${esc(view.q)}”` : ''}`);
    }, 140);
  }

  return { route, render, onPointer, onWheel, onClick, onKey, onInput };
}
