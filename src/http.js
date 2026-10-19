import fs from 'node:fs';
import { EnvHttpProxyAgent, setGlobalDispatcher } from 'undici';
import { assertPublicUrl, publicOnlyDispatcher, BlockedUrlError } from './security/ssrf.js';

// Load .env when present (Node 21.7+).
if (fs.existsSync('.env')) process.loadEnvFile('.env');

// Respect HTTPS_PROXY/HTTP_PROXY when present (corporate networks, sandboxes).
if (process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy) {
  setGlobalDispatcher(new EnvHttpProxyAgent());
}

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36 FrontierWire/0.1';

// Per-host backoff so a rate-limited host is skipped instead of hammered.
const hostCooldown = new Map();

export class HttpError extends Error {
  constructor(status, url) {
    super(`HTTP ${status} for ${url}`);
    this.status = status;
  }
}

export async function get(url, { timeout = 15000, headers = {}, retries = 1, publicOnly = false, maxRedirects = 5 } = {}) {
  const host = new URL(url).host;
  const until = hostCooldown.get(host);
  if (until && until > Date.now()) throw new Error(`cooling down ${host}`);

  for (let attempt = 0; ; attempt++) {
    try {
      const init = {
        headers: { 'user-agent': UA, accept: '*/*', 'accept-language': 'en-US,en;q=0.9', ...headers },
        signal: AbortSignal.timeout(timeout),
      };
      const res = publicOnly ? await fetchPublic(url, init, maxRedirects) : await fetch(url, { ...init, redirect: 'follow' });
      if (res.status === 429 || res.status === 503) {
        const retryAfter = Number(res.headers.get('retry-after')) || 120;
        hostCooldown.set(host, Date.now() + Math.min(retryAfter, 900) * 1000);
      }
      if (!res.ok) throw new HttpError(res.status, url);
      return res;
    } catch (err) {
      const retriable = !(err instanceof HttpError || err instanceof BlockedUrlError) || err.status >= 500;
      if (attempt >= retries || !retriable) throw err;
      await new Promise((r) => setTimeout(r, 600 * 2 ** attempt));
    }
  }
}

// Untrusted URLs (anything the crawler found): every hop must resolve to a
// public address, redirects are followed by hand so each target is checked.
async function fetchPublic(url, init, maxRedirects = 5) {
  let current = url;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    await assertPublicUrl(current);
    const res = await fetch(current, { ...init, redirect: 'manual', ...(publicOnlyDispatcher ? { dispatcher: publicOnlyDispatcher } : {}) });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      await res.body?.cancel();
      current = new URL(res.headers.get('location'), current).toString();
      continue;
    }
    return res;
  }
  throw new HttpError(310, url);
}

export const getText = async (url, opts) => (await get(url, opts)).text();
export const getJSON = async (url, opts) =>
  (await get(url, { ...opts, headers: { accept: 'application/json', ...(opts?.headers || {}) } })).json();

// Run async tasks with bounded concurrency; failures are collected, not thrown.
export async function pool(items, limit, fn) {
  const results = [];
  const errors = [];
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const item = items[i++];
      try {
        results.push(await fn(item));
      } catch (err) {
        errors.push({ item, error: err.message });
      }
    }
  });
  await Promise.all(workers);
  return { results, errors };
}
