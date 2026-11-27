'use strict';

const dns = require('node:dns').promises;
const net = require('node:net');

const ALLOWED_PUSH_HOST_SUFFIXES = Object.freeze([
  'fcm.googleapis.com',
  'android.googleapis.com',
  'push.services.mozilla.com',
  'push.apple.com',
  'notify.windows.com',
  'push.samsungosp.com'
]);

function isAllowedWebPushHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host) return false;
  return ALLOWED_PUSH_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith('.' + suffix));
}

function ipv4ToInt(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

function isPrivateOrReservedIpv4(ip) {
  const num = ipv4ToInt(ip);
  if (num === null) return true;
  const o1 = (num >>> 24) & 0xff;
  const o2 = (num >>> 16) & 0xff;
  const o3 = (num >>> 8) & 0xff;
  if (o1 === 0 || o1 === 10 || o1 === 127) return true;
  if (o1 === 100 && o2 >= 64 && o2 <= 127) return true; // CGNAT 100.64.0.0/10
  if (o1 === 169 && o2 === 254) return true; // Link-local / Cloud metadata 169.254.0.0/16
  if (o1 === 172 && o2 >= 16 && o2 <= 31) return true; // RFC1918
  if (o1 === 192 && o2 === 168) return true; // RFC1918
  if (o1 === 192 && o2 === 0 && (o3 === 0 || o3 === 2)) return true; // IETF / TEST-NET-1
  if (o1 === 198 && (o2 === 18 || o2 === 19)) return true; // Benchmarking 198.18.0.0/15
  if (o1 === 198 && o2 === 51 && o3 === 100) return true; // TEST-NET-2
  if (o1 === 203 && o2 === 0 && o3 === 113) return true; // TEST-NET-3
  if (o1 >= 224) return true; // Multicast & Reserved
  return false;
}

function ipv6ToBytes(rawIp) {
  const ip = String(rawIp || '').toLowerCase().trim().replace(/%.+$/, '');
  if (!ip) return null;
  const doubleColonParts = ip.split('::');
  if (doubleColonParts.length > 2) return null;

  const parseGroups = (segment) => {
    if (!segment) return [];
    const tokens = segment.split(':');
    const out = [];
    for (let idx = 0; idx < tokens.length; idx++) {
      const tok = tokens[idx];
      if (tok.includes('.')) {
        if (idx !== tokens.length - 1) return null;
        const v4Int = ipv4ToInt(tok);
        if (v4Int === null) return null;
        out.push((v4Int >>> 16) & 0xffff, v4Int & 0xffff);
      } else {
        if (!/^[0-9a-f]{1,4}$/.test(tok)) return null;
        out.push(parseInt(tok, 16));
      }
    }
    return out;
  };

  let hextets;
  if (doubleColonParts.length === 2) {
    const left = parseGroups(doubleColonParts[0]);
    const right = parseGroups(doubleColonParts[1]);
    if (!left || !right) return null;
    const missing = 8 - (left.length + right.length);
    if (missing < 1) return null;
    hextets = [...left, ...new Array(missing).fill(0), ...right];
  } else {
    hextets = parseGroups(ip);
    if (!hextets || hextets.length !== 8) return null;
  }

  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    bytes[i * 2] = (hextets[i] >>> 8) & 0xff;
    bytes[i * 2 + 1] = hextets[i] & 0xff;
  }
  return bytes;
}

