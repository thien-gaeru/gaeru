'use strict';

/**
 * GAERU Enterprise AI (Trợ lý điều hành doanh nghiệp nội bộ 24/7)
 * 
 * Tính năng chính:
 * 1. Business Intelligence qua ngôn ngữ tự nhiên: Doanh thu, đơn hàng, khách hàng, tỷ lệ chuyển đổi.
 * 2. Smart Inventory: Kiểm tra tồn kho, cảnh báo chạm ngưỡng an toàn (< 5), phân bổ kho.
 * 3. CSKH & Soạn thảo nội dung: Hỗ trợ viết phản hồi khách hàng, bài viết marketing, chính sách.
 * 4. Human-in-the-loop Safe Action Calling: Đề xuất hành động (tạo voucher, gửi mail) qua Thẻ Xác nhận.
 * 5. Chuẩn phân quyền RBAC: Bảo vệ dữ liệu tài chính tối mật chỉ dành riêng cho CEO/Owner.
 * 6. Realtime Streaming SSE: Phản hồi gõ chữ từng từ mượt mà (< 300ms).
 */

const express = require('express');
const { getSystemHealth } = require('./security-shield');
const { withTransaction } = require('./db');
const { appendAudit } = require('./audit');
const {
  normalizeVi: sharedNormalizeVi,
  expandQueryVi,
  hasBoundaryTerm,
  hasAnyBoundaryTerm,
  isTermNegated,
  extractOrderCodes,
  extractPhoneNumbers,
  isExplicitDetailedRequest
} = require('./lib/ai-nlu');

const ACTION_PERMISSION_MAP = Object.freeze({
  create_voucher: 'marketing.write',
  cancel_voucher: 'marketing.write',
  delete_voucher: 'marketing.write',
  cancel_campaign: 'marketing.write',
  delete_campaign: 'marketing.write',
  confirm_order: 'orders.write',
  cancel_order: 'orders.write',
  sync_shipping: 'orders.write'
});

function hasActionPermission(admin, actionType) {
  if (!admin) return false;
  if (admin.isOwner || admin.role === 'owner' || admin.source === 'bootstrap') return true;
  const required = ACTION_PERMISSION_MAP[actionType];
  if (!required) return false;
  return Array.isArray(admin.permissions) && admin.permissions.includes(required);
}

function hasReadPermission(admin, perm) {
  if (!admin) return false;
  if (admin.isOwner || admin.role === 'owner' || admin.source === 'bootstrap') return true;
  const perms = Array.isArray(admin.permissions) ? admin.permissions : [];
  if (Array.isArray(perm)) return perm.some((p) => perms.includes(p));
  return perms.includes(perm);
}

async function runAtomic(pool, fn) {
  if (typeof pool?.connect === 'function') {
    return withTransaction(pool, fn);
  }
  return fn(pool);
}

