// AI status board: incidents from AI services' status pages (stored by
// src/sources/uptime.js) turned into what a reader wants to know. Is it down
// right now? How often does it go down, for how long, and when? Did people
// on X and in the press notice before the status page said so?
//
// Coverage: for each service, documents in the last 90 days whose title names
// the service and an outage word; one lands on an incident when it was
// published between three hours before the incident started and twelve hours
// after it ended.

import { cachedJob } from './offload.js';
import { SERVICES } from '../sources/uptime.js';

const DAY = 86400e3;
const TTL_MS = 3 * 60e3;
export const UPTIME_DAYS = 90;

// FTS terms and a title check per service: the title must name it.
const TERMS = {
  openai: ['chatgpt OR openai OR sora OR codex', /\b(?:chatgpt|openai|sora|codex)\b/i],
  claude: ['claude OR anthropic', /\b(?:claude|anthropic)\b/i],
  github: ['copilot', /\bcopilot\b/i],
  cursor: ['cursor', /\bcursor\b/i],
  perplexity: ['perplexity', /\bperplexity\b/i],
  deepseek: ['deepseek', /\bdeepseek\b/i],
  huggingface: ['"hugging face" OR huggingface', /\bhugging ?face\b/i],
  groq: ['groq', /\bgroq\b/i],
  together: ['"together ai"', /\btogether ai\b/i],
  runway: ['runway', /\brunway\b/i],
  cohere: ['cohere', /\bcohere\b/i],
  'cloudflare-ai': ['"workers ai"', /\bworkers ai\b/i],
};
const OUTAGE_FTS = 'outage OR outages OR down OR "not working" OR unavailable OR degraded OR errors OR error OR disruption OR disrupted OR offline OR incident OR issues OR problems';
// "Down" only as a state ("ChatGPT is down", "down for thousands"), never
// "shut down" or "hands-down"; "errors" only as a service's error rate.
export const OUTAGE_RE = /\b(?:outages?|not working|unavailable|degraded|elevated errors|error rates?|disruptions?|disrupted|(?:is|was|were|are|goes|went|go|going|been) (?:down|offline)|down (?:for|again|globally|worldwide|across)|stopped working|(?:widespread|major|global) (?:issues|problems)|(?:new|status) incident)\b|(?<![-\w])down\s*(?:[:?!]|$)/i;