function isPrivateOrReservedIp(rawIp) {
  const ip = String(rawIp || '').trim().replace(/%.+$/, '');
  const ver = net.isIP(ip);
  if (!ver) return true;
  if (ver === 4) return isPrivateOrReservedIpv4(ip);

  const b = ipv6ToBytes(ip);
  if (!b) return true;

  // ::/128 (unspecified) and ::1/128 (loopback)
  let first12Zero = true;
  for (let i = 0; i < 12; i++) {
    if (b[i] !== 0) { first12Zero = false; break; }
  }
  if (first12Zero) {
    // ::/96 includes ::, ::1, and deprecated IPv4-compatible ::a.b.c.d
    return true;
  }

  // ::ffff:0:0/96 (IPv4-mapped)
  const isV4Mapped = b[0] === 0 && b[1] === 0 && b[2] === 0 && b[3] === 0 &&
    b[4] === 0 && b[5] === 0 && b[6] === 0 && b[7] === 0 &&
    b[8] === 0 && b[9] === 0 && b[10] === 0xff && b[11] === 0xff;
  if (isV4Mapped) {
    return isPrivateOrReservedIpv4(`${b[12]}.${b[13]}.${b[14]}.${b[15]}`);
  }

  // ::ffff:0:0:0/96 (IPv4-translated RFC 2765)
  const isV4Translated = b[0] === 0 && b[1] === 0 && b[2] === 0 && b[3] === 0 &&
    b[4] === 0 && b[5] === 0 && b[6] === 0 && b[7] === 0 &&
    b[8] === 0xff && b[9] === 0xff && b[10] === 0 && b[11] === 0;
  if (isV4Translated) {
    return isPrivateOrReservedIpv4(`${b[12]}.${b[13]}.${b[14]}.${b[15]}`);
  }

  // 64:ff9b::/96 and 64:ff9b:1::/48 (NAT64)
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b) return true;
  // 100::/64 (Discard-Only RFC 6666)
  if (b[0] === 0x01 && b[1] === 0x00 && b[2] === 0 && b[3] === 0 && b[4] === 0 && b[5] === 0 && b[6] === 0 && b[7] === 0) return true;
  // 2001::/32 (Teredo), 2001:2::/48 (Benchmarking), 2001:10::/28 & 2001:20::/28 (ORCHID), 2001:db8::/32 (Docs)
  if (b[0] === 0x20 && b[1] === 0x01) {
    if (b[2] === 0x00 && b[3] === 0x00) return true;
    if (b[2] === 0x00 && b[3] === 0x02 && b[4] === 0x00 && b[5] === 0x00) return true;
    if (b[2] === 0x00 && (b[3] & 0xf0) === 0x10) return true;
    if (b[2] === 0x00 && (b[3] & 0xf0) === 0x20) return true;
    if (b[2] === 0x0d && b[3] === 0xb8) return true;
  }
  // 2002::/16 (6to4)
  if (b[0] === 0x20 && b[1] === 0x02) return true;
  // fc00::/7 (ULA)
  if ((b[0] & 0xfe) === 0xfc) return true;
  // fe80::/10 (Link-local) and fec0::/10 (Site-local deprecated)
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true;
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0xc0) return true;
  // ff00::/8 (Multicast)
  if (b[0] === 0xff) return true;

  return false;
}

function assertHttpsUrlWithoutCredentials(rawUrl) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl || '').trim());
  } catch (_) {
    throw Object.assign(new Error('URL không hợp lệ.'), { status: 400 });
  }
  if (parsed.protocol !== 'https:') {
    throw Object.assign(new Error('Chỉ chấp nhận liên kết HTTPS.'), { status: 400 });
  }
  if (parsed.username || parsed.password) {
    throw Object.assign(new Error('URL không được chứa thông tin xác thực nhúng.'), { status: 400 });
  }
  if (parsed.port && parsed.port !== '443') {
    throw Object.assign(new Error('Cổng kết nối không được phép.'), { status: 400 });
  }
  return parsed;
}

function isForbiddenHostSyntax(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host) return true;
  if (net.isIP(host) !== 0) return true;
  if (/^\d+$/.test(host) || /^0x[0-9a-f]+$/i.test(host)) return true;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.localdomain')) {
    return true;
  }
  return false;
}

async function assertSafePushEndpoint(rawUrl, { allowUnresolvedForMockFetch = false, lookup = dns.lookup, enforceHostAllowlist = true } = {}) {
  const parsed = assertHttpsUrlWithoutCredentials(rawUrl);
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (isForbiddenHostSyntax(host)) {
    throw Object.assign(new Error('Endpoint Web Push không được trỏ tới địa chỉ nội bộ hoặc IP trực tiếp.'), { status: 400 });
  }
  if (enforceHostAllowlist && !allowUnresolvedForMockFetch && !isAllowedWebPushHost(host)) {
    throw Object.assign(new Error('Endpoint Web Push không thuộc nhà cung cấp thông báo đẩy trình duyệt hợp lệ.'), { status: 400 });
  }

  let records = null;
  try {
    records = await lookup(host, { all: true });
  } catch (err) {
    if (allowUnresolvedForMockFetch) {
      return { url: parsed, addresses: [] };
    }
    throw Object.assign(new Error('Không thể phân giải tên miền endpoint Web Push an toàn.'), { status: 400, cause: err });
  }

  if (!Array.isArray(records) || !records.length) {
    if (allowUnresolvedForMockFetch) return { url: parsed, addresses: [] };
    throw Object.assign(new Error('Không tìm thấy địa chỉ IP hợp lệ cho endpoint Web Push.'), { status: 400 });
  }

  for (const rec of records) {
    if (isPrivateOrReservedIp(rec?.address)) {
      throw Object.assign(new Error('Endpoint Web Push phân giải tới dải IP nội bộ không được phép.'), { status: 400 });
    }
  }
  return { url: parsed, addresses: records.map((r) => r.address) };
}

function assertPublicHttpsUrlSyntax(rawUrl) {
  const parsed = assertHttpsUrlWithoutCredentials(rawUrl);
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (isForbiddenHostSyntax(host)) {
    throw Object.assign(new Error('URL không được trỏ tới địa chỉ nội bộ hoặc IP trực tiếp.'), { status: 400 });
  }
  return parsed;
}

module.exports = {
  ALLOWED_PUSH_HOST_SUFFIXES,
  assertHttpsUrlWithoutCredentials,
  assertPublicHttpsUrlSyntax,
  assertSafePushEndpoint,
  isAllowedWebPushHost,
  isForbiddenHostSyntax,
  isPrivateOrReservedIp
};
