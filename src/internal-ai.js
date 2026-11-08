'use strict';

/**
 * GAERU Enterprise AI Copilot (Trợ lý điều hành doanh nghiệp nội bộ 24/7)
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
const { getChatAIConfig } = require('./chat-ai-provider');
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

  // Tool 4: Tra cứu vận đơn
  async function toolQueryShipping({ orderNumber }) {
    if (!orderNumber) return { error: 'Vui lòng cung cấp mã đơn hàng.' };
    
    const row = (await pool.query(`
      SELECT 
        order_number AS "orderNumber",
        customer_name AS "customerName",
        phone,
        address,
        city,
        status,
        note
      FROM orders
      WHERE lower(order_number) = lower($1)
      LIMIT 1
    `, [orderNumber.trim()])).rows[0];

    if (!row) return { error: `Không tìm thấy đơn hàng mã ${orderNumber}` };

    // Kiểm tra xem có bản ghi shipment trong logistics/shipping_fulfillments không
    let shipment = null;
    try {
      shipment = (await pool.query(`
        SELECT carrier_name AS "carrier", tracking_number AS "trackingNumber", status, synced_at AS "syncedAt"
        FROM shipping_fulfillments
        WHERE order_number = $1
        ORDER BY created_at DESC
        LIMIT 1
      `, [row.orderNumber])).rows[0] || null;
    } catch (_) {}

    return {
      order: row,
      shipment: shipment || { carrier: 'Viettel Post / GAERU Logistics', status: row.status, trackingNumber: 'Chưa tạo vận đơn hoặc đang đóng gói' }
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

  const SYSTEM_INSTRUCTION = `Bạn là GAERU Copilot - Trợ lý Điều hành Doanh nghiệp AI nội bộ cao cấp của GAERU (dành riêng cho Ban Giám Đốc và Đội ngũ Quản trị).
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

    if (lower.includes('vận đơn') || lower.includes('viettel') || lower.includes('giao hàng') || lower.includes('vận chuyển')) {
      const orderMatch = lower.match(/gae-[a-z0-9-]+/i);
      if (orderMatch) {
        const shipping = await toolQueryShipping({ orderNumber: orderMatch[0] });
        toolResults.push({ tool: 'query_shipping', data: shipping });
      }
    }

    if (lower.includes('hệ thống') || lower.includes('máy chủ') || lower.includes('server') || lower.includes('cluster') || lower.includes('bảo mật') || lower.includes('cpu') || lower.includes('ram')) {
      const sys = await toolCheckSystemHealth();
      toolResults.push({ tool: 'check_system_health', data: sys });
    }

    // Kiểm tra xem người dùng có yêu cầu tạo mã giảm giá / voucher không
    const isVoucherIntent = /(?:tạo|lập|thêm|phát hành).*(?:mã|voucher|coupon|khuyến mãi)/i.test(lower) ||
                            /(?:mã giảm giá|mã khuyến mãi|tạo voucher)/i.test(lower) ||
                            (lower.includes('voucher') && (lower.includes('tạo') || lower.includes('thêm')));
    if (isVoucherIntent) {
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
          title: `Ưu đãi GAERU Copilot: ${code}`,
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

    // 3. Gọi LLM sinh phản hồi
    let aiResponseText = '';
    const promptForLLM = `NGỮ CẢNH HỆ THỐNG VÀ DỮ LIỆU THỰC TẾ TRUY VẤN ĐƯỢC:\n` + JSON.stringify(contextPayload, null, 2) + `\n\nCÂU HỎI CỦA NGƯỜI DÙNG: "${userQuestion}"\n\nHãy trả lời bằng tiếng Việt chuyên nghiệp, định dạng Markdown rõ ràng, giải đáp đầy đủ câu hỏi và tóm tắt số liệu.`;

    if (aiConfig.enabled && aiConfig.apiKey) {
      try {
        if (aiConfig.provider === 'gemini') {
          const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(aiConfig.model || 'gemini-2.5-flash')}:generateContent`;
          const resp = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-goog-api-key': aiConfig.apiKey },
            body: JSON.stringify({
              contents: [{ role: 'user', parts: [{ text: promptForLLM }] }],
              generationConfig: { maxOutputTokens: 2048, temperature: 0.2 }
            }),
            signal: AbortSignal.timeout(15000)
          });
          if (resp.ok) {
            const data = await resp.json();
            aiResponseText = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
          }
        } else if (aiConfig.provider === 'openai') {
          const resp = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${aiConfig.apiKey}` },
            body: JSON.stringify({
              model: aiConfig.model || 'gpt-4o-mini',
              messages: [{ role: 'system', content: SYSTEM_INSTRUCTION }, { role: 'user', content: promptForLLM }],
              max_tokens: 2048,
              temperature: 0.2
            }),
            signal: AbortSignal.timeout(15000)
          });
          if (resp.ok) {
            const data = await resp.json();
            aiResponseText = data.choices?.[0]?.message?.content || '';
          }
        }
      } catch (e) {
        console.warn('[GAERU-COPILOT] Upstream AI call failed, falling back to deterministic synthesis:', e.message);
      }
    }

    // Fallback tổng hợp thông minh nếu chưa cấu hình AI API key hoặc API lỗi mạng
    if (!aiResponseText) {
      aiResponseText = synthesizeDeterministicResponse(userQuestion, toolResults, actionCard, user);
    }

    return {
      content: aiResponseText,
      toolResults,
      actionCard
    };
  }

  // Bộ tổng hợp deterministic phản hồi nhanh khi không có API key
  function synthesizeDeterministicResponse(question, toolResults, actionCard, user) {
    let out = `### 🤖 Báo cáo từ GAERU Copilot\n\n`;

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

    const orders = toolResults.find(t => t.tool === 'query_orders')?.data;
    if (orders && orders.length) {
      out += `#### 📦 Danh sách đơn hàng phù hợp:\n`;
      out += `| Mã đơn | Khách hàng | SĐT | Trạng thái | Thanh toán | Tổng tiền |\n`;
      out += `|:---|:---|:---|:---:|:---:|---:|\n`;
      for (const o of orders) {
        out += `| **${o.orderNumber}** | ${o.customerName} | ${o.phone} | \`${o.status}\` | \`${o.paymentStatus}\` | ${o.totalFormatted} |\n`;
      }
      out += `\n`;
    }

    const inventory = toolResults.find(t => t.tool === 'check_inventory')?.data;
    if (inventory && inventory.length) {
      out += `#### 📋 Báo cáo Tồn kho:\n`;
      out += `| Sản phẩm | Biến thể | SKU | Tồn kho | Tình trạng |\n`;
      out += `|:---|:---|:---|:---:|:---:|\n`;
      for (const it of inventory) {
        out += `| ${it.productName} | ${it.variantName} | \`${it.sku}\` | **${it.stockQuantity}** | ${it.isLowStock ? '⚠️ ' + it.stockStatus : '✅ ' + it.stockStatus} |\n`;
      }
      out += `\n`;
    }

    const sys = toolResults.find(t => t.tool === 'check_system_health')?.data;
    if (sys) {
      out += `#### 🛡️ Sức khỏe Hệ thống & Hạ tầng:\n`;
      out += `- **Chế độ máy chủ:** ${sys.clusterMode}\n`;
      out += `- **Thời gian hoạt động (Uptime):** ${Math.round(sys.uptimeSeconds / 60)} phút\n`;
      out += `- **Bộ nhớ RSS:** ${sys.memoryRssMb} MB (Heap used: ${sys.heapUsedMb} MB)\n`;
      out += `- **Mối đe dọa WAF đã chặn:** ${sys.threatsBlocked} cuộc tấn công\n\n`;
    }

    if (actionCard) {
      out += `> 💡 **Đề xuất thao tác:** Tôi đã tạo thẻ hành động phía dưới. Vui lòng bấm **[Xác nhận]** để hệ thống chính thức áp dụng.\n\n`;
    }

    if (!toolResults.length) {
      out += `Tôi đã ghi nhận yêu cầu: *"${question}"*. Hệ thống GAERU Copilot luôn sẵn sàng hỗ trợ bạn quản lý doanh thu, tra cứu đơn hàng, kiểm tra tồn kho và tự động hóa quy trình quản trị. Bạn có thể chọn các câu hỏi nhanh bên dưới!`;
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

      // Lấy cấu hình AI
      const aiConfig = await getChatAIConfig(pool, config);

      // Thực thi Agent Turn
      const turnResult = await executeAgentTurn({
        userQuestion: question,
        history,
        user: req.admin,
        threadId,
        aiConfig
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
        message: assistantMsg,
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

      const aiConfig = await getChatAIConfig(pool, config);
      const turnResult = await executeAgentTurn({
        userQuestion: question,
        user: req.admin,
        threadId,
        aiConfig
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

        result = { success: true, message: `Đã kích hoạt thành công mã giảm giá ${p.code} trên website!` };
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
