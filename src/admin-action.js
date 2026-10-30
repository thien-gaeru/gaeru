'use strict';

const { requirePermission } = require('./staff-access');
const { requireCsrf } = require('./security');

/**
 * Middleware chuẩn hóa yêu cầu quyền quản trị và CSRF
 * Chặn 401 nếu thiếu req.admin, kiểm tra quyền hạn, và xác thực CSRF cho các thao tác ghi.
 */
function requireAdminAction(permission) {
  const permCheck = requirePermission(permission);
  return function(req, res, next) {
    if (!req.admin) {
      return res.status(401).json({ error: 'Yêu cầu phiên đăng nhập quản trị viên.' });
    }
    permCheck(req, res, () => {
      const isWrite = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method.toUpperCase());
      if (isWrite && req.session) {
        return requireCsrf(req, res, next);
      }
      next();
    });
  };
}

module.exports = { requireAdminAction };
