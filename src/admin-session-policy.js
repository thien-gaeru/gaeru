const ADMIN_IDLE_MS = 30 * 60 * 1000;
const ADMIN_ABSOLUTE_MS = 8 * 60 * 60 * 1000;
function stampAdminSession(session, now = Date.now()) {
  session.adminAuthenticatedAt = now;
  session.adminLastSeenAt = now;
}
function adminSessionPolicy(req, _res, next) {
  if (!req.session?.admin || !req.path.startsWith('/api/')) return next();
  const now = Date.now();
  if (!req.session.adminAuthenticatedAt || !req.session.adminLastSeenAt) stampAdminSession(req.session, now);
  if (now - req.session.adminAuthenticatedAt >= ADMIN_ABSOLUTE_MS || now - req.session.adminLastSeenAt >= ADMIN_IDLE_MS) {
    delete req.session.admin;
    delete req.session.adminAuthenticatedAt;
    delete req.session.adminLastSeenAt;
    return next();
  }
  const passive = req.method === 'GET' && /^\/api\/gaeru_ceo\/(?:notifications(?:\/|$)|care-requests(?:\/|$))/.test(req.path);
  if (!passive) req.session.adminLastSeenAt = now;
  next();
}
module.exports = {stampAdminSession, adminSessionPolicy, ADMIN_IDLE_MS, ADMIN_ABSOLUTE_MS};
