const { requirePermission } = require("./staff-access");

function adminPolicy(req, res, next) {
  const path = req.path.toLowerCase().replace(/\/$/, "");
  if (/^\/notifications(\/|$)/.test(path)) return next();
  if (/^\/shopping-chat(\/|$)/.test(path)) return next();
  const read = req.method === "GET";
  if (/^\/marketing(\/|$)/.test(path)) return next();
  if (/^\/care-requests(\/|$)/.test(path)) return next();
  if (/^\/owner(\/|$)/.test(path)) return next();
  if (/^\/warranties(\/|$)/.test(path)) return next();
  if (/^\/business(\/|$)/.test(path)) return next();
  if (/^\/(news|news-images)(\/|$)/.test(path)) return next();
  if (/^\/(product-workspace|catalog-images|catalog-videos)(\/|$)/.test(path)) return next();
  let permission;
  if (path === "/summary") permission = "dashboard.read";
  else if (/^\/(products|variants|uploads)(\/|$)/.test(path)) permission = read ? "catalog.read" : "catalog.write";
  else if (/^\/orders(\/|$)/.test(path)) permission = "orders.read";
  else if (/^\/customers(\/|$)/.test(path)) permission = read ? "customers.read" : "customers.write";
  else if (path === "/settings") permission = read ? "settings.read" : "settings.write";
  // New domain routers enforce their own operation-specific permissions.
  else if (/^\/(staff|departments|audit-logs|warehouses|inventory|suppliers|purchase-orders|goods-receipts|finance|reports)(\/|$)/.test(path)) return next();
  else return res.status(404).json({ error: "Không tìm thấy chức năng quản trị." });
  return requirePermission(permission)(req, res, next);
}

module.exports = { adminPolicy };
