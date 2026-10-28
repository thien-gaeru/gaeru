const { createHash } = require("node:crypto");

const PERMISSIONS = Object.freeze([
  "marketing.read", "marketing.write", "dashboard.read", "catalog.read", "catalog.write", "inventory.read", "inventory.write", "inventory.approve",
  "orders.read", "orders.write", "payments.write", "customers.read", "customers.write", "chat.files.delete",
  "suppliers.read", "suppliers.write", "purchases.read", "purchases.write", "purchases.approve",
  "finance.read", "finance.write", "finance.approve", "reports.read", "staff.read", "staff.write",
  "audit.read", "settings.read", "settings.write", "warranty.approve",
  "payroll.read", "payroll.write", "payroll.approve", "tax.read", "tax.write", "tax.approve",
  "invoice.read", "invoice.write", "invoice.approve", "marketplace.read", "marketplace.write", "marketplace.approve"
]);

const ROLE_PERMISSIONS = Object.freeze({
  owner: PERMISSIONS,
  admin: PERMISSIONS,
  manager: Object.freeze(PERMISSIONS.filter((name) => !["staff.write", "settings.write", "tax.approve", "invoice.approve", "chat.files.delete"].includes(name) && !name.startsWith("payroll."))),
  sales: Object.freeze(["dashboard.read", "catalog.read", "inventory.read", "orders.read", "orders.write", "customers.read", "customers.write"]),
  warehouse: Object.freeze(["dashboard.read", "catalog.read", "inventory.read", "inventory.write", "orders.read", "orders.write", "suppliers.read", "purchases.read", "purchases.write"]),
  accountant: Object.freeze(["dashboard.read", "catalog.read", "inventory.read", "orders.read", "payments.write", "customers.read", "suppliers.read", "purchases.read", "finance.read", "finance.write", "reports.read", "audit.read", "payroll.read", "payroll.write", "tax.read", "tax.write", "invoice.read", "invoice.write", "marketplace.read", "marketplace.write"]),
  viewer: Object.freeze(["marketing.read", "dashboard.read", "catalog.read", "inventory.read", "orders.read", "customers.read", "suppliers.read", "purchases.read", "finance.read", "reports.read"])
});

const ROLE_LABELS = Object.freeze({
  owner: "Chủ doanh nghiệp", admin: "Quản trị viên", manager: "Quản lý", sales: "Kinh doanh",
  warehouse: "Nhân viên kho", accountant: "Kế toán", viewer: "Chỉ xem"
});

function publicRoles() {
  return Object.entries(ROLE_PERMISSIONS).map(([id, permissions]) => ({
    id, label: ROLE_LABELS[id], permissions: [...permissions], assignable: id !== "owner"
  }));
}

function bootstrapCredentialVersion(config) {
  return createHash("sha256").update(`${config.ADMIN_USERNAME}\0${config.ADMIN_PASSWORD_HASH}${config.ADMIN_SECURITY_VERSION===undefined?"":"\0"+config.ADMIN_SECURITY_VERSION}`).digest("hex");
}

function principalFromStaff(row) {
  if (!row || !row.active || !Object.hasOwn(ROLE_PERMISSIONS, row.role) || row.role === "owner") return null;
  return {
    id: row.id, username: row.username, fullName: row.fullName || row.full_name || row.username,
    role: row.role, permissions: [...ROLE_PERMISSIONS[row.role]], source: "staff"
  };
}

function bootstrapPrincipal(config) {
  return {
    id: null, username: config.ADMIN_USERNAME, fullName: "Chủ doanh nghiệp",
    role: "owner", permissions: [...PERMISSIONS], source: "bootstrap"
  };
}

async function resolveAdminSession(req, pool, config) {
  if(config.accountSecurity)config={...await config.accountSecurity.ownerConfig(),accountSecurity:config.accountSecurity};
  const identity = req.session?.admin;
  if (!identity) return null;
  let principal = null;
  if (identity.source === "bootstrap") {
    if (identity.username === config.ADMIN_USERNAME && identity.credentialVersion === bootstrapCredentialVersion(config)) {
      principal = bootstrapPrincipal(config);
    }
  } else if (identity.source === "staff" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(identity.id || "")) {
    const result = await pool.query(
      `SELECT id, username, full_name AS "fullName", role, active, auth_version AS "authVersion"
       FROM staff_accounts WHERE id=$1`, [identity.id]
    );
    const row = result.rows[0];
    if (row && row.authVersion === identity.authVersion) principal = principalFromStaff(row);
  }
  if (!principal) delete req.session.admin;
  return principal;
}

function createAdminAccess(pool, config) {
  return async (req, res, next) => {
    try {
      req.admin = null;
      req.admin = await resolveAdminSession(req, pool, config);
      if (!req.admin) return res.status(401).json({ error: "Phiên quản trị đã hết hạn hoặc không còn quyền truy cập. Vui lòng đăng nhập lại." });
      if(require('./security-hardening').required(config)){
        if(await require('./security-hardening').enrollment(config,req,req.admin))return res.status(403).json({code:'MFA_SETUP_REQUIRED',error:'Bật xác thực hai yếu tố trong Cài đặt bảo mật tài khoản trước khi sử dụng quản trị.'});
        if(req.session.adminMfaVerified!==true){delete req.session.admin;return res.status(401).json({error:'Đăng nhập lại và xác thực hai yếu tố để tiếp tục.'});}
      }
      next();
    } catch (error) {
      next(error);
    }
  };
}

function requirePermission(name) {
  if (!PERMISSIONS.includes(name)) throw new Error(`Unknown admin permission: ${name}`);
  return (req, res, next) => {
    if (!req.admin) return res.status(401).json({ error: "Vui lòng đăng nhập quản trị viên." });
    if (!Array.isArray(req.admin.permissions) || !req.admin.permissions.includes(name)) {
      return res.status(403).json({ error: "Tài khoản không có quyền thực hiện thao tác này." });
    }
    next();
  };
}

module.exports = {
  PERMISSIONS, ROLE_PERMISSIONS, publicRoles, bootstrapCredentialVersion, bootstrapPrincipal,
  principalFromStaff, resolveAdminSession, createAdminAccess, requirePermission
};