function createInternalAiRouter(pool, config) {
  const router = express.Router();
  const { requireCsrf } = require('./security');
  router.use((req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    if (req.session || req.get('cookie')) return requireCsrf(req, res, next);
    next();
  });
  const {updateOrder} = require('./order-workflow').createOrderWorkflow({config});

  // Helper định dạng tiền tệ VNĐ
  const formatVnd = (num) => new Intl.NumberFormat('vi-VN').format(Math.round(num || 0)) + ' ₫';

  // Helper chuẩn hóa văn bản tiếng Việt (hỗ trợ cả gõ có dấu và không dấu)
  const normalizeVi = (str) => sharedNormalizeVi(str);

  // Helper nhận diện khung thời gian linh hoạt từ câu hỏi tự nhiên
  function parseFlexibleDays(text) {
    const norm = expandQueryVi(text);
    const numMatch = norm.match(/\b(\d+)\s*(?:ngay|hom)\b/);
    if (numMatch) return Math.max(1, Math.min(90, parseInt(numMatch[1], 10)));
    const weekMatch = norm.match(/\b(\d+)\s*tuan\b/);
    if (weekMatch) return Math.max(7, Math.min(90, parseInt(weekMatch[1], 10) * 7));
    const monthMatch = norm.match(/\b(\d+)\s*thang\b/);
    if (monthMatch) return Math.max(30, Math.min(90, parseInt(monthMatch[1], 10) * 30));
    if (hasAnyBoundaryTerm(norm, ['quy', '3 thang'])) return 90;
    if (hasAnyBoundaryTerm(norm, ['thang nay', 'thang qua', 'thang'])) return 30;
    if (hasAnyBoundaryTerm(norm, ['tuan truoc', '2 tuan'])) return 14;
    if (hasAnyBoundaryTerm(norm, ['tuan nay', 'tuan qua', 'tuan'])) return 7;
    if (hasBoundaryTerm(norm, 'hom qua')) return 2;
    return 1;
  }

  // ==========================================================================
  // BỘ CÔNG CỤ TRUY VẤN NỘI BỘ (INTERNAL ENTERPRISE GROUNDING TOOLS)
  // ==========================================================================

  // Tool 1: Tổng quan kinh doanh & doanh thu (có phân quyền RBAC)
  async function toolGetBusinessOverview({ days = 1 }, user) {
    const numDays = Math.max(1, Math.min(90, parseInt(days || 1, 10)));
    const canViewFinance = user?.isOwner || hasReadPermission(user, ['finance.read']);
    const canViewOrders = user?.isOwner || canViewFinance || hasReadPermission(user, ['orders.read', 'orders.write']);
    const canViewCustomers = user?.isOwner || hasReadPermission(user, ['customers.read', 'customers.write']);

    let orderStats = {
      total_orders: null,
      pending_orders: null,
      confirmed_orders: null,
      processing_orders: null,
      shipped_orders: null,
      completed_orders: null,
      cancelled_orders: null,
      paid_revenue: 0,
      gross_revenue: 0
    };
    if (canViewOrders) {
      orderStats = (await pool.query(`
        SELECT 
          COUNT(*)::int AS total_orders,
          COUNT(CASE WHEN status = 'pending' THEN 1 END)::int AS pending_orders,
          COUNT(CASE WHEN status = 'confirmed' THEN 1 END)::int AS confirmed_orders,
          COUNT(CASE WHEN status = 'processing' THEN 1 END)::int AS processing_orders,
          COUNT(CASE WHEN status = 'shipped' THEN 1 END)::int AS shipped_orders,
          COUNT(CASE WHEN status = 'completed' THEN 1 END)::int AS completed_orders,
          COUNT(CASE WHEN status = 'cancelled' THEN 1 END)::int AS cancelled_orders,
          COALESCE(SUM(CASE WHEN payment_status = 'paid' THEN total_vnd ELSE 0 END), 0)::bigint AS paid_revenue,
          COALESCE(SUM(total_vnd), 0)::bigint AS gross_revenue
        FROM orders
        WHERE created_at >= NOW() - INTERVAL '1 day' * $1
      `, [numDays])).rows[0] || orderStats;
    }

    const newCustomers = canViewCustomers
      ? ((await pool.query(`
          SELECT COUNT(*)::int AS count
          FROM customers
          WHERE created_at >= NOW() - INTERVAL '1 day' * $1
        `, [numDays])).rows[0]?.count || 0)
      : null;

    return {
      periodDays: numDays,
      ...(canViewOrders ? {
        totalOrders: orderStats.total_orders,
        pendingOrders: orderStats.pending_orders,
        processingOrders: orderStats.processing_orders,
        shippedOrders: orderStats.shipped_orders,
        completedOrders: orderStats.completed_orders,
        cancelledOrders: orderStats.cancelled_orders
      } : { ordersNote: 'Bạn không có quyền xem số liệu đơn hàng (cần orders.read).' }),
      ...(canViewCustomers ? { newCustomers } : { customersNote: 'Bạn không có quyền xem số liệu khách hàng (cần customers.read).' }),
      // Bảo vệ thông tin tài chính theo quyền RBAC
      revenue: canViewFinance ? {
        paidVnd: orderStats.paid_revenue,
        paidFormatted: formatVnd(orderStats.paid_revenue),
        grossVnd: orderStats.gross_revenue,
        grossFormatted: formatVnd(orderStats.gross_revenue)
      } : { note: 'Bạn không có quyền xem thông tin tài chính và doanh thu.' }
    };
  }

  // Tool 2: Tra cứu đơn hàng chi tiết
  async function toolQueryOrders({ keyword = '', status = '', limit = 5 }, user) {
    if (!hasReadPermission(user, ['orders.read', 'orders.write'])) {
      return { error: 'Bạn không có quyền tra cứu danh sách đơn hàng (cần quyền orders.read).', orders: [] };
    }
    const lim = Math.max(1, Math.min(20, parseInt(limit || 5, 10)));
    const params = [];
    const where = [];

    if (keyword) {
      params.push(`%${keyword.trim().toLowerCase()}%`);
      where.push(`(lower(order_number) LIKE $${params.length} OR lower(customer_name) LIKE $${params.length} OR phone LIKE $${params.length})`);
    }

    if (status) {
      params.push(status.trim().toLowerCase());
      where.push(`status = $${params.length}`);
    }

    params.push(lim);
    const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';

    const orders = (await pool.query(`
      SELECT 
        order_number AS "orderNumber",
        customer_name AS "customerName",
        phone,
        city,
        status,
        payment_status AS "paymentStatus",
        payment_method AS "paymentMethod",
        total_vnd AS "totalVnd",
        created_at AS "createdAt"
      FROM orders
      ${whereClause}
      ORDER BY created_at DESC
      LIMIT $${params.length}
    `, params)).rows;

    return orders.map(o => ({
      ...o,
      totalFormatted: formatVnd(o.totalVnd)
    }));
  }

  // Tool 3: Kiểm tra tồn kho & cảnh báo mức an toàn
  async function toolCheckInventory({ keyword = '', lowStockOnly = false }, user) {
    if (!hasReadPermission(user, ['inventory.read', 'inventory.write', 'catalog.read', 'catalog.write'])) {
      return { error: 'Bạn không có quyền xem dữ liệu tồn kho (cần quyền inventory.read hoặc catalog.read).', items: [] };
    }
    const params = [];
    const where = ['p.deleted_at IS NULL', 'v.active = true'];

    if (keyword) {
      params.push(`%${keyword.trim().toLowerCase()}%`);
      where.push(`(lower(p.name) LIKE $${params.length} OR lower(v.name) LIKE $${params.length} OR lower(v.sku) LIKE $${params.length})`);
    }

    if (lowStockOnly) {
      where.push(`v.stock_quantity <= 5`);
    }

    const items = (await pool.query(`
      SELECT 
        p.name AS "productName",
        v.name AS "variantName",
        v.sku,
        v.price_vnd AS "priceVnd",
        v.stock_quantity AS "stockQuantity",
        v.stock_quantity <= 5 AS "isLowStock"
      FROM product_variants v
      JOIN products p ON v.product_id = p.id
      WHERE ${where.join(' AND ')}
      ORDER BY v.stock_quantity ASC, p.name ASC
      LIMIT 15
    `, params)).rows;

    return items.map(it => ({
      ...it,
      priceFormatted: formatVnd(it.priceVnd),
      stockStatus: it.stockQuantity <= 0 ? 'Hết hàng' : it.stockQuantity <= 5 ? 'Cảnh báo sắp hết' : 'Đủ hàng'
    }));
  }

  // Tool 4: Tra cứu vận đơn bưu cục
  async function toolQueryShipping({ orderNumber } = {}, user) {
    if (!hasReadPermission(user, ['shipping.read', 'shipping.write', 'orders.read', 'orders.write'])) {
      return { error: 'Bạn không có quyền tra cứu vận đơn (cần quyền shipping.read hoặc orders.read).', shipments: [] };
    }
    const carrierNameMap = { viettel: 'Viettel Post', jt: 'J&T Express', spx: 'SPX Express' };
    if (!orderNumber) {
      const rows = (await pool.query(`
        SELECT 
          o.id,
          o.order_number AS "orderNumber",
          o.customer_name AS "customerName",
          o.phone,
          o.city,
          o.status,
          s.carrier_id AS "carrierId",
          s.tracking_number AS "trackingNumber",
          s.status AS "shipmentStatus",
          s.updated_at AS "syncedAt"
        FROM orders o
        LEFT JOIN carrier_shipments s ON s.order_id = o.id AND s.status != 'cancelled'
        WHERE o.status IN ('shipped', 'processing', 'confirmed') OR s.tracking_number IS NOT NULL
        ORDER BY o.created_at DESC
        LIMIT 5
      `)).rows;
      return {
        shipments: rows.map(r => ({
          orderNumber: r.orderNumber,
          customerName: r.customerName,
          phone: r.phone,
          city: r.city,
          orderStatus: r.status,
          carrier: carrierNameMap[r.carrierId] || 'Viettel Post',
          trackingNumber: r.trackingNumber || 'Đang cấp mã vận đơn',
          shipmentStatus: r.shipmentStatus || r.status
        }))
      };
    }
    
    const row = (await pool.query(`
      SELECT 
        o.id,
        o.order_number AS "orderNumber",
        o.customer_name AS "customerName",
        o.phone,
        o.address,
        o.city,
        o.status,
        o.note,
        s.carrier_id AS "carrierId",
        s.tracking_number AS "trackingNumber",
        s.status AS "shipmentStatus",
        s.updated_at AS "syncedAt"
      FROM orders o
      LEFT JOIN carrier_shipments s ON s.order_id = o.id AND s.status != 'cancelled'
      WHERE lower(o.order_number) = lower($1)
      ORDER BY s.created_at DESC
      LIMIT 1
    `, [orderNumber.trim()])).rows[0];

    if (!row) return { error: `Không tìm thấy đơn hàng mã ${orderNumber}` };

    return {
      order: row,
      shipment: {
        carrier: carrierNameMap[row.carrierId] || 'GAERU Carrier Engine',
        status: row.shipmentStatus || row.status,
        trackingNumber: row.trackingNumber || 'Chưa tạo mã vận đơn hãng'
      }
    };
  }

  // Tool 5: Sức khỏe hệ thống
  async function toolCheckSystemHealth() {
    try {
      const health = await getSystemHealth(pool, config);
      return {
        status: health.status,
        uptimeSeconds: Math.round(process.uptime()),
        nodeVersion: process.version,
        memoryRssMb: health.server?.memoryUsage?.rssMb || 0,
        heapUsedMb: health.server?.memoryUsage?.heapUsedMb || 0,
        threatsBlocked: health.securityMetrics?.threatsBlocked || 0,
        dbLatencyMs: health.database?.latencyMs || 0.5,
        clusterMode: process.env.CLUSTER_ENABLED === 'true' ? 'Enterprise Multi-Core Cluster (Active)' : 'Single'
      };
    } catch (_) {
      return { status: 'degraded', uptimeSeconds: Math.round(process.uptime()), message: 'Không thể kiểm tra sức khỏe hệ thống lúc này.' };
    }
  }

  // Tool 6: Đề xuất hành động quản trị (Action Card Creation)
  async function toolProposeAction({ actionType, title, description, payload }, user, threadId) {
    if (!hasActionPermission(user, actionType)) {
      throw Object.assign(new Error('Bạn không có quyền đề xuất hoặc thực thi thao tác quản trị này.'), { status: 403 });
    }
    const res = await pool.query(`
      INSERT INTO internal_ai_action_logs (thread_id, action_type, payload, created_by)
      VALUES ($1, $2, $3, $4)
      RETURNING id, action_type, payload, status, created_at
    `, [threadId, actionType, JSON.stringify(payload || {}), user?.username || 'admin']);

    const action = res.rows[0];
    return {
      id: action.id,
      actionId: action.id,
      actionType,
      title: title || 'Hành động quản trị đề xuất',
      description: description || 'Nhấn Xác nhận để thực thi hành động này trên hệ thống.',
      payload: action.payload,
      status: 'pending'
    };
  }

  // Tool 7: Thống kê lưu lượng truy cập Storefront (Traffic & Online Visitors)
  async function toolGetTrafficAnalytics() {
    try {
      const { getTrafficSummary } = require('./traffic-tracker');
      return await getTrafficSummary(pool);
    } catch (_) {
      return { todayPageviews: 0, todayVisitors: 0, totalPageviews: 0, totalVisitors: 0, activeNow: 0 };
    }
  }

  // Tool 8: Kiểm tra chương trình khuyến mãi & mã Voucher đang hoạt động
  async function toolGetMarketingOverview(user) {
    if (!hasReadPermission(user, ['marketing.read', 'marketing.write'])) {
      return { error: 'Bạn không có quyền xem chương trình khuyến mãi và mã giảm giá (cần quyền marketing.read).', vouchers: [], campaigns: [] };
    }
    try {
      const vouchersRes = await pool.query(`
        SELECT code, title, kind, amount, min_spend_vnd AS "minSpendVnd", total_limit AS "totalLimit", active, ends_at AS "endsAt"
        FROM marketing_vouchers
        ORDER BY active DESC, created_at DESC
        LIMIT 8
      `);
      let campaigns = [];
      try {
        const campRes = await pool.query(`
          SELECT title, active, starts_at AS "startsAt", ends_at AS "endsAt"
          FROM marketing_campaigns
          ORDER BY active DESC, created_at DESC
          LIMIT 5
        `);
        campaigns = campRes.rows || [];
      } catch (_) {}
      return {
        vouchers: (vouchersRes.rows || []).map(v => ({
          ...v,
          discountFormatted: v.kind === 'percent' ? `${v.amount}%` : formatVnd(v.amount),
          minSpendFormatted: formatVnd(v.minSpendVnd || 0)
        })),
        campaigns
      };
    } catch (_) {
      return { vouchers: [], campaigns: [] };
    }
  }

  // Tool 9: Tổng quan CSKH, Tin nhắn chờ & Bảo hành / Đổi trả
  async function toolGetCustomerCareOverview(user) {
    if (!hasReadPermission(user, ['care.read', 'care.write', 'customers.read', 'warranty.read', 'orders.read'])) {
      return { error: 'Bạn không có quyền xem dữ liệu CSKH và bảo hành.', openChats: 0, awaitingAdminChats: 0, activeWarranties: 0, pendingReturns: 0 };
    }
    const out = { openChats: 0, awaitingAdminChats: 0, activeWarranties: 0, pendingReturns: 0 };
    try {
      const chatRes = await pool.query(`
        SELECT 
          COUNT(*) FILTER (WHERE status <> 'closed')::int AS open_chats,
          COUNT(*) FILTER (WHERE status <> 'closed' AND awaiting_admin = true)::int AS awaiting_admin
        FROM shopping_chat_threads
      `);
      out.openChats = chatRes.rows[0]?.open_chats || 0;
      out.awaitingAdminChats = chatRes.rows[0]?.awaiting_admin || 0;
    } catch (_) {}
    try {
      const warRes = await pool.query(`SELECT COUNT(*)::int AS total FROM warranty_activations WHERE status = 'active'`);
      out.activeWarranties = warRes.rows[0]?.total || 0;
    } catch (_) {}
    try {
      const retRes = await pool.query(`SELECT COUNT(*)::int AS total FROM order_after_sales WHERE status NOT IN ('resolved', 'rejected')`);
      out.pendingReturns = retRes.rows[0]?.total || 0;
    } catch (_) {}
    return out;
  }

  // ==========================================================================
  // DISPATCHER & SYSTEM PROMPT
  // ==========================================================================

  const SYSTEM_INSTRUCTION = `Bạn là GAERU AI - Trợ lý Điều hành Doanh nghiệp nội bộ của GAERU.
Văn phong: Chuyên nghiệp, ngắn gọn, đi thẳng vào đúng số liệu được hỏi; KHÔNG trả lời lan man hay chèn nội dung thừa không được hỏi.

Quy tắc cốt lõi:
1. Chỉ dùng số liệu thực tế từ Tools: Doanh thu, Đơn hàng, Tồn kho, Vận đơn, Sức khỏe hệ thống.
2. TUYỆT ĐỐI không bịa đặt số liệu (Zero Hallucination). Dùng tiền tệ VNĐ (Ví dụ: 1.250.000 ₫).
3. Chỉ xuất bảng Markdown đầy đủ khi cần liệt kê danh sách hoặc được hỏi tổng quan/báo cáo; với câu hỏi một chỉ số (doanh thu, số khách online, tồn kho 1 mã), trả lời trực diện trong 1-3 dòng.
4. Đối với thao tác ghi (tạo/hủy voucher, xác nhận/hủy đơn, đồng bộ vận đơn), luôn tạo Action Card qua propose_action để người dùng bấm xác nhận.
5. Tuân thủ phân quyền RBAC nghiêm ngặt theo vai trò người dùng.`;

  // Thực thi Function Calling logic
  async function executeAgentTurn({ userQuestion, history = [], user, threadId, aiConfig, readOnly = false }) {
    const lower = userQuestion.toLowerCase();
    const norm = expandQueryVi(userQuestion);
    const toolResults = [];
    let actionCard = null;

    // Ngữ cảnh các lượt trước (Multi-turn Memory)
    const prevUserMsgs = (Array.isArray(history) ? history : [])
      .filter(m => m && m.role === 'user' && m.content !== userQuestion)
      .map(m => String(m.content || ''));
    const prevAssistantMsgs = (Array.isArray(history) ? history : [])
      .filter(m => m && m.role === 'assistant')
      .map(m => String(m.content || ''));
    const lastContextText = [...prevUserMsgs.slice(-2), ...prevAssistantMsgs.slice(-1)].join(' ');
    const normHistory = expandQueryVi(lastContextText);

    const questionOrders = extractOrderCodes(userQuestion);
    const historyOrders = extractOrderCodes(lastContextText);
    const questionPhones = extractPhoneNumbers(userQuestion);
    const refersPrevOrder = hasAnyBoundaryTerm(norm, ['don nay', 'don do', 'don vua roi', 'ma nay', 'ma do']);
    const resolvedOrderCode = questionOrders[0] || (refersPrevOrder ? historyOrders[0] : null) || null;

    let matchedOrder = null;
    if (resolvedOrderCode && hasReadPermission(user, ['orders.read', 'orders.write', 'shipping.read'])) {
      try {
        const ordRes = await pool.query(
          `SELECT o.id, o.order_number, o.customer_name, o.total_vnd, o.status, o.payment_status, s.tracking_number
           FROM orders o
           LEFT JOIN carrier_shipments s ON s.order_id = o.id AND s.status != 'cancelled'
           WHERE lower(o.order_number) = lower($1)
           ORDER BY s.created_at DESC LIMIT 1`,
          [resolvedOrderCode]
        );
        if (ordRes.rows.length) matchedOrder = ordRes.rows[0];
      } catch (_) {}
    }

    // 1. Nhận diện Ý định Hành động Quản trị trước để không gọi nhầm các tool báo cáo thừa
    const isConfirmOrderIntent = (/(?:xác nhận|duyệt|chuẩn bị|tiến hành|chuyển sang giao).{0,25}(?:đơn|đơn hàng)/i.test(lower) ||
                                 /(?:xác nhận đơn|duyệt đơn|chuẩn bị đơn)/i.test(lower)) && !isTermNegated(norm, 'duyet') && !isTermNegated(norm, 'xac nhan');
    if (!readOnly && hasActionPermission(user, 'confirm_order') && isConfirmOrderIntent && matchedOrder && ['pending', 'confirmed'].includes(matchedOrder.status)) {
      actionCard = await toolProposeAction({
        actionType: 'confirm_order',
        title: `📦 Xác nhận & Chuyển đơn sang Giao hàng: ${matchedOrder.order_number}`,
        description: `Duyệt đơn và chuyển sang bước Giao hàng (processing), khóa tồn kho sản phẩm cho khách ${matchedOrder.customer_name} (${formatVnd(matchedOrder.total_vnd)}).`,
        payload: {
          orderId: matchedOrder.id,
          orderNumber: matchedOrder.order_number,
          targetStatus: 'processing'
        }
      }, user, threadId);
      toolResults.push({ tool: 'propose_action', data: actionCard });
    }

    const isCancelOrderIntent = /(?:hủy|huỷ|cancel).{0,20}(?:đơn|đơn hàng)/i.test(lower) || /(?:hủy đơn|huỷ đơn)/i.test(lower);
    if (!readOnly && hasActionPermission(user, 'cancel_order') && !actionCard && isCancelOrderIntent && matchedOrder && !['cancelled', 'completed'].includes(matchedOrder.status)) {
      actionCard = await toolProposeAction({
        actionType: 'cancel_order',
        title: `⚠️ Đề xuất Hủy đơn hàng: ${matchedOrder.order_number}`,
        description: `Hủy đơn hàng của khách ${matchedOrder.customer_name}, tự động hủy mã vận đơn hãng (nếu có) và hoàn trả số lượng vào kho tồn.`,
        payload: {
          orderId: matchedOrder.id,
          orderNumber: matchedOrder.order_number
        }
      }, user, threadId);
      toolResults.push({ tool: 'propose_action', data: actionCard });
    }

    const isSyncShippingIntent = /(?:đồng bộ|cập nhật hành trình).{0,25}(?:đơn|vận đơn|vận chuyển|viettel|jt|spx)/i.test(lower) ||
                                 /(?:đồng bộ vận đơn|kiểm tra hành trình)/i.test(lower);
    if (!readOnly && hasActionPermission(user, 'sync_shipping') && !actionCard && isSyncShippingIntent && matchedOrder && matchedOrder.tracking_number) {
      actionCard = await toolProposeAction({
        actionType: 'sync_shipping',
        title: `🚚 Đồng bộ hành trình bưu cục: ${matchedOrder.order_number}`,
        description: `Lấy trạng thái mới nhất của mã vận đơn ${matchedOrder.tracking_number} từ cổng hãng và tự động cập nhật tiến trình đơn.`,
        payload: {
          orderId: matchedOrder.id,
          orderNumber: matchedOrder.order_number,
          trackingNumber: matchedOrder.tracking_number
        }
      }, user, threadId);
      toolResults.push({ tool: 'propose_action', data: actionCard });
    }

    const isVoucherActionIntent = !/\b(?:xem|danh sach|liet ke|kiem tra|co nhung|dang chay|hien tai)\b/.test(norm) && (
      /(?:tạo|lập|thêm|phát hành).{0,25}(?:mã|voucher|coupon|khuyến mãi)/i.test(lower) ||
      (hasBoundaryTerm(norm, 'voucher') && hasAnyBoundaryTerm(norm, ['tao', 'lap', 'them', 'phat hanh']))
    );
    const isCancelVoucherIntent = /(?:hủy|huỷ|dừng|tắt).{0,25}(?:voucher|mã giảm|mã khuyến mãi)/i.test(lower) ||
                                 /(?:hủy voucher|huỷ voucher|dừng voucher|tắt voucher)/i.test(lower);
    const isDeleteVoucherIntent = /(?:xóa|xoá|gỡ).{0,25}(?:voucher|mã giảm|mã khuyến mãi)/i.test(lower) ||
                                 /(?:xóa voucher|xoá voucher)/i.test(lower);
    const isCancelCampaignIntent = /(?:hủy|huỷ|dừng|tắt).{0,25}(?:chiến dịch|campaign|khuyến mại|khuyến mãi|flash sale)/i.test(lower);
    const isDeleteCampaignIntent = /(?:xóa|xoá|gỡ).{0,25}(?:chiến dịch|campaign|khuyến mại|khuyến mãi|flash sale)/i.test(lower);

    if (!readOnly && hasActionPermission(user, 'create_voucher') && !actionCard && isVoucherActionIntent && !isCancelVoucherIntent && !isDeleteVoucherIntent) {
      const codeMatch = userQuestion.match(/(?:mã\s*(?:giảm\s*giá\s*|khuyến\s*mãi\s*)?|voucher\s*)([A-Za-z0-9_-]{3,20})/i);
      const candidateCode = codeMatch ? codeMatch[1] : '';
      const reservedWords = /^(?:cho|giam|khach|moi|nay|ngay|them|toi|khuyen|mai)$/i;
      const code = (candidateCode && !reservedWords.test(candidateCode))
        ? candidateCode.toUpperCase()
        : 'SALE' + Math.floor(Math.random() * 900 + 100);
      const amountMatch = userQuestion.match(/(\d+(?:[.,]\d+)?)\s*(%|k\b|nghìn|ngàn|đồng|đ\b)/i);
      let amount = 30000;
      let kind = 'fixed';
      if (amountMatch) {
        const rawNum = amountMatch[1];
        const unit = String(amountMatch[2] || '').toLowerCase();
        if (unit === '%') {
          kind = 'percent';
          const parsedPct = Math.round(Number(rawNum.replace(',', '.')));
          amount = Math.min(100, Math.max(1, Number.isFinite(parsedPct) ? parsedPct : 1));
        } else {
          const digitsOnly = rawNum.replace(/[.,]/g, '');
          const multiplier = unit === 'k' || unit === 'nghìn' || unit === 'ngàn' || digitsOnly.length <= 3 ? 1000 : 1;
          amount = Math.max(1, parseInt(digitsOnly, 10) * multiplier || 1);
        }
      }

      actionCard = await toolProposeAction({
        actionType: 'create_voucher',
        title: `🎫 Đề xuất tạo mã khuyến mãi: ${code}`,
        description: `Tạo mã giảm giá ${kind === 'percent' ? amount + '%' : formatVnd(amount)} cho khách hàng.`,
        payload: {
          code,
          title: `Ưu đãi GAERU AI: ${code}`,
          kind,
          amount,
          minSpendVnd: 200000,
          startsAt: new Date().toISOString(),
          endsAt: new Date(Date.now() + 7 * 86400000).toISOString(),
          totalLimit: 50
        }
      }, user, threadId);

      toolResults.push({ tool: 'propose_action', data: actionCard });
    }

    if (!readOnly && !actionCard && (isCancelVoucherIntent || isDeleteVoucherIntent) && hasActionPermission(user, isDeleteVoucherIntent ? 'delete_voucher' : 'cancel_voucher')) {
      const vCodeMatch = userQuestion.match(/(?:voucher|mã(?:\s+giảm(?:\s+giá)?)?|mã\s+khuyến\s+mãi|code)\s+([A-Za-z0-9_-]{3,40})/i);
      let targetVoucher = null;
      if (vCodeMatch && vCodeMatch[1]) {
        try {
          const vRes = await pool.query('SELECT id, code, title, amount, kind, active FROM marketing_vouchers WHERE lower(code) = lower($1) OR id::text = $1 LIMIT 1', [vCodeMatch[1].trim()]);
          if (vRes.rows.length) targetVoucher = vRes.rows[0];
        } catch (_) {}
      } else {
        try {
          const vRes = await pool.query('SELECT id, code, title, amount, kind, active FROM marketing_vouchers WHERE (SELECT count(*) FROM marketing_vouchers) = 1 LIMIT 1');
          if (vRes.rows.length) targetVoucher = vRes.rows[0];
        } catch (_) {}
      }
      if (targetVoucher) {
        const isDelete = isDeleteVoucherIntent;
        actionCard = await toolProposeAction({
          actionType: isDelete ? 'delete_voucher' : 'cancel_voucher',
          title: isDelete ? `🗑️ Xác nhận XÓA VĨNH VIỄN Voucher: ${targetVoucher.code}` : `🛑 Xác nhận DỪNG Voucher: ${targetVoucher.code}`,
          description: isDelete ? `Xóa vĩnh viễn voucher ${targetVoucher.code} khỏi cơ sở dữ liệu. Thao tác không thể hoàn tác.` : `Dừng kích hoạt voucher ${targetVoucher.code} (chuyển trạng thái sang Tạm tắt).`,
          payload: {
            voucherId: targetVoucher.id,
            code: targetVoucher.code,
            title: targetVoucher.title
          }
        }, user, threadId);
        toolResults.push({ tool: 'propose_action', data: actionCard });
      }
    }

    if (!readOnly && !actionCard && (isCancelCampaignIntent || isDeleteCampaignIntent) && hasActionPermission(user, isDeleteCampaignIntent ? 'delete_campaign' : 'cancel_campaign')) {
      const campNameMatch = userQuestion.match(/(?:chiến\s+dịch(?:\s+khuyến\s+mại|\s+khuyến\s+mãi)?|campaign|flash\s+sale)\s+([^\n,.!?]{2,80})/i);
      const rawCampName = campNameMatch ? campNameMatch[1].trim() : '';
      const requestedName = /^(?:khuyến\s+mại|khuyến\s+mãi)$/i.test(rawCampName) ? '' : rawCampName;
      let targetCampaign = null;
      try {
        if (requestedName) {
          const cRes = await pool.query("SELECT id, title, active FROM marketing_campaigns WHERE lower(title) LIKE '%' || lower($1) || '%' OR id::text = $1 ORDER BY created_at DESC LIMIT 1", [requestedName]);
          if (cRes.rows.length) targetCampaign = { ...cRes.rows[0], type: 'campaign' };
          if (!targetCampaign) {
            const pRes = await pool.query("SELECT id, title, active FROM product_promotions WHERE lower(title) LIKE '%' || lower($1) || '%' OR id::text = $1 ORDER BY created_at DESC LIMIT 1", [requestedName]);
            if (pRes.rows.length) targetCampaign = { ...pRes.rows[0], type: 'promotion' };
          }
        } else {
          const cRes = await pool.query('SELECT id, title, active FROM marketing_campaigns ORDER BY created_at DESC LIMIT 1');
          if (cRes.rows.length) targetCampaign = { ...cRes.rows[0], type: 'campaign' };
          if (!targetCampaign) {
            const pRes = await pool.query('SELECT id, title, active FROM product_promotions ORDER BY created_at DESC LIMIT 1');
            if (pRes.rows.length) targetCampaign = { ...pRes.rows[0], type: 'promotion' };
          }
        }
      } catch (_) {}
      if (targetCampaign) {
        const isDelete = isDeleteCampaignIntent;
        actionCard = await toolProposeAction({
          actionType: isDelete ? 'delete_campaign' : 'cancel_campaign',
          title: isDelete ? `🗑️ Xác nhận XÓA VĨNH VIỄN Chiến dịch: ${targetCampaign.title}` : `🛑 Xác nhận DỪNG Chiến dịch: ${targetCampaign.title}`,
          description: isDelete ? `Xóa vĩnh viễn chiến dịch "${targetCampaign.title}" khỏi hệ thống.` : `Dừng kích hoạt chiến dịch "${targetCampaign.title}".`,
          payload: {
            campaignId: targetCampaign.id,
            title: targetCampaign.title,
            type: targetCampaign.type
          }
        }, user, threadId);
        toolResults.push({ tool: 'propose_action', data: actionCard });
      }
    }

    const isActionWorkflowTurn = Boolean(
      actionCard || isVoucherActionIntent || isCancelVoucherIntent || isDeleteVoucherIntent || isCancelCampaignIntent || isDeleteCampaignIntent
    );

    // 2. Nhận diện câu hỏi tiếp nối ngắn (Multi-turn follow-up)
    const isFollowUpTime = /^(?:con|the con|vay con|xem|neu|hom qua|tuan|thang|\d+\s*(?:ngay|tuan|thang))\b/.test(norm) &&
      hasAnyBoundaryTerm(norm, ['ngay', 'tuan', 'thang', 'hom qua', 'quy']);
    const isFollowUpProduct = /^(?:con|the con|vay con|kiem tra|the|xem)\b/.test(norm) &&
      hasAnyBoundaryTerm(norm, ['p01', 'k9', 'm3', 'p185', 'g1', 'g1 ultra']);
    const isDraftingRequest = !hasAnyBoundaryTerm(norm, ['doanh thu', 'ton kho', 'tra cuu', 'don hang', 'thong ke', 'bao cao', 'van don']) &&
      hasAnyBoundaryTerm(norm, ['viet', 'soan', 'mau tin nhan', 'caption', 'kich ban', 'bai dang']);

    if (!isActionWorkflowTurn && !isDraftingRequest) {
      // A. Doanh thu & Tổng quan kinh doanh (không kích hoạt nhầm khi "báo cáo" đi kèm chủ đề khác như CSKH/kho/hệ thống)
      const mentionsOtherReportDomain = hasAnyBoundaryTerm(norm, ['ton kho', 'kho hang', 'cskh', 'bao hanh', 'khiếu nại', 'khieu nai', 'doi tra', 'van don', 'he thong', 'may chu', 'tri thuc', 'tu hoc']);
      if (
        hasAnyBoundaryTerm(norm, ['doanh thu', 'doanh so', 'tong quan', 'ban duoc bao nhieu', 'hom nay the nao', 'tinh hinh kinh doanh', 'ket qua kinh doanh']) ||
        (hasBoundaryTerm(norm, 'bao cao') && !mentionsOtherReportDomain) ||
        (isFollowUpTime && hasAnyBoundaryTerm(normHistory, ['doanh thu', 'doanh so', 'kinh doanh', 'tong quan']))
      ) {
        const days = parseFlexibleDays(userQuestion);
        const overview = await toolGetBusinessOverview({ days }, user);
        toolResults.push({ tool: 'get_business_overview', data: overview });
      }

      // B. Tra cứu Đơn hàng (Hỗ trợ cả GR-... và GAE-...; không hiểu nhầm "tạo cho tôi" thành pending)
      const isOrderLookupQuery = hasAnyBoundaryTerm(norm, [
        'don hang', 'tra cuu don', 'cho xu ly', 'cho xac nhan', 'don cho', 'don moi', 'chua thanh toan', 'don huy', 'don bi huy', 'tim don', 'kiem tra don'
      ]) || questionOrders.length > 0 || questionPhones.length > 0;
      const onlyShippingTracking = hasAnyBoundaryTerm(norm, ['van don', 'lo trinh', 'buu cuc', 'viettel post', 'hanh trinh giao']) && !hasAnyBoundaryTerm(norm, ['don hang', 'cho xu ly', 'don moi', 'don huy']);
      if (isOrderLookupQuery && !onlyShippingTracking) {
        const isPendingStatus = /\b(?:cho xu ly|cho xac nhan|chua duyet|don cho|pending|don moi|moi dat)\b/.test(norm) ||
          (/\bchờ\b/i.test(lower) && hasAnyBoundaryTerm(norm, ['don', 'xac nhan', 'xu ly', 'duyet']));
        const status = isPendingStatus ? 'pending'
          : hasAnyBoundaryTerm(norm, ['dang dong goi', 'chuan bi hang', 'processing']) ? 'processing'
          : hasAnyBoundaryTerm(norm, ['dang giao', 'dang van chuyen', 'shipped']) ? 'shipped'
          : hasAnyBoundaryTerm(norm, ['hoan thanh', 'da giao', 'giao thanh cong', 'completed']) ? 'completed'
          : (hasAnyBoundaryTerm(norm, ['da huy', 'don huy', 'bi huy', 'cancelled']) && !isTermNegated(norm, 'huy')) ? 'cancelled' : '';
        const kw = questionOrders[0] || questionPhones[0] || '';
        const orders = await toolQueryOrders({ keyword: kw, status, limit: 6 }, user);
        toolResults.push({ tool: 'query_orders', data: orders });
      }

      // C. Kiểm tra Tồn kho & Sản phẩm
      const modelKw = hasBoundaryTerm(norm, 'p01') ? 'P01'
        : hasBoundaryTerm(norm, 'k9') ? 'K9'
        : hasBoundaryTerm(norm, 'm3') ? 'M3'
        : hasBoundaryTerm(norm, 'p185') ? 'P185'
        : hasAnyBoundaryTerm(norm, ['g1', 'g1 ultra']) ? 'G1'
        : (userQuestion.match(/\bSKU-[A-Z0-9-]+\b/i)?.[0] || '');
      const asksInventory = hasAnyBoundaryTerm(norm, ['ton kho', 'het hang', 'sap het', 'kho hang', 'con bao nhieu', 'so luong kho', 'kiem ke']) ||
        (Boolean(modelKw) && !hasAnyBoundaryTerm(norm, ['don hang', 'van don'])) ||
        (isFollowUpProduct && hasAnyBoundaryTerm(normHistory, ['ton kho', 'kho hang']));
      if (asksInventory) {
        const lowStockOnly = hasAnyBoundaryTerm(norm, ['sap het', 'het hang', 'canh bao', 'ton thap', 'duoi 5']) && !modelKw;
        const stock = await toolCheckInventory({ keyword: modelKw, lowStockOnly }, user);
        toolResults.push({ tool: 'check_inventory', data: stock });
      }

      // D. Vận đơn & Lộ trình giao hàng
      if (hasAnyBoundaryTerm(norm, ['van don', 'viettel', 'viettel post', 'jt', 'spx', 'giao hang', 'van chuyen', 'lo trinh', 'buu cuc'])) {
        const isSpecificOrderRef = questionOrders.length > 0 || (refersPrevOrder && Boolean(historyOrders[0]));
        const shipping = await toolQueryShipping({ orderNumber: isSpecificOrderRef ? resolvedOrderCode : '' }, user);
        toolResults.push({ tool: 'query_shipping', data: shipping });
      }

      // E. Lưu lượng truy cập Website (Traffic & Online Visitors)
      if (hasAnyBoundaryTerm(norm, ['truy cap', 'traffic', 'luot xem', 'pageview', 'khach online', 'dang online', 'nguoi online', 'ghe tham'])) {
        const traffic = await toolGetTrafficAnalytics();
        toolResults.push({ tool: 'get_traffic_analytics', data: traffic });
      }

      // F. Chương trình Khuyến mãi & Danh sách Voucher
      if (hasAnyBoundaryTerm(norm, ['khuyen mai', 'voucher', 'ma giam gia', 'chien dich', 'flash sale'])) {
        const mkt = await toolGetMarketingOverview(user);
        toolResults.push({ tool: 'get_marketing_overview', data: mkt });
      }

      // G. Chăm sóc khách hàng, Tin nhắn chờ & Bảo hành / Đổi trả
      if (hasAnyBoundaryTerm(norm, ['cskh', 'cham soc khach hang', 'tin nhan khach', 'chat khach', 'bao hanh', 'doi tra', 'hau mai', 'khieu nai'])) {
        const care = await toolGetCustomerCareOverview(user);
        toolResults.push({ tool: 'get_customer_care', data: care });
      }

      // H. Sức khỏe Hệ thống & Hạ tầng Máy chủ
      if (hasAnyBoundaryTerm(norm, ['he thong', 'may chu', 'server', 'cluster', 'bao mat', 'cpu', 'ram', 'waf', 'suc khoe'])) {
        const sys = await toolCheckSystemHealth();
        toolResults.push({ tool: 'check_system_health', data: sys });
      }

      // I. Tri thức Tự học (Self-Learning Knowledge - requires settings.read)
      if (hasAnyBoundaryTerm(norm, ['tu hoc', 'hoc hoi', 'tri thuc', 'learned', 'khach hang hoi gi', 'kien thuc'])) {
        if (!hasReadPermission(user, ['settings.read'])) {
          toolResults.push({ tool: 'get_learned_knowledge', data: { error: 'Bạn không có quyền xem cấu hình/tri thức AI (cần quyền settings.read).' } });
        } else {
          try {
            const { getLearnedKnowledgeStats } = require('./ai-self-learning');
            const learned = await getLearnedKnowledgeStats(pool);
            toolResults.push({ tool: 'get_learned_knowledge', data: learned });
          } catch (_) {}
        }
      }
    }

    // 3. Tổng hợp phản hồi chính xác, súc tích, đúng trọng tâm câu hỏi
    let dynamicShippingPhrase = 'Freeship toàn quốc';
    try {
      const liveFacts = await require('./chat-web-knowledge').loadLiveSiteFacts(pool);
      const nationwideFee = liveFacts?.shippingRates?.['Toàn quốc'];
      if (liveFacts?.shippingNote) dynamicShippingPhrase = liveFacts.shippingNote;
      else if (nationwideFee === undefined) dynamicShippingPhrase = 'Freeship đơn từ 500.000 ₫';
      else if (Number(nationwideFee) > 0) dynamicShippingPhrase = `phí ship đồng giá ${formatVnd(nationwideFee)}`;
    } catch (_) {}

    let aiResponseText = synthesizeDeterministicResponse(userQuestion, toolResults, actionCard, user, dynamicShippingPhrase);

    if (aiResponseText) {
      aiResponseText = aiResponseText.replace(/GAERU Copilot/gi, 'GAERU AI').replace(/Copilot/gi, 'GAERU AI');
    }

    return {
      content: aiResponseText,
      toolResults,
      actionCard
    };
  }

  // Bộ tổng hợp phản hồi chính xác, ngắn gọn, không lan man của GAERU AI
  function synthesizeDeterministicResponse(question, toolResults, actionCard, user, dynamicShippingPhrase = 'Freeship toàn quốc') {
    const norm = expandQueryVi(question);
    const detailed = isExplicitDetailedRequest(norm);
    const userTitle = user?.isOwner ? 'CEO' : (user?.username || 'Quản trị viên');
    const statusLabelMap = {
      pending: 'Chờ xác nhận',
      confirmed: 'Đã xác nhận',
      processing: 'Đang đóng gói',
      shipped: 'Đang giao hàng',
      completed: 'Hoàn thành',
      cancelled: 'Đã hủy'
    };
    const payLabelMap = {
      paid: 'Đã thanh toán',
      pending: 'Chờ thanh toán',
      refunded: 'Đã hoàn tiền',
      failed: 'Thất bại'
    };

    const overview = toolResults.find(t => t.tool === 'get_business_overview')?.data;
    const ordersTool = toolResults.find(t => t.tool === 'query_orders');
    const orders = ordersTool?.data;
    const shippingTool = toolResults.find(t => t.tool === 'query_shipping');
    const shipping = shippingTool?.data;
    const inventoryTool = toolResults.find(t => t.tool === 'check_inventory');
    const inventory = inventoryTool?.data;
    const traffic = toolResults.find(t => t.tool === 'get_traffic_analytics')?.data;
    const marketing = toolResults.find(t => t.tool === 'get_marketing_overview')?.data;
    const care = toolResults.find(t => t.tool === 'get_customer_care')?.data;
    const sys = toolResults.find(t => t.tool === 'check_system_health')?.data;
    const learned = toolResults.find(t => t.tool === 'get_learned_knowledge')?.data;

    let out = '';

    // 1. Kinh doanh & Doanh thu: Trả thẳng số liệu cần hỏi khi hỏi gọn, chỉ mở bảng breakdown khi yêu cầu báo cáo/tổng quan
    if (overview) {
      const periodText = overview.periodDays === 1 ? 'hôm nay (24h qua)' : `${overview.periodDays} ngày qua`;
      const wantsOnlyRevenueSummary = !detailed &&
        hasAnyBoundaryTerm(norm, ['doanh thu', 'doanh so', 'ban duoc bao nhieu']) &&
        !hasAnyBoundaryTerm(norm, ['don cho', 'don hang', 'khach moi', 'tien do']);

      if (wantsOnlyRevenueSummary) {
        if (overview.revenue?.paidFormatted) {
          out += `**Doanh thu ${periodText}:** Thực thu **${overview.revenue.paidFormatted}** · Tổng giá trị **${overview.revenue.grossFormatted}** (${overview.totalOrders} đơn hàng${overview.pendingOrders > 0 ? `, ${overview.pendingOrders} chờ xác nhận` : ''}).\n\n`;
        } else {
          out += `**Doanh thu (${periodText}):** ${overview.revenue?.note || 'Không có quyền xem dữ liệu tài chính.'}\n\n`;
        }
      } else {
        out += `**Báo cáo kinh doanh (${periodText}):**\n`;
        if (overview.revenue?.paidFormatted) {
          out += `- **Doanh thu thực thu:** **${overview.revenue.paidFormatted}** (Tổng giá trị đơn: **${overview.revenue.grossFormatted}**)\n`;
        } else if (overview.revenue?.note) {
          out += `- **Doanh thu:** *${overview.revenue.note}*\n`;
        }
        out += `- **Đơn hàng:** **${overview.totalOrders}** đơn (Chờ xác nhận: ${overview.pendingOrders}, Đang xử lý: ${overview.processingOrders}, Đang giao: ${overview.shippedOrders}, Hoàn thành: ${overview.completedOrders})\n`;
        out += `- **Khách mới:** ${overview.newCustomers} tài khoản\n\n`;
      }
    }

    // 2. Đơn hàng
    if (orders?.error) {
      out += `- ⚠️ ${orders.error}\n\n`;
    } else if (orders && orders.length) {
      out += `**Đơn hàng (${orders.length} đơn):**\n`;
      out += `| Mã đơn | Khách hàng | SĐT | Trạng thái | Thanh toán | Tổng tiền |\n`;
      out += `|:---|:---|:---|:---|:---|---:|\n`;
      for (const o of orders) {
        out += `| **${o.orderNumber}** | ${o.customerName} | ${o.phone} | ${statusLabelMap[o.status] || o.status} | ${payLabelMap[o.paymentStatus] || o.paymentStatus} | **${o.totalFormatted}** |\n`;
      }
      out += `\n`;
    } else if (ordersTool && Array.isArray(orders) && orders.length === 0 && !overview && !shippingTool) {
      out += `Không tìm thấy đơn hàng nào khớp điều kiện tra cứu.\n\n`;
    }

    // 3. Vận chuyển & Vận đơn
    if (shipping) {
      if (shipping.error) {
        out += `- ⚠️ ${shipping.error} (định dạng mã \`GR-...\` hoặc \`GAE-...\`).\n\n`;
      } else if (shipping.shipment && shipping.order) {
        out += `**Vận đơn ${shipping.order.orderNumber}:** ${shipping.shipment.carrier} · Mã \`${shipping.shipment.trackingNumber}\` · ${statusLabelMap[shipping.shipment.status] || shipping.shipment.status} (${shipping.order.customerName} — ${shipping.order.city || ''}).\n\n`;
      } else if (Array.isArray(shipping.shipments)) {
        if (shipping.shipments.length > 0) {
          out += `**Vận đơn đang điều phối (${shipping.shipments.length}):**\n`;
          out += `| Mã đơn | Khách hàng | Khu vực | Hãng VC | Mã vận đơn | Trạng thái |\n`;
          out += `|:---|:---|:---|:---|:---|:---|\n`;
          for (const s of shipping.shipments) {
            out += `| **${s.orderNumber}** | ${s.customerName} | ${s.city || '—'} | ${s.carrier} | \`${s.trackingNumber}\` | ${statusLabelMap[s.shipmentStatus] || s.shipmentStatus} |\n`;
          }
          out += `\n`;
        } else {
          out += `Hiện không có đơn hàng nào đang chờ giao hoặc trên lộ trình vận chuyển.\n\n`;
        }
      }
    }

    // 4. Tồn kho
    if (inventory?.error) {
      out += `- ⚠️ ${inventory.error}\n\n`;
    } else if (inventory && inventory.length) {
      const lowCount = inventory.filter(i => i.isLowStock).length;
      out += `**Tồn kho (${inventory.length} SKU${lowCount > 0 ? `, ${lowCount} sắp hết ≤ 5` : ''}):**\n`;
      out += `| Sản phẩm | Biến thể | SKU | Giá | Tồn | Trạng thái |\n`;
      out += `|:---|:---|:---|---:|:---:|:---|\n`;
      for (const it of inventory) {
        out += `| **${it.productName}** | ${it.variantName} | \`${it.sku}\` | ${it.priceFormatted} | **${it.stockQuantity}** | ${it.stockStatus} |\n`;
      }
      out += `\n`;
    } else if (inventoryTool && Array.isArray(inventory) && inventory.length === 0) {
      out += `Không có SKU nào nằm dưới ngưỡng tồn kho thấp (≤ 5) hoặc khớp từ khóa tìm kiếm.\n\n`;
    }

    // 5. Lưu lượng truy cập Storefront
    if (traffic) {
      const nf = new Intl.NumberFormat('vi-VN');
      const onlyOnline = !detailed && hasAnyBoundaryTerm(norm, ['dang online', 'khach online', 'nguoi online']) && !hasAnyBoundaryTerm(norm, ['luot xem', 'pageview', 'tong']);
      if (onlyOnline) {
        out += `- **Đang trực tuyến:** **${traffic.activeNow}** khách (hôm nay: ${nf.format(traffic.todayVisitors)} khách, ${nf.format(traffic.todayPageviews)} lượt xem).\n\n`;
      } else {
        out += `**Lưu lượng truy cập Website:**\n`;
        out += `- Đang trực tuyến (15 phút qua): **${traffic.activeNow}** khách\n`;
        out += `- Hôm nay: **${nf.format(traffic.todayPageviews)}** lượt xem (**${nf.format(traffic.todayVisitors)}** khách)\n`;
        out += `- Tổng tích lũy: **${nf.format(traffic.totalPageviews)}** lượt xem\n\n`;
      }
    }

    // 6. Khuyến mãi & Voucher
    if (marketing) {
      if (marketing.error) {
        out += `- ⚠️ ${marketing.error}\n\n`;
      } else if (marketing.vouchers && marketing.vouchers.length > 0) {
        out += `**Mã giảm giá (${marketing.vouchers.length}):**\n`;
        out += `| Mã Voucher | Chương trình | Mức giảm | Đơn tối thiểu | Trạng thái |\n`;
        out += `|:---|:---|:---:|---:|:---:|\n`;
        for (const v of marketing.vouchers) {
          out += `| \`${v.code}\` | ${v.title} | **${v.discountFormatted}** | ${v.minSpendFormatted} | ${v.active ? 'Đang bật' : 'Tạm tắt'} |\n`;
        }
        out += `\n`;
      } else {
        out += `Hiện chưa có mã giảm giá nào trong hệ thống.\n\n`;
      }
    }

    // 7. CSKH & Bảo hành (Giữ chuẩn định dạng số đếm bảo hành & hồ sơ đổi trả)
    if (care) {
      if (care.error) {
        out += `- ⚠️ ${care.error}\n\n`;
      } else {
        out += `**CSKH & Hậu mãi:**\n`;
        out += `- Chat đang mở: **${care.openChats}** (${care.awaitingAdminChats > 0 ? `**${care.awaitingAdminChats}** chờ nhân viên` : 'đã phản hồi đủ'})\n`;
        out += `- Đổi trả / khiếu nại chưa đóng: **${care.pendingReturns}** hồ sơ\n`;
        out += `- Bảo hành kích hoạt: **${care.activeWarranties}** thiết bị\n\n`;
      }
    }

    // 8. Sức khỏe Hệ thống
    if (sys) {
      out += `**Hệ thống (${String(sys.status || 'ok').toUpperCase()}):** ${sys.clusterMode} · Uptime ${Math.max(1, Math.round((sys.uptimeSeconds || 0) / 60))} phút · RSS **${sys.memoryRssMb} MB** (Heap **${sys.heapUsedMb} MB**) · DB **${sys.dbLatencyMs} ms** · WAF đã chặn **${sys.threatsBlocked}**.\n\n`;
    }

    // 9. Tri thức Tự học
    if (learned) {
      const counts = learned.stats || learned.counts || {};
      out += `**Tri thức tự học:** **${counts.total || 0}** bài (**${counts.active_count || 0}** đang bật, **${counts.total_interactions || 0}** lượt học, tin cậy TB **${Math.round((counts.avg_confidence || 0.85) * 100)}%**).\n`;
      if (learned.topEntries && learned.topEntries.length) {
        for (const e of learned.topEntries.slice(0, 5)) {
          out += `- **${e.topic}** (${e.occurrence_count} lần · ${Math.round(e.confidence_score * 100)}%)\n`;
        }
      }
      out += `\n`;
    }

    // 10. Action Card
    if (actionCard) {
      out += `Đã tạo thẻ xác nhận **${actionCard.title}** phía dưới — vui lòng kiểm tra lại thông số và bấm **[Xác nhận thực hiện]** để áp dụng.\n\n`;
    }

    // 11. Soạn thảo nội dung / Chào hỏi / Ngoài phạm vi
    if (!toolResults.length && !actionCard) {
      if (/^(?:xin chao|chao|hello|hi|alo|ban la ai|giup gi|co the lam gi)\b/.test(norm)) {
        out += `Chào ${userTitle}, mình là **GAERU AI**. Bạn cần kiểm tra số liệu **doanh thu**, **đơn hàng/vận đơn**, **tồn kho**, **CSKH**, hay muốn **tạo action** (duyệt đơn, tạo voucher)?`;
      } else if (hasAnyBoundaryTerm(norm, ['viet', 'soan', 'mau tin nhan', 'caption', 'kich ban', 'bai dang', 'xin loi khach'])) {
        if (hasAnyBoundaryTerm(norm, ['xin loi', 'giao tre', 'cham'])) {
          out += `Mẫu tin nhắn xin lỗi giao trễ:\n\n` +
            `> *"Chào anh/chị, GAERU xin lỗi vì đơn hàng giao chậm hơn dự kiến. Bên mình đã làm việc trực tiếp với Viettel Post để ưu tiên phát sớm nhất tới anh/chị. Cảm ơn anh/chị đã thông cảm và đồng hành cùng GAERU ạ!"*`;
        } else if (hasBoundaryTerm(norm, 'p01')) {
          out += `Bản thảo giới thiệu **GAERU P01 (Gimbal AI quay theo người)**:\n\n` +
            `> Tự quay một mình vẫn luôn gọn khung hình với **GAERU P01** — tự động nhận diện và xoay 360° theo người không cần app, pin ~6–8 giờ, hỗ trợ bản để bàn hoặc chân 2m1. Bảo hành 12 tháng 1 đổi 1.`;
        } else if (hasBoundaryTerm(norm, 'm3')) {
          out += `Bản thảo giới thiệu **GAERU M3**:\n\n` +
            `> Thu âm gọn nhẹ cùng **GAERU M3** — bộ 2 mic cài áo kèm hộp sạc hiển thị % pin, thu 360° chuẩn 24-bit/48kHz, giảm ồn AI thông minh, tổng thời lượng lên tới 24 giờ.`;
        } else if (hasBoundaryTerm(norm, 'k9')) {
          out += `Bản thảo giới thiệu **GAERU K9**:\n\n` +
            `> **GAERU K9** — mic cài áo không dây siêu nhẹ 7g, cắm là dùng ngay (Type-C / Lightning), thu đa hướng 360° lọc ồn DSP, cự ly tới 20m cho TikTok, livestream và dạy học.`;
        } else {
          out += `Bản thảo gợi ý:\n\n` +
            `> Thiết bị thu âm & sáng tạo **GAERU** — kết nối cắm là dùng cho iPhone, Android và Laptop, lọc ồn rõ nét, bảo hành chính hãng 12 tháng (1 đổi 1 trong 30 ngày) và ${dynamicShippingPhrase}.`;
        }
      } else {
        out += `Chưa khớp yêu cầu với công cụ nào. Hãy hỏi cụ thể theo mảng (**doanh thu 7 ngày**, **đơn hàng mã GR-...**, **tồn kho K9**, **khách online**, **tạo voucher...**) để mình trích xuất dữ liệu ngay.`;
      }
    }

    return out.trim();
  }

  // ==========================================================================
  // ROUTE ENDPOINTS
  // ==========================================================================

  // 1. Lấy danh sách hội thoại của user
  router.get('/threads', async (req, res, next) => {
    try {
      const userId = req.admin?.id || 'admin';
      const rows = (await pool.query(`
        SELECT id, title, created_at AS "createdAt", updated_at AS "updatedAt"
        FROM internal_ai_threads
        WHERE user_id = $1
        ORDER BY updated_at DESC
        LIMIT 20
      `, [userId])).rows;
      res.json({ threads: rows });
    } catch (e) {
      next(e);
    }
  });

  // 2. Tạo hội thoại mới
  router.post('/threads', async (req, res, next) => {
    try {
      const userId = req.admin?.id || 'admin';
      const userRole = req.admin?.role || (req.admin?.isOwner ? 'owner' : 'staff');
      const userName = req.admin?.username || 'Quản trị viên';
      const title = (req.body?.title || 'Hội thoại mới').trim().slice(0, 100);

      const row = (await pool.query(`
        INSERT INTO internal_ai_threads (user_id, user_role, user_name, title)
        VALUES ($1, $2, $3, $4)
        RETURNING id, title, created_at AS "createdAt", updated_at AS "updatedAt"
      `, [userId, userRole, userName, title])).rows[0];

      res.status(201).json({ thread: row });
    } catch (e) {
      next(e);
    }
  });

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const isUuid = value => UUID_RE.test(String(value || '').trim());

  // 3. Lấy chi tiết tin nhắn trong hội thoại (Bảo mật F02: Chỉ chủ sở hữu hoặc Owner)
  router.get('/threads/:id', async (req, res, next) => {
    try {
      const threadId = req.params.id;
      if (!isUuid(threadId)) return res.status(400).json({ error: 'Mã hội thoại không hợp lệ.' });
      const userId = req.admin?.id || 'admin';
      const isOwner = req.admin?.isOwner || req.admin?.role === 'owner';
      const thread = (await pool.query(`
        SELECT id, title, user_role AS "userRole", created_at AS "createdAt", updated_at AS "updatedAt"
        FROM internal_ai_threads
        WHERE id = $1 AND (user_id = $2 OR $3 = true)
      `, [threadId, userId, isOwner])).rows[0];

      if (!thread) return res.status(404).json({ error: 'Không tìm thấy phiên hội thoại.' });

      const messages = (await pool.query(`
        SELECT id, role, content, tool_results AS "toolResults", action_card AS "actionCard", created_at AS "createdAt"
        FROM (
          SELECT id, role, content, tool_results, action_card, created_at
          FROM internal_ai_messages
          WHERE thread_id = $1
          ORDER BY created_at DESC, id DESC
          LIMIT 100
        ) recent
        ORDER BY created_at ASC, id ASC
      `, [threadId])).rows;

      res.json({ thread, messages });
    } catch (e) {
      next(e);
    }
  });

  // 4. Xóa phiên hội thoại (Bảo mật F02: Chỉ chủ sở hữu hoặc Owner)
  router.delete('/threads/:id', async (req, res, next) => {
    try {
      const threadId = req.params.id;
      if (!isUuid(threadId)) return res.status(400).json({ error: 'Mã hội thoại không hợp lệ.' });
      const userId = req.admin?.id || 'admin';
      const isOwner = req.admin?.isOwner || req.admin?.role === 'owner';
      const delRes = await pool.query(`
        DELETE FROM internal_ai_threads 
        WHERE id = $1 AND (user_id = $2 OR $3 = true)
      `, [threadId, userId, isOwner]);

      if (!delRes.rowCount) {
        return res.status(404).json({ error: 'Không tìm thấy phiên hội thoại để xóa.' });
      }
      res.json({ success: true, message: 'Đã xóa phiên hội thoại.' });
    } catch (e) {
      next(e);
    }
  });

  // 5. Gửi câu hỏi và chat với AI (Standard JSON - Bảo mật F02: Phân quyền phiên)
  router.post('/threads/:id/chat', async (req, res, next) => {
    try {
      const threadId = req.params.id;
      if (!isUuid(threadId)) return res.status(400).json({ error: 'Mã hội thoại không hợp lệ.' });
      const question = String(req.body?.question || '').trim();
      if (!question) return res.status(400).json({ error: 'Nội dung câu hỏi không được để trống.' });
      if (question.length > 2000) return res.status(400).json({ error: 'Câu hỏi tối đa 2000 ký tự.' });

      const userId = req.admin?.id || 'admin';
      const isOwner = req.admin?.isOwner || req.admin?.role === 'owner';
      const thread = (await pool.query(`
        SELECT id, title 
        FROM internal_ai_threads 
        WHERE id = $1 AND (user_id = $2 OR $3 = true)
      `, [threadId, userId, isOwner])).rows[0];
      if (!thread) return res.status(404).json({ error: 'Không tìm thấy phiên hội thoại.' });

      // Lưu câu hỏi của user
      await pool.query(`
        INSERT INTO internal_ai_messages (thread_id, role, content)
        VALUES ($1, $2, $3)
      `, [threadId, 'user', question]);

      // Lấy lịch sử hội thoại gần nhất
      const history = (await pool.query(`
        SELECT role, content FROM (
          SELECT role, content, created_at, id
          FROM internal_ai_messages
          WHERE thread_id = $1
          ORDER BY created_at DESC, id DESC
          LIMIT 10
        ) recent
        ORDER BY created_at ASC, id ASC
      `, [threadId])).rows;

      // Thực thi Agent Turn GAERU AI
      const turnResult = await executeAgentTurn({
        userQuestion: question,
        history,
        user: req.admin,
        threadId
      });

      // Lưu phản hồi của Assistant
      const assistantMsg = (await pool.query(`
        INSERT INTO internal_ai_messages (thread_id, role, content, tool_results, action_card)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id, role, content, tool_results AS "toolResults", action_card AS "actionCard", created_at AS "createdAt"
      `, [threadId, 'assistant', turnResult.content, JSON.stringify(turnResult.toolResults || []), turnResult.actionCard ? JSON.stringify(turnResult.actionCard) : null])).rows[0];

      // Cập nhật tiêu đề nếu phiên mới
      if (thread.title === 'Hội thoại mới') {
        const newTitle = question.slice(0, 40) + (question.length > 40 ? '...' : '');
        await pool.query(`UPDATE internal_ai_threads SET title = $1, updated_at = NOW() WHERE id = $2`, [newTitle, threadId]);
      } else {
        await pool.query(`UPDATE internal_ai_threads SET updated_at = NOW() WHERE id = $1`, [threadId]);
      }

      res.json({
        answer: assistantMsg.content,
        messageRecord: assistantMsg,
        message: null,
        toolResults: turnResult.toolResults,
        actionCard: turnResult.actionCard
      });
    } catch (e) {
      next(e);
    }
  });

  function isSameOriginSseRequest(req) {
    const secFetchSite = String(req.headers?.['sec-fetch-site'] || '').trim().toLowerCase();
    return !secFetchSite || secFetchSite === 'same-origin' || secFetchSite === 'none';
  }

  async function streamAgentConversation(req, res, { question, readOnly }) {
    const threadId = req.params.id;
    if (!isUuid(threadId)) {
      return res.status(400).send('Mã hội thoại không hợp lệ.');
    }
    const cleanQuestion = String(question || '').trim();

    if (!cleanQuestion) {
      return res.status(400).send('Câu hỏi không được để trống');
    }
    if (cleanQuestion.length > 2000) {
      return res.status(400).send('Câu hỏi tối đa 2000 ký tự.');
    }

    // Bảo mật F02: Xác thực quyền sở hữu thread trước khi stream
    const userId = req.admin?.id || 'admin';
    const isOwner = Boolean(req.admin?.isOwner || req.admin?.role === 'owner' || req.admin?.source === 'bootstrap');
    const thread = (await pool.query(`
      SELECT id, title 
      FROM internal_ai_threads 
      WHERE id = $1 AND (user_id = $2 OR $3 = true)
    `, [threadId, userId, isOwner])).rows[0];

    if (!thread) {
      return res.status(404).send('Không tìm thấy phiên hội thoại hoặc không có quyền truy cập');
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });

    const sendEvent = (event, data) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    try {
      sendEvent('status', { message: 'Đang kết nối cơ sở dữ liệu và phân tích...' });

      let history = [];
      if (!readOnly) {
        // Chỉ lưu DB trên POST (GET SSE giữ read-only tuyệt đối, tránh CSRF đột biến)
        await pool.query(`
          INSERT INTO internal_ai_messages (thread_id, role, content)
          VALUES ($1, $2, $3)
        `, [threadId, 'user', cleanQuestion]);

        history = (await pool.query(`
          SELECT role, content FROM (
            SELECT id, role, content, created_at
            FROM internal_ai_messages
            WHERE thread_id = $1
            ORDER BY created_at DESC, id DESC
            LIMIT 10
          ) recent
          ORDER BY created_at ASC, id ASC
        `, [threadId]))?.rows || [];
      }

      const turnResult = await executeAgentTurn({
        userQuestion: cleanQuestion,
        history,
        user: req.admin,
        threadId,
        readOnly
      });

      sendEvent('tools', { toolResults: turnResult.toolResults });

      // Sửa F11: Phát đầy đủ 100% các từ qua sự kiện SSE token (theo nhóm 3 từ để mượt mà, không rơi từ)
      const words = turnResult.content.split(' ');
      let chunk = '';
      for (let i = 0; i < words.length; i++) {
        if (res.writableEnded || req.destroyed) break;
        chunk += (chunk ? ' ' : '') + words[i];
        if ((i + 1) % 3 === 0 || i === words.length - 1) {
          sendEvent('token', { text: chunk + (i === words.length - 1 ? '' : ' ') });
          chunk = '';
          await new Promise(r => setTimeout(r, 20));
        }
      }
      if (res.writableEnded || req.destroyed) return;

      if (readOnly) {
        sendEvent('done', {
          message: {
            role: 'assistant',
            content: turnResult.content,
            toolResults: turnResult.toolResults || [],
            actionCard: null,
            readOnly: true
          },
          actionCard: null
        });
      } else {
        const assistantMsg = (await pool.query(`
          INSERT INTO internal_ai_messages (thread_id, role, content, tool_results, action_card)
          VALUES ($1, $2, $3, $4, $5)
          RETURNING id, role, content, tool_results AS "toolResults", action_card AS "actionCard", created_at AS "createdAt"
        `, [threadId, 'assistant', turnResult.content, JSON.stringify(turnResult.toolResults || []), turnResult.actionCard ? JSON.stringify(turnResult.actionCard) : null])).rows[0];

        await pool.query(`UPDATE internal_ai_threads SET updated_at = NOW() WHERE id = $1`, [threadId]);

        sendEvent('done', { message: assistantMsg, actionCard: turnResult.actionCard });
      }
      res.end();
    } catch (_) {
      sendEvent('error', { error: 'Đã xảy ra lỗi khi xử lý yêu cầu AI.' });
      res.end();
    }
  }

  // 6. Gửi câu hỏi và nhận câu trả lời dạng Streaming SSE (GET chỉ đọc an toàn, POST ghi lịch sử + action)
  router.get('/threads/:id/chat/stream', async (req, res, next) => {
    try {
      if (!isSameOriginSseRequest(req)) {
        return res.status(403).send('Yêu cầu cross-site SSE không được phép.');
      }
      return await streamAgentConversation(req, res, {
        question: req.query?.question,
        readOnly: true
      });
    } catch (e) {
      next(e);
    }
  });

  router.post('/threads/:id/chat/stream', async (req, res, next) => {
    try {
      return await streamAgentConversation(req, res, {
        question: req.body?.question ?? req.query?.question,
        readOnly: false
      });
    } catch (e) {
      next(e);
    }
  });

  // 7. Xác nhận thực thi hành động từ Thẻ Action Card
  router.post('/actions/:actionId/execute', async (req, res, next) => {
    try {
      const actionId = req.params.actionId;
      if (!isUuid(actionId)) return res.status(400).json({ error: 'Mã thẻ hành động không hợp lệ.' });
      const actor = {
        ...(req.admin || {}),
        username: req.admin?.username || req.admin?.id || 'admin'
      };
      const isOwner = Boolean(actor.isOwner || actor.role === 'owner' || actor.source === 'bootstrap');
      const externalActions = new Set(['confirm_order', 'cancel_order', 'sync_shipping']);

      const phase1 = await runAtomic(pool, async (client) => {
        const row = (await client.query(`
          SELECT id, action_type AS "actionType", payload, status, created_by AS "createdBy"
          FROM internal_ai_action_logs
          WHERE id = $1
          FOR UPDATE
        `, [actionId])).rows[0];

        if (!row) return { status: 404, body: { error: 'Không tìm thấy thẻ hành động.' } };
        if (row.createdBy && !isOwner && row.createdBy !== actor.username) {
          return { status: 403, body: { error: 'Bạn không có quyền thực thi thẻ hành động do nhân sự khác tạo.' } };
        }
        if (!hasActionPermission(req.admin, row.actionType)) {
          return { status: 403, body: { error: 'Tài khoản của bạn không có quyền thực thi hành động này.' } };
        }
        if (row.status !== 'pending') {
          return { status: 400, body: { error: `Hành động này đã ở trạng thái: ${row.status}.` } };
        }

        if (externalActions.has(row.actionType)) {
          // Giải phóng kết nối/lock DB trước khi gọi updateOrder/syncShipmentTracking (tránh deadlock kết nối lồng nhau)
          await client.query(`
            UPDATE internal_ai_action_logs
            SET status = 'executing'
            WHERE id = $1 AND status = 'pending'
          `, [actionId]);
          return { pendingExternal: true, row };
        }

        let result = null;
        const p = row.payload || {};

        if (row.actionType === 'create_voucher') {
          const insertRes = await client.query(`
            INSERT INTO marketing_vouchers (code, title, kind, amount, min_spend_vnd, starts_at, ends_at, total_limit, active)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true)
            ON CONFLICT (code) DO NOTHING
            RETURNING id
          `, [p.code, p.title, p.kind, p.amount, p.minSpendVnd || 0, p.startsAt, p.endsAt, p.totalLimit || 50]);
          const inserted = insertRes?.rows?.[0];
          if (!inserted && insertRes?.rowCount !== 1) {
            return { status: 409, body: { error: `Mã giảm giá ${p.code} đã tồn tại trên hệ thống.` } };
          }

          try { require('./realtime-sse').publishAdminEvent('marketing:update', { kind: 'vouchers', id: inserted?.id, active: true }); } catch (_) {}
          try { require('./cache').flushAllCache(); } catch (_) {}
          result = { success: true, ...(inserted?.id ? { voucherId: inserted.id } : {}), message: `Đã kích hoạt thành công mã giảm giá ${p.code} (-${p.kind === 'percent' ? p.amount + '%' : formatVnd(p.amount)}) trên toàn hệ thống!`, actionType: 'create_voucher' };
        } else if (row.actionType === 'cancel_voucher') {
          await client.query('UPDATE marketing_vouchers SET active=false, version=version+1, updated_at=now() WHERE id=$1', [p.voucherId]);
          try { require('./realtime-sse').publishAdminEvent('marketing:update', { kind: 'vouchers', id: p.voucherId, active: false }); } catch (_) {}
          try { require('./cache').flushAllCache(); } catch (_) {}
          result = { success: true, message: `Đã dừng kích hoạt mã voucher ${p.code} thành công!`, voucherId: p.voucherId, actionType: 'cancel_voucher' };
        } else if (row.actionType === 'delete_voucher') {
          const existingVoucher = (await client.query('SELECT id FROM marketing_vouchers WHERE id=$1 FOR UPDATE', [p.voucherId])).rows[0];
          if (!existingVoucher) {
            return { status: 404, body: { error: `Mã voucher ${p.code || ''} không tồn tại hoặc đã bị xóa.` } };
          }
          if ((await client.query('SELECT 1 FROM voucher_redemptions WHERE voucher_id=$1 LIMIT 1', [p.voucherId])).rows.length) {
            return { status: 409, body: { error: 'Voucher đã phát sinh lịch sử áp dụng trên đơn hàng; hãy chọn Tạm dừng thay vì xóa vĩnh viễn để bảo toàn đối soát đơn hàng.' } };
          }
          await client.query('UPDATE marketing_campaigns SET voucher_id=NULL WHERE voucher_id=$1', [p.voucherId]);
          await client.query('DELETE FROM customer_vouchers WHERE voucher_id=$1', [p.voucherId]);
          await client.query('DELETE FROM marketing_vouchers WHERE id=$1', [p.voucherId]);
          try { require('./realtime-sse').publishAdminEvent('marketing:update', { kind: 'vouchers', id: p.voucherId, deleted: true }); } catch (_) {}
          try { require('./cache').flushAllCache(); } catch (_) {}
          result = { success: true, message: `Đã xóa vĩnh viễn mã voucher ${p.code} khỏi cơ sở dữ liệu!`, voucherId: p.voucherId, actionType: 'delete_voucher' };
        } else if (row.actionType === 'cancel_campaign') {
          if (p.type === 'promotion') {
            await client.query('UPDATE product_promotions SET active=false, version=version+1, updated_at=now() WHERE id=$1', [p.campaignId]);
          } else {
            await client.query('UPDATE marketing_campaigns SET active=false, version=version+1, updated_at=now() WHERE id=$1', [p.campaignId]);
          }
          try { require('./realtime-sse').publishAdminEvent('marketing:update', { kind: p.type || 'campaigns', id: p.campaignId, active: false }); } catch (_) {}
          try { require('./cache').flushAllCache(); } catch (_) {}
          result = { success: true, message: `Đã dừng kích hoạt chiến dịch "${p.title}" thành công!`, campaignId: p.campaignId, actionType: 'cancel_campaign' };
        } else if (row.actionType === 'delete_campaign') {
          if (p.type === 'promotion') {
            await client.query('DELETE FROM product_promotion_variants WHERE promotion_id=$1', [p.campaignId]);
            await client.query('DELETE FROM product_promotions WHERE id=$1', [p.campaignId]);
          } else {
            await client.query('DELETE FROM customer_campaign_reads WHERE campaign_id=$1', [p.campaignId]);
            await client.query('DELETE FROM marketing_campaigns WHERE id=$1', [p.campaignId]);
          }
          try { require('./realtime-sse').publishAdminEvent('marketing:update', { kind: p.type || 'campaigns', id: p.campaignId, deleted: true }); } catch (_) {}
          try { require('./cache').flushAllCache(); } catch (_) {}
          result = { success: true, message: `Đã xóa vĩnh viễn chiến dịch "${p.title}" khỏi hệ thống!`, campaignId: p.campaignId, actionType: 'delete_campaign' };
        } else {
          return { status: 400, body: { error: `Loại hành động không được hỗ trợ: ${row.actionType}` } };
        }

        await client.query(`
          UPDATE internal_ai_action_logs
          SET status = 'executed', executed_at = NOW(), result = $1
          WHERE id = $2
        `, [JSON.stringify(result), actionId]);

        await appendAudit(client, {
          actor,
          action: `internal_ai.execute.${row.actionType}`,
          entityType: 'internal_ai_action',
          entityId: actionId,
          after: { status: 'executed', actionType: row.actionType, result }
        });

        return { status: 200, body: { success: true, actionId, status: 'executed', result } };
      });

      if (!phase1.pendingExternal) {
        return res.status(phase1.status).json(phase1.body);
      }

      const { row } = phase1;
      const p = row.payload || {};
      let result = null;
      try {
        if (row.actionType === 'confirm_order') {
          const updated = await updateOrder(pool, p.orderId, { status: 'processing' }, req.admin, { expectedStatuses: ['pending', 'confirmed'] });
          if (!updated) throw Object.assign(new Error('Không tìm thấy đơn hàng.'), { status: 404 });
          try {
            const { invalidateTags } = require('./cache');
            invalidateTags(['orders', `order:${p.orderId}`, 'stock']);
          } catch (_) {}
          try {
            require('./realtime-sse').publishAdminEvent('order:update', {
              orderId: p.orderId,
              orderNumber: p.orderNumber,
              status: 'processing'
            });
          } catch (_) {}
          result = { success: true, message: `Đã duyệt và chuyển đơn ${p.orderNumber} sang Đóng gói (processing) thành công! Tồn kho đã được đảm bảo.`, orderId: p.orderId, actionType: 'confirm_order' };
        } else if (row.actionType === 'cancel_order') {
          const updated = await updateOrder(pool, p.orderId, { status: 'cancelled', cancelActiveWaybill: true }, req.admin, { expectedStatuses: ['pending', 'confirmed', 'processing'] });
          if (!updated) throw Object.assign(new Error('Không tìm thấy đơn hàng.'), { status: 404 });
          try {
            const { invalidateTags } = require('./cache');
            invalidateTags(['orders', `order:${p.orderId}`, 'stock']);
          } catch (_) {}
          try {
            require('./realtime-sse').publishAdminEvent('order:update', {
              orderId: p.orderId,
              orderNumber: p.orderNumber,
              status: 'cancelled'
            });
          } catch (_) {}
          result = { success: true, message: `Đã hủy đơn hàng ${p.orderNumber} và hoàn trả số lượng vào kho thành công!`, orderId: p.orderId, actionType: 'cancel_order' };
        } else if (row.actionType === 'sync_shipping') {
          const { syncShipmentTracking } = require('./shipping-management');
          const syncRes = await syncShipmentTracking(pool, config, { orderId: p.orderId, actor: req.admin });
          result = { success: true, message: syncRes?.message || `Đã đồng bộ hành trình bưu cục cho đơn ${p.orderNumber} thành công!`, orderId: p.orderId, actionType: 'sync_shipping' };
        }
      } catch (execErr) {
        await pool.query(
          "UPDATE internal_ai_action_logs SET status = 'pending' WHERE id = $1 AND status = 'executing'",
          [actionId]
        ).catch(() => {});
        throw execErr;
      }

      await runAtomic(pool, async (client) => {
        await client.query(`
          UPDATE internal_ai_action_logs
          SET status = 'executed', executed_at = NOW(), result = $1
          WHERE id = $2
        `, [JSON.stringify(result), actionId]);

        await appendAudit(client, {
          actor,
          action: `internal_ai.execute.${row.actionType}`,
          entityType: 'internal_ai_action',
          entityId: actionId,
          after: { status: 'executed', actionType: row.actionType, result }
        });
      });

      return res.json({ success: true, actionId, status: 'executed', result });
    } catch (e) {
      next(e);
    }
  });

  // 8. Hủy bỏ hành động từ Thẻ Action Card
  router.post('/actions/:actionId/cancel', async (req, res, next) => {
    try {
      const actionId = req.params.actionId;
      if (!isUuid(actionId)) return res.status(400).json({ error: 'Mã thẻ hành động không hợp lệ.' });
      const actor = {
        ...(req.admin || {}),
        username: req.admin?.username || req.admin?.id || 'admin'
      };
      const isOwner = Boolean(actor.isOwner || actor.role === 'owner' || actor.source === 'bootstrap');

      const out = await runAtomic(pool, async (client) => {
        const row = (await client.query(`
          SELECT id, action_type AS "actionType", status, created_by AS "createdBy"
          FROM internal_ai_action_logs
          WHERE id = $1
          FOR UPDATE
        `, [actionId])).rows[0];

        if (!row) return { status: 404, body: { error: 'Không tìm thấy thẻ hành động.' } };
        if (row.createdBy && !isOwner && row.createdBy !== actor.username) {
          return { status: 403, body: { error: 'Bạn không có quyền hủy thẻ hành động do nhân sự khác tạo.' } };
        }
        if (!hasActionPermission(req.admin, row.actionType)) {
          return { status: 403, body: { error: 'Tài khoản của bạn không có quyền hủy hành động này.' } };
        }
        if (row.status !== 'pending') {
          return { status: 400, body: { error: `Hành động này đã ở trạng thái: ${row.status}.` } };
        }

        await client.query(`
          UPDATE internal_ai_action_logs
          SET status = 'cancelled', executed_at = NOW()
          WHERE id = $1 AND status = 'pending'
        `, [actionId]);

        await appendAudit(client, {
          actor,
          action: `internal_ai.cancel.${row.actionType}`,
          entityType: 'internal_ai_action',
          entityId: actionId,
          after: { status: 'cancelled', actionType: row.actionType }
        });

        return { status: 200, body: { success: true, actionId, status: 'cancelled', message: 'Đã hủy bỏ hành động.' } };
      });

      return res.status(out.status).json(out.body);
    } catch (e) {
      next(e);
    }
  });

  // 9. Lấy danh sách câu hỏi gợi ý nhanh (Quick Prompts)
  router.get('/quick-prompts', (req, res) => {
    const isOwner = Boolean(req.admin?.isOwner);
    const prompts = [
      { category: 'analytics', label: '📊 Doanh thu hôm nay thế nào?', prompt: 'Báo cáo tổng quan doanh thu và số lượng đơn hàng hôm nay' },
      { category: 'orders', label: '📦 Đơn hàng đang chờ xử lý', prompt: 'Liệt kê các đơn hàng đang ở trạng thái pending chờ xác nhận' },
      { category: 'inventory', label: '⚠️ Cảnh báo tồn kho thấp', prompt: 'Kiểm tra xem sản phẩm nào sắp hết hàng (tồn kho dưới 5 cái)' },
      { category: 'shipping', label: '🚚 Lộ trình vận chuyển', prompt: 'Kiểm tra trạng thái các đơn hàng đang giao của Viettel Post' },
      { category: 'system', label: '🛡️ Tình trạng máy chủ', prompt: 'Kiểm tra sức khỏe hệ thống, Cluster Master và các cuộc tấn công WAF đã chặn' }
    ];

    if (isOwner) {
      prompts.unshift({ category: 'owner', label: '💎 Báo cáo tuần Ban Giám Đốc', prompt: 'Tổng hợp doanh thu, khách hàng mới và tỷ lệ hoàn thành đơn trong 7 ngày qua' });
    }

    res.json({ prompts });
  });

  return router;
}

module.exports = {
  createInternalAiRouter
};
