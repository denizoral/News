// Admin API and dashboard pages.
//
// Every route declares the sign-in stage and permission it needs; the router
// enforces them before the handler runs, along with CSRF/Origin checks on
// every state-changing request, a per-IP request budget, body size limits and
// an optional IP allowlist. Every change is written to the audit log.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import QRCode from 'qrcode';
import { q } from '../db.js';
import { settings, SCHEMA, roleAtLeast } from '../settings.js';
import { RateLimiter } from '../security/ratelimit.js';
import { clientIp, parseAllowlist, securityHeaders, readJson, sendJson, HttpError } from '../security/httpkit.js';
import { randomPassword } from '../security/passwords.js';
import * as auth from './auth.js';
import { audit, listAudit } from './audit.js';
import { listContent, getContent, updateContent, removeContent, contentCounts } from './content.js';
import { runRetention, optimizeIndex } from '../index/retention.js';
import { MEDIA_DIR } from '../spider/media.js';

const UI_DIR = path.resolve('admin-ui');
const UI_FILES = { '': 'index.html', 'app.js': 'app.js', 'styles.css': 'styles.css', 'favicon.svg': 'favicon.svg' };
const UI_TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

function normalizeAdminPath(p) {
  const v = `/${String(p || 'admin').replace(/^\/+|\/+$/g, '')}`;
  if (!/^\/[a-zA-Z0-9_-]{3,64}$/.test(v) || /^\/(api|media|data)$/.test(v)) throw new Error('ADMIN_PATH must be one path segment of 3-64 letters, digits, - or _.');
  return v;
}