// Phrasal verbs with "down" that aren't outages.
const NOT_OUTAGE = /\b(?:slow|shut|shuts|shutting|crack|cracks|cracking|step|steps|stepping|wind|winds|winding|back|backs|backing|turn|turns|turning|tone|tones|water|watered|stand|stands|scale|scales|scaling|calm|bring|brings|take|takes|taking|track|tracks|tracking|hunt|hunts|knock|knocks)(?:\s+[\w’']+){0,3}\s+down\b/i;

const dayKey = (t) => new Date(t).toISOString().slice(0, 10);
const RANK = { major: 2, minor: 1, maintenance: 0 };
const STATE = { major: 3, minor: 2, maintenance: 1, ok: 0 };
const dayStart = (t) => Math.floor(t / DAY) * DAY;

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

// Duration in minutes when we know both ends from separate updates.
export function durationMin(inc) {
  if (!inc.resolved_at || inc.updates.length < 2) return null;
  const d = (inc.resolved_at - inc.started_at) / 60e3;
  return d > 0 ? Math.round(d) : null;
}

function coverage(db, svcKey, since) {
  const t = TERMS[svcKey];
  if (!t) return [];
  const rows = db.prepare(`SELECT id, url, type, title, site, source, author, published_at AS at FROM docs
    WHERE id IN (SELECT rowid FROM docs_fts WHERE docs_fts MATCH ?) AND published_at >= ? AND hidden = 0 AND type IN ('article', 'post')`)
    .all(`title:(${t[0]}) AND title:(${OUTAGE_FTS})`, since);
  return rows.filter((r) => t[1].test(r.title) && OUTAGE_RE.test(r.title) && !NOT_OUTAGE.test(r.title)).sort((a, b) => a.at - b.at);
}

export function computeUptime(db, now = Date.now()) {
  const since = now - UPTIME_DAYS * DAY;
  let rows;
  try {
    rows = db.prepare(`SELECT * FROM status_incidents WHERE started_at >= ? OR (resolved_at IS NULL AND updated_at >= ?) ORDER BY started_at DESC`).all(since, now - 3 * DAY);
  } catch {
    rows = []; // table not created yet (first start)
  }
  const incs = rows.map((r) => ({ ...r, updates: JSON.parse(r.updates), components: JSON.parse(r.components) }));
  const byService = new Map(SERVICES.map((s) => [s.key, []]));
  for (const i of incs) byService.get(i.service)?.push(i);

  const heat = Array.from({ length: 7 }, () => Array(24).fill(0));
  const out = [];
  const services = SERVICES.map((svc) => {
    const mine = byService.get(svc.key) || [];
    const docs = coverage(db, svc.key, since - DAY);
    // Ongoing: an incident whose latest update isn't resolved. Scheduled
    // maintenance that never posted "completed" stops counting after a day.
    const open = mine.filter((i) => i.status !== 'resolved' && (i.kind === 'incident' ? now - i.updated_at < 3 * DAY : i.status !== 'scheduled' && now - i.updated_at < DAY));
    // Each report goes to the one incident it's nearest in time to.
    const hitsOf = new Map();
    for (const x of docs) {
      let best = null, bd = Infinity;
      for (const i of mine) {
        if (i.kind !== 'incident' || x.at < i.started_at - 3 * 3600e3 || x.at > (i.resolved_at || now) + 12 * 3600e3) continue;
        const d = Math.abs(x.at - i.started_at);
        if (d < bd) { bd = d; best = i; }
      }
      if (best) (hitsOf.get(best) || hitsOf.set(best, []).get(best)).push(x);
    }
    const days = new Map();
    const durs = [];
    let openMin30 = 0;
    for (const i of mine) {
      const dur = durationMin(i);
      i.durMin = dur;
      if (i.kind === 'incident') {
        if (dur != null) durs.push(dur);
        if (i.started_at >= now - 30 * DAY) openMin30 += dur || 0;
        const d = new Date(i.started_at);
        heat[(d.getUTCDay() + 6) % 7][d.getUTCHours()]++;
      }
      // Each day the incident touched gets its worst severity.
      const end = i.resolved_at || (open.includes(i) ? now : i.updated_at);
      for (let t = dayStart(i.started_at); t <= end; t += DAY) {
        if (t < since - DAY) continue;
        const k = dayKey(t);
        const cur = days.get(k) || { d: k, sev: -1, n: 0, titles: [] };
        cur.sev = Math.max(cur.sev, RANK[i.severity] ?? 1);
        cur.n++;
        if (cur.titles.length < 3) cur.titles.push(i.title);
        days.set(k, cur);
      }
      // News and X coverage around the incident.
      const hits = hitsOf.get(i) || [];
      const first = hits[0];
      out.push({
        service: svc.key,
        name: svc.name,
        title: i.title,
        url: i.url,
        kind: i.kind,
        severity: i.severity,
        status: i.status,
        open: open.includes(i),
        started: i.started_at,
        resolved: i.resolved_at,
        durMin: dur,
        components: i.components.slice(0, 8),
        updates: i.updates.slice(-10).map((u) => ({ at: u.at, status: u.status, body: u.body.slice(0, 220) })),
        news: hits.length ? {
          n: hits.length,
          posts: hits.filter((x) => x.type === 'post').length,
          // Minutes the first report came before (negative) or after the status page's first update.
          leadMin: Math.round((first.at - i.started_at) / 60e3),
          items: hits.slice(0, 5).map((x) => ({ title: x.title, url: x.url, site: x.site, source: x.source || x.author || x.site, at: x.at, post: x.type === 'post' })),
        } : null,
      });
    }
    const last90 = mine.filter((i) => i.kind === 'incident');
    const state = open.some((i) => i.kind === 'incident' && i.severity === 'major') ? 'major'
      : open.some((i) => i.kind === 'incident') ? 'minor'
        : open.length ? 'maintenance' : 'ok';
    const strip = [];
    for (let t = dayStart(now - (UPTIME_DAYS - 1) * DAY); t <= now; t += DAY) {
      const d = days.get(dayKey(t));
      strip.push(d ? { d: d.d, sev: d.sev, n: d.n, titles: d.titles } : { d: dayKey(t), sev: -1 });
    }
    // Days before the first incident we've stored aren't known to be clean
    // when the feed doesn't reach that far back.
    const oldest = mine.length ? Math.min(...mine.map((i) => i.started_at)) : now;
    return {
      key: svc.key,
      name: svc.name,
      product: svc.product,
      home: svc.home,
      state,
      open: open.map((i) => ({ title: i.title, url: i.url, severity: i.severity, status: i.status, started: i.started_at })),
      days: strip,
      knownSince: dayKey(oldest),
      incidents30: last90.filter((i) => i.started_at >= now - 30 * DAY).length,
      incidents90: last90.length,
      majors90: last90.filter((i) => i.severity === 'major').length,
      openMin30,
      medianFixMin: median(durs),
      lastIncident: last90[0] ? { title: last90[0].title, at: last90[0].started_at } : null,
      coverage90: docs.length,
    };
  });

  out.sort((a, b) => b.open - a.open || b.started - a.started);
  const noticed = out.filter((i) => i.news && i.news.leadMin < 0);
  return {
    generatedAt: now,
    days: UPTIME_DAYS,
    services: services.sort((a, b) => STATE[b.state] - STATE[a.state] || b.incidents30 - a.incidents30),
    incidents: out.slice(0, 250),
    heat,
    stats: {
      open: out.filter((i) => i.open && i.kind === 'incident').length,
      incidents7: out.filter((i) => i.kind === 'incident' && i.started >= now - 7 * DAY).length,
      majors30: out.filter((i) => i.kind === 'incident' && i.severity === 'major' && i.started >= now - 30 * DAY).length,
      covered: out.filter((i) => i.news).length,
      noticedFirst: noticed.length,
    },
  };
}

export const uptimeQuery = () => cachedJob('uptime', { kind: 'uptime' }, TTL_MS);
