// Reader accounts: sign up and sign in with an email and password, with
// Google, or both on one account (same verified email). Separate from the
// admin accounts in src/admin/auth.js, and built the same way:
//
// - Passwords: scrypt (security/passwords.js), NIST-style rules.
// - Sessions: 256-bit random bearer tokens. Only their SHA-256 is stored;
//   30 days, sliding, and a password change ends every older session.
//   Bearer tokens are never sent by a browser on its own, so there's nothing
//   to forge cross-site (no cookie, no CSRF token needed).
// - Brute force: per-IP and per-email token buckets, then a growing lock.
//   Unknown emails take as long as real ones and fail with the same message.
// - Prefs: follows (topics, names, X accounts, outlets) and alert settings,
//   validated and capped on the way in.

import crypto from 'node:crypto';
import { q } from '../db.js';
import { hashPassword, verifyPassword, burnTime, passwordProblem } from '../security/passwords.js';
import { RateLimiter } from '../security/ratelimit.js';
import { clientIp, HttpError } from '../security/httpkit.js';

const SESSION_MS = 30 * 86400e3;
const TOKEN_PREFIX = 'fwu_';
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;
const FAIL = 'That email and password don’t match an account, or it’s locked for a few minutes.';

const ipLimiter = new RateLimiter({ capacity: 30, refillPerSec: 30 / 900 });
const emailLimiter = new RateLimiter({ capacity: 10, refillPerSec: 10 / 900 });
const signupLimiter = new RateLimiter({ capacity: 5, refillPerSec: 5 / 3600 }); // 5 accounts an hour per IP

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const normEmail = (e) => String(e || '').trim().toLowerCase();
// The email's name part counts as a username for the password rules when it's long enough to matter.
const nameOf = (email) => (email.split('@')[0].length >= 4 ? email.split('@')[0] : '');

export function publicUser(u) {
  return u && { id: u.id, email: u.email, name: u.name, hasPassword: !!u.pw_hash, google: !!u.google_sub, emailVerified: !!u.email_verified, createdAt: u.created_at, prefs: readPrefs(u) };
}

export const getUser = (id) => q('SELECT * FROM users WHERE id = ?').get(id);

function limit(req, email) {
  const a = ipLimiter.take(`ip:${clientIp(req)}`);
  const b = email ? emailLimiter.take(`e:${email}`) : { ok: true, retryAfter: 0 };
  if (!a.ok || !b.ok) {
    const retry = Math.max(a.retryAfter, b.retryAfter);
    throw new HttpError(429, `Too many attempts. Try again in ${Math.max(1, Math.ceil(retry / 60))} minutes.`, { retryAfter: retry });
  }
}

