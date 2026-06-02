/**
 * SSRF guard for user-supplied URLs (HTTP widgets + rule HTTP sources).
 *
 * The previous guard only string-matched IP *literals* against a narrow regex,
 * which left several bypasses open: hostnames resolving to private IPs (incl.
 * DNS rebinding), 0.0.0.0, dotless-decimal IPs (2130706433 == 127.0.0.1),
 * IPv4-mapped IPv6 (::ffff:127.0.0.1), and HTTP redirects pointing at internal
 * hosts. This module closes all of those:
 *   - resolves the hostname and validates EVERY resolved address,
 *   - blocks loopback / private / link-local / ULA / CGNAT / multicast ranges,
 *   - follows redirects manually, re-validating each hop.
 *
 * Residual risk: TOCTOU DNS rebinding between validation and connect is not
 * fully closed (would require pinning the validated IP at connect time); for
 * this self-hosted app that is an acceptable trade-off.
 */
import { lookup } from 'node:dns/promises';
import net from 'node:net';

/** True for any address we must never let the server connect to. */
export function ipIsPrivate(ip: string): boolean {
  let addr = ip.toLowerCase();

  // IPv4-mapped IPv6 in dotted form, e.g. ::ffff:127.0.0.1
  const mappedDotted = addr.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mappedDotted) addr = mappedDotted[1];

  if (net.isIPv4(addr)) {
    const o = addr.split('.').map(Number);
    if (o.length !== 4 || o.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return true; // malformed → unsafe
    const [a, b] = o;
    if (a === 0) return true;                       // 0.0.0.0/8 ("this host")
    if (a === 10) return true;                      // 10.0.0.0/8 private
    if (a === 127) return true;                     // 127.0.0.0/8 loopback
    if (a === 169 && b === 254) return true;        // 169.254.0.0/16 link-local
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
    if (a === 192 && b === 168) return true;        // 192.168.0.0/16 private
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
    if (a >= 224) return true;                      // 224+ multicast/reserved
    return false;
  }

  if (net.isIPv6(addr)) {
    if (addr === '::1' || addr === '::') return true;            // loopback / unspecified
    if (/^f[cd]/.test(addr)) return true;                        // fc00::/7 unique-local
    if (/^fe[89ab]/.test(addr)) return true;                     // fe80::/10 link-local
    // IPv4-mapped IPv6 in hex form, e.g. ::ffff:7f00:1
    const m = addr.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (m) {
      const hi = parseInt(m[1], 16), lo = parseInt(m[2], 16);
      return ipIsPrivate(`${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`);
    }
    return false;
  }

  return true; // not a recognisable IP → treat as unsafe
}

/**
 * Validate a target URL for SSRF safety. Throws on disallowed scheme/host.
 * Returns the parsed URL on success.
 */
export async function assertPublicUrl(target: string): Promise<URL> {
  let parsed: URL;
  try { parsed = new URL(target); } catch { throw new Error('Invalid URL.'); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only http(s) is allowed.');
  }

  let host = parsed.hostname;
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1); // IPv6 literal

  // Direct IP literal.
  if (net.isIP(host)) {
    if (ipIsPrivate(host)) throw new Error('Private/loopback addresses are not allowed.');
    return parsed;
  }

  // Dotless-decimal IPv4 (e.g. 2130706433 == 127.0.0.1).
  if (/^\d+$/.test(host)) {
    const n = Number(host);
    if (Number.isFinite(n) && n >= 0 && n <= 0xffffffff) {
      const ip = `${(n >>> 24) & 0xff}.${(n >>> 16) & 0xff}.${(n >>> 8) & 0xff}.${n & 0xff}`;
      if (ipIsPrivate(ip)) throw new Error('Private/loopback addresses are not allowed.');
      return parsed;
    }
  }

  if (host === 'localhost' || host.endsWith('.localhost')) {
    throw new Error('Private/loopback addresses are not allowed.');
  }

  // Resolve and validate every address the name maps to.
  let addrs: { address: string }[];
  try { addrs = await lookup(host, { all: true }); }
  catch { throw new Error('Host could not be resolved.'); }
  if (!addrs.length) throw new Error('Host could not be resolved.');
  for (const a of addrs) {
    if (ipIsPrivate(a.address)) throw new Error('Private/loopback addresses are not allowed.');
  }
  return parsed;
}

/**
 * SSRF-safe fetch: validates the URL, then follows redirects manually,
 * re-validating each hop so a public URL cannot bounce to an internal one.
 */
export async function safeFetch(
  target: string,
  init: RequestInit = {},
  opts: { maxRedirects?: number } = {}
): Promise<Response> {
  const maxRedirects = opts.maxRedirects ?? 3;
  let current = target;
  for (let hop = 0; ; hop++) {
    await assertPublicUrl(current);
    const res = await fetch(current, { ...init, redirect: 'manual' });
    const loc = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && loc) {
      if (hop >= maxRedirects) throw new Error('Too many redirects.');
      current = new URL(loc, current).toString();
      continue;
    }
    return res;
  }
}