export function createAdminRouter({ store, spider, runNow, sourceNames }) {
  const adminPath = normalizeAdminPath(process.env.ADMIN_PATH);
  const allowed = parseAllowlist(process.env.ADMIN_ALLOWED_IPS || '');
  const apiLimiter = new RateLimiter({ capacity: 240, refillPerSec: 4 }); // per IP, ~240/min sustained
  const routes = [];
  const route = (method, pattern, opts, handler) => routes.push({ method, re: new RegExp(`^/api/admin${pattern}$`), opts, handler });

  // ---------- session ----------

  route('GET', '/session', { auth: false }, ({ req }) => {
    const a = auth.authenticate(req);
    const base = { setupRequired: auth.countUsers() === 0, require2fa: auth.REQUIRE_2FA };
    if (!a) return { ...base, state: 'anonymous' };
    const state = !a.session.mfa_ok ? 'mfa' : auth.REQUIRE_2FA && !a.user.totp_enabled ? 'enroll' : a.user.must_change_password ? 'password' : 'ok';
    return { ...base, state, csrf: a.session.csrf, user: auth.publicUser(a.user), permissions: permissionsOf(a.user) };
  });

  route('POST', '/login', { auth: false, limit: 4096 }, async ({ req, res, body }) => {
    const { user, next } = await auth.login(req, res, body);
    audit(req, { user, action: next === 'mfa' ? 'login.password_ok' : 'login.success' });
    return { next };
  });

  route('POST', '/login/mfa', { auth: false, limit: 4096 }, ({ req, res, body }) => {
    const { user, method } = auth.secondFactor(req, res, body);
    audit(req, { user, action: 'login.success', detail: { method } });
    if (method === 'recovery') audit(req, { user, action: 'account.recovery_code_used' });
    return { ok: true };
  });

  route('POST', '/logout', { auth: false }, ({ req, res }) => {
    const a = auth.authenticate(req);
    if (a) {
      auth.checkCsrf(req, a);
      audit(req, { user: a.user, action: 'logout' });
    }
    auth.logout(req, res);
    return { ok: true };
  });

  // ---------- own account ----------

  route('POST', '/account/password', { stage: 'enroll', permission: null, limit: 4096 }, async ({ req, res, a, body }) => {
    await auth.changeOwnPassword(a, body.current, body.next);
    auth.reissueAfterPasswordChange(req, res, a.user.id);
    audit(req, { user: a.user, action: 'account.password_changed' });
    return { ok: true };
  });

  route('POST', '/account/totp/begin', { stage: 'enroll', permission: null }, async ({ a }) => {
    if (a.user.totp_enabled) throw new HttpError(409, 'Two-factor sign-in is already on.');
    const { secret, uri } = auth.beginTotp(a.user);
    const qr = await QRCode.toString(uri, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
    return { secret, uri, qr };
  });

  route('POST', '/account/totp/confirm', { stage: 'enroll', permission: null, limit: 4096 }, ({ req, a, body }) => {
    const codes = auth.confirmTotp(a.user, body.code);
    audit(req, { user: a.user, action: 'account.2fa_enabled' });
    return { recoveryCodes: codes };
  });

  route('POST', '/account/totp/disable', { permission: null, limit: 4096 }, async ({ req, a, body }) => {
    await auth.disableTotp(a.user, body.password);
    audit(req, { user: a.user, action: 'account.2fa_disabled' });
    return { ok: true };
  });

  route('GET', '/account/sessions', { permission: null }, ({ a }) => ({
    current: a.idHash.slice(0, 16),
    sessions: auth.listSessions(a.user.id),
  }));

  route('POST', '/account/sessions/revoke', { permission: null, limit: 1024 }, ({ req, a, body }) => {
    if (body.all) {
      auth.revokeSessions(a.user.id, { exceptHash: a.idHash });
      audit(req, { user: a.user, action: 'account.sessions_revoked', detail: { all: true } });
      return { ok: true };
    }
    if (body.id === a.idHash.slice(0, 16)) throw new HttpError(400, 'Use Sign out to end this session.');
    const n = auth.revokeSessionByPrefix(a.user.id, String(body.id || ''));
    audit(req, { user: a.user, action: 'account.sessions_revoked', detail: { count: n } });
    return { revoked: n };
  });

  // ---------- overview ----------

  route('GET', '/overview', {}, ({ a }) => {
    const sp = spider.status();
    const src = store.sourceStatus;
    const docsBytes = fileSize(path.resolve(process.env.DATA_DIR || 'data', 'wire.db')) + fileSize(path.resolve(process.env.DATA_DIR || 'data', 'wire.db-wal'));
    return {
      content: contentCounts(),
      docsByType: sp.docs,
      crawler: { running: sp.running, paused: sp.paused, pagesPerMinute: sp.pagesPerMinute, queued: sp.frontier.queued || 0, crawledPages: sp.crawledPages, hosts: sp.hosts, errors: sp.session.errors },
      sources: Object.entries(src).map(([name, s]) => ({ name, ok: s.ok, paused: !!s.paused, count: s.count, lastRun: s.lastRun, error: s.error })),
      storage: { dbBytes: docsBytes, mediaBytes: sp.images.bytes, images: sp.images.stored },
      feed: { stories: store.snapshot.stories.length, builds: store.snapshot.builds.length, markets: store.snapshot.markets.length, generatedAt: store.snapshot.generatedAt },
      security: securityChecks(),
      recentActivity: auth.can(a.user, 'audit:read') ? listAudit({ limit: 12 }) : [],
    };
  });

  // ---------- settings ----------

  route('GET', '/settings', {}, () => ({ settings: settings.describe() }));

  route('PATCH', '/settings', { permission: 'site:write', limit: 1024 * 1024 }, ({ req, a, body }) => {
    const r = settings.update(body, { role: a.user.role, actor: a.user.username });
    if (r.errors) throw new HttpError(400, 'Some settings were not saved.', { fields: r.errors });
    if (r.changes.length) {
      audit(req, { user: a.user, action: 'settings.update', target: r.changes.map((c) => c.key).join(', '), detail: r.changes.map((c) => ({ key: c.key, before: redactSetting(c.key, c.before), after: redactSetting(c.key, c.after) })) });
      store.scheduleRebuild();
    }
    return { changed: r.changes.map((c) => c.key), settings: settings.describe() };
  });

  // ---------- content ----------

  route('GET', '/content', {}, ({ url }) => listContent({
    search: url.searchParams.get('q') || '', type: url.searchParams.get('type') || '', state: url.searchParams.get('state') || 'all', page: url.searchParams.get('page') || 1,
  }));

  route('GET', '/content/(\\d+)', {}, ({ params }) => getContent(params[0]));

  route('PATCH', '/content/(\\d+)', { permission: 'content:write', limit: 16384 }, ({ req, a, params, body }) => {
    const r = updateContent(params[0], pick(body, ['title', 'description', 'type', 'hidden', 'pinned', 'locked']), a.user.username);
    audit(req, { user: a.user, action: 'content.update', target: `${r.doc.id} ${r.doc.url}`, detail: r.changed });
    store.scheduleRebuild();
    return r.doc;
  });

  route('POST', '/content/(\\d+)/remove', { permission: 'content:write' }, ({ req, a, params }) => {
    const r = removeContent(params[0], a.user.username);
    audit(req, { user: a.user, action: 'content.remove', target: `${r.id} ${r.url}`, detail: { title: r.title, images: r.images } });
    store.scheduleRebuild();
    return r;
  });

  // ---------- crawler ----------

  route('GET', '/crawler', {}, () => ({ status: spider.status(), queue: spider.queueSummary() }));

  route('GET', '/crawler/live', {}, () => spider.live());

  route('GET', '/crawler/log', {}, ({ url }) => ({
    entries: spider.logEntries({
      host: (url.searchParams.get('host') || '').slice(0, 100), outcome: (url.searchParams.get('outcome') || '').slice(0, 20),
      before: url.searchParams.get('before'), limit: 100,
    }),
  }));

  // Dry run: fetches one page (through the SSRF guard and robots.txt) and
  // reports what would happen, without writing anything.
  const inspectLimiter = new RateLimiter({ capacity: 10, refillPerSec: 10 / 60 });
  route('POST', '/crawler/inspect', { permission: 'crawler:write', limit: 4096 }, async ({ req, a, body }) => {
    const lim = inspectLimiter.take(`u:${a.user.id}`);
    if (!lim.ok) throw new HttpError(429, 'Too many test fetches. Wait a minute.', { retryAfter: lim.retryAfter });
    let u;
    try {
      u = new URL(String(body.url || ''));
    } catch {
      throw new HttpError(400, 'Enter a full http:// or https:// link.');
    }
    if (!/^https?:$/.test(u.protocol)) throw new HttpError(400, 'Only http and https links can be tested.');
    audit(req, { user: a.user, action: 'crawler.inspect', target: u.toString() });
    return spider.inspect(u.toString());
  });

  route('GET', '/crawler/hosts', {}, ({ url }) => ({ hosts: spider.hosts({ search: (url.searchParams.get('q') || '').slice(0, 100), limit: Math.min(500, Number(url.searchParams.get('limit')) || 100) }) }));

  route('GET', '/crawler/robots', {}, ({ url }) => {
    const host = String(url.searchParams.get('host') || '').toLowerCase();
    if (!/^[a-z0-9.-]{3,253}$/.test(host)) throw new HttpError(400, 'Enter a host name.');
    return { host, robots: spider.robotsFor(host) };
  });

  route('POST', '/crawler/crawl', { permission: 'crawler:write', limit: 4096 }, ({ req, a, body }) => {
    let u;
    try {
      u = new URL(String(body.url || ''));
    } catch {
      throw new HttpError(400, 'Enter a full http:// or https:// link.');
    }
    if (!/^https?:$/.test(u.protocol)) throw new HttpError(400, 'Only http and https links can be crawled.');
    const queued = spider.crawlNow(u.toString(), `admin:${a.user.username}`);
    audit(req, { user: a.user, action: 'crawler.crawl_now', target: queued });
    return { queued };
  });

  route('POST', '/crawler/purge', { permission: 'crawler:write', limit: 1024 }, ({ req, a, body }) => {
    const host = hostParam(body.host);
    const removed = spider.purgeHost(host);
    audit(req, { user: a.user, action: 'crawler.purge_host', target: host, detail: { removed } });
    return { removed };
  });

  route('POST', '/crawler/requeue', { permission: 'crawler:write', limit: 1024 }, ({ req, a, body }) => {
    const host = body.host ? hostParam(body.host) : null;
    const requeued = spider.requeueErrors(host);
    audit(req, { user: a.user, action: 'crawler.requeue_errors', target: host || 'all', detail: { requeued } });
    return { requeued };
  });

  route('POST', '/crawler/dismiss-hub', { permission: 'crawler:write', limit: 1024 }, ({ req, a, body }) => {
    const host = hostParam(body.host);
    spider.dismissHub(host);
    audit(req, { user: a.user, action: 'crawler.dismiss_hub', target: host });
    return { ok: true };
  });

  route('POST', '/crawler/refresh-robots', { permission: 'crawler:write', limit: 1024 }, ({ req, a, body }) => {
    const host = hostParam(body.host);
    spider.refreshRobots(host);
    audit(req, { user: a.user, action: 'crawler.refresh_robots', target: host });
    return { ok: true };
  });

  // ---------- sources ----------

  route('GET', '/sources', {}, () => ({
    sources: sourceNames.map((name) => ({
      name, status: store.sourceStatus[name] || null,
      enabled: settings.get(`sources.${name}.enabled`), intervalSec: settings.get(`sources.${name}.intervalSec`),
    })),
  }));

  route('POST', '/sources/(\\w+)/run', { permission: 'sources:write' }, async ({ req, a, params }) => {
    if (!sourceNames.includes(params[0])) throw new HttpError(404, 'No source with that name.');
    await runNow(params[0]);
    audit(req, { user: a.user, action: 'sources.run_now', target: params[0] });
    return { status: store.sourceStatus[params[0]] };
  });

  // ---------- storage ----------

  route('GET', '/storage', {}, () => {
    const dir = path.resolve(process.env.DATA_DIR || 'data');
    return {
      dbBytes: fileSize(path.join(dir, 'wire.db')), walBytes: fileSize(path.join(dir, 'wire.db-wal')),
      media: q("SELECT COUNT(*) AS files, COALESCE(SUM(bytes), 0) AS bytes FROM images WHERE status = 'stored'").get(),
      imagesByStatus: Object.fromEntries(q('SELECT status, COUNT(*) AS n FROM images GROUP BY status').all().map((r) => [r.status, r.n])),
      docs: q('SELECT COUNT(*) AS n, MIN(COALESCE(published_at, first_seen)) AS oldest FROM docs').get(),
      frontier: q('SELECT COUNT(*) AS n FROM frontier').get().n,
      auditRows: q('SELECT COUNT(*) AS n FROM audit_log').get().n,
      mediaDir: path.relative(process.cwd(), MEDIA_DIR),
    };
  });

  route('POST', '/storage/prune', { permission: 'storage:write' }, ({ req, a }) => {
    const r = runRetention();
    audit(req, { user: a.user, action: 'storage.prune', detail: r });
    return r;
  });

  route('POST', '/storage/optimize', { permission: 'storage:write' }, ({ req, a }) => {
    optimizeIndex();
    audit(req, { user: a.user, action: 'storage.optimize' });
    return { ok: true };
  });

  // ---------- users ----------

  route('GET', '/users', { permission: 'users:manage' }, () => ({ users: auth.listUsers() }));

  route('POST', '/users', { permission: 'users:manage', limit: 4096 }, async ({ req, a, body }) => {
    const role = String(body.role || '');
    assertCanManageRole(a.user, role);
    const temp = randomPassword();
    const user = await auth.createUser({ username: String(body.username || '').trim(), password: temp, role, createdBy: a.user.username, mustChange: true });
    audit(req, { user: a.user, action: 'users.create', target: user.username, detail: { role } });
    return { user: auth.publicUser(user), temporaryPassword: temp };
  });

  route('PATCH', '/users/(\\d+)', { permission: 'users:manage', limit: 4096 }, ({ req, a, params, body }) => {
    const target = managedUser(a.user, params[0]);
    const changes = {};
    if ('role' in body) {
      assertCanManageRole(a.user, body.role);
      if (target.role === 'owner' && body.role !== 'owner') assertNotLastOwner(target);
      changes.role = body.role;
    }
    if ('disabled' in body) {
      if (typeof body.disabled !== 'boolean') throw new HttpError(400, 'disabled must be true or false.');
      if (body.disabled && target.role === 'owner') assertNotLastOwner(target);
      changes.disabled = body.disabled;
    }
    if (!Object.keys(changes).length) throw new HttpError(400, 'Nothing to change.');
    if (changes.role) q('UPDATE admin_users SET role = ? WHERE id = ?').run(changes.role, target.id);
    if ('disabled' in changes) q('UPDATE admin_users SET disabled = ? WHERE id = ?').run(changes.disabled ? 1 : 0, target.id);
    auth.revokeSessions(target.id); // new permissions take effect at next sign-in
    audit(req, { user: a.user, action: 'users.update', target: target.username, detail: { before: { role: target.role, disabled: !!target.disabled }, after: changes } });
    return { user: auth.publicUser(auth.getUser(target.id)) };
  });

  route('POST', '/users/(\\d+)/reset-password', { permission: 'users:manage' }, async ({ req, a, params }) => {
    const target = managedUser(a.user, params[0]);
    const temp = randomPassword();
    await auth.setPassword(target.id, temp, { mustChange: true });
    auth.revokeSessions(target.id);
    audit(req, { user: a.user, action: 'users.reset_password', target: target.username });
    return { temporaryPassword: temp };
  });

  route('POST', '/users/(\\d+)/reset-2fa', { permission: 'users:manage' }, ({ req, a, params }) => {
    const target = managedUser(a.user, params[0]);
    auth.resetTotp(target.id);
    audit(req, { user: a.user, action: 'users.reset_2fa', target: target.username });
    return { ok: true };
  });

  route('POST', '/users/(\\d+)/revoke-sessions', { permission: 'users:manage' }, ({ req, a, params }) => {
    const target = managedUser(a.user, params[0]);
    auth.revokeSessions(target.id);
    audit(req, { user: a.user, action: 'users.revoke_sessions', target: target.username });
    return { ok: true };
  });

  // ---------- audit ----------

  route('GET', '/audit', { permission: 'audit:read' }, ({ url }) => ({
    entries: listAudit({ action: url.searchParams.get('action') || '', user: url.searchParams.get('user') || '', before: url.searchParams.get('before'), limit: 100 }),
  }));

  // ---------- dispatcher ----------

  async function handleApi(req, res, url) {
    securityHeaders(res, { admin: true });
    const reqId = crypto.randomBytes(6).toString('hex');
    try {
      const lim = apiLimiter.take(clientIp(req));
      if (!lim.ok) throw new HttpError(429, 'Too many requests. Slow down.', { retryAfter: lim.retryAfter });
      const r = routes.find((x) => x.method === req.method && x.re.test(url.pathname));
      if (!r) {
        const exists = routes.some((x) => x.re.test(url.pathname));
        throw new HttpError(exists ? 405 : 404, exists ? 'Method not allowed.' : 'Not found.');
      }
      const params = url.pathname.match(r.re).slice(1);
      const mutating = req.method !== 'GET';
      let a = null;
      if (r.opts.auth !== false) {
        a = auth.requireAuth(req, { permission: r.opts.permission === undefined ? 'dashboard:read' : r.opts.permission, stage: r.opts.stage || 'full' });
        if (mutating) auth.checkCsrf(req, a);
      } else if (mutating) {
        auth.checkCsrf(req, null); // Origin check; there's no session token yet
      }
      const body = mutating ? await readJson(req, { limit: r.opts.limit || 65536 }) : null;
      const out = await r.handler({ req, res, url, params, a, body: body || {} });
      return sendJson(res, 200, out ?? { ok: true });
    } catch (err) {
      if (err instanceof HttpError) {
        if (err.extra?.audit) {
          try { audit(req, { ...err.extra.audit, username: err.extra.audit.target }); } catch { /* never mask the response */ }
        }
        const headers = err.extra?.retryAfter ? { 'retry-after': String(err.extra.retryAfter) } : {};
        if (err.status === 401 && !err.extra?.next) auth.clearCookie(res);
        return sendJson(res, err.status, { error: err.message, next: err.extra?.next, fields: err.extra?.fields }, headers);
      }
      // Never leak internals; log them with an id the admin can quote.
      console.error(`[admin ${reqId}]`, err);
      return sendJson(res, 500, { error: `Something went wrong on the server (reference ${reqId}).` });
    }
  }

  function serveUi(req, res, url) {
    if (url.pathname === adminPath) {
      res.writeHead(308, { location: `${adminPath}/` });
      return res.end();
    }
    const rel = url.pathname.slice(adminPath.length + 1);
    const file = UI_FILES[rel];
    if (!file || (req.method !== 'GET' && req.method !== 'HEAD')) return notFound(res);
    securityHeaders(res, { admin: true });
    fs.readFile(path.join(UI_DIR, file), (err, data) => {
      if (err) return notFound(res);
      res.writeHead(200, { 'content-type': UI_TYPES[path.extname(file)] });
      res.end(req.method === 'HEAD' ? undefined : data);
    });
  }

  function notFound(res) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }

  // Returns true when the request was for the admin area.
  return function handle(req, res, url) {
    const isApi = url.pathname === '/api/admin' || url.pathname.startsWith('/api/admin/');
    const isUi = url.pathname === adminPath || url.pathname.startsWith(`${adminPath}/`);
    if (!isApi && !isUi) return false;
    // Outside the allowlist the admin area doesn't exist.
    if (allowed && !allowed(clientIp(req))) {
      notFound(res);
      return true;
    }
    if (isApi) handleApi(req, res, url);
    else serveUi(req, res, url);
    return true;
  };
}

