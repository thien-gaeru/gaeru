
function getMisaApiUrl(misaConfig = {}) {
  if (misaConfig.apiUrl) return misaConfig.apiUrl.replace(/\/+$/, "");
  if (process.env.MISA_API_URL) return process.env.MISA_API_URL.replace(/\/+$/, "");
  return misaConfig.environment === "production"
    ? "https://eshopapi.misa.vn"
    : "https://testeshopapi.misa.vn";
}

function buildInvoicePayload(order, items = [], misaConfig = {}) {
  const orderId = order.id;
  const orderNumber = order.order_number || order.orderNumber || "ORDER";
  const customerName = order.buyer_name || order.customer_name || order.customerName || "Khách hàng cá nhân";
  const buyerTaxCode = order.buyer_tax_code || order.buyerTaxCode || "";
  const address = order.buyer_address || order.address || "";
  const email = order.buyer_email || order.email || "";
  const phone = order.buyer_phone || order.phone || "";
  const templateCode = misaConfig.templateCode || "1/001";
  const series = misaConfig.series || "C26TGA";

  let paymentMethod = "TM/CK";
  const pm = order.payment_method || order.paymentMethod;
  if (pm === "bank_transfer") paymentMethod = "CK";
  else if (pm === "cod") paymentMethod = "TM";

  const invoiceItems = items.map((item) => {
    const fullName = item.product_name
      ? `${item.product_name}${item.variant_name ? " - " + item.variant_name : ""}`
      : (item.productName || "Sản phẩm");
    const qty = Number(item.quantity) || 1;
    const unitPrice = Number(item.unit_price_vnd ?? item.unitPriceVnd ?? 0);
    const lineTotal = Number(item.line_total_vnd ?? item.lineTotalVnd ?? (qty * unitPrice));
    return {
      ItemName: fullName,
      ItemCode: item.sku || "SKU",
      UnitName: "Cái",
      Quantity: qty,
      UnitPrice: unitPrice,
      Amount: lineTotal,
      VATRate: 0,
      VATAmount: 0
    };
  });

  const shippingFee = Number(order.shipping_fee_vnd ?? order.shippingFeeVnd ?? 0);
  if (shippingFee > 0) {
    invoiceItems.push({
      ItemName: "Cước phí vận chuyển",
      ItemCode: "SHIPPING",
      UnitName: "Chuyến",
      Quantity: 1,
      UnitPrice: shippingFee,
      Amount: shippingFee,
      VATRate: 0,
      VATAmount: 0
    });
  }

  const totalVnd = Number(order.total_vnd ?? order.totalVnd ?? (invoiceItems.reduce((s, i) => s + i.Amount, 0)));

  return {
    RefID: orderId,
    RefNo: orderNumber,
    InvoiceDate: new Date().toISOString(),
    InvoiceTemplate: templateCode,
    InvoiceSeries: series,
    Currency: "VND",
    ExchangeRate: 1,
    PaymentMethod: paymentMethod,
    BuyerLegalName: customerName,
    BuyerTaxCode: buyerTaxCode,
    BuyerAddress: address,
    BuyerEmail: email,
    BuyerPhoneNumber: phone,
    SellerTaxCode: misaConfig.taxCode || "",
    Items: invoiceItems,
    DiscountAmount: Math.max(0, Number(order.discount_vnd ?? order.discountVnd ?? 0)),
    ShippingAmount: Math.max(0, Number(order.shipping_fee_vnd ?? order.shippingFeeVnd ?? 0)),
    TotalAmount: totalVnd,
    TotalVATAmount: 0
  };
}

const protocolMessage = 'MISA chưa được nghiệm thu giao thức eShop/meInvoice và quyền phát hành. Đã khóa kiểm tra kết nối và phát hành; hồ sơ hóa đơn nội bộ vẫn được giữ.';
function protocolUnavailable() { return Object.assign(new Error(protocolMessage), { status:501, code:'MISA_PROTOCOL_UNVERIFIED' }); }
async function probeConnection() { throw protocolUnavailable(); }
async function issueInvoice() { throw protocolUnavailable(); }
async function autoIssueForOrder(_pool, _config, _orderId, { manual=false } = {}) {
  if(manual) throw protocolUnavailable();
  return { skipped:true, reason:'misa_protocol_unverified', message:protocolMessage };
}
async function issueInvoiceForDocument() { throw protocolUnavailable(); }


