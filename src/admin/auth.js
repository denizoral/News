// Admin authentication and authorization.
//
// - Passwords: scrypt (see security/passwords.js). No default account exists;
//   the first owner is created on the server with `npm run admin -- create`.
// - Sessions: 256-bit random token in an HttpOnly, SameSite=Strict cookie
//   (__Host- prefixed and Secure in production). Only its SHA-256 is stored,
//   so a database leak doesn't hand out live sessions. Idle and absolute
//   timeouts; a new token on every privilege change (login, second factor).
// - Second factor: TOTP, required by default (ADMIN_REQUIRE_2FA=off disables).
//   Until a user has enrolled, their session can only reach enrollment.
// - Brute force: per-IP and per-account token buckets, plus a growing
//   per-account lock after repeated failures. Unknown usernames take as long
//   as real ones, and every failure returns the same message.
// - CSRF: SameSite=Strict, plus a per-session token in a header and an
//   Origin check on every state-changing request.

import crypto from 'node:crypto';
import { q, tx } from '../db.js';
import { hashPassword, verifyPassword, burnTime, passwordProblem, BusyError } from '../security/passwords.js';
import { newTotpSecret, verifyTotp, otpauthUri, newRecoveryCodes, useRecoveryCode } from '../security/totp.js';
import { seal, open } from '../security/secretbox.js';
import { RateLimiter } from '../security/ratelimit.js';
import { parseCookies, serializeCookie, clientIp, HttpError } from '../security/httpkit.js';
import { roleAtLeast } from '../settings.js';

const PROD = process.env.NODE_ENV === 'production';
const SECURE_COOKIE = process.env.COOKIE_SECURE ? process.env.COOKIE_SECURE !== 'off' : PROD;
export const COOKIE = SECURE_COOKIE ? '__Host-fw_admin' : 'fw_admin';
const IDLE_MS = (Number(process.env.ADMIN_IDLE_MINUTES) || 30) * 60e3;
const ABSOLUTE_MS = (Number(process.env.ADMIN_SESSION_HOURS) || 12) * 3600e3;
const PENDING_MS = 10 * 60e3; // half-logged-in (password ok, second factor pending)
export const REQUIRE_2FA = process.env.ADMIN_REQUIRE_2FA !== 'off';
const ISSUER = 'Frontier Wire';

export const ROLES = ['viewer', 'editor', 'admin', 'owner'];

// What each permission needs. Routes ask for a permission, never a role.
const PERMISSIONS = {
  'dashboard:read': 'viewer',
  'content:write': 'editor',
  'site:write': 'editor',
  'crawler:write': 'admin',
  'storage:write': 'admin',
  'sources:write': 'admin',
  'audit:read': 'admin',
  'users:manage': 'admin',
};
export const can = (user, perm) => !!user && roleAtLeast(user.role, PERMISSIONS[perm] || 'owner');

const ipLimiter = new RateLimiter({ capacity: 20, refillPerSec: 20 / 900 }); // 20 attempts per 15 min per IP
const userLimiter = new RateLimiter({ capacity: 8, refillPerSec: 8 / 900 }); // 8 per 15 min per account
const mfaLimiter = new RateLimiter({ capacity: 6, refillPerSec: 6 / 300 }); // 6 codes per 5 min per session

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,31}$/i;

// ---------- users ----------

export function countUsers() {
  return q('SELECT COUNT(*) AS n FROM admin_users').get().n;
}

export function publicUser(u) {
  return u && {
    id: u.id, username: u.username, role: u.role, disabled: !!u.disabled, totpEnabled: !!u.totp_enabled,
    mustChangePassword: !!u.must_change_password, createdAt: u.created_at, createdBy: u.created_by, lastLoginAt: u.last_login_at,
    recoveryCodesLeft: u.recovery_codes ? JSON.parse(u.recovery_codes).length : 0,
  };
}

