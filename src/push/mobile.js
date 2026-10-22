// Push notifications for the Android apps.
//
// Reader app ("wire" devices):
// - Breaking news, to every device that wants it (signed in or not).
// - Followed topics, names, X accounts and outlets: a story is sent once it
//   matches a follow and enough outlets carry it (the reader's threshold,
//   3 by default), so one blog post doesn't buzz a phone.
// - Per device: never the same story twice, a daily cap, quiet hours, and at
//   least 10 minutes between follow alerts (breaking ignores the gap).
//
// Admin app ("admin" devices, tied to an admin account):
// - New entries in FEATURES.md (the changelog), once each.
// - A source that stops working, and when it recovers.

import fs from 'node:fs';
import path from 'node:path';
import { q } from '../db.js';
import { HttpError } from '../security/httpkit.js';
import { sendFcm, fcmEnabled } from './fcm.js';
import { readPrefs, ALERT_DEFAULTS } from '../accounts/users.js';

const DAY = 86400e3;
const FOLLOW_GAP = 10 * 60e3;
const MAX_FAILS = 5;
export const pushStatus = { devices: 0, sent: 0, failed: 0, lastSent: null, lastError: null };

// ---------- devices ----------

const TOKEN_RE = /^[A-Za-z0-9_:.\-]{40,4096}$/;

export function registerDevice({ token, app, userId = null, adminUserId = null, platform = 'android' }, now = Date.now()) {
  if (!TOKEN_RE.test(String(token || ''))) throw new HttpError(400, 'That device token isn’t valid.');
  if (!['wire', 'admin'].includes(app)) throw new HttpError(400, 'Unknown app.');
  q(`INSERT INTO devices (token, app, user_id, admin_user_id, platform, created_at, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(token) DO UPDATE SET app = excluded.app, user_id = excluded.user_id, admin_user_id = excluded.admin_user_id, last_seen = excluded.last_seen, fails = 0`)
    .run(token, app, userId, adminUserId, String(platform).slice(0, 20), now, now);
  return deviceCount();
}

export function unregisterDevice(token) {
  return q('DELETE FROM devices WHERE token = ?').run(String(token || '')).changes > 0;
}

export const deviceCount = () => (pushStatus.devices = q('SELECT COUNT(*) AS n FROM devices').get().n);

// ---------- matching ----------

const lower = (s) => String(s || '').toLowerCase();
export const outletCount = (s) => new Set((s.sources || []).filter((x) => x.platform !== 'x').map((x) => x.host || x.name)).size;

// Which of a reader's follows a story matches, as a short reason ("OpenAI").
export function followMatch(story, follows) {
  const ents = new Set((story.entities || []).map(lower));
  const tops = new Set((story.topics || []).map(lower));
  for (const f of follows.names) if (ents.has(f.key)) return f.label;
  for (const f of follows.topics) if (tops.has(f.key)) return f.label;
  const handles = new Set((story.sources || []).filter((x) => x.platform === 'x').map((x) => lower(x.name).replace(/^@/, '')));
  for (const f of follows.accounts) if (handles.has(f.key.replace(/^@/, ''))) return `@${f.key.replace(/^@/, '')}`;
  const hosts = new Set((story.sources || []).map((x) => lower(x.host).replace(/^www\./, '')));
  for (const f of follows.outlets) if (hosts.has(f.key.replace(/^www\./, ''))) return f.label;
  return null;
}

// Quiet hours in the reader's own time zone (tz: minutes east of UTC).
export function inQuiet(quiet, now = Date.now()) {
  if (!quiet) return false;
  const h = new Date(now + quiet.tz * 60e3).getUTCHours();
  return quiet.from <= quiet.to ? h >= quiet.from && h < quiet.to : h >= quiet.from || h < quiet.to;
}

function devicesFor(app) {
  return q(`SELECT d.token, d.user_id, u.prefs, d.last_ok FROM devices d LEFT JOIN users u ON u.id = d.user_id WHERE d.app = ? AND d.fails < ?`).all(app, MAX_FAILS);
}

const prefsOf = (row) => (row.user_id ? readPrefs(row) : { follows: { topics: [], names: [], accounts: [], outlets: [] }, alerts: { ...ALERT_DEFAULTS, follows: false } });
const sentToday = (token, now) => q('SELECT COUNT(*) AS n FROM pushes_sent WHERE token = ? AND at > ?').get(token, now - DAY).n;
const lastSent = (token) => q("SELECT MAX(at) AS at FROM pushes_sent WHERE token = ? AND ref NOT LIKE 'breaking:%'").get(token).at || 0;
const already = (token, ref) => !!q('SELECT 1 FROM pushes_sent WHERE token = ? AND ref = ?').get(token, ref);

async function deliver(row, ref, msg, { send, now }) {
  // Claim first, so two updates racing can't both send it.
  const claimed = q('INSERT OR IGNORE INTO pushes_sent (token, ref, at) VALUES (?, ?, ?)').run(row.token, ref, now).changes;
  if (!claimed) return false;
  try {
    const r = await send(row.token, msg);
    if (r === 'gone') {
      unregisterDevice(row.token);
      return false;
    }
    q('UPDATE devices SET last_ok = ?, fails = 0 WHERE token = ?').run(now, row.token);
    pushStatus.sent++;
    pushStatus.lastSent = now;
    return true;
  } catch (err) {
    pushStatus.failed++;
    pushStatus.lastError = err.message;
    q('UPDATE devices SET fails = fails + 1 WHERE token = ?').run(row.token);
    return false;
  }
}

