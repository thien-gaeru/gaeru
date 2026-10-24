const { randomBytes, timingSafeEqual } = require("node:crypto");

function getCsrfToken(req) {
  if (!req.session.csrfToken) req.session.csrfToken = randomBytes(32).toString("hex");
  return req.session.csrfToken;
}

function requireCsrf(req, res, next) {
  const expected = req.session?.csrfToken;
  const actual = req.get("x-csrf-token");
  if (!expected || !actual || Buffer.byteLength(expected) !== Buffer.byteLength(actual)) {
    return res.status(403).json({ error: "Yêu cầu không hợp lệ. Hãy tải lại trang và thử lại." });
  }
  const matches = timingSafeEqual(Buffer.from(expected), Buffer.from(actual));
  if (!matches) return res.status(403).json({ error: "Yêu cầu không hợp lệ. Hãy tải lại trang và thử lại." });
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session?.admin) return res.status(401).json({ error: "Vui lòng đăng nhập quản trị viên." });
  next();
}

function setCsrfToken(req, res, next) {
  res.locals.csrfToken = getCsrfToken(req);
  next();
}

module.exports = { getCsrfToken, requireCsrf, requireAdmin, setCsrfToken };