async function ensureMisaRetryTable(client) {
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS misa_einvoice_retry_queue (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
        attempts integer NOT NULL DEFAULT 0,
        max_attempts integer NOT NULL DEFAULT 3,
        last_error text,
        next_attempt_at timestamptz NOT NULL DEFAULT now(),
        status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'processing', 'completed', 'failed')),
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE(order_id)
      );
      CREATE INDEX IF NOT EXISTS idx_misa_retry_pending ON misa_einvoice_retry_queue(next_attempt_at) WHERE status = 'pending';
    `);
  } catch (err) {
    // If table already exists or client error, tolerate gracefully
  }
}

async function enqueueInvoiceRetry(pool, orderId, error) {
  try {
    await ensureMisaRetryTable(pool);
    const errMsg = String(error?.message || error || 'Lỗi không xác định');
    await pool.query(
      `INSERT INTO misa_einvoice_retry_queue (order_id, attempts, last_error, next_attempt_at, status, updated_at)
       VALUES ($1, 1, $2, now() + interval '5 minutes', 'pending', now())
       ON CONFLICT (order_id) DO UPDATE SET
         attempts = misa_einvoice_retry_queue.attempts + 1,
         last_error = EXCLUDED.last_error,
         next_attempt_at = CASE
           WHEN misa_einvoice_retry_queue.attempts + 1 = 2 THEN now() + interval '15 minutes'
           WHEN misa_einvoice_retry_queue.attempts + 1 = 3 THEN now() + interval '60 minutes'
           ELSE now() + interval '120 minutes'
         END,
         status = CASE
           WHEN misa_einvoice_retry_queue.attempts + 1 >= 3 THEN 'failed'
           ELSE 'pending'
         END,
         updated_at = now()`,
      [orderId, errMsg]
    );
  } catch (e) {
    // Tolerant in case of mock pools
  }
}

async function dequeueInvoiceSuccess(pool, orderId) {
  try {
    await pool.query("DELETE FROM misa_einvoice_retry_queue WHERE order_id = $1", [orderId]);
  } catch (_) {}
}

async function retryPendingInvoices(pool, config = {}, { fetcher, limit = 50 } = {}) {
  try {
    await ensureMisaRetryTable(pool);
    // 1. Quét các mục đang chờ trong misa_einvoice_retry_queue đến hạn
    let queuedRows = [];
    try {
      const qRes = await pool.query(
        `SELECT q.order_id AS "orderId", q.attempts, o.order_number AS "orderNumber"
         FROM misa_einvoice_retry_queue q
         JOIN orders o ON o.id = q.order_id
         WHERE q.status = 'pending' AND q.next_attempt_at <= now()
         ORDER BY q.next_attempt_at ASC
         LIMIT $1`,
        [Math.max(1, Math.min(100, Number(limit) || 50))]
      );
      queuedRows = qRes.rows || [];
    } catch (_) {}

    // 2. Quét các đơn completed + paid chưa có hóa đơn và chưa vào queue
    let missingRows = [];
    try {
      const mRes = await pool.query(
        `SELECT o.id AS "orderId", 0 AS attempts, o.order_number AS "orderNumber"
         FROM orders o
         WHERE o.status = 'completed' AND o.payment_status = 'paid'
           AND NOT EXISTS (SELECT 1 FROM misa_einvoices m WHERE m.order_id = o.id)
           AND NOT EXISTS (SELECT 1 FROM misa_einvoice_retry_queue q WHERE q.order_id = o.id)
         ORDER BY o.updated_at ASC
         LIMIT $1`,
        [Math.max(1, Math.min(100, Number(limit) || 50))]
      );
      missingRows = mRes.rows || [];
    } catch (_) {}

    const allCandidates = [...queuedRows, ...missingRows].slice(0, Number(limit) || 50);
    const results = [];
    for (const order of allCandidates) {
      try {
        const res = await autoIssueForOrder(pool, config, order.orderId, { fetcher, manual: false });
        if (res?.success) {
          await dequeueInvoiceSuccess(pool, order.orderId);
        } else if (res?.skipped) {
          // Bổ sung vào hàng đợi nếu giao thức chưa sẵn sàng hoặc mạng ngắt
          await enqueueInvoiceRetry(pool, order.orderId, res.reason || res.message);
        }
        results.push({ orderId: order.orderId, orderNumber: order.orderNumber, success: true, ...res });
      } catch (err) {
        await enqueueInvoiceRetry(pool, order.orderId, err.message);
        results.push({ orderId: order.orderId, orderNumber: order.orderNumber, success: false, error: err.message });
      }
    }
    return {
      success: true,
      pendingCount: allCandidates.length,
      retriedCount: results.length,
      results,
      scannedAt: new Date().toISOString()
    };
  } catch (err) {
    return {
      success: false,
      error: err.message,
      scannedAt: new Date().toISOString()
    };
  }
}

function startMisaRetryScheduler(pool, config = {}, intervalMs = 30 * 60 * 1000) {
  const timer = setInterval(() => {
    retryPendingInvoices(pool, config).catch((e) => {
      console.warn('[MISA Retry Scheduler] Background sweep failed:', e.message);
    });
  }, Math.max(60000, Number(intervalMs) || 1800000));
  if (timer.unref) timer.unref();
  const stopper = () => clearInterval(timer);
  stopper.stop = stopper;
  stopper.trigger = () => retryPendingInvoices(pool, config);
  return stopper;
}

module.exports = {
  getMisaApiUrl,
  buildInvoicePayload,
  probeConnection,
  issueInvoice,
  autoIssueForOrder,
  issueInvoiceForDocument,
  retryPendingInvoices,
  startMisaRetryScheduler,
  enqueueInvoiceRetry,
  dequeueInvoiceSuccess,
  ensureMisaRetryTable
};
