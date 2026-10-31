'use strict';

const { requirePermission } = require('./staff-access');
const { requireCsrf } = require('./security');

/**
 * Middleware chuẩn hóa yêu cầu quyền quản trị và CSRF
 * Chặn 401 nếu thiếu req.admin (trong môi trường có session hoặc production),
 * kiểm tra quyền hạn qua requirePermission, và xác thực CSRF cho các thao tác ghi.
 */
function requireAdminAction(permission) {
  if (typeof permission !== 'string' || !permission.trim()) {
    throw new Error('AdminAction bắt buộc khai báo quyền cụ thể tại route (ví dụ: catalog.write).');
  }
  const permCheck = requirePermission(permission.trim());
  return function adminActionMiddleware(req, res, next) {
    if (!req.admin) {
      if (req.session || process.env.NODE_ENV === 'production') {
        return res.status(401).json({ error: 'Yêu cầu phiên đăng nhập quản trị viên.' });
      }
      return next();
    }
    permCheck(req, res, () => {
      const isWrite = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(String(req.method || '').toUpperCase());
      if (isWrite && req.session) {
        return requireCsrf(req, res, next);
      }
      next();
    });
  };
}

module.exports = {
  requireAdminAction,
  AdminAction: requireAdminAction
};