const storyMsg = (s, title, channel) => ({ title, body: s.title, channel, collapse: `story-${s.sid}`, data: { kind: 'story', sid: s.sid, url: s.url || '' } });

// A story broke: tell every reader device that wants breaking alerts.
export async function pushBreakingMobile(started, stories = [], { now = Date.now(), send = sendFcm, enabled = fcmEnabled() } = {}) {
  if (!enabled) return 0;
  const ev = [...started].sort((a, b) => b.peak - a.peak)[0];
  if (!ev) return 0;
  const story = stories.find((s) => s.sid === ev.sid) || { sid: ev.sid, title: ev.title, url: ev.url };
  let n = 0;
  for (const row of devicesFor('wire')) {
    const p = prefsOf(row);
    if (!p.alerts.breaking || inQuiet(p.alerts.quiet, now) || sentToday(row.token, now) >= p.alerts.maxPerDay) continue;
    if (await deliver(row, `breaking:${ev.sid}`, storyMsg(story, 'Breaking', 'breaking'), { send, now })) n++;
  }
  return n;
}

// After every snapshot: stories that now match someone's follows.
export async function pushFollows(stories, { now = Date.now(), send = sendFcm, enabled = fcmEnabled() } = {}) {
  if (!enabled) return 0;
  const fresh = stories.filter((s) => s.sid && now - (s.publishedAt || now) < 12 * 3600e3);
  if (!fresh.length) return 0;
  let n = 0;
  for (const row of devicesFor('wire')) {
    if (!row.user_id) continue;
    const p = prefsOf(row);
    if (!p.alerts.follows || inQuiet(p.alerts.quiet, now)) continue;
    if (now - lastSent(row.token) < FOLLOW_GAP || sentToday(row.token, now) >= p.alerts.maxPerDay) continue;
    // The biggest matching story not yet sent; one per pass.
    const pick = fresh
      .filter((s) => outletCount(s) >= p.alerts.minOutlets && !already(row.token, `story:${s.sid}`) && !already(row.token, `breaking:${s.sid}`))
      .map((s) => ({ s, why: followMatch(s, p.follows) }))
      .filter((x) => x.why)
      .sort((a, b) => outletCount(b.s) - outletCount(a.s))[0];
    if (pick && (await deliver(row, `story:${pick.s.sid}`, storyMsg(pick.s, pick.why, 'follows'), { send, now }))) n++;
  }
  return n;
}

// ---------- admin app ----------

// FEATURES.md entries: "## 2026-10-22 · Rumor mill (#rumors)" plus the body.
export function readChangelog(file = path.resolve('FEATURES.md'), limit = 200) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const out = [];
  const parts = text.split(/^## /m).slice(1);
  for (const part of parts) {
    const nl = part.indexOf('\n');
    const head = part.slice(0, nl < 0 ? undefined : nl).trim();
    const m = /^(\d{4}-\d{2}-\d{2})\s*·\s*(.+)$/.exec(head);
    if (!m) continue;
    const route = /\((#[^)]+)\)/.exec(m[2])?.[1] || null;
    out.push({ id: `${m[1]}:${m[2].replace(/\s*\(#[^)]*\)\s*$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, date: m[1], title: m[2].replace(/\s*\(#[^)]*\)\s*$/, '').trim(), route, body: part.slice(nl + 1).trim() });
    if (out.length >= limit) break;
  }
  return out;
}

export async function pushChangelog({ now = Date.now(), send = sendFcm, enabled = fcmEnabled(), entries = readChangelog() } = {}) {
  if (!enabled || !entries.length) return 0;
  const admins = devicesFor('admin');
  let n = 0;
  for (const row of admins) {
    // A device only hears about entries added after it registered.
    for (const e of entries.slice(0, 5).reverse()) {
      if (Date.parse(`${e.date}T23:59:59Z`) < (q('SELECT created_at FROM devices WHERE token = ?').get(row.token)?.created_at || now) - DAY) continue;
      const lead = e.body.replace(/\*\*/g, '').split('\n').find((l) => l.trim() && !l.startsWith('#'))?.trim() || '';
      if (await deliver(row, `feature:${e.id}`, { title: `Shipped: ${e.title}`, body: lead.replace(/^[-*]\s*/, '').slice(0, 200), channel: 'changelog', collapse: `feature-${e.id}`, data: { kind: 'feature', id: e.id } }, { send, now })) n++;
    }
  }
  return n;
}

const sourceState = new Map(); // name -> ok
export async function pushSourceHealth(sources = {}, { now = Date.now(), send = sendFcm, enabled = fcmEnabled() } = {}) {
  if (!enabled) return 0;
  let n = 0;
  for (const [name, s] of Object.entries(sources)) {
    const ok = !!s.ok && !s.error;
    const was = sourceState.get(name);
    sourceState.set(name, ok);
    if (was === undefined || was === ok) continue;
    const ref = `source:${name}:${ok ? 'up' : 'down'}:${Math.floor(now / 3600e3)}`;
    for (const row of devicesFor('admin')) {
      if (await deliver(row, ref, { title: ok ? `${name} is back` : `${name} stopped working`, body: ok ? 'The source is fetching again.' : String(s.error || 'No items on the last run.').slice(0, 200), channel: 'health', collapse: `source-${name}`, data: { kind: 'source', name } }, { send, now })) n++;
    }
  }
  return n;
}

export function prunePushes(now = Date.now()) {
  return Number(q('DELETE FROM pushes_sent WHERE at < ?').run(now - 7 * DAY).changes);
}

export function resetPushState() {
  sourceState.clear();
}
