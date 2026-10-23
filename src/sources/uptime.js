// AI service status: the incident history feeds that AI companies publish on
// their status pages (Atom/RSS, the same feed a reader would subscribe to).
// Several of these hosts disallow /api/ in robots.txt, so we read only the
// public history feed, with conditional GET, every ten minutes.
//
// Feeds come in four shapes, all reduced here to incidents with a list of
// updates ({ at, status, body }):
//   - Statuspage Atom: one entry per incident, every update in the content
//     ("Oct 22, 08:07 UTC — Resolved — ...").
//   - incident.io / Flashduty Atom: one entry per incident, the latest status
//     only ("Status: Resolved").
//   - Instatus-style RSS: one item per update, grouped by incident link.
// Feeds only carry recent incidents, so each poll merges into status_incidents
// and the history grows from there.

import { get, getTextCached as getText, pool } from '../http.js';
import { parseFeed } from './rss.js';
import { stripHtml, decodeEntities } from '../pipeline/text.js';
import { q, tx } from '../db.js';

export const SERVICES = [
  { key: 'openai', name: 'OpenAI', product: 'ChatGPT and the API', home: 'https://status.openai.com', feed: 'https://status.openai.com/history.atom', org: 'openai' },
  { key: 'claude', name: 'Claude', product: 'claude.ai, Claude Code and the API', home: 'https://status.claude.com', feed: 'https://status.claude.com/history.atom', org: 'anthropic' },
  { key: 'github', name: 'GitHub Copilot', product: 'Copilot (GitHub incidents that mention it)', home: 'https://www.githubstatus.com', feed: 'https://www.githubstatus.com/history.atom', org: 'github', only: /copilot/i },
  { key: 'cursor', name: 'Cursor', product: 'the Cursor editor and agents', home: 'https://status.cursor.com', feed: 'https://status.cursor.com/history.atom', org: 'cursor' },
  { key: 'perplexity', name: 'Perplexity', product: 'search, Comet and the API', home: 'https://status.perplexity.com', feed: 'https://status.perplexity.com/history.atom', org: 'perplexity' },
  { key: 'deepseek', name: 'DeepSeek', product: 'chat and the API', home: 'https://status.deepseek.com', feed: 'https://status.deepseek.com/history.atom', org: 'deepseek' },
  { key: 'huggingface', name: 'Hugging Face', product: 'the Hub, Inference and Spaces', home: 'https://status.huggingface.co', feed: 'https://status.huggingface.co/feed.atom', org: 'hugging-face' },
  { key: 'groq', name: 'Groq', product: 'GroqCloud', home: 'https://groqstatus.com', feed: 'https://groqstatus.com/history.atom', org: 'groq' },
  { key: 'together', name: 'Together AI', product: 'serverless and dedicated inference', home: 'https://status.together.ai', feed: 'https://status.together.ai/feed.atom', org: 'together' },
  { key: 'runway', name: 'Runway', product: 'video generation', home: 'https://status.runwayml.com', feed: 'https://status.runwayml.com/history.atom', org: 'runway' },
  { key: 'cohere', name: 'Cohere', product: 'the API', home: 'https://status.cohere.com', feed: 'https://status.cohere.com/history.atom', org: 'cohere' },
  { key: 'cloudflare-ai', name: 'Cloudflare AI', product: 'Workers AI and AI Gateway', home: 'https://www.cloudflarestatus.com', feed: 'https://www.cloudflarestatus.com/history.atom', org: 'cloudflare', only: /workers ai|ai gateway|\bai search\b|vectorize/i },
];

const MON = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
const RESOLVED = /^(?:resolved|completed?|restored|postmortem|closed|fixed)\b/i;

const clean = (s) => stripHtml(decodeEntities(s || '')).replace(/\s+/g, ' ').trim();
const normStatus = (s) => {
  const t = clean(s).toLowerCase();
  if (RESOLVED.test(t)) return 'resolved';
  if (/^monitor/.test(t)) return 'monitoring';
  if (/^identif/.test(t)) return 'identified';
  if (/^(?:in progress|verifying|update)/.test(t)) return 'update';
  if (/^scheduled/.test(t)) return 'scheduled';
  return t.split(/\s+/)[0] || 'update';
};

