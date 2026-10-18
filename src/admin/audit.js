// Append-only audit trail of every admin action and every sign-in attempt.

import { q } from '../db.js';
import { clientIp } from '../security/httpkit.js';

const MAX_DETAIL = 8000;

export function audit(req, { user = null, userId = null, username = null, action, target = null, detail = null }) {
  let d = detail == null ? null : JSON.stringify(detail);
  if (d && d.length > MAX_DETAIL) d = JSON.stringify({ truncated: true, preview: d.slice(0, MAX_DETAIL) });
  q('INSERT INTO audit_log (at, user_id, username, action, target, detail, ip, ua) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    Date.now(), user?.id ?? userId, user?.username ?? username, action, target == null ? null : String(target).slice(0, 500), d,
    req ? clientIp(req) : null, req ? String(req.headers['user-agent'] || '').slice(0, 300) : null,
  );
}

export function listAudit({ action = '', user = '', before = null, limit = 100 } = {}) {
  const where = [];
  const args = [];
  if (action) { where.push('action LIKE ?'); args.push(`${action.replace(/[%_]/g, '')}%`); }
  if (user) { where.push('username = ?'); args.push(user); }
  if (before) { where.push('id < ?'); args.push(Number(before)); }
  const rows = q(`SELECT * FROM audit_log ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`).all(...args, Math.min(500, Number(limit) || 100));
  return rows.map((r) => ({ ...r, detail: r.detail ? JSON.parse(r.detail) : null }));
}
