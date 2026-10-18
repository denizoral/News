// SSRF protection for the crawler. URLs come from untrusted places (links on
// Reddit, Hacker News, any crawled page), so before fetching we make sure the
// host resolves only to public addresses. Otherwise a link to
// http://169.254.169.254/ or http://localhost:6379/ would be fetched from
// inside our network and could end up in public search results.
//
// Checks run on every redirect hop, and (when no outbound proxy is in use)
// again at connect time via a custom DNS lookup, which also defeats DNS
// rebinding between the check and the connection.

import dns from 'node:dns';
import net from 'node:net';
import { Agent } from 'undici';

const blocked = new net.BlockList();
for (const [addr, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
]) blocked.addSubnet(addr, bits, 'ipv4');
for (const [addr, bits] of [['::', 128], ['::1', 128], ['64:ff9b::', 96], ['100::', 64], ['2001:db8::', 32], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]]) {
  blocked.addSubnet(addr, bits, 'ipv6');
}

export function isPublicAddress(ip) {
  const v = net.isIP(ip);
  if (!v) return false;
  // IPv4-mapped IPv6 (::ffff:10.0.0.1) is judged by its IPv4 address. (Don't
  // add ::ffff:0:0/96 to the block list: BlockList then matches every IPv4.)
  const mapped = v === 6 && ip.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPublicAddress(mapped[1]);
  if (v === 6 && /^::ffff:/i.test(ip)) return false; // hex-form mapped address: refuse rather than parse
  return !blocked.check(ip, v === 6 ? 'ipv6' : 'ipv4');
}

export class BlockedUrlError extends Error {}

const ALLOWED_PORTS = new Set(['', '80', '443', '8080', '8443']);

export async function assertPublicUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new BlockedUrlError('Not a valid URL');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new BlockedUrlError('Only http and https are crawled');
  if (u.username || u.password) throw new BlockedUrlError('URLs with credentials are not crawled');
  if (!ALLOWED_PORTS.has(u.port)) throw new BlockedUrlError(`Port ${u.port} is not crawled`);
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (/^(localhost|.*\.local|.*\.internal|.*\.localhost)$/i.test(host)) throw new BlockedUrlError('Internal host names are not crawled');
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.promises.lookup(host, { all: true, verbatim: true });
  if (!addrs.length || addrs.some((a) => !isPublicAddress(a.address))) throw new BlockedUrlError(`${host} resolves to a private address`);
  return u;
}

// Connect-time check (direct connections only).
function safeLookup(hostname, options, callback) {
  dns.lookup(hostname, { ...options, all: true, verbatim: true }, (err, addrs) => {
    if (err) return callback(err);
    const bad = addrs.find((a) => !isPublicAddress(a.address));
    if (bad) return callback(new BlockedUrlError(`${hostname} resolves to a private address`));
    if (options.all) return callback(null, addrs);
    callback(null, addrs[0].address, addrs[0].family);
  });
}

const usingProxy = !!(process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy);
export const publicOnlyDispatcher = usingProxy ? undefined : new Agent({ connect: { lookup: safeLookup } });
