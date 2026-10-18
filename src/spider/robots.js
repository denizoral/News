// robots.txt (RFC 9309): user-agent groups, Allow/Disallow with longest-match
// precedence, * and $ wildcards, Crawl-delay and Sitemap lines.

export const BOT_TOKEN = 'FrontierWireBot';

export function parseRobots(text = '') {
  const groups = [];
  const sitemaps = [];
  let current = null;
  let lastWasAgent = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === 'user-agent') {
      if (!lastWasAgent || !current) {
        current = { agents: [], rules: [], delay: null };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (key === 'sitemap') {
      sitemaps.push(value);
      continue;
    }
    if (!current) continue;
    if (key === 'allow' || key === 'disallow') {
      if (key === 'disallow' && value === '') continue; // empty disallow = allow all
      current.rules.push({ allow: key === 'allow', path: value, re: patternToRegex(value) });
    } else if (key === 'crawl-delay') {
      const d = parseFloat(value);
      if (Number.isFinite(d)) current.delay = d;
    }
  }
  return { groups, sitemaps };
}

function patternToRegex(p) {
  const anchored = p.endsWith('$');
  const body = (anchored ? p.slice(0, -1) : p).split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${body}${anchored ? '$' : ''}`);
}

function groupFor(robots, agent = BOT_TOKEN) {
  const a = agent.toLowerCase();
  return robots.groups.find((g) => g.agents.some((x) => x !== '*' && a.includes(x))) || robots.groups.find((g) => g.agents.includes('*')) || null;
}

export function isAllowed(robots, url, agent) {
  if (!robots) return true;
  const g = groupFor(robots, agent);
  if (!g) return true;
  const u = new URL(url);
  const target = decodeSafe(u.pathname) + u.search;
  let best = null;
  for (const r of g.rules) {
    if (r.re.test(target) && (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow))) best = r;
  }
  return best ? best.allow : true;
}

export function crawlDelay(robots, agent) {
  return groupFor(robots, agent)?.delay ?? null;
}

function decodeSafe(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