// ---------- helpers ----------

function permissionsOf(user) {
  return ['content:write', 'site:write', 'crawler:write', 'storage:write', 'sources:write', 'audit:read', 'users:manage'].filter((p) => auth.can(user, p));
}

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (Object.prototype.hasOwnProperty.call(obj, k)) out[k] = obj[k];
  return out;
}

function hostParam(h) {
  const host = String(h || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!/^[a-z0-9.-]{3,253}$/.test(host)) throw new HttpError(400, 'Enter a host name like example.com.');
  return host;
}

// Admins manage editors and viewers; only owners manage admins and owners.
function assertCanManageRole(actor, role) {
  if (!auth.ROLES.includes(role)) throw new HttpError(400, 'Choose a role: viewer, editor, admin or owner.');
  if ((role === 'admin' || role === 'owner') && actor.role !== 'owner') throw new HttpError(403, 'Only owners can grant the admin or owner role.');
}

function managedUser(actor, id) {
  const target = auth.getUser(Number(id));
  if (!target) throw new HttpError(404, 'No user with that id.');
  if (target.id === actor.id) throw new HttpError(400, 'Change your own account from the Account page.');
  if (!roleAtLeast(actor.role, 'owner') && roleAtLeast(target.role, 'admin')) throw new HttpError(403, 'Only owners can change admins and owners.');
  return target;
}

