'use strict';

const dns = require('node:dns').promises;
const net = require('node:net');

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

function normalizeMappedIpv6(ip) {
  const lower = String(ip || '').toLowerCase().replace(/%.+$/, '');
  if (lower.startsWith('::ffff:')) {
    const tail = lower.slice(7);
    if (net.isIPv4(tail)) return { kind: 'v4', ip: tail };
    const hexMatch = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(tail);
    if (hexMatch) {
      const hi = parseInt(hexMatch[1], 16);
      const lo = parseInt(hexMatch[2], 16);
      const v4 = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
      return { kind: 'v4', ip: v4 };
    }
  }
  return { kind: 'v6', ip: lower };
}

function isPrivateOrReservedIp(rawIp) {
  const ip = String(rawIp || '').trim().replace(/%.+$/, '');
  const ver = net.isIP(ip);
  if (!ver) return true;
  if (ver === 4) return isPrivateOrReservedIpv4(ip);

  const mapped = normalizeMappedIpv6(ip);
  if (mapped.kind === 'v4') return isPrivateOrReservedIpv4(mapped.ip);

  const v6 = mapped.ip;
  if (v6 === '::' || v6 === '::1') return true;
  const firstHextetStr = v6.split(':')[0] || '0';
  const firstHextet = parseInt(firstHextetStr || '0', 16);
  if ((firstHextet & 0xfe00) === 0xfc00) return true; // ULA fc00::/7
  if ((firstHextet & 0xffc0) === 0xfe80) return true; // Link-local fe80::/10
  if ((firstHextet & 0xff00) === 0xff00) return true; // Multicast ff00::/8
  if (v6.startsWith('64:ff9b::') || v6.startsWith('2002:')) return true; // NAT64 / 6to4
  if (v6.startsWith('2001:db8:')) return true; // Documentation
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

async function assertSafePushEndpoint(rawUrl, { allowUnresolvedForMockFetch = false, lookup = dns.lookup } = {}) {
  const parsed = assertHttpsUrlWithoutCredentials(rawUrl);
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (isForbiddenHostSyntax(host)) {
    throw Object.assign(new Error('Endpoint Web Push không được trỏ tới địa chỉ nội bộ hoặc IP trực tiếp.'), { status: 400 });
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
  assertHttpsUrlWithoutCredentials,
  assertPublicHttpsUrlSyntax,
  assertSafePushEndpoint,
  isForbiddenHostSyntax,
  isPrivateOrReservedIp
};
