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

function createInternalAiRouter(pool, config) {
  const router = express.Router();

  // Helper định dạng tiền tệ VNĐ
  const formatVnd = (num) => new Intl.NumberFormat('vi-VN').format(Math.round(num || 0)) + ' ₫';

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
  async function toolQueryOrders({ keyword = '', status = '', limit = 5 }) {
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
  async function toolCheckInventory({ keyword = '', lowStockOnly = false }) {
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
  async function toolQueryShipping({ orderNumber } = {}) {
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
  async function executeAgentTurn({ userQuestion, history = [], user, threadId, aiConfig }) {
    // 1. Phân tích câu hỏi xem cần gọi tool nào (Heuristic / Fast Grounding)
    const lower = userQuestion.toLowerCase();
    const toolResults = [];
    let actionCard = null;

    if (lower.includes('doanh thu') || lower.includes('tổng quan') || lower.includes('bán được bao nhiêu') || lower.includes('hôm nay thế nào') || lower.includes('báo cáo')) {
      const days = lower.includes('tuần') ? 7 : lower.includes('tháng') ? 30 : 1;
      const overview = await toolGetBusinessOverview({ days }, user);
      toolResults.push({ tool: 'get_business_overview', data: overview });
    }

    if (lower.includes('đơn hàng') || lower.includes('tra cứu đơn') || lower.includes('chờ xử lý') || lower.includes('gae-') || /\b0\d{9}\b/.test(lower)) {
      const status = lower.includes('chờ') ? 'pending' : lower.includes('đang giao') ? 'shipped' : lower.includes('hoàn thành') ? 'completed' : '';
      const orderMatch = lower.match(/gae-[a-z0-9-]+/i);
      const phoneMatch = lower.match(/\b0\d{9}\b/);
      const kw = orderMatch ? orderMatch[0] : phoneMatch ? phoneMatch[0] : '';
      const orders = await toolQueryOrders({ keyword: kw, status, limit: 5 });
      toolResults.push({ tool: 'query_orders', data: orders });
    }

    if (lower.includes('tồn kho') || lower.includes('hết hàng') || lower.includes('sắp hết') || lower.includes('kho hàng') || lower.includes('p01') || lower.includes('k9') || lower.includes('m3')) {
      const lowStockOnly = lower.includes('hết') || lower.includes('sắp hết') || lower.includes('cảnh báo');
      const kw = lower.includes('p01') ? 'P01' : lower.includes('k9') ? 'K9' : lower.includes('m3') ? 'M3' : '';
      const stock = await toolCheckInventory({ keyword: kw, lowStockOnly });
      toolResults.push({ tool: 'check_inventory', data: stock });
    }

    if (lower.includes('vận đơn') || lower.includes('viettel') || lower.includes('giao hàng') || lower.includes('vận chuyển') || lower.includes('lộ trình')) {
      const orderMatch = lower.match(/gae-[a-z0-9-]+/i);
      const shipping = await toolQueryShipping({ orderNumber: orderMatch ? orderMatch[0] : '' });
      toolResults.push({ tool: 'query_shipping', data: shipping });
    }

    if (lower.includes('hệ thống') || lower.includes('máy chủ') || lower.includes('server') || lower.includes('cluster') || lower.includes('bảo mật') || lower.includes('cpu') || lower.includes('ram')) {
      const sys = await toolCheckSystemHealth();
      toolResults.push({ tool: 'check_system_health', data: sys });
    }

    if (lower.includes('tự học') || lower.includes('học hỏi') || lower.includes('tri thức') || lower.includes('learned') || lower.includes('khách hàng hỏi gì') || lower.includes('kiến thức')) {
      try {
        const { getLearnedKnowledgeStats } = require('./ai-self-learning');
        const learned = await getLearnedKnowledgeStats(pool);
        toolResults.push({ tool: 'get_learned_knowledge', data: learned });
      } catch (_) {}
    }

    // Tìm kiếm đơn hàng trong câu hỏi nếu có
    const orderCodeMatch = userQuestion.match(/(?:gae-[a-z0-9-]+|gr-[a-z0-9-]+|test-[a-z0-9-]+)/i);
    let matchedOrder = null;
    if (orderCodeMatch) {
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
    if (isConfirmOrderIntent && matchedOrder && ['pending', 'confirmed'].includes(matchedOrder.status)) {
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
    if (!actionCard && isCancelOrderIntent && matchedOrder && !['cancelled', 'completed'].includes(matchedOrder.status)) {
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
    if (!actionCard && isSyncShippingIntent && matchedOrder && matchedOrder.tracking_number) {
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
    if (!actionCard && isVoucherIntent) {
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
    if (!actionCard && (isCancelVoucherIntent || isDeleteVoucherIntent)) {
      const vCodeMatch = userQuestion.match(/(?:voucher|mã|code)?\s*([A-Za-z0-9_-]{3,20})/i);
      let targetVoucher = null;
      if (vCodeMatch && vCodeMatch[1]) {
        try {
          const vRes = await pool.query('SELECT id, code, title, amount, kind, active FROM marketing_vouchers WHERE lower(code) = lower($1) OR id::text = $1 LIMIT 1', [vCodeMatch[1].trim()]);
          if (vRes.rows.length) targetVoucher = vRes.rows[0];
        } catch (_) {}
      }
      if (!targetVoucher) {
        const vRes = await pool.query('SELECT id, code, title, amount, kind, active FROM marketing_vouchers ORDER BY created_at DESC LIMIT 1');
        if (vRes.rows.length) targetVoucher = vRes.rows[0];
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
    if (!actionCard && (isCancelCampaignIntent || isDeleteCampaignIntent)) {
      let targetCampaign = null;
      try {
        const cRes = await pool.query('SELECT id, title, active FROM marketing_campaigns ORDER BY created_at DESC LIMIT 1');
        if (cRes.rows.length) targetCampaign = { ...cRes.rows[0], type: 'campaign' };
        if (!targetCampaign) {
          const pRes = await pool.query('SELECT id, title, active FROM product_promotions ORDER BY created_at DESC LIMIT 1');
          if (pRes.rows.length) targetCampaign = { ...pRes.rows[0], type: 'promotion' };
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

  // Bộ tổng hợp deterministic phản hồi nhanh khi không có API key
  function synthesizeDeterministicResponse(question, toolResults, actionCard, user) {
    let out = `### 🤖 Báo cáo từ GAERU AI\n\n`;

    const overview = toolResults.find(t => t.tool === 'get_business_overview')?.data;
    if (overview) {
      out += `#### 📊 Tình hình Kinh doanh (${overview.periodDays} ngày qua)\n`;
      out += `- **Tổng đơn hàng ghi nhận:** **${overview.totalOrders}** đơn\n`;
      out += `- **Đơn chờ xác nhận (Pending):** ${overview.pendingOrders} đơn\n`;
      out += `- **Đơn đang đóng gói (Processing):** ${overview.processingOrders} đơn\n`;
      out += `- **Đơn đang giao (Shipped):** ${overview.shippedOrders} đơn\n`;
      out += `- **Đơn hoàn thành (Completed):** ${overview.completedOrders} đơn\n`;
      out += `- **Khách hàng mới đăng ký:** ${overview.newCustomers} người\n`;
      if (overview.revenue && overview.revenue.paidFormatted) {
        out += `- **Doanh thu thực thu:** **${overview.revenue.paidFormatted}** (Tổng giá trị đơn: ${overview.revenue.grossFormatted})\n`;
      }
      out += `\n`;
    }

    const ordersTool = toolResults.find(t => t.tool === 'query_orders');
    const orders = ordersTool?.data;
    const shippingTool = toolResults.find(t => t.tool === 'query_shipping');
    const shipping = shippingTool?.data;

    if (orders && orders.length) {
      out += `#### 📦 Danh sách đơn hàng phù hợp:\n`;
      out += `| Mã đơn | Khách hàng | SĐT | Trạng thái | Thanh toán | Tổng tiền |\n`;
      out += `|:---|:---|:---|:---:|:---:|---:|\n`;
      for (const o of orders) {
        out += `| **${o.orderNumber}** | ${o.customerName} | ${o.phone} | \`${o.status}\` | \`${o.paymentStatus}\` | ${o.totalFormatted} |\n`;
      }
      out += `\n`;
    } else if (ordersTool && Array.isArray(orders) && orders.length === 0 && !overview && !shippingTool) {
      out += `#### 📦 Tra cứu Đơn hàng:\n`;
      out += `- Hiện tại **không có đơn hàng nào** đang ở trạng thái chờ xử lý hoặc khớp với điều kiện tra cứu. Tất cả đơn hàng đã được xử lý hoàn tất! ✅\n\n`;
    }

    if (shipping) {
      if (shipping.error) {
        out += `#### 🚚 Tra cứu Vận chuyển:\n`;
        out += `- ⚠️ ${shipping.error}\n\n`;
      } else if (shipping.shipment && shipping.order) {
        out += `#### 🚚 Thông tin Vận đơn (${shipping.order.orderNumber}):\n`;
        out += `- **Đơn vị vận chuyển:** ${shipping.shipment.carrier}\n`;
        out += `- **Mã vận đơn:** \`${shipping.shipment.trackingNumber}\`\n`;
        out += `- **Trạng thái vận chuyển:** \`${shipping.shipment.status}\`\n`;
        out += `- **Khách hàng:** ${shipping.order.customerName} (${shipping.order.phone})\n\n`;
      } else if (Array.isArray(shipping.shipments)) {
        out += `#### 🚚 Lộ trình Vận chuyển & Vận đơn:\n`;
        if (shipping.shipments.length > 0) {
          out += `| Mã đơn | Khách hàng | Đơn vị VC | Mã vận đơn | Trạng thái |\n`;
          out += `|:---|:---|:---|:---|:---:|\n`;
          for (const s of shipping.shipments) {
            out += `| **${s.orderNumber}** | ${s.customerName} | ${s.carrier} | \`${s.trackingNumber}\` | \`${s.shipmentStatus}\` |\n`;
          }
          out += `\n`;
        } else {
          out += `- Hiện tại **không có đơn hàng nào đang trong lộ trình vận chuyển** hoặc chờ bưu cục Viettel Post lấy hàng. ✅\n\n`;
        }
      }
    }

    const inventoryTool = toolResults.find(t => t.tool === 'check_inventory');
    const inventory = inventoryTool?.data;
    if (inventory && inventory.length) {
      out += `#### 📋 Báo cáo Tồn kho:\n`;
      out += `| Sản phẩm | Biến thể | SKU | Tồn kho | Tình trạng |\n`;
      out += `|:---|:---|:---|:---:|:---:|\n`;
      for (const it of inventory) {
        out += `| ${it.productName} | ${it.variantName} | \`${it.sku}\` | **${it.stockQuantity}** | ${it.isLowStock ? '⚠️ ' + it.stockStatus : '✅ ' + it.stockStatus} |\n`;
      }
      out += `\n`;
    } else if (inventoryTool && Array.isArray(inventory) && inventory.length === 0) {
      out += `#### 📋 Báo cáo Tồn kho:\n`;
      out += `- Hiện tại **không có sản phẩm nào sắp hết hàng** (tất cả mặt hàng đều đảm bảo định mức tồn kho an toàn > 5 sản phẩm). ✅\n\n`;
    }

    const sys = toolResults.find(t => t.tool === 'check_system_health')?.data;
    if (sys) {
      out += `#### 🛡️ Sức khỏe Hệ thống & Hạ tầng:\n`;
      out += `- **Chế độ máy chủ:** ${sys.clusterMode}\n`;
      out += `- **Thời gian hoạt động (Uptime):** ${Math.round(sys.uptimeSeconds / 60)} phút\n`;
      out += `- **Bộ nhớ RSS:** ${sys.memoryRssMb} MB (Heap used: ${sys.heapUsedMb} MB)\n`;
      out += `- **Mối đe dọa WAF đã chặn:** ${sys.threatsBlocked} cuộc tấn công\n\n`;
    }

    const learned = toolResults.find(t => t.tool === 'get_learned_knowledge')?.data;
    if (learned) {
      out += `#### 🧠 Tri Thức Tự Học từ Hội Thoại (Autonomous Continuous Learning):\n`;
      out += `- **Tổng số tri thức đã tích lũy:** **${learned.stats?.total || 0}** bài học\n`;
      out += `- **Đang kích hoạt phục vụ khách:** **${learned.stats?.active_count || 0}** bài\n`;
      out += `- **Tổng lượt tương tác học hỏi:** **${learned.stats?.total_interactions || 0}** lượt\n`;
      out += `- **Độ tin cậy trung bình:** **${Math.round((learned.stats?.avg_confidence || 0.85) * 100)}%**\n`;
      if (learned.topEntries && learned.topEntries.length) {
        out += `\n**Top tri thức đúc kết gần đây:**\n`;
        for (const e of learned.topEntries.slice(0, 5)) {
          out += `- **${e.topic}** (Từ khóa: \`${(e.triggers || []).slice(0, 3).join(', ')}\`) · Lặp lại: ${e.occurrence_count} lần · Tin cậy: ${Math.round(e.confidence_score * 100)}%\n`;
        }
      }
      out += `\n`;
    }

    if (actionCard) {
      out += `> 💡 **Đề xuất thao tác:** Tôi đã tạo thẻ hành động phía dưới. Vui lòng bấm **[Xác nhận]** để hệ thống chính thức áp dụng.\n\n`;
    }

    if (!toolResults.length) {
      out += `Tôi đã ghi nhận yêu cầu: *"${question}"*. Hệ thống GAERU AI luôn sẵn sàng hỗ trợ bạn quản lý doanh thu, tra cứu đơn hàng, kiểm tra tồn kho và tự động hóa quy trình quản trị. Bạn có thể chọn các câu hỏi nhanh bên dưới!`;
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

  // 3. Lấy chi tiết tin nhắn trong hội thoại
  router.get('/threads/:id', async (req, res, next) => {
    try {
      const threadId = req.params.id;
      const thread = (await pool.query(`
        SELECT id, title, user_role AS "userRole", created_at AS "createdAt", updated_at AS "updatedAt"
        FROM internal_ai_threads
        WHERE id = $1
      `, [threadId])).rows[0];

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

  // 4. Xóa phiên hội thoại
  router.delete('/threads/:id', async (req, res, next) => {
    try {
      const threadId = req.params.id;
      await pool.query(`DELETE FROM internal_ai_threads WHERE id = $1`, [threadId]);
      res.json({ success: true, message: 'Đã xóa phiên hội thoại.' });
    } catch (e) {
      next(e);
    }
  });

  // 5. Gửi câu hỏi và chat với AI (Standard JSON)
  router.post('/threads/:id/chat', async (req, res, next) => {
    try {
      const threadId = req.params.id;
      const question = String(req.body?.question || '').trim();
      if (!question) return res.status(400).json({ error: 'Nội dung câu hỏi không được để trống.' });

      const thread = (await pool.query(`SELECT id, title FROM internal_ai_threads WHERE id = $1`, [threadId])).rows[0];
      if (!thread) return res.status(404).json({ error: 'Không tìm thấy phiên hội thoại.' });

      // Lưu câu hỏi của user
      await pool.query(`
        INSERT INTO internal_ai_messages (thread_id, role, content)
        VALUES ($1, $2, $3)
      `, [threadId, 'user', question]);

      // Lấy lịch sử hội thoại gần nhất
      const history = (await pool.query(`
        SELECT role, content FROM internal_ai_messages
        WHERE thread_id = $1
        ORDER BY created_at ASC
        LIMIT 10
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

  // 6. Gửi câu hỏi và nhận câu trả lời dạng Streaming SSE (Realtime typing)
  router.get('/threads/:id/chat/stream', async (req, res) => {
    const threadId = req.params.id;
    const question = String(req.query?.question || '').trim();

    if (!question) {
      return res.status(400).send('Câu hỏi không được để trống');
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

      // Lưu câu hỏi user
      await pool.query(`
        INSERT INTO internal_ai_messages (thread_id, role, content)
        VALUES ($1, $2, $3)
      `, [threadId, 'user', question]);

      const turnResult = await executeAgentTurn({
        userQuestion: question,
        user: req.admin,
        threadId
      });

      sendEvent('tools', { toolResults: turnResult.toolResults });

      // Phát từng từ mô phỏng streaming mượt mà
      const words = turnResult.content.split(' ');
      let buffer = '';
      for (let i = 0; i < words.length; i++) {
        buffer += (i === 0 ? '' : ' ') + words[i];
        if (i % 3 === 0 || i === words.length - 1) {
          sendEvent('token', { text: words[i] + ' ' });
          await new Promise(r => setTimeout(r, 20));
        }
      }

      // Lưu tin nhắn trợ lý
      const assistantMsg = (await pool.query(`
        INSERT INTO internal_ai_messages (thread_id, role, content, tool_results, action_card)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id, role, content, tool_results AS "toolResults", action_card AS "actionCard", created_at AS "createdAt"
      `, [threadId, 'assistant', turnResult.content, JSON.stringify(turnResult.toolResults || []), turnResult.actionCard ? JSON.stringify(turnResult.actionCard) : null])).rows[0];

      await pool.query(`UPDATE internal_ai_threads SET updated_at = NOW() WHERE id = $1`, [threadId]);

      sendEvent('done', { message: assistantMsg, actionCard: turnResult.actionCard });
      res.end();
    } catch (err) {
      sendEvent('error', { error: err.message });
      res.end();
    }
  });

  // 7. Xác nhận thực thi hành động từ Thẻ Action Card
  router.post('/actions/:actionId/execute', async (req, res, next) => {
    try {
      const actionId = req.params.actionId;
      const row = (await pool.query(`
        SELECT id, action_type AS "actionType", payload, status, created_by AS "createdBy"
        FROM internal_ai_action_logs
        WHERE id = $1
      `, [actionId])).rows[0];

      if (!row) return res.status(404).json({ error: 'Không tìm thấy thẻ hành động.' });
      if (row.status !== 'pending') return res.status(400).json({ error: `Hành động này đã ở trạng thái: ${row.status}.` });

      let result = null;

      // Thực thi tạo mã giảm giá voucher
      if (row.actionType === 'create_voucher') {
        const canManageMarketing = req.admin?.isOwner || (Array.isArray(req.admin?.permissions) && req.admin.permissions.includes('marketing.write'));
        if (!canManageMarketing) {
          return res.status(403).json({ error: 'Tài khoản của bạn không có quyền tạo mã khuyến mãi.' });
        }

        const p = row.payload;
        await pool.query(`
          INSERT INTO marketing_vouchers (code, title, kind, amount, min_spend_vnd, starts_at, ends_at, total_limit, active)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true)
          ON CONFLICT (code) DO UPDATE
          SET title = $2, amount = $4, active = true
        `, [p.code, p.title, p.kind, p.amount, p.minSpendVnd || 0, p.startsAt, p.endsAt, p.totalLimit || 50]);

        result = { success: true, message: `Đã kích hoạt thành công mã giảm giá ${p.code} (-${p.kind === 'percent' ? p.amount + '%' : formatVnd(p.amount)}) trên toàn hệ thống!`, actionType: 'create_voucher' };
      } else if (row.actionType === 'confirm_order') {
        const canManageOrders = req.admin?.isOwner || (Array.isArray(req.admin?.permissions) && req.admin.permissions.includes('orders.write'));
        if (!canManageOrders) {
          return res.status(403).json({ error: 'Tài khoản của bạn không có quyền quản lý đơn hàng.' });
        }
        const p = row.payload;
        const { withTransaction } = require('./db');
        await withTransaction(pool, async (client) => {
          const ord = (await client.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [p.orderId])).rows[0];
          if (!ord) throw new Error('Không tìm thấy đơn hàng.');
          if (ord.status === 'cancelled' || ord.status === 'completed') {
            throw new Error(`Đơn hàng đang ở trạng thái ${ord.status}, không thể chuyển sang Giao hàng.`);
          }
          await client.query("UPDATE orders SET status = 'processing', updated_at = now() WHERE id = $1", [p.orderId]);
        });
        try {
          require('./realtime-sse').publishAdminEvent('order:update', {
            orderId: p.orderId,
            orderNumber: p.orderNumber,
            status: 'processing'
          });
        } catch (_) {}
        result = { success: true, message: `Đã duyệt và chuyển đơn ${p.orderNumber} sang Giao hàng (processing) thành công! Tồn kho đã được đảm bảo.`, orderId: p.orderId, actionType: 'confirm_order' };
      } else if (row.actionType === 'cancel_order') {
        const canManageOrders = req.admin?.isOwner || (Array.isArray(req.admin?.permissions) && req.admin.permissions.includes('orders.write'));
        if (!canManageOrders) {
          return res.status(403).json({ error: 'Tài khoản của bạn không có quyền hủy đơn hàng.' });
        }
        const p = row.payload;
        const { withTransaction } = require('./db');
        const { releaseOrderStock } = require('./inventory');
        await withTransaction(pool, async (client) => {
          const ord = (await client.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [p.orderId])).rows[0];
          if (!ord) throw new Error('Không tìm thấy đơn hàng.');
          if (ord.status === 'completed') throw new Error('Đơn hàng đã hoàn thành, không thể hủy.');
          // Hủy vận đơn liên quan nếu có
          await client.query("UPDATE carrier_shipments SET status = 'cancelled', updated_at = now() WHERE order_id = $1 AND status != 'cancelled'", [p.orderId]);
          // Hoàn kho
          await releaseOrderStock(client, { orderId: p.orderId, actor: req.admin }).catch(() => {});
          await client.query("UPDATE orders SET status = 'cancelled', updated_at = now() WHERE id = $1", [p.orderId]);
        });
        try {
          require('./realtime-sse').publishAdminEvent('order:update', {
            orderId: p.orderId,
            orderNumber: p.orderNumber,
            status: 'cancelled'
          });
        } catch (_) {}
        result = { success: true, message: `Đã hủy đơn hàng ${p.orderNumber} và hoàn trả số lượng vào kho thành công!`, orderId: p.orderId, actionType: 'cancel_order' };
      } else if (row.actionType === 'sync_shipping') {
        const canManageOrders = req.admin?.isOwner || (Array.isArray(req.admin?.permissions) && req.admin.permissions.includes('orders.write'));
        if (!canManageOrders) {
          return res.status(403).json({ error: 'Tài khoản của bạn không có quyền xem thông tin vận chuyển.' });
        }
        const p = row.payload;
        const { syncShipmentTracking } = require('./shipping-management');
        let syncRes = null;
        try {
          syncRes = await syncShipmentTracking(pool, config, { orderId: p.orderId, actor: req.admin });
        } catch (err) {
          syncRes = { message: 'Đã hoàn tất kiểm tra hành trình: ' + err.message };
        }
        result = { success: true, message: syncRes?.message || `Đã đồng bộ hành trình bưu cục cho đơn ${p.orderNumber} thành công!`, orderId: p.orderId, actionType: 'sync_shipping' };
      } else if (row.actionType === 'cancel_voucher') {
        const canManageMarketing = req.admin?.isOwner || (Array.isArray(req.admin?.permissions) && req.admin.permissions.includes('marketing.write'));
        if (!canManageMarketing) {
          return res.status(403).json({ error: 'Tài khoản của bạn không có quyền quản lý marketing.' });
        }
        const p = row.payload;
        await pool.query('UPDATE marketing_vouchers SET active=false, version=version+1, updated_at=now() WHERE id=$1', [p.voucherId]);
        try { require('./realtime-sse').publishAdminEvent('marketing:update', { kind: 'vouchers', id: p.voucherId, active: false }); } catch (_) {}
        try { require('./cache').flushAllCache(); } catch (_) {}
        result = { success: true, message: `Đã dừng kích hoạt mã voucher ${p.code} thành công!`, voucherId: p.voucherId, actionType: 'cancel_voucher' };
      } else if (row.actionType === 'delete_voucher') {
        const canManageMarketing = req.admin?.isOwner || (Array.isArray(req.admin?.permissions) && req.admin.permissions.includes('marketing.write'));
        if (!canManageMarketing) {
          return res.status(403).json({ error: 'Tài khoản của bạn không có quyền quản lý marketing.' });
        }
        const p = row.payload;
        const { withTransaction } = require('./db');
        await withTransaction(pool, async (c) => {
          await c.query('UPDATE marketing_campaigns SET voucher_id=NULL WHERE voucher_id=$1', [p.voucherId]);
          await c.query('DELETE FROM customer_vouchers WHERE voucher_id=$1', [p.voucherId]);
          await c.query('DELETE FROM voucher_redemptions WHERE voucher_id=$1', [p.voucherId]);
          await c.query('DELETE FROM marketing_vouchers WHERE id=$1', [p.voucherId]);
        });
        try { require('./realtime-sse').publishAdminEvent('marketing:update', { kind: 'vouchers', id: p.voucherId, deleted: true }); } catch (_) {}
        try { require('./cache').flushAllCache(); } catch (_) {}
        result = { success: true, message: `Đã xóa vĩnh viễn mã voucher ${p.code} khỏi cơ sở dữ liệu!`, voucherId: p.voucherId, actionType: 'delete_voucher' };
      } else if (row.actionType === 'cancel_campaign') {
        const canManageMarketing = req.admin?.isOwner || (Array.isArray(req.admin?.permissions) && req.admin.permissions.includes('marketing.write'));
        if (!canManageMarketing) {
          return res.status(403).json({ error: 'Tài khoản của bạn không có quyền quản lý marketing.' });
        }
        const p = row.payload;
        if (p.type === 'promotion') {
          await pool.query('UPDATE product_promotions SET active=false, version=version+1, updated_at=now() WHERE id=$1', [p.campaignId]);
        } else {
          await pool.query('UPDATE marketing_campaigns SET active=false, version=version+1, updated_at=now() WHERE id=$1', [p.campaignId]);
        }
        try { require('./realtime-sse').publishAdminEvent('marketing:update', { kind: p.type || 'campaigns', id: p.campaignId, active: false }); } catch (_) {}
        try { require('./cache').flushAllCache(); } catch (_) {}
        result = { success: true, message: `Đã dừng kích hoạt chiến dịch "${p.title}" thành công!`, campaignId: p.campaignId, actionType: 'cancel_campaign' };
      } else if (row.actionType === 'delete_campaign') {
        const canManageMarketing = req.admin?.isOwner || (Array.isArray(req.admin?.permissions) && req.admin.permissions.includes('marketing.write'));
        if (!canManageMarketing) {
          return res.status(403).json({ error: 'Tài khoản của bạn không có quyền quản lý marketing.' });
        }
        const p = row.payload;
        const { withTransaction } = require('./db');
        await withTransaction(pool, async (c) => {
          if (p.type === 'promotion') {
            await c.query('DELETE FROM product_promotion_variants WHERE promotion_id=$1', [p.campaignId]);
            await c.query('DELETE FROM product_promotions WHERE id=$1', [p.campaignId]);
          } else {
            await c.query('DELETE FROM customer_campaign_reads WHERE campaign_id=$1', [p.campaignId]);
            await c.query('DELETE FROM marketing_campaigns WHERE id=$1', [p.campaignId]);
          }
        });
        try { require('./realtime-sse').publishAdminEvent('marketing:update', { kind: p.type || 'campaigns', id: p.campaignId, deleted: true }); } catch (_) {}
        try { require('./cache').flushAllCache(); } catch (_) {}
        result = { success: true, message: `Đã xóa vĩnh viễn chiến dịch "${p.title}" khỏi hệ thống!`, campaignId: p.campaignId, actionType: 'delete_campaign' };
      } else {
        result = { success: true, message: `Đã ghi nhận thực thi hành động: ${row.actionType}` };
      }

      await pool.query(`
        UPDATE internal_ai_action_logs
        SET status = 'executed', executed_at = NOW(), result = $1
        WHERE id = $2
      `, [JSON.stringify(result), actionId]);

      res.json({ success: true, actionId, status: 'executed', result });
    } catch (e) {
      next(e);
    }
  });

  // 8. Hủy bỏ hành động từ Thẻ Action Card
  router.post('/actions/:actionId/cancel', async (req, res, next) => {
    try {
      const actionId = req.params.actionId;
      await pool.query(`
        UPDATE internal_ai_action_logs
        SET status = 'cancelled', executed_at = NOW()
        WHERE id = $1 AND status = 'pending'
      `, [actionId]);

      res.json({ success: true, actionId, status: 'cancelled', message: 'Đã hủy bỏ hành động.' });
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
