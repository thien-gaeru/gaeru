'use strict';

function resolveEhloDomain(s) {
  const fromStr = String(s?.from || '').trim();
  const at = fromStr.lastIndexOf('@');
  if (at >= 0) {
    const dom = fromStr.slice(at + 1).replace(/>.*$/, '').trim().toLowerCase();
    if (/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(dom)) return dom;
  }
  try {
    const host = new URL(String(s?.publicBaseUrl || '')).hostname.toLowerCase();
    if (/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host)) return host;
  } catch {}
  return 'gaeru.com';
}

function smtpOptions(s) {
  return {
    host: s.host,
    port: s.port,
    secure: s.secure === true,
    requireTLS: true,
    name: resolveEhloDomain(s),
    tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' },
    auth: { user: s.user, pass: s.password },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 20000
  };
}

module.exports = { smtpOptions, resolveEhloDomain };
