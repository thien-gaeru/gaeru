const ADMIN_IDLE_MS = 30 * 60 * 1000;
const ADMIN_ABSOLUTE_MS = 8 * 60 * 60 * 1000;
function stampAdminSession(session, now = Date.now()) {
  session.adminAuthenticatedAt = now;
  session.adminLastSeenAt = now;
}
function adminSessionPolicy(req, _res, next) {
  if (!req.session?.admin || !req.path.startsWith('/api/')) return next();
  const now = Date.now();
  const idleMs=(req.adminSessionLimits?.idleMinutes || 30)*60000;
  const absoluteMs=(req.adminSessionLimits?.absoluteHours || 8)*3600000;
  if (!req.session.adminAuthenticatedAt || !req.session.adminLastSeenAt) stampAdminSession(req.session, now);
  if (now - req.session.adminAuthenticatedAt >= absoluteMs || now - req.session.adminLastSeenAt >= idleMs) {
    delete req.session.admin;
    delete req.session.adminAuthenticatedAt;
    delete req.session.adminLastSeenAt;
    return next();
  }
  // Background refreshes must not count as a person's activity. The UI sends
  // /api/auth/activity for real keyboard and click interactions.
  const passive = req.method === 'GET' && /^\/api\/gaeru_ceo\/(?:notifications|care-requests|orders|summary|traffic-summary|shopping-chat)(?:\/|$)/.test(req.path);
  if (!passive) req.session.adminLastSeenAt = now;
  next();
}
module.exports = {stampAdminSession, adminSessionPolicy, ADMIN_IDLE_MS, ADMIN_ABSOLUTE_MS};