export async function createUser({ username, password, role, createdBy = null, mustChange = false }) {
  if (!USERNAME_RE.test(username || '')) throw new HttpError(400, 'Usernames are 3 to 32 letters, digits, dots, dashes or underscores.');
  if (!ROLES.includes(role)) throw new HttpError(400, 'Choose a role: viewer, editor, admin or owner.');
  const problem = passwordProblem(password, username);
  if (problem) throw new HttpError(400, problem);
  if (q('SELECT 1 FROM admin_users WHERE username = ?').get(username)) throw new HttpError(409, 'That username is taken.');
  const now = Date.now();
  const r = q('INSERT INTO admin_users (username, pw_hash, role, must_change_password, created_at, created_by, password_changed_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(username, await hashPassword(password), role, mustChange ? 1 : 0, now, createdBy, now);
  return getUser(Number(r.lastInsertRowid));
}

export const getUser = (id) => q('SELECT * FROM admin_users WHERE id = ?').get(id);
export const listUsers = () => q('SELECT * FROM admin_users ORDER BY created_at').all().map(publicUser);

export async function setPassword(userId, password, { mustChange = false } = {}) {
  const u = getUser(userId);
  const problem = passwordProblem(password, u.username);
  if (problem) throw new HttpError(400, problem);
  q('UPDATE admin_users SET pw_hash = ?, must_change_password = ?, password_changed_at = ?, failed_logins = 0, locked_until = 0 WHERE id = ?')
    .run(await hashPassword(password), mustChange ? 1 : 0, Date.now(), userId);
}

// ---------- sessions ----------

function issueSession(res, req, user, { mfaOk }) {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  const ttl = mfaOk ? ABSOLUTE_MS : PENDING_MS;
  q('INSERT INTO admin_sessions (id_hash, user_id, csrf, mfa_ok, created_at, last_seen, expires_at, ip, ua) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(sha256(token), user.id, crypto.randomBytes(24).toString('base64url'), mfaOk ? 1 : 0, now, now, now + ttl, clientIp(req), String(req.headers['user-agent'] || '').slice(0, 300));
  if (!isApp(req)) res.setHeader('Set-Cookie', serializeCookie(COOKIE, token, { maxAge: ttl / 1000, secure: SECURE_COOKIE }));
  return token;
}

export function clearCookie(res) {
  res.setHeader('Set-Cookie', serializeCookie(COOKIE, '', { maxAge: 0, secure: SECURE_COOKIE }));
}

function destroyByToken(token) {
  if (token) q('DELETE FROM admin_sessions WHERE id_hash = ?').run(sha256(token));
}

export function revokeSessions(userId, { exceptHash = null } = {}) {
  if (exceptHash) q('DELETE FROM admin_sessions WHERE user_id = ? AND id_hash != ?').run(userId, exceptHash);
  else q('DELETE FROM admin_sessions WHERE user_id = ?').run(userId);
}

export function listSessions(userId) {
  return q('SELECT id_hash, created_at, last_seen, expires_at, ip, ua, mfa_ok FROM admin_sessions WHERE user_id = ? ORDER BY last_seen DESC').all(userId)
    .map((s) => ({ id: s.id_hash.slice(0, 16), createdAt: s.created_at, lastSeen: s.last_seen, expiresAt: s.expires_at, ip: s.ip, ua: s.ua }));
}

export function revokeSessionByPrefix(userId, prefix) {
  if (!/^[a-f0-9]{16}$/.test(prefix)) return 0;
  return Number(q("DELETE FROM admin_sessions WHERE user_id = ? AND substr(id_hash, 1, 16) = ?").run(userId, prefix).changes);
}

// Resolve the session for a request. Returns null when there's none or it expired.
// The admin app sends its session token as `Authorization: Bearer …`; the
// dashboard uses the cookie. A browser never attaches a bearer token on its
// own, so bearer requests need no CSRF token.
export const APP_CLIENT = 'wire-admin-app';
const isApp = (req) => req.headers['x-client'] === APP_CLIENT;
function tokenOf(req) {
  const m = /^Bearer\s+([A-Za-z0-9_-]{20,100})$/.exec(String(req.headers.authorization || ''));
  return m ? { token: m[1], bearer: true } : { token: parseCookies(req)[COOKIE], bearer: false };
}

export function authenticate(req) {
  const { token, bearer } = tokenOf(req);
  if (!token || token.length > 100) return null;
  const idHash = sha256(token);
  const s = q('SELECT * FROM admin_sessions WHERE id_hash = ?').get(idHash);
  if (!s) return null;
  const now = Date.now();
  const user = getUser(s.user_id);
  const expired = now > s.expires_at || (s.mfa_ok && now - s.last_seen > IDLE_MS);
  // A password change or account lock ends every session issued before it.
  if (expired || !user || user.disabled || user.password_changed_at > s.created_at) {
    q('DELETE FROM admin_sessions WHERE id_hash = ?').run(idHash);
    return null;
  }
  if (now - s.last_seen > 30e3) q('UPDATE admin_sessions SET last_seen = ? WHERE id_hash = ?').run(now, idHash);
  return { session: s, idHash, user, token, bearer };
}

// Gate for every admin API call.
export function requireAuth(req, { permission = 'dashboard:read', stage = 'full' } = {}) {
  const a = authenticate(req);
  if (!a) throw new HttpError(401, 'Sign in to continue.');
  const pendingMfa = !a.session.mfa_ok;
  const needsEnroll = REQUIRE_2FA && !a.user.totp_enabled;
  if (stage === 'full') {
    if (pendingMfa) throw new HttpError(401, 'Enter the code from your authenticator app.', { next: 'mfa' });
    if (needsEnroll) throw new HttpError(403, 'Set up two-factor sign-in to continue.', { next: 'enroll' });
    if (a.user.must_change_password) throw new HttpError(403, 'Choose a new password to continue.', { next: 'password' });
  } else if (stage === 'enroll' && pendingMfa) {
    throw new HttpError(401, 'Enter the code from your authenticator app.', { next: 'mfa' });
  }
  if (permission && !can(a.user, permission)) throw new HttpError(403, "Your role doesn't allow this.");
  return a;
}

// Double-submit token plus Origin check. Called for every non-GET request.
export function checkCsrf(req, a) {
  if (a?.bearer) return;
  // The app signing in: no Origin, and a custom header no other site can
  // send without a CORS preflight (which this server never grants).
  if (!a && !req.headers.origin && isApp(req) && !parseCookies(req)[COOKIE]) return;
  const origin = req.headers.origin || '';
  const allowed = allowedOrigins(req);
  if (!origin || !allowed.includes(origin)) throw new HttpError(403, 'This request came from another site and was blocked.');
  if (a) {
    const sent = String(req.headers['x-csrf-token'] || '');
    const ok = sent.length === a.session.csrf.length && crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(a.session.csrf));
    if (!ok) throw new HttpError(403, 'Your session token is missing or stale. Reload the page.');
  }
}

function allowedOrigins(req) {
  if (process.env.PUBLIC_ORIGIN) return process.env.PUBLIC_ORIGIN.split(',').map((s) => s.trim().replace(/\/$/, ''));
  // Without an explicit origin, accept only the Host this request was sent to.
  const host = String(req.headers.host || '');
  return [`https://${host}`, ...(SECURE_COOKIE ? [] : [`http://${host}`])];
}

// ---------- login ----------

const FAIL = 'That username and password combination is wrong, or the account is locked.';

export async function login(req, res, creds) {
  try {
    return await doLogin(req, res, creds);
  } catch (err) {
    if (err instanceof BusyError) throw new HttpError(503, err.message, { retryAfter: 5 });
    throw err;
  }
}

async function doLogin(req, res, { username, password }) {
  const ip = clientIp(req);
  if (typeof username !== 'string' || typeof password !== 'string' || username.length > 64 || password.length > 256) {
    throw new HttpError(400, 'Enter a username and password.');
  }
  const ipOk = ipLimiter.take(`ip:${ip}`);
  const userOk = userLimiter.take(`u:${username.toLowerCase()}`);
  if (!ipOk.ok || !userOk.ok) {
    const retry = Math.max(ipOk.retryAfter, userOk.retryAfter);
    throw new HttpError(429, `Too many sign-in attempts. Try again in ${Math.ceil(retry / 60)} minutes.`, { retryAfter: retry });
  }
  const user = q('SELECT * FROM admin_users WHERE username = ?').get(username);
  if (!user) {
    await burnTime(password);
    throw new HttpError(401, FAIL, { audit: { action: 'login.failed', target: username, detail: { reason: 'unknown user' } } });
  }
  if (user.disabled || user.locked_until > Date.now()) {
    await burnTime(password);
    throw new HttpError(401, FAIL, { audit: { action: 'login.failed', target: username, userId: user.id, detail: { reason: user.disabled ? 'disabled' : 'locked' } } });
  }
  const v = await verifyPassword(password, user.pw_hash);
  if (!v.ok) {
    const fails = user.failed_logins + 1;
    // After 5 failures, lock for 1, 2, 4… minutes, capped at an hour.
    const lock = fails >= 5 ? Date.now() + Math.min(60, 2 ** (fails - 5)) * 60e3 : 0;
    q('UPDATE admin_users SET failed_logins = ?, locked_until = ? WHERE id = ?').run(fails, lock, user.id);
    throw new HttpError(401, FAIL, { audit: { action: 'login.failed', target: username, userId: user.id, detail: { reason: 'bad password', fails } } });
  }
  if (v.needsRehash) q('UPDATE admin_users SET pw_hash = ? WHERE id = ?').run(await hashPassword(password), user.id);
  q('UPDATE admin_users SET failed_logins = 0, locked_until = 0 WHERE id = ?').run(user.id);
  userLimiter.reset(`u:${username.toLowerCase()}`);

  // Replace any session this browser already had (prevents session fixation).
  destroyByToken(tokenOf(req).token);
  const mfaOk = !user.totp_enabled;
  const token = issueSession(res, req, user, { mfaOk });
  if (mfaOk) q('UPDATE admin_users SET last_login_at = ? WHERE id = ?').run(Date.now(), user.id);
  return { user, token: isApp(req) ? token : undefined, next: user.totp_enabled ? 'mfa' : REQUIRE_2FA ? 'enroll' : user.must_change_password ? 'password' : null };
}

export function secondFactor(req, res, { code, recoveryCode }) {
  const a = authenticate(req);
  if (!a || a.session.mfa_ok) throw new HttpError(401, 'Sign in again.');
  const lim = mfaLimiter.take(a.idHash);
  if (!lim.ok) throw new HttpError(429, 'Too many codes tried. Sign in again in a few minutes.', { retryAfter: lim.retryAfter });
  const user = a.user;
  let ok = false;
  if (recoveryCode) {
    const remaining = useRecoveryCode(JSON.parse(user.recovery_codes || '[]'), recoveryCode);
    if (remaining) {
      q('UPDATE admin_users SET recovery_codes = ? WHERE id = ?').run(JSON.stringify(remaining), user.id);
      ok = 'recovery';
    }
  } else {
    const step = verifyTotp(open(user.totp_secret), code, { lastStep: user.totp_last_step });
    if (step) {
      q('UPDATE admin_users SET totp_last_step = ? WHERE id = ?').run(step, user.id);
      ok = 'totp';
    }
  }
  // `next` keeps the half-signed-in session so the person can try again.
  if (!ok) throw new HttpError(401, "That code didn't work. Codes change every 30 seconds.", { next: 'mfa', audit: { action: 'login.mfa_failed', target: user.username, userId: user.id } });
  // Upgrade to a full session with a fresh token.
  q('DELETE FROM admin_sessions WHERE id_hash = ?').run(a.idHash);
  const token = issueSession(res, req, user, { mfaOk: true });
  q('UPDATE admin_users SET last_login_at = ? WHERE id = ?').run(Date.now(), user.id);
  return { user, method: ok, token: isApp(req) ? token : undefined };
}

export function logout(req, res) {
  destroyByToken(tokenOf(req).token);
  clearCookie(res);
}

// ---------- two-factor enrollment ----------

const pendingSecrets = new Map(); // userId -> { secret, at }

export function beginTotp(user) {
  const secret = newTotpSecret();
  pendingSecrets.set(user.id, { secret, at: Date.now() });
  return { secret, uri: otpauthUri(secret, user.username, ISSUER) };
}

export function confirmTotp(user, code) {
  const p = pendingSecrets.get(user.id);
  if (!p || Date.now() - p.at > 15 * 60e3) throw new HttpError(400, 'Start two-factor setup again; the code expired.');
  const step = verifyTotp(p.secret, code);
  if (!step) throw new HttpError(400, "That code didn't match. Check your phone's clock and try the newest code.");
  const { codes, hashes } = newRecoveryCodes();
  q('UPDATE admin_users SET totp_secret = ?, totp_enabled = 1, totp_last_step = ?, recovery_codes = ? WHERE id = ?').run(seal(p.secret), step, JSON.stringify(hashes), user.id);
  pendingSecrets.delete(user.id);
  return codes;
}

export async function disableTotp(user, password) {
  const v = await verifyPassword(password || '', user.pw_hash);
  if (!v.ok) throw new HttpError(401, 'That password is wrong.');
  if (REQUIRE_2FA) throw new HttpError(400, 'Two-factor sign-in is required on this server and can only be reset by an admin.');
  q('UPDATE admin_users SET totp_secret = NULL, totp_enabled = 0, recovery_codes = NULL WHERE id = ?').run(user.id);
}

export function resetTotp(userId) {
  tx(() => {
    q('UPDATE admin_users SET totp_secret = NULL, totp_enabled = 0, recovery_codes = NULL, totp_last_step = 0 WHERE id = ?').run(userId);
    revokeSessions(userId);
  });
}

export async function changeOwnPassword(a, current, next) {
  const v = await verifyPassword(current || '', a.user.pw_hash);
  if (!v.ok) throw new HttpError(401, 'Your current password is wrong.');
  if (current === next) throw new HttpError(400, 'Choose a password different from the current one.');
  await setPassword(a.user.id, next);
  // Everything else is signed out; this browser gets a fresh session.
  revokeSessions(a.user.id);
}

export function reissueAfterPasswordChange(req, res, userId) {
  issueSession(res, req, getUser(userId), { mfaOk: true });
}

export function pruneSessions() {
  q('DELETE FROM admin_sessions WHERE expires_at < ? OR (mfa_ok = 1 AND last_seen < ?)').run(Date.now(), Date.now() - IDLE_MS);
}