function assertNotLastOwner(target) {
  const owners = q("SELECT COUNT(*) AS n FROM admin_users WHERE role = 'owner' AND disabled = 0 AND id != ?").get(target.id).n;
  if (!owners) throw new HttpError(400, 'This is the last active owner. Make someone else an owner first.');
}

function redactSetting(key, value) {
  // Nothing secret lives in settings today; keep large values readable in the log.
  if (Array.isArray(value) && value.length > 50) return { items: value.length };
  if (typeof value === 'string' && value.length > 2000) return `${value.slice(0, 2000)}…`;
  return SCHEMA.has(key) ? value : undefined;
}

function fileSize(f) {
  try {
    return fs.statSync(f).size;
  } catch {
    return 0;
  }
}

function securityChecks() {
  const prod = process.env.NODE_ENV === 'production';
  const checks = [
    { ok: prod, label: 'Running with NODE_ENV=production', fix: 'Set NODE_ENV=production so cookies are Secure and HSTS is sent.' },
    { ok: auth.COOKIE.startsWith('__Host-'), label: 'Session cookie is Secure and host-locked', fix: 'Serve over HTTPS and leave COOKIE_SECURE unset (or on).' },
    { ok: settings.get('crawler.obeyRobots'), label: 'Crawler obeys robots.txt', fix: 'robots.txt is switched off for every site (Crawler > Settings). Sites may ban the crawler, and it can carry legal risk.' },
    { ok: auth.REQUIRE_2FA, label: 'Two-factor sign-in required', fix: 'Remove ADMIN_REQUIRE_2FA=off.' },
    { ok: !!process.env.ADMIN_ALLOWED_IPS, label: 'Admin area limited to known IP addresses', fix: 'Set ADMIN_ALLOWED_IPS to your office or VPN ranges.' },
    { ok: !!process.env.ADMIN_ENCRYPTION_KEY, label: 'Encryption key from the environment', fix: 'Set ADMIN_ENCRYPTION_KEY (openssl rand -base64 32) from your secret manager instead of the generated key file.' },
    { ok: process.env.TRUST_PROXY != null || !prod, label: 'Client IP addresses resolved through your proxy', fix: 'Behind a load balancer or CDN, set TRUST_PROXY to the number of proxy hops. Without it every visitor shares one rate limit and the IP allowlist sees only the proxy.' },
    { ok: (process.env.ADMIN_PATH || 'admin') !== 'admin', label: 'Admin area at a non-default address', fix: 'Set ADMIN_PATH to something less guessable. (This only cuts noise; it is not a security boundary.)' },
    { ok: !!process.env.PUBLIC_ORIGIN, label: 'Allowed origin set explicitly', fix: 'Set PUBLIC_ORIGIN=https://your-domain so requests are checked against it rather than the Host header.' },
    { ok: q("SELECT COUNT(*) AS n FROM admin_users WHERE role = 'owner' AND disabled = 0").get().n >= 2, label: 'At least two owners', fix: 'Add a second owner so you are not locked out if one account is lost.' },
  ];
  return checks;
}