// Statuspage content: "<small>Oct <var>22</var>, <var>08:07</var> UTC</small><br><strong>Resolved</strong> - body".
// The year isn't given: it's the entry's year, or the one before when the
// month is later than the entry's (an incident that ran over New Year).
export function statuspageUpdates(html, refAt) {
  const out = [];
  const re = /<small>\s*([A-Z][a-z]{2})\s*<var[^>]*>(\d{1,2})<\/var>,?\s*(?:(\d{4})\s*-?\s*)?<var[^>]*>(\d{1,2}):(\d{2})<\/var>\s*UTC\s*<\/small>\s*(?:<br\s*\/?>)?\s*<strong>([^<]+)<\/strong>\s*-?\s*([\s\S]*?)(?=<\/p>|<small>|$)/g;
  const ref = new Date(refAt || Date.now());
  let m;
  while ((m = re.exec(html))) {
    const mon = MON[m[1].toLowerCase()];
    if (mon == null) continue;
    let year = m[3] ? +m[3] : ref.getUTCFullYear();
    if (!m[3] && mon > ref.getUTCMonth()) year--;
    out.push({ at: Date.UTC(year, mon, +m[2], +m[4], +m[5]), status: normStatus(m[6]), body: clean(m[7]).slice(0, 600) });
  }
  return out;
}

// incident.io / Flashduty: one status line and the affected components.
function latestOnly(html, at) {
  const st = /Status:\s*(?:<\/strong>|<\/b>)?\s*([A-Za-z ]+?)\s*(?:<|$)/.exec(html);
  const body = clean(html.replace(/<b>Status:[^<]*<\/b>|<p><strong>Status:<\/strong>[^<]*<\/p>/i, '').replace(/<b>Affected components<\/b>[\s\S]*$/i, '').replace(/<p><strong>Affected components:<\/strong>[\s\S]*$/i, ''));
  return [{ at, status: normStatus(st ? st[1] : body), body: body.slice(0, 600) }];
}

function componentsOf(html) {
  const li = [...html.matchAll(/<li>([^<(]+?)\s*(?:\([^)]*\))?\s*<\/li>/g)].map((m) => clean(m[1]));
  if (li.length) return li;
  const fd = /Affected components:<\/strong>\s*([^<]+)/i.exec(html);
  return fd ? clean(fd[1]).split(/\s*,\s*/).filter(Boolean) : [];
}

// Words in the incident decide how bad it was; status pages' own impact
// level isn't in their feeds.
export function severityOf(title, bodies = '') {
  const t = `${title} ${bodies}`;
  if (/^\s*(?:maintenance|scheduled)\b|\bscheduled maintenance\b|\bplanned maintenance\b/i.test(title)) return 'maintenance';
  if (/\b(?:outage|unavailable|down\b|not (?:loading|accessible|available|working)|inaccessible|all models|complete(?:ly)? (?:fail|unavail)|major)\b|中断|不可用/i.test(t)) return 'major';
  return 'minor';
}

