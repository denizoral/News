// Dead ends, learned from fetched pages, so the rest isn't queued:
//   example.com/cs        a section in a language the crawler doesn't index
//   example.com/*         a whole site in one (the-decoder.de beside the-decoder.com)
//   example.com/partners  a section whose pages all come back empty (JS apps)
//   example.com/*         a site that keeps refusing the crawler (expires)
// Stored in kv as key -> { reason, at, until? }; the dashboard can forget one.

import { q } from '../db.js';
import { bare, sectionPath, localeOf } from './policy.js';

const KV_KEY = 'spider.deadEnds';
export const DEAD_END_REASONS = { language: 'another language', empty: 'pages come back empty', refuses: 'the site refuses the crawler' };

const splitKey = (key) => [key.slice(0, key.indexOf('/')), key.slice(key.indexOf('/') + 1)];

// The queued pages a key covers, as SQL: the site (with or without www.),
// optionally narrowed to a section.
function covering(key) {
  const [host, seg] = splitKey(key);
  if (seg === '*') return { where: 'host IN (?, ?)', args: [host, `www.${host}`] };
  return { where: 'host IN (?, ?) AND (url LIKE ? OR url LIKE ?)', args: [host, `www.${host}`, `https://${host}/${seg}/%`, `https://www.${host}/${seg}/%`] };
}

export class DeadEnds {
  // `cfg()` returns the live crawler settings (languages, hubHosts).
  constructor(cfg) {
    this.cfg = cfg;
    this.map = null;
    this.misses = new Map(); // "lang:host", "empty:host/section" -> unindexed pages in a row
  }

  all() {
    if (!this.map) {
      let stored = {};
      try {
        stored = JSON.parse(q('SELECT v FROM kv WHERE k = ?').get(KV_KEY)?.v || '{}');
        // Earlier versions kept translations as a plain list.
        for (const k of JSON.parse(q("SELECT v FROM kv WHERE k = 'spider.translations'").get()?.v || '[]')) stored[k] ??= { reason: 'language', at: Date.now() };
      } catch { /* start empty */ }
      this.map = new Map(Object.entries(stored));
    }
    return this.map;
  }

  save() {
    q('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(KV_KEY, JSON.stringify(Object.fromEntries([...this.all()].slice(-5000))));
  }

  learn(key, reason, { days = null } = {}) {
    const known = this.all();
    if (known.has(key) && !(known.get(key).until < Date.now())) return;
    known.set(key, { reason, at: Date.now(), ...(days ? { until: Date.now() + days * 86400e3 } : {}) });
    this.save();
    // What's already queued there goes too.
    const { where, args } = covering(key);
    const n = q(`UPDATE frontier SET status = 'skipped', error = ? WHERE ${where} AND status = 'queued' AND fetched_at IS NULL AND kind IN ('article', 'page')`)
      .run(`Learned dead end: ${DEAD_END_REASONS[reason] || reason}`, ...args).changes;
    console.log(`[spider] learned dead end ${key} (${reason}); ${n} queued URLs dropped`);
  }

  // Pages it dropped from the queue come back.
  forget(key) {
    const known = this.all();
    if (!known.has(key)) return false;
    const { where, args } = covering(key);
    q(`UPDATE frontier SET status = 'queued', error = NULL WHERE ${where} AND status = 'skipped' AND error LIKE 'Learned dead end%'`).run(...args);
    known.delete(key);
    this.save();
    return true;
  }

  has(u) {
    const known = this.all();
    if (!known.size) return false;
    const url = new URL(u);
    const host = bare(url.hostname);
    const seg = sectionPath(url);
    const hit = known.get(`${host}/*`) || (seg && (known.get(`${host}/${seg}`) || known.get(`${host}/${seg.split('/')[0]}`)));
    if (!hit || hit.until < Date.now()) return false;
    // Language dead ends only apply while languages are restricted.
    return hit.reason !== 'language' || this.cfg().languages.length > 0;
  }

  // Indexed pages in a wanted language on a site, or in one of its sections.
  wantedLanguageDocs(host, section = null) {
    const langs = this.cfg().languages;
    if (!langs.length) return 0;
    const inSection = section ? ' AND (url LIKE ? OR url LIKE ?)' : '';
    const args = section ? [`https://${host}/${section}/%`, `http://${host}/${section}/%`] : [];
    return q(`SELECT COUNT(*) AS n FROM docs WHERE site = ? AND fetched_at IS NOT NULL AND lang IN (${langs.map(() => '?').join(', ')})${inSection}`).get(host, ...langs, ...args).n;
  }

  // Language dead ends learned wrongly (a site or section with plenty of
  // indexed pages in a wanted language) are forgotten, which requeues what
  // they dropped. Run at startup.
  heal() {
    for (const [key, v] of [...this.all()]) {
      if (v.reason !== 'language') continue;
      const [host, seg] = splitKey(key);
      if (this.wantedLanguageDocs(host, seg === '*' ? null : seg) >= 3) {
        this.forget(key);
        console.log(`[spider] forgot dead end ${key}: it has pages in a wanted language`);
      }
    }
  }

  // Called with every page that wasn't indexed, and with every one that was
  // (`d.ok`), which resets the counts for its site.
  learnFromPage(page, d) {
    if (!page.url) return;
    const url = new URL(page.url);
    const host = bare(url.hostname);
    const seg = sectionPath(url);
    const first = (url.pathname.split('/')[1] || '').toLowerCase();
    if (d.ok) {
      for (const k of [`lang:${host}`, `lang:${host}/${first}`, `empty:${host}`, `empty:${host}/${seg}`]) this.misses.delete(k);
      return;
    }
    const bump = (k) => { const n = (this.misses.get(k) || 0) + 1; this.misses.set(k, n); return n; };
    const { languages: langs, hubHosts } = this.cfg();
    const hub = hubHosts.includes(host);
    // Only pages skipped for their language count (a mislabelled English page
    // that was skipped for something else is no evidence).
    if (langs.length && /^Language /.test(d.reason || '')) {
      // Keyed by the actual segment (/zh-cn/, not /zh/), which is what URLs are matched on.
      if (localeOf(page.url) === page.lang) this.learn(`${host}/${first}`, 'language');
      // A section in another language under any name (/cn/ for Chinese): 3 in a row.
      else if (first && bump(`lang:${host}/${first}`) >= 3 && this.wantedLanguageDocs(host, first) === 0) this.learn(`${host}/${first}`, 'language');
      // A whole site only if nothing from it was ever indexed in a wanted
      // language (multilingual sites like cloud.google.com have runs of
      // translated pages).
      else if (bump(`lang:${host}`) >= 5 && !hub && this.wantedLanguageDocs(host) === 0) this.learn(`${host}/*`, 'language');
    } else if (/^Too short \(0 words/.test(d.reason || '')) {
      if (seg && bump(`empty:${host}/${seg}`) >= 10) this.learn(`${host}/${seg}`, 'empty');
      else if (bump(`empty:${host}`) >= 25 && !hub) this.learn(`${host}/*`, 'empty');
    }
  }
}
