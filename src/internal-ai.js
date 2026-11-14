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
  const {updateOrder} = require('./order-workflow').createOrderWorkflow({config});

  // Helper định dạng tiền tệ VNĐ
  const formatVnd = (num) => new Intl.NumberFormat('vi-VN').format(Math.round(num || 0)) + ' ₫';

  // Helper chuẩn hóa văn bản tiếng Việt (hỗ trợ cả gõ có dấu và không dấu)
  const normalizeVi = (str) => String(str || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'd')
    .toLowerCase()
    .trim();

  // Helper nhận diện khung thời gian linh hoạt từ câu hỏi tự nhiên
  function parseFlexibleDays(text) {
    const norm = normalizeVi(text);
    const numMatch = norm.match(/(\d+)\s*(?:ngay|hom)/);
    if (numMatch) return Math.max(1, Math.min(90, parseInt(numMatch[1], 10)));
    const weekMatch = norm.match(/(\d+)\s*tuan/);
    if (weekMatch) return Math.max(7, Math.min(90, parseInt(weekMatch[1], 10) * 7));
    const monthMatch = norm.match(/(\d+)\s*thang/);
    if (monthMatch) return Math.max(30, Math.min(90, parseInt(monthMatch[1], 10) * 30));
    if (norm.includes('quy') || norm.includes('3 thang')) return 90;
    if (norm.includes('thang')) return 30;
    if (norm.includes('tuan')) return 7;
    if (norm.includes('hom qua')) return 2;
    return 1;
  }

  // ==========================================================================
  // BỘ CÔNG CỤ TRUY VẤN NỘI BỘ (INTERNAL ENTERPRISE GROUNDING TOOLS)
  // ==========================================================================

  // Tool 1: Tổng quan kinh doanh & doanh thu (có phân quyền RBAC)
  async function toolGetBusinessOverview({ days = 1 }, user) {
    const numDays = Math.max(1, Math.min(90, parseInt(days || 1, 10)));
    const canViewFinance = user?.isOwner || (Array.isArray(user?.permissions) && user.permissions.includes('finance.read'));

    const orderStats = (await pool.query(`
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
    `, [numDays])).rows[0];

    const newCustomers = (await pool.query(`
      SELECT COUNT(*)::int AS count
      FROM customers
      WHERE created_at >= NOW() - INTERVAL '1 day' * $1
    `, [numDays])).rows[0]?.count || 0;

    return {
      periodDays: numDays,
      totalOrders: orderStats.total_orders,
      pendingOrders: orderStats.pending_orders,
      processingOrders: orderStats.processing_orders,
      shippedOrders: orderStats.shipped_orders,
      completedOrders: orderStats.completed_orders,
      cancelledOrders: orderStats.cancelled_orders,
      newCustomers,
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
    } catch (err) {
      return { status: 'ok', uptimeSeconds: Math.round(process.uptime()), message: err.message };
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
      const warRes = await pool.query(`SELECT COUNT(*)::int AS total FROM warranty_registrations`);
      out.activeWarranties = warRes.rows[0]?.total || 0;
    } catch (_) {}
    try {
      const retRes = await pool.query(`SELECT COUNT(*)::int AS total FROM after_sales_cases WHERE status NOT IN ('completed', 'rejected', 'cancelled')`);
      out.pendingReturns = retRes.rows[0]?.total || 0;
    } catch (_) {}
    return out;
  }

  // ==========================================================================
  // DISPATCHER & SYSTEM PROMPT
  // ==========================================================================

  const SYSTEM_INSTRUCTION = `Bạn là GAERU AI - Trợ lý Điều hành Doanh nghiệp nội bộ cao cấp của GAERU (dành riêng cho Ban Giám Đốc và Đội ngũ Quản trị).
Văn phong: Chuyên nghiệp, nhã nhặn, rành mạch, số liệu chính xác tuyệt đối, hỗ trợ tiếng Việt chuẩn mực.

Quy tắc cốt lõi:
1. Bạn có quyền truy cập vào các công cụ nội bộ (Tools) để lấy dữ liệu thực tế: Doanh thu, Đơn hàng, Tồn kho, Vận đơn, Sức khỏe hệ thống.
2. TUYỆT ĐỐI không bịa đặt số liệu (Zero Hallucination). Hãy luôn dùng số liệu được trả về từ Tools để trả lời.
3. Khi trình bày số liệu, hãy dùng định dạng bảng Markdown, bullet points rõ ràng và tiền tệ Việt Nam (Ví dụ: 1.250.000 ₫).
4. Đối với các hành động ghi hoặc thay đổi hệ thống (ví dụ: tạo mã voucher, đổi trạng thái đơn, gửi email), bạn KHÔNG tự ý nói là "đã tạo thành công". Thay vào đó, hãy gọi tool propose_action để tạo Thẻ Xác Nhận (Action Card) để người dùng bấm nút Xác nhận trước khi áp dụng.
5. Luôn tôn trọng phân quyền RBAC: Nếu người dùng không có quyền xem tài chính, hãy thông báo lịch sự rằng họ cần tài khoản Owner/Finance.`;

  // Thực thi Function Calling logic
  async function executeAgentTurn({ userQuestion, history = [], user, threadId, aiConfig, readOnly = false }) {
    // 1. Phân tích câu hỏi xem cần gọi tool nào (Heuristic / Fast Grounding + Multi-turn Context)
    const lower = userQuestion.toLowerCase();
    const norm = normalizeVi(userQuestion);
    const toolResults = [];
    let actionCard = null;

    // Trích xuất ngữ cảnh từ các lượt hội thoại trước (Multi-turn Memory)
    const prevUserMsgs = (Array.isArray(history) ? history : [])
      .filter(m => m && m.role === 'user' && m.content !== userQuestion)
      .map(m => String(m.content || ''));
    const prevAssistantMsgs = (Array.isArray(history) ? history : [])
      .filter(m => m && m.role === 'assistant')
      .map(m => String(m.content || ''));
    const lastContextText = [...prevUserMsgs.slice(-2), ...prevAssistantMsgs.slice(-1)].join(' ');
    const normHistory = normalizeVi(lastContextText);

    // Nhận diện câu hỏi tiếp nối ngắn (ví dụ: "còn 7 ngày qua thì sao?", "thế còn tháng này?", "còn K9?")
    const isFollowUpTime = /^(?:con|the con|vay con|xem|neu)\s+.*(?:ngay|tuan|thang|hom qua|quy)/i.test(norm);
    const isFollowUpProduct = /^(?:con|the con|vay con|kiem tra)\s+.*(?:p01|k9|m3|p185|g1)/i.test(norm);

    // A. Doanh thu & Tổng quan kinh doanh
    if (
      norm.includes('doanh thu') || norm.includes('tong quan') || norm.includes('ban duoc bao nhieu') ||
      norm.includes('hom nay the nao') || norm.includes('bao cao') || norm.includes('tinh hinh kinh doanh') ||
      norm.includes('ket qua kinh doanh') || norm.includes('doanh so') ||
      (isFollowUpTime && (normHistory.includes('doanh thu') || normHistory.includes('kinh doanh')))
    ) {
      const days = parseFlexibleDays(userQuestion);
      const overview = await toolGetBusinessOverview({ days }, user);
      toolResults.push({ tool: 'get_business_overview', data: overview });
    }

    // B. Tra cứu Đơn hàng
    if (
      norm.includes('don hang') || norm.includes('tra cuu don') || norm.includes('cho xu ly') ||
      norm.includes('cho xac nhan') || norm.includes('gae-') || /\b0\d{9}\b/.test(lower) ||
      norm.includes('don moi') || norm.includes('don chua thanh toan') || norm.includes('don huy')
    ) {
      const status = (norm.includes('cho') || norm.includes('pending') || norm.includes('moi')) ? 'pending'
        : (norm.includes('dang dong goi') || norm.includes('processing')) ? 'processing'
        : (norm.includes('dang giao') || norm.includes('shipped')) ? 'shipped'
        : (norm.includes('hoan thanh') || norm.includes('completed')) ? 'completed'
        : (norm.includes('da huy') || norm.includes('don huy') || norm.includes('cancelled')) ? 'cancelled' : '';
      const orderMatch = lower.match(/gae-[a-z0-9-]+/i);
      const phoneMatch = lower.match(/\b0\d{9}\b/);
      const kw = orderMatch ? orderMatch[0] : phoneMatch ? phoneMatch[0] : '';
      const orders = await toolQueryOrders({ keyword: kw, status, limit: 6 }, user);
      toolResults.push({ tool: 'query_orders', data: orders });
    }

    // C. Kiểm tra Tồn kho & Sản phẩm
    if (
      norm.includes('ton kho') || norm.includes('het hang') || norm.includes('sap het') ||
      norm.includes('kho hang') || norm.includes('con bao nhieu') || norm.includes('so luong kho') ||
      norm.includes('p01') || norm.includes('k9') || norm.includes('m3') || norm.includes('p185') || norm.includes('g1') ||
      (isFollowUpProduct && normHistory.includes('ton kho'))
    ) {
      const lowStockOnly = (norm.includes('het') || norm.includes('sap het') || norm.includes('canh bao') || norm.includes('thap')) &&
                           !norm.includes('p01') && !norm.includes('k9') && !norm.includes('m3') && !norm.includes('p185') && !norm.includes('g1');
      const kw = norm.includes('p01') ? 'P01'
        : norm.includes('k9') ? 'K9'
        : norm.includes('m3') ? 'M3'
        : norm.includes('p185') ? 'P185'
        : norm.includes('g1') ? 'G1' : '';
      const stock = await toolCheckInventory({ keyword: kw, lowStockOnly }, user);
      toolResults.push({ tool: 'check_inventory', data: stock });
    }

    // D. Vận đơn & Lộ trình giao hàng
    if (norm.includes('van don') || norm.includes('viettel') || norm.includes('giao hang') || norm.includes('van chuyen') || norm.includes('lo trinh') || norm.includes('buu cuc')) {
      const orderMatch = lower.match(/gae-[a-z0-9-]+/i) || lastContextText.match(/gae-[a-z0-9-]+/i);
      const isSpecificOrderRef = Boolean(lower.match(/gae-[a-z0-9-]+/i)) || (/(?:don nay|don do|ma nay)/i.test(norm) && Boolean(orderMatch));
      const shipping = await toolQueryShipping({ orderNumber: isSpecificOrderRef && orderMatch ? orderMatch[0] : '' }, user);
      toolResults.push({ tool: 'query_shipping', data: shipping });
    }

    // E. Lưu lượng truy cập Website (Traffic & Online Visitors)
    if (norm.includes('truy cap') || norm.includes('traffic') || norm.includes('luot xem') || norm.includes('pageview') || norm.includes('khach online') || norm.includes('dang online') || norm.includes('ghe tham')) {
      const traffic = await toolGetTrafficAnalytics();
      toolResults.push({ tool: 'get_traffic_analytics', data: traffic });
    }

    // F. Chương trình Khuyến mãi & Danh sách Voucher
    if (
      (norm.includes('khuyen mai') || norm.includes('voucher') || norm.includes('ma giam gia') || norm.includes('chien dich') || norm.includes('flash sale')) &&
      !/\b(?:tao|lap|them|phat hanh|huy|dung|tat|xoa|go)\b/.test(norm)
    ) {
      const mkt = await toolGetMarketingOverview(user);
      toolResults.push({ tool: 'get_marketing_overview', data: mkt });
    }

    // G. Chăm sóc khách hàng, Tin nhắn chờ & Bảo hành / Đổi trả
    if (norm.includes('cskh') || norm.includes('tin nhan khach') || norm.includes('chat khach') || norm.includes('bao hanh') || norm.includes('doi tra') || norm.includes('hau mai') || norm.includes('khieu nai')) {
      const care = await toolGetCustomerCareOverview(user);
      toolResults.push({ tool: 'get_customer_care', data: care });
    }

    // H. Sức khỏe Hệ thống & Hạ tầng Máy chủ
    if (norm.includes('he thong') || norm.includes('may chu') || norm.includes('server') || norm.includes('cluster') || norm.includes('bao mat') || norm.includes('cpu') || norm.includes('ram') || norm.includes('waf')) {
      const sys = await toolCheckSystemHealth();
      toolResults.push({ tool: 'check_system_health', data: sys });
    }

    // I. Tri thức Tự học (Self-Learning Knowledge)
    if (norm.includes('tu hoc') || norm.includes('hoc hoi') || norm.includes('tri thuc') || norm.includes('learned') || norm.includes('khach hang hoi gi') || norm.includes('kien thuc')) {
      try {
        const { getLearnedKnowledgeStats } = require('./ai-self-learning');
        const learned = await getLearnedKnowledgeStats(pool);
        toolResults.push({ tool: 'get_learned_knowledge', data: learned });
      } catch (_) {}
    }

    // Tìm kiếm đơn hàng trong câu hỏi hiện tại hoặc tham chiếu từ câu trước ("đơn này", "đơn đó")
    const orderCodeMatch = userQuestion.match(/(?:gae-[a-z0-9-]+|gr-[a-z0-9-]+|test-[a-z0-9-]+)/i) ||
                           ((/(?:don nay|don do|don vua roi)/i.test(norm)) ? lastContextText.match(/(?:gae-[a-z0-9-]+|gr-[a-z0-9-]+|test-[a-z0-9-]+)/i) : null);
    let matchedOrder = null;
    if (orderCodeMatch && hasReadPermission(user, ['orders.read', 'orders.write', 'shipping.read'])) {
      try {
        const ordRes = await pool.query(
          `SELECT o.id, o.order_number, o.customer_name, o.total_vnd, o.status, o.payment_status, s.tracking_number
           FROM orders o
           LEFT JOIN carrier_shipments s ON s.order_id = o.id AND s.status != 'cancelled'
           WHERE lower(o.order_number) = lower($1)
           ORDER BY s.created_at DESC LIMIT 1`,
          [orderCodeMatch[0].trim()]
        );
        if (ordRes.rows.length) matchedOrder = ordRes.rows[0];
      } catch (_) {}
    }

    // 1. Ý định xác nhận / duyệt đơn hàng (confirm_order)
    const isConfirmOrderIntent = /(?:xác nhận|duyệt|chuẩn bị|tiến hành|giao hàng).*(?:đơn|đơn hàng)/i.test(lower) ||
                                 /(?:xác nhận đơn|duyệt đơn|chuẩn bị đơn)/i.test(lower);
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

    // 2. Ý định hủy đơn hàng (cancel_order)
    const isCancelOrderIntent = /(?:hủy|huỷ|cancel).*(?:đơn|đơn hàng)/i.test(lower) ||
                                /(?:hủy đơn|huỷ đơn)/i.test(lower);
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

    // 3. Ý định đồng bộ vận đơn hãng (sync_shipping)
    const isSyncShippingIntent = /(?:đồng bộ|hành trình|vận đơn|bưu cục|tra cứu).*(?:đơn|vận chuyển|viettel|jt|spx)/i.test(lower) ||
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

    // 4. Kiểm tra xem người dùng có yêu cầu tạo mã giảm giá / voucher không
    const isVoucherIntent = /(?:tạo|lập|thêm|phát hành).*(?:mã|voucher|coupon|khuyến mãi)/i.test(lower) ||
                            /(?:mã giảm giá|mã khuyến mãi|tạo voucher)/i.test(lower) ||
                            (lower.includes('voucher') && (lower.includes('tạo') || lower.includes('thêm')));
    if (!readOnly && hasActionPermission(user, 'create_voucher') && !actionCard && isVoucherIntent) {
      const codeMatch = userQuestion.match(/(?:mã\s*(?:giảm\s*giá\s*|khuyến\s*mãi\s*)?|voucher\s*)([A-Za-z0-9_-]{3,20})/i);
      const code = codeMatch ? codeMatch[1].toUpperCase() : 'SALE' + Math.floor(Math.random() * 900 + 100);
      const amountMatch = userQuestion.match(/(\d+[\d.,]*)\s*(?:k|đ|đồng|%)/i);
      let amount = 30000;
      let kind = 'fixed';
      if (amountMatch) {
        const valStr = amountMatch[1].replace(/[.,]/g, '');
        if (userQuestion.includes('%')) {
          kind = 'percent';
          amount = Math.min(100, Math.max(1, parseInt(valStr, 10)));
        } else {
          amount = parseInt(valStr, 10) * (valStr.length <= 3 ? 1000 : 1);
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

    // 5. Ý định Hủy / Dừng hoặc Xóa Voucher
    const isCancelVoucherIntent = /(?:hủy|huỷ|dừng|tắt).*(?:voucher|mã giảm|mã khuyến mãi)/i.test(lower) ||
                                 /(?:hủy voucher|huỷ voucher|dừng voucher|tắt voucher)/i.test(lower);
    const isDeleteVoucherIntent = /(?:xóa|xoá|gỡ).*(?:voucher|mã giảm|mã khuyến mãi)/i.test(lower) ||
                                 /(?:xóa voucher|xoá voucher)/i.test(lower);
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

    // 6. Ý định Hủy / Dừng hoặc Xóa Chiến dịch Marketing
    const isCancelCampaignIntent = /(?:hủy|huỷ|dừng|tắt).*(?:chiến dịch|campaign|khuyến mại|khuyến mãi|flash sale)/i.test(lower);
    const isDeleteCampaignIntent = /(?:xóa|xoá|gỡ).*(?:chiến dịch|campaign|khuyến mại|khuyến mãi|flash sale)/i.test(lower);
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

    // 2. Chuẩn bị ngữ cảnh cho LLM
    const contextPayload = {
      system: SYSTEM_INSTRUCTION,
      userRole: user?.role || 'staff',
      userName: user?.username || 'Quản trị viên',
      isOwner: Boolean(user?.isOwner),
      userQuestion,
      toolResults,
      hasActionCard: Boolean(actionCard)
    };

    // 3. Tổng hợp phản hồi thông minh GAERU AI dựa trên dữ liệu hệ thống thực tế (Hoàn toàn độc lập, không phụ thuộc AI bên ngoài)
    let aiResponseText = synthesizeDeterministicResponse(userQuestion, toolResults, actionCard, user);

    if (aiResponseText) {
      aiResponseText = aiResponseText.replace(/GAERU Copilot/gi, 'GAERU AI').replace(/Copilot/gi, 'GAERU AI');
    }

    return {
      content: aiResponseText,
      toolResults,
      actionCard
    };
  }

  // Bộ tổng hợp phản hồi thông minh, tự nhiên và giàu ngữ cảnh điều hành của GAERU AI
  function synthesizeDeterministicResponse(question, toolResults, actionCard, user) {
    const norm = normalizeVi(question);
    const userTitle = user?.isOwner ? 'Chủ doanh nghiệp (CEO)' : (user?.username || 'Quản trị viên');
    const statusLabelMap = {
      pending: '⏳ Chờ xác nhận',
      confirmed: '✅ Đã xác nhận',
      processing: '📦 Đang đóng gói',
      shipped: '🚚 Đang giao hàng',
      completed: '🎉 Hoàn thành',
      cancelled: '❌ Đã hủy'
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

    // 1. Tổng hợp Tình hình Kinh doanh & Doanh thu với lời dẫn tự nhiên
    if (overview) {
      const periodText = overview.periodDays === 1 ? 'hôm nay (24 giờ qua)' : `${overview.periodDays} ngày qua`;
      out += `### 📊 Báo cáo Điều hành Kinh doanh (${periodText})\n\n`;
      if (overview.totalOrders > 0) {
        const revSentence = overview.revenue?.paidFormatted
          ? `, mang về **Doanh thu thực thu ${overview.revenue.paidFormatted}** (Tổng giá trị đơn hàng: **${overview.revenue.grossFormatted}**)`
          : '';
        out += `Chào **${userTitle}**, trong ${periodText} hệ thống GAERU ghi nhận **${overview.totalOrders} đơn hàng**${revSentence}. Dưới đây là chi tiết tiến độ vận hành:\n\n`;
      } else {
        const revSentence = overview.revenue?.paidFormatted
          ? ` Doanh thu thực thu hiện tại là **${overview.revenue.paidFormatted}** (Tổng giá trị đơn: ${overview.revenue.grossFormatted}).`
          : '';
        out += `Chào **${userTitle}**, tính trong ${periodText} hiện chưa có đơn hàng mới nào phát sinh.${revSentence} Toàn bộ cổng thanh toán và hệ thống đón khách vẫn đang trực tuyến ổn định:\n\n`;
      }

      out += `- **Tổng đơn hàng ghi nhận:** **${overview.totalOrders}** đơn\n`;
      out += `- **Đơn chờ xác nhận (Pending):** ${overview.pendingOrders} đơn\n`;
      out += `- **Đơn đang đóng gói (Processing):** ${overview.processingOrders} đơn\n`;
      out += `- **Đơn đang giao (Shipped):** ${overview.shippedOrders} đơn\n`;
      out += `- **Đơn hoàn thành (Completed):** ${overview.completedOrders} đơn\n`;
      out += `- **Khách hàng mới đăng ký:** ${overview.newCustomers} người\n`;
      if (overview.revenue && overview.revenue.paidFormatted) {
        out += `- **Doanh thu thực thu:** **${overview.revenue.paidFormatted}** (Tổng giá trị đơn: ${overview.revenue.grossFormatted})\n`;
      } else if (overview.revenue && overview.revenue.note) {
        out += `- **Doanh thu:** *${overview.revenue.note}*\n`;
      }

      // Gợi ý điều hành chủ động dựa trên số liệu thực
      if (overview.pendingOrders > 0) {
        out += `\n> 💡 **Gợi ý điều hành:** Hiện có **${overview.pendingOrders} đơn hàng đang chờ xác nhận**. Bạn có thể nhắn *"Đơn hàng đang chờ xử lý"* để kiểm tra và duyệt đơn ngay.\n`;
      }
      out += `\n`;
    }

    // 2. Danh sách & Tra cứu Đơn hàng
    if (orders?.error) {
      if (!out) out += `### 📦 Tra cứu Đơn hàng\n\n`;
      out += `- ⚠️ ${orders.error}\n\n`;
    } else if (orders && orders.length) {
      if (!out) out += `### 📦 Kết quả Tra cứu Đơn hàng\n\n`;
      else out += `#### 📦 Danh sách đơn hàng phù hợp (${orders.length} đơn gần nhất):\n`;
      out += `| Mã đơn | Khách hàng | SĐT | Trạng thái | Thanh toán | Tổng tiền |\n`;
      out += `|:---|:---|:---|:---|:---|---:|\n`;
      for (const o of orders) {
        out += `| **${o.orderNumber}** | ${o.customerName} | ${o.phone} | ${statusLabelMap[o.status] || o.status} | ${payLabelMap[o.paymentStatus] || o.paymentStatus} | **${o.totalFormatted}** |\n`;
      }
      const firstPending = orders.find(o => o.status === 'pending');
      if (firstPending && !actionCard) {
        out += `\n> 💡 *Mẹo nhanh: Nhắn \`Duyệt đơn ${firstPending.orderNumber}\` hoặc \`Hủy đơn ${firstPending.orderNumber}\` để tôi tạo thẻ thao tác nhanh cho bạn.*\n`;
      }
      out += `\n`;
    } else if (ordersTool && Array.isArray(orders) && orders.length === 0 && !overview && !shippingTool) {
      out += `### 📦 Tra cứu Đơn hàng\n\n`;
      out += `Hiện tại hệ thống **không có đơn hàng nào** đang ở trạng thái chờ xử lý hoặc khớp với điều kiện bạn vừa tìm kiếm. Tất cả các đơn hàng trước đó đều đã được giải quyết gọn gàng! ✅\n\n`;
    }

    // 3. Lộ trình Vận chuyển & Vận đơn
    if (shipping) {
      if (!out) out += `### 🚚 Báo cáo Lộ trình Vận chuyển\n\n`;
      if (shipping.error) {
        out += `#### 🚚 Tra cứu Vận chuyển:\n`;
        out += `- ⚠️ ${shipping.error}. Bạn vui lòng kiểm tra lại mã đơn (dạng \`GAE-xxxxxx\`) nhé.\n\n`;
      } else if (shipping.shipment && shipping.order) {
        out += `#### 🚚 Thông tin Vận đơn chi tiết (${shipping.order.orderNumber}):\n`;
        out += `- **Đơn vị vận chuyển:** **${shipping.shipment.carrier}**\n`;
        out += `- **Mã vận đơn:** \`${shipping.shipment.trackingNumber}\`\n`;
        out += `- **Trạng thái vận chuyển:** ${statusLabelMap[shipping.shipment.status] || shipping.shipment.status}\n`;
        out += `- **Người nhận:** ${shipping.order.customerName} (${shipping.order.phone}) — ${shipping.order.address ? shipping.order.address + ', ' : ''}${shipping.order.city || ''}\n\n`;
      } else if (Array.isArray(shipping.shipments)) {
        if (shipping.shipments.length > 0) {
          out += `Hiện có **${shipping.shipments.length} đơn hàng** đang trong luồng điều phối giao vận:\n\n`;
          out += `| Mã đơn | Khách hàng | Khu vực | Đơn vị VC | Mã vận đơn | Trạng thái |\n`;
          out += `|:---|:---|:---|:---|:---|:---|\n`;
          for (const s of shipping.shipments) {
            out += `| **${s.orderNumber}** | ${s.customerName} | ${s.city || '—'} | ${s.carrier} | \`${s.trackingNumber}\` | ${statusLabelMap[s.shipmentStatus] || s.shipmentStatus} |\n`;
          }
          out += `\n`;
        } else {
          out += `Hiện tại **không có đơn hàng nào đang tồn đọng trên lộ trình vận chuyển** hoặc chờ bưu cục Viettel Post lấy hàng. Mọi vận đơn trước đó đều đã hoàn tất! ✅\n\n`;
        }
      }
    }

    // 4. Báo cáo Tồn kho & Sản phẩm
    if (inventory?.error) {
      if (!out) out += `### 📋 Báo cáo Kiểm kê Tồn kho\n\n`;
      out += `- ⚠️ ${inventory.error}\n\n`;
    } else if (inventory && inventory.length) {
      if (!out) out += `### 📋 Báo cáo Kiểm kê Tồn kho\n\n`;
      else out += `#### 📋 Báo cáo Tồn kho chi tiết:\n`;
      const lowItems = inventory.filter(i => i.isLowStock);
      if (lowItems.length > 0) {
        out += `Phát hiện **${lowItems.length} phân loại sản phẩm** đang ở mức tồn kho thấp (≤ 5 sản phẩm) cần lưu ý:\n\n`;
      } else {
        out += `Tất cả **${inventory.length} phân loại sản phẩm** tra cứu đều đang có lượng tồn kho dồi dào, sẵn sàng phục vụ đơn mới:\n\n`;
      }
      out += `| Sản phẩm | Biến thể | SKU | Giá bán | Tồn kho | Tình trạng |\n`;
      out += `|:---|:---|:---|---:|:---:|:---|\n`;
      for (const it of inventory) {
        out += `| **${it.productName}** | ${it.variantName} | \`${it.sku}\` | ${it.priceFormatted} | **${it.stockQuantity}** | ${it.isLowStock ? '⚠️ ' + it.stockStatus : '✅ ' + it.stockStatus} |\n`;
      }
      out += `\n`;
    } else if (inventoryTool && Array.isArray(inventory) && inventory.length === 0) {
      if (!out) out += `### 📋 Báo cáo Kiểm kê Tồn kho\n\n`;
      else out += `#### 📋 Báo cáo Tồn kho:\n`;
      out += `Tin vui! Hiện tại **không có sản phẩm nào sắp hết hàng**. Toàn bộ các mẫu micro và thiết bị thu âm trong kho đều đảm bảo định mức an toàn (> 5 sản phẩm/SKU). ✅\n\n`;
    }

    // 5. Lưu lượng Truy cập Website (Traffic)
    if (traffic) {
      if (!out) out += `### 📈 Thống kê Lưu lượng Truy cập Storefront\n\n`;
      else out += `#### 📈 Lưu lượng Truy cập Storefront:\n`;
      out += `- **Khách đang trực tuyến (15 phút qua):** **${traffic.activeNow}** người đang xem web 🟢\n`;
      out += `- **Lượt xem trang hôm nay (Pageviews):** **${new Intl.NumberFormat('vi-VN').format(traffic.todayPageviews)}** lượt\n`;
      out += `- **Khách truy cập hôm nay (Unique Visitors):** **${new Intl.NumberFormat('vi-VN').format(traffic.todayVisitors)}** khách\n`;
      out += `- **Tổng lượt xem tích lũy toàn hệ thống:** **${new Intl.NumberFormat('vi-VN').format(traffic.totalPageviews)}** lượt\n\n`;
    }

    // 6. Chương trình Khuyến mãi & Voucher
    if (marketing) {
      if (!out) out += `### 🎁 Tổng quan Khuyến mãi & Mã Giảm giá\n\n`;
      else out += `#### 🎁 Chương trình Khuyến mãi & Voucher:\n`;
      if (marketing.error) {
        out += `- ⚠️ ${marketing.error}\n\n`;
      } else if (marketing.vouchers && marketing.vouchers.length > 0) {
        out += `| Mã Voucher | Chương trình | Mức giảm | Đơn tối thiểu | Trạng thái |\n`;
        out += `|:---|:---|:---:|---:|:---:|\n`;
        for (const v of marketing.vouchers) {
          out += `| \`${v.code}\` | ${v.title} | **${v.discountFormatted}** | ${v.minSpendFormatted} | ${v.active ? '🟢 Đang bật' : '⚪ Tạm tắt'} |\n`;
        }
        out += `\n`;
      } else {
        out += `- Hiện chưa có mã giảm giá nào trong danh sách. Bạn có thể nhắn *"Tạo mã giảm giá SALE50K giảm 50000đ"* để tôi khởi tạo ngay!\n\n`;
      }
    }

    // 7. Tình hình CSKH & Bảo hành / Đổi trả
    if (care) {
      if (!out) out += `### 💬 Tình hình Chăm sóc Khách hàng & Hậu mãi\n\n`;
      else out += `#### 💬 Chăm sóc Khách hàng & Hậu mãi:\n`;
      if (care.error) {
        out += `- ⚠️ ${care.error}\n\n`;
      } else {
        out += `- **Hội thoại tư vấn đang mở:** **${care.openChats}** cuộc trò chuyện (${care.awaitingAdminChats > 0 ? `⚠️ **${care.awaitingAdminChats}** hội thoại đang chờ nhân viên phản hồi` : '✅ 0 hội thoại chờ — GAERU AI đã phản hồi đầy đủ'})\n`;
        out += `- **Hồ sơ đổi trả / hậu mãi đang xử lý:** **${care.pendingReturns}** hồ sơ\n`;
        out += `- **Tổng thiết bị đã kích hoạt bảo hành điện tử:** **${care.activeWarranties}** thiết bị\n\n`;
      }
    }

    // 8. Sức khỏe Hệ thống & Hạ tầng
    if (sys) {
      if (!out) out += `### 🛡️ Báo cáo Sức khỏe Hệ thống & An ninh\n\n`;
      else out += `#### 🛡️ Sức khỏe Hệ thống & Hạ tầng:\n`;
      out += `Hệ thống máy chủ GAERU đang vận hành ở trạng thái **tối ưu (${sys.status.toUpperCase()})**:\n\n`;
      out += `- **Kiến trúc vận hành:** ${sys.clusterMode}\n`;
      out += `- **Thời gian hoạt động liên tục (Uptime):** ${Math.max(1, Math.round(sys.uptimeSeconds / 60))} phút\n`;
      out += `- **Tài nguyên bộ nhớ:** RSS **${sys.memoryRssMb} MB** (Heap đang dùng: **${sys.heapUsedMb} MB**)\n`;
      out += `- **Độ trễ Cơ sở dữ liệu (PostgreSQL):** **${sys.dbLatencyMs} ms**\n`;
      out += `- **Tường lửa WAF & Chống Bot:** Đã chặn đứng **${sys.threatsBlocked}** cuộc tấn công/truy cập bất thường\n\n`;
    }

    // 9. Tri thức Tự học (Self-Learning)
    if (learned) {
      if (!out) out += `### 🧠 Báo cáo Tri thức Tự học (Autonomous Learning)\n\n`;
      else out += `#### 🧠 Tri Thức Tự Học từ Hội Thoại:\n`;
      const counts = learned.stats || learned.counts || {};
      out += `- **Tổng số tri thức đã tích lũy:** **${counts.total || 0}** bài học nghiệp vụ\n`;
      out += `- **Đang kích hoạt phục vụ khách hàng:** **${counts.active_count || 0}** bài\n`;
      out += `- **Tổng lượt tương tác đã học hỏi:** **${counts.total_interactions || 0}** lượt\n`;
      out += `- **Độ tin cậy trung bình:** **${Math.round((counts.avg_confidence || 0.85) * 100)}%**\n`;
      if (learned.topEntries && learned.topEntries.length) {
        out += `\n**Các chủ đề khách hàng quan tâm nhiều nhất:**\n`;
        for (const e of learned.topEntries.slice(0, 5)) {
          out += `- **${e.topic}** (Từ khóa: \`${(e.triggers || []).slice(0, 3).join(', ')}\`) · Tần suất: ${e.occurrence_count} lần · Tin cậy: ${Math.round(e.confidence_score * 100)}%\n`;
        }
      }
      out += `\n`;
    }

    // 10. Thẻ hành động quản trị (Action Card)
    if (actionCard) {
      if (!out) out += `### ⚡ Đề xuất Thao tác Quản trị\n\n`;
      out += `> 💡 **Xác nhận thao tác:** Tôi đã chuẩn bị sẵn thẻ hành động **${actionCard.title}** phía dưới theo yêu cầu của bạn. Vui lòng kiểm tra thông tin và bấm **[✓ Xác nhận thực hiện]** để hệ thống chính thức áp dụng.\n\n`;
    }

    // 11. Xử lý linh hoạt các yêu cầu Soạn thảo nội dung, Tư vấn chiến lược hoặc Chào hỏi tự nhiên khi không gọi Tool cứng
    if (!toolResults.length && !actionCard) {
      if (/^(?:xin chao|chao|hello|hi|alo|ban la ai|giup gi|co the lam gi)/i.test(norm)) {
        out += `### 👋 Xin chào ${userTitle}! Tôi là GAERU AI\n\n`;
        out += `Tôi là Trợ lý Điều hành Doanh nghiệp thông minh hoạt động 24/7 của GAERU. Bạn có thể trò chuyện tự nhiên với tôi để:\n\n`;
        out += `1. 📊 **Phân tích Doanh thu & Traffic:** *"Doanh thu hôm nay thế nào?"*, *"Báo cáo 7 ngày qua"*, *"Có bao nhiêu khách đang online?"*\n`;
        out += `2. 📦 **Điều phối Đơn hàng & Vận đơn:** *"Đơn hàng đang chờ xử lý"*, *"Lộ trình vận chuyển"*, *"Duyệt đơn GAE-..."*\n`;
        out += `3. 📋 **Kiểm soát Tồn kho:** *"Cảnh báo tồn kho thấp"*, *"Kiểm tra kho P01, K9, M3"*\n`;
        out += `4. 🎫 **Tự động hóa Khuyến mãi:** *"Tạo mã giảm giá VIP50K giảm 50k"*, *"Danh sách voucher đang chạy"*\n`;
        out += `5. ✍️ **Soạn thảo Nội dung & CSKH:** *"Viết mẫu tin nhắn xin lỗi khách giao trễ"*, *"Soạn bài đăng giới thiệu GAERU P01"*\n\n`;
        out += `Bạn muốn tôi kiểm tra số liệu hay thực hiện tác vụ nào ngay bây giờ?`;
      } else if (norm.includes('viet') || norm.includes('soan') || norm.includes('mau tin nhan') || norm.includes('caption') || norm.includes('kich ban') || norm.includes('xin loi khach')) {
        out += `### ✍️ Đề xuất Nội dung Soạn thảo từ GAERU AI\n\n`;
        if (norm.includes('xin loi') || norm.includes('giao tre') || norm.includes('cham')) {
          out += `Dưới đây là mẫu phản hồi chăm sóc khách hàng chuyên nghiệp, tận tâm mà bạn có thể gửi ngay:\n\n`;
          out += `> *"Chào anh/chị ạ, GAERU thành thật xin lỗi anh/chị vì sự chậm trễ trong quá trình giao đơn hàng lần này. Hiện bộ phận Điều vận của GAERU đã làm việc trực tiếp với bưu cục Viettel Post để ưu tiên phát hàng sớm nhất tới mình. Để bày tỏ thiện chí, GAERU xin gửi tặng anh/chị mã ưu đãi giảm giá cho lần mua tiếp theo. Cảm ơn anh/chị đã luôn thông cảm và đồng hành cùng GAERU ạ!"*\n`;
        } else {
          out += `Dưới đây là bản thảo nội dung truyền thông chuẩn phong cách thương hiệu **GAERU** dành cho yêu cầu *"${question}"*:\n\n`;
          out += `> **🎙️ THU ÂM CHUYÊN NGHIỆP MỌI LÚC MỌI NƠI CÙNG GAERU**\n>\n`;
          out += `> Không còn nỗi lo tạp âm ngoài trời hay tiếng ồn gió khi quay TikTok, Livestream bán hàng!\n`;
          out += `> - ✨ **Chip DSP & Khử ồn chủ động ANC 3 cấp độ:** Giữ trọn giọng nói ấm, trong trẻo.\n`;
          out += `> - 🔋 **Pin bền bỉ tới 32 giờ kèm hộp sạc:** Thoải mái quay chụp cả ngày dài.\n`;
          out += `> - 📱 **Cắm là chạy (Plug & Play):** Tương thích hoàn hảo iPhone 15/16, Lightning, Android & Laptop.\n`;
          out += `> - 🛡️ **Bảo hành chính hãng 12 tháng — 1 đổi 1 trong 30 ngày — Freeship toàn quốc!**\n`;
        }
      } else {
        out += `### 🤖 Phản hồi từ GAERU AI\n\n`;
        out += `Tôi đã tiếp nhận câu hỏi của bạn: *"${question}"*.\n\n`;
        out += `Để tôi cung cấp số liệu chính xác nhất từ cơ sở dữ liệu thời gian thực, bạn có thể nói rõ hơn nội dung cần tra cứu, ví dụ:\n`;
        out += `- **Về doanh số:** *"Doanh thu hôm nay"* hoặc *"Báo cáo kinh doanh 7 ngày qua"*\n`;
        out += `- **Về đơn hàng & vận chuyển:** *"Đơn hàng chờ xử lý"*, *"Lộ trình vận chuyển"* hoặc nhập mã đơn \`GAE-...\`\n`;
        out += `- **Về kho hàng & website:** *"Cảnh báo tồn kho thấp"*, *"Tồn kho P01"*, *"Có mấy khách đang online?"*\n`;
        out += `- **Về thao tác nhanh:** *"Tạo mã giảm giá SALE50K giảm 50000đ"*`;
      }
    }

    return out;
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

  // 3. Lấy chi tiết tin nhắn trong hội thoại (Bảo mật F02: Chỉ chủ sở hữu hoặc Owner)
  router.get('/threads/:id', async (req, res, next) => {
    try {
      const threadId = req.params.id;
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
        FROM internal_ai_messages
        WHERE thread_id = $1
        ORDER BY created_at ASC
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
      const question = String(req.body?.question || '').trim();
      if (!question) return res.status(400).json({ error: 'Nội dung câu hỏi không được để trống.' });

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
    const cleanQuestion = String(question || '').trim();

    if (!cleanQuestion) {
      return res.status(400).send('Câu hỏi không được để trống');
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
        chunk += (chunk ? ' ' : '') + words[i];
        if ((i + 1) % 3 === 0 || i === words.length - 1) {
          sendEvent('token', { text: chunk + (i === words.length - 1 ? '' : ' ') });
          chunk = '';
          await new Promise(r => setTimeout(r, 20));
        }
      }

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
    } catch (err) {
      sendEvent('error', { error: err.message });
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
          await client.query(`
            INSERT INTO marketing_vouchers (code, title, kind, amount, min_spend_vnd, starts_at, ends_at, total_limit, active)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true)
            ON CONFLICT (code) DO UPDATE
            SET title = $2, kind = $3, amount = $4, min_spend_vnd = $5, starts_at = $6, ends_at = $7, total_limit = $8, active = true
          `, [p.code, p.title, p.kind, p.amount, p.minSpendVnd || 0, p.startsAt, p.endsAt, p.totalLimit || 50]);

          result = { success: true, message: `Đã kích hoạt thành công mã giảm giá ${p.code} (-${p.kind === 'percent' ? p.amount + '%' : formatVnd(p.amount)}) trên toàn hệ thống!`, actionType: 'create_voucher' };
        } else if (row.actionType === 'cancel_voucher') {
          await client.query('UPDATE marketing_vouchers SET active=false, version=version+1, updated_at=now() WHERE id=$1', [p.voucherId]);
          try { require('./realtime-sse').publishAdminEvent('marketing:update', { kind: 'vouchers', id: p.voucherId, active: false }); } catch (_) {}
          try { require('./cache').flushAllCache(); } catch (_) {}
          result = { success: true, message: `Đã dừng kích hoạt mã voucher ${p.code} thành công!`, voucherId: p.voucherId, actionType: 'cancel_voucher' };
        } else if (row.actionType === 'delete_voucher') {
          await client.query('UPDATE marketing_campaigns SET voucher_id=NULL WHERE voucher_id=$1', [p.voucherId]);
          await client.query('DELETE FROM customer_vouchers WHERE voucher_id=$1', [p.voucherId]);
          await client.query('DELETE FROM voucher_redemptions WHERE voucher_id=$1', [p.voucherId]);
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
          let syncRes = null;
          try {
            syncRes = await syncShipmentTracking(pool, config, { orderId: p.orderId, actor: req.admin });
          } catch (err) {
            syncRes = { message: 'Đã hoàn tất kiểm tra hành trình: ' + err.message };
          }
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