// Feed text -> incidents for one service.
export function parseStatusFeed(xml, svc) {
  const byKey = new Map();
  for (const e of parseFeed(xml)) {
    if (!e.url) continue;
    const key = e.url.replace(/#.*$/, '').replace(/\/\/+(?=incidents?|maintenance)/, '/').replace(/\/maintenance\//, '/incident/');
    const html = e.summaryHtml || '';
    let updates = statuspageUpdates(html, e.publishedAt);
    if (!updates.length) {
      if (/Status:/i.test(html)) updates = latestOnly(html, e.publishedAt);
      else updates = [{ at: e.publishedAt, status: normStatus(/completed|resolved|restored/i.test(html) ? 'resolved' : /^\s*we will be performing|scheduled/i.test(clean(html)) ? 'scheduled' : 'update'), body: clean(html).slice(0, 600) }];
    }
    updates = updates.filter((u) => Number.isFinite(u.at));
    if (!updates.length) continue;
    const title = clean(e.title);
    const cur = byKey.get(key) || { service: svc.key, key, url: key, title, kind: /maintenance/i.test(e.category || '') || /^maintenance:/i.test(title) ? 'maintenance' : 'incident', components: [], updates: [] };
    cur.updates.push(...updates);
    cur.components = [...new Set([...cur.components, ...componentsOf(html)])];
    byKey.set(key, cur);
  }
  const out = [];
  for (const inc of byKey.values()) {
    if (svc.only && !svc.only.test(`${inc.title} ${inc.components.join(' ')} ${inc.updates.map((u) => u.body).join(' ')}`)) continue;
    inc.updates = dedupe(inc.updates);
    inc.severity = inc.kind === 'maintenance' ? 'maintenance' : severityOf(inc.title, inc.updates.map((u) => u.body).join(' '));
    if (inc.severity === 'maintenance') inc.kind = 'maintenance';
    out.push(inc);
  }
  return out;
}

function dedupe(updates) {
  const seen = new Set();
  return updates.filter((u) => {
    const k = `${u.at}:${u.status}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).sort((a, b) => a.at - b.at);
}

// Merge a poll into the table: updates are unioned, the start is the earliest
// time we know of (the first update, or when we first saw it ongoing).
export function saveIncidents(incidents, now = Date.now()) {
  if (!incidents.length) return 0;
  let fresh = 0;
  tx(() => {
    for (const inc of incidents) {
      const prev = q('SELECT updates, first_seen FROM status_incidents WHERE service = ? AND key = ?').get(inc.service, inc.key);
      const updates = dedupe([...(prev ? JSON.parse(prev.updates) : []), ...inc.updates]);
      const last = updates[updates.length - 1];
      const resolved = updates.find((u) => u.status === 'resolved');
      const firstSeen = prev?.first_seen ?? now;
      // A single-update feed (latest status only) gives no start; if we saw it
      // before it was resolved, our first sighting bounds it.
      const started = Math.min(updates[0].at, last.status !== 'resolved' || prev ? firstSeen : updates[0].at);
      if (!prev) fresh++;
      q(`INSERT INTO status_incidents (service, key, url, title, kind, severity, status, started_at, resolved_at, updated_at, components, updates, first_seen)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(service, key) DO UPDATE SET title = excluded.title, kind = excluded.kind, severity = excluded.severity, status = excluded.status,
           started_at = MIN(status_incidents.started_at, excluded.started_at), resolved_at = excluded.resolved_at, updated_at = excluded.updated_at,
           components = excluded.components, updates = excluded.updates`)
        .run(inc.service, inc.key, inc.url, inc.title, inc.kind, inc.severity, last.status, started, resolved && last.status === 'resolved' ? resolved.at : null, last.at,
          JSON.stringify(inc.components.slice(0, 20)), JSON.stringify(updates.slice(-40)), firstSeen);
    }
  });
  return fresh;
}

// incident.io pages (OpenAI, Groq, Perplexity) put only the latest status in
// the feed, but the incident's own page lists every update with its time.
// Fetched once per incident (and again while it's ongoing), a few per poll.
export function incidentIoUpdates(html) {
  const s = html.replace(/\\"/g, '"');
  const out = [];
  const re = /"published_at":"([^"]+)"(?:(?!"published_at")[\s\S]){0,400}?"to_status":"(\w+)"/g;
  let m;
  while ((m = re.exec(s))) {
    const at = Date.parse(m[1]);
    if (Number.isFinite(at)) out.push({ at, status: normStatus(m[2]), body: '' });
  }
  return dedupe(out);
}

const DETAIL_PER_POLL = 4;

async function enrich(svc) {
  const rows = q(`SELECT key, updates FROM status_incidents WHERE service = ? AND detailed = 0 AND key LIKE '%/incidents/%'
    ORDER BY (status != 'resolved') DESC, started_at DESC LIMIT ?`).all(svc.key, DETAIL_PER_POLL);
  for (const r of rows) {
    // Plain GET: these pages are large and read once, not worth the conditional cache.
    const html = await (await get(r.key, { timeout: 15000 })).text();
    const found = incidentIoUpdates(html);
    const prev = JSON.parse(r.updates);
    // Keep the feed's wording on the latest update.
    const merged = dedupe([...found.map((u) => ({ ...u, body: prev.find((p) => p.status === u.status)?.body || '' })), ...prev]);
    const last = merged[merged.length - 1];
    const resolved = last.status === 'resolved' ? merged.find((u) => u.status === 'resolved') : null;
    q(`UPDATE status_incidents SET updates = ?, started_at = MIN(started_at, ?), resolved_at = ?, status = ?, detailed = ? WHERE service = ? AND key = ?`)
      .run(JSON.stringify(merged.slice(-40)), merged[0].at, resolved?.at ?? null, last.status, last.status === 'resolved' ? 1 : 0, svc.key, r.key);
  }
}

export async function fetchUptime() {
  const errors = [];
  let count = 0, added = 0;
  const { errors: errs } = await pool(SERVICES, 4, async (svc) => {
    const xml = await getText(svc.feed, { headers: { accept: 'application/atom+xml, application/rss+xml, application/xml;q=0.9' } });
    const incs = parseStatusFeed(xml, svc);
    added += saveIncidents(incs);
    count += incs.length;
    if (/history\.atom$/.test(svc.feed) && incs.some((i) => /\/incidents\/[0-9A-Z]{26}$/.test(i.key))) await enrich(svc).catch((err) => errors.push({ source: svc.key, error: `detail: ${err.message}` }));
  });
  for (const e of errs) errors.push({ source: e.item.key, error: e.error });
  return { items: [], count, added, errors };
}