export function issueSession(req, user, client = 'app') {
  const token = TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  q('INSERT INTO user_sessions (id_hash, user_id, created_at, last_seen, expires_at, client, ip) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(sha256(token), user.id, now, now, now + SESSION_MS, String(client).slice(0, 40), clientIp(req));
  q('UPDATE users SET last_login_at = ? WHERE id = ?').run(now, user.id);
  return token;
}

// The account behind an `Authorization: Bearer fwu_…` header, or null.
export function authenticate(req) {
  const m = /^Bearer\s+(fwu_[A-Za-z0-9_-]{20,80})$/.exec(String(req.headers.authorization || ''));
  if (!m) return null;
  const idHash = sha256(m[1]);
  const s = q('SELECT * FROM user_sessions WHERE id_hash = ?').get(idHash);
  if (!s) return null;
  const now = Date.now();
  const user = getUser(s.user_id);
  if (!user || user.disabled || now > s.expires_at || user.password_changed_at > s.created_at) {
    q('DELETE FROM user_sessions WHERE id_hash = ?').run(idHash);
    return null;
  }
  // Sliding expiry, written at most once an hour.
  if (now - s.last_seen > 3600e3) q('UPDATE user_sessions SET last_seen = ?, expires_at = ? WHERE id_hash = ?').run(now, now + SESSION_MS, idHash);
  return { user, idHash };
}

export function requireUser(req) {
  const a = authenticate(req);
  if (!a) throw new HttpError(401, 'Sign in to continue.');
  return a;
}

export async function signup(req, { email, password, name }) {
  const e = normEmail(email);
  if (!EMAIL_RE.test(e) || e.length > 254) throw new HttpError(400, 'Enter a valid email address.', { fields: { email: 'invalid' } });
  const problem = passwordProblem(password, nameOf(e));
  if (problem) throw new HttpError(400, problem, { fields: { password: 'weak' } });
  const ok = signupLimiter.take(`ip:${clientIp(req)}`);
  if (!ok.ok) throw new HttpError(429, 'Too many new accounts from this network. Try again later.', { retryAfter: ok.retryAfter });
  const cleanName = String(name || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 60);
  const hash = await hashPassword(password);
  const existing = q('SELECT * FROM users WHERE email = ?').get(e);
  if (existing) {
    // A Google-only account can't be taken over by signing up with a
    // password: that needs signing in with Google first.
    throw new HttpError(409, 'There’s already an account with that email. Sign in instead.');
  }
  const now = Date.now();
  const r = q('INSERT INTO users (email, name, pw_hash, created_at, password_changed_at) VALUES (?, ?, ?, ?, ?)').run(e, cleanName, hash, now, now - 1);
  const user = getUser(Number(r.lastInsertRowid));
  return { user, token: issueSession(req, user, req.headers['x-client']) };
}

export async function login(req, { email, password }) {
  const e = normEmail(email);
  if (!e || typeof password !== 'string' || password.length > 256) throw new HttpError(400, 'Enter your email and password.');
  limit(req, e);
  const user = q('SELECT * FROM users WHERE email = ?').get(e);
  if (!user || !user.pw_hash || user.disabled || user.locked_until > Date.now()) {
    await burnTime(password);
    throw new HttpError(401, FAIL);
  }
  const v = await verifyPassword(password, user.pw_hash);
  if (!v.ok) {
    const fails = user.failed_logins + 1;
    const lock = fails >= 6 ? Date.now() + Math.min(60, 2 ** (fails - 6)) * 60e3 : 0;
    q('UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?').run(fails, lock, user.id);
    throw new HttpError(401, FAIL);
  }
  if (v.needsRehash) q('UPDATE users SET pw_hash = ? WHERE id = ?').run(await hashPassword(password), user.id);
  q('UPDATE users SET failed_logins = 0, locked_until = 0 WHERE id = ?').run(user.id);
  return { user, token: issueSession(req, user, req.headers['x-client']) };
}

// Google: the caller has already verified the ID token (google.js). Signs in
// the account linked to that Google user, links it to an account with the
// same verified email, or creates one.
export function googleLogin(req, claims) {
  limit(req, null);
  let user = q('SELECT * FROM users WHERE google_sub = ?').get(claims.sub);
  if (!user) {
    const e = normEmail(claims.email);
    const byEmail = q('SELECT * FROM users WHERE email = ?').get(e);
    if (byEmail) {
      if (byEmail.google_sub) throw new HttpError(409, 'That email is linked to a different Google account.');
      q('UPDATE users SET google_sub = ?, email_verified = 1 WHERE id = ?').run(claims.sub, byEmail.id);
      user = getUser(byEmail.id);
    } else {
      const now = Date.now();
      const r = q('INSERT INTO users (email, name, google_sub, email_verified, created_at) VALUES (?, ?, ?, 1, ?)').run(e, String(claims.name || '').slice(0, 60), claims.sub, now);
      user = getUser(Number(r.lastInsertRowid));
    }
  }
  if (user.disabled) throw new HttpError(403, 'This account is disabled.');
  return { user, token: issueSession(req, user, req.headers['x-client']) };
}

export function logout(a) {
  q('DELETE FROM user_sessions WHERE id_hash = ?').run(a.idHash);
}

export async function changePassword(req, a, { current, next }) {
  const u = a.user;
  if (u.pw_hash) {
    const v = await verifyPassword(String(current || ''), u.pw_hash);
    if (!v.ok) throw new HttpError(401, 'Your current password is wrong.');
  }
  const problem = passwordProblem(next, nameOf(u.email));
  if (problem) throw new HttpError(400, problem);
  const now = Date.now();
  q('UPDATE users SET pw_hash = ?, password_changed_at = ? WHERE id = ?').run(await hashPassword(next), now, u.id);
  // Every other session ends; this one gets a fresh token.
  q('DELETE FROM user_sessions WHERE user_id = ?').run(u.id);
  return issueSession(req, getUser(u.id), req.headers['x-client']);
}

export async function deleteAccount(a, { password }) {
  if (a.user.pw_hash) {
    const v = await verifyPassword(String(password || ''), a.user.pw_hash);
    if (!v.ok) throw new HttpError(401, 'That password is wrong.');
  }
  q('DELETE FROM users WHERE id = ?').run(a.user.id); // sessions and devices cascade
}

// ---------- prefs ----------

const KINDS = ['topics', 'names', 'accounts', 'outlets'];
export const ALERT_DEFAULTS = { breaking: true, follows: true, minOutlets: 3, quiet: null, maxPerDay: 12 };

export function readPrefs(u) {
  let raw = {};
  try { raw = JSON.parse(u.prefs || '{}'); } catch { /* reset below */ }
  return cleanPrefs(raw);
}

export function cleanPrefs(raw = {}) {
  const follows = {};
  for (const k of KINDS) {
    const list = Array.isArray(raw.follows?.[k]) ? raw.follows[k] : [];
    const seen = new Set();
    follows[k] = list
      .map((x) => ({ key: String(x?.key || '').trim().toLowerCase().slice(0, 80), label: String(x?.label || x?.key || '').trim().slice(0, 80) }))
      .filter((x) => x.key && !seen.has(x.key) && seen.add(x.key))
      .slice(0, 50);
  }
  const al = raw.alerts || {};
  const hour = (h) => (Number.isInteger(h) && h >= 0 && h < 24 ? h : null);
  const quiet = al.quiet && hour(al.quiet.from) != null && hour(al.quiet.to) != null ? { from: al.quiet.from, to: al.quiet.to, tz: Number.isFinite(al.quiet.tz) ? Math.max(-840, Math.min(840, Math.round(al.quiet.tz))) : 0 } : null;
  const alerts = {
    breaking: al.breaking !== undefined ? !!al.breaking : ALERT_DEFAULTS.breaking,
    follows: al.follows !== undefined ? !!al.follows : ALERT_DEFAULTS.follows,
    minOutlets: [1, 2, 3, 5, 8].includes(al.minOutlets) ? al.minOutlets : ALERT_DEFAULTS.minOutlets,
    maxPerDay: [3, 6, 12, 24, 48].includes(al.maxPerDay) ? al.maxPerDay : ALERT_DEFAULTS.maxPerDay,
    quiet,
  };
  return { follows, alerts };
}

export function savePrefs(a, body) {
  const cur = readPrefs(a.user);
  const next = cleanPrefs({ follows: body.follows || cur.follows, alerts: { ...cur.alerts, ...(body.alerts || {}) } });
  q('UPDATE users SET prefs = ? WHERE id = ?').run(JSON.stringify(next), a.user.id);
  return next;
}

export function pruneUserSessions(now = Date.now()) {
  return Number(q('DELETE FROM user_sessions WHERE expires_at < ?').run(now).changes);
}

export const countUsers = () => q('SELECT COUNT(*) AS n FROM users').get().n;
