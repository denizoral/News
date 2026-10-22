// Breaking alerts: the browsers that asked for them, and the push sent when
// a story breaks. At most one alert per 20 minutes, so two stories breaking
// together don't buzz a phone twice; the second is still on the banner.

import { q } from '../db.js';
import { sendPush, validSubscription } from './webpush.js';

const GAP = 20 * 60e3;
const MAX_FAILS = 5;
export const alertStatus = { subscribers: 0, sent: 0, failed: 0, lastSent: null, lastError: null };

export function subscribe(sub, now = Date.now()) {
  if (!validSubscription(sub)) return false;
  q(`INSERT INTO push_subs (endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, fails = 0`).run(sub.endpoint, sub.keys.p256dh, sub.keys.auth, now);
  return true;
}

export function unsubscribe(endpoint) {
  return q('DELETE FROM push_subs WHERE endpoint = ?').run(String(endpoint || '')).changes > 0;
}

export function subscriberCount() {
  return (alertStatus.subscribers = q('SELECT COUNT(*) AS n FROM push_subs').get().n);
}

let lastPush = 0;
// Pushes the newest of the stories that just broke. `send` is swapped in tests.
export async function pushBreaking(started, tracker, { now = Date.now(), send = sendPush } = {}) {
  const ev = started.filter((e) => !e.pushed).sort((a, b) => b.peak - a.peak)[0];
  if (!ev || now - lastPush < GAP) return 0;
  lastPush = now;
  for (const e of started) tracker.markPushed(e.sid);
  const payload = { title: 'Breaking', body: ev.title, url: `/#story/${ev.sid}`, tag: `breaking-${ev.sid}`, at: ev.startedAt };
  const subs = q('SELECT endpoint, p256dh, auth FROM push_subs').all();
  let ok = 0;
  // A few at a time: plenty for a hobby-sized list, gentle on the push services.
  for (let i = 0; i < subs.length; i += 8) {
    await Promise.all(subs.slice(i, i + 8).map(async (r) => {
      const sub = { endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth } };
      try {
        const status = await send(sub, payload, { topic: ev.sid });
        if (status === 404 || status === 410) return unsubscribe(r.endpoint);
        if (status >= 200 && status < 300) {
          ok++;
          q('UPDATE push_subs SET last_ok = ?, fails = 0 WHERE endpoint = ?').run(now, r.endpoint);
          return;
        }
        throw new Error(`push service answered ${status}`);
      } catch (err) {
        alertStatus.failed++;
        alertStatus.lastError = err.message;
        q('UPDATE push_subs SET fails = fails + 1 WHERE endpoint = ?').run(r.endpoint);
        q('DELETE FROM push_subs WHERE endpoint = ? AND fails >= ?').run(r.endpoint, MAX_FAILS);
      }
    }));
  }
  alertStatus.sent += ok;
  alertStatus.lastSent = now;
  subscriberCount();
  return ok;
}

export function resetAlertPacing() {
  lastPush = 0;
}
