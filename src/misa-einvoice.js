const { randomUUID } = require("node:crypto");
const { readRecord } = require("./admin-configuration");
const { appendAudit } = require("./audit");

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
    TotalAmount: totalVnd,
    TotalVATAmount: 0
  };
}

async function probeConnection(misaConfig, { fetcher = fetch } = {}) {
  if (!misaConfig || !misaConfig.appId || !misaConfig.secret || !misaConfig.storeId) {
    throw Object.assign(new Error("Vui lòng cấu hình App ID, Store ID và Khóa bí mật MISA eShop."), { status: 400 });
  }

  const baseUrl = getMisaApiUrl(misaConfig);
  const headers = {
    "Content-Type": "application/json",
    "X-MISA-AppId": misaConfig.appId,
    "X-MISA-Secret": misaConfig.secret,
    "X-MISA-StoreId": misaConfig.storeId
  };

  const response = await fetcher(`${baseUrl}/api/v1/connection/verify`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      appId: misaConfig.appId,
      storeId: misaConfig.storeId,
      taxCode: misaConfig.taxCode || "",
      testedAt: new Date().toISOString()
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    let msg = `Máy chủ MISA eShop phản hồi mã HTTP ${response.status}.`;
    try {
      const errJson = JSON.parse(errText);
      msg = errJson.ErrorMessage || errJson.message || errJson.error || msg;
    } catch {}
    throw Object.assign(new Error(msg), { status: 503 });
  }

  return {
    verified: true,
    message: "Kết nối MISA eShop thành công. Sẵn sàng phát hành hóa đơn điện tử tự động."
  };
}

async function issueInvoice(misaConfig, payload, { fetcher = fetch } = {}) {
  const baseUrl = getMisaApiUrl(misaConfig);
  const headers = {
    "Content-Type": "application/json",
    "X-MISA-AppId": misaConfig.appId,
    "X-MISA-Secret": misaConfig.secret,
    "X-MISA-StoreId": misaConfig.storeId
  };

  const response = await fetcher(`${baseUrl}/api/v1/invoices/publish`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const text = await response.text();
    let msg = `HTTP ${response.status}`;
    try {
      const json = JSON.parse(text);
      msg = json.ErrorMessage || json.message || json.error || msg;
    } catch {}
    throw Object.assign(new Error("Lỗi xuất hóa đơn MISA eShop: " + msg), { status: response.status });
  }

  const result = await response.json();
  const invoiceNumber = String(result.InvoiceNo || result.invoiceNumber || result.InvoiceData?.InvoiceNo || ("HD-" + Date.now()));
  const invoiceSeries = String(result.InvoiceSeries || result.invoiceSeries || misaConfig.series || "C26TGA");
  const templateCode = String(result.TemplateCode || result.templateCode || misaConfig.templateCode || "1/001");
  const transactionId = String(result.TransactionID || result.transactionId || result.TransactionId || result.InvoiceData?.TransactionID || randomUUID());
  const viewUrl = String(result.ViewUrl || result.viewUrl || result.InvoiceData?.ViewUrl || `${baseUrl}/invoice/view/${transactionId}`);

  return {
    invoiceNumber,
    invoiceSeries,
    templateCode,
    transactionId,
    viewUrl,
    raw: result
  };
}

async function autoIssueForOrder(pool, config, orderId, { fetcher = fetch } = {}) {
  if (!config || (!process.env.AUTH_ENCRYPTION_KEY && !config.SESSION_SECRET)) {
    return { skipped: true, reason: "unconfigured" };
  }

  const record = await readRecord(pool, config, "misa");
  const misa = record?.data;
  if (!record?.version || !misa?.enabled || !misa?.autoIssue || !misa?.secret) {
    return { skipped: true, reason: "misa_not_enabled" };
  }

  const orderRes = await pool.query(
    `SELECT id, order_number, customer_name, email, phone, address, city, payment_method, payment_status, status, subtotal_vnd, shipping_fee_vnd, discount_vnd, total_vnd
     FROM orders WHERE id=$1`,
    [orderId]
  );
  const order = orderRes.rows[0];
  if (!order) return { skipped: true, reason: "order_not_found" };
  if (order.status !== "completed" || order.payment_status !== "paid") {
    return { skipped: true, reason: "order_not_completed_or_paid" };
  }

  const existing = await pool.query("SELECT * FROM misa_einvoices WHERE order_id=$1", [orderId]);
  if (existing.rows.length) {
    return { skipped: true, reason: "already_issued", einvoice: existing.rows[0] };
  }

  const itemsRes = await pool.query(
    `SELECT product_name, variant_name, sku, unit_price_vnd, quantity, line_total_vnd
     FROM order_items WHERE order_id=$1 ORDER BY id`,
    [orderId]
  );
  const items = itemsRes.rows;

  const docRes = await pool.query(
    `SELECT id, payload FROM business_documents WHERE kind='invoice' AND reference=$1 LIMIT 1`,
    [orderId]
  );
  const documentId = docRes.rows[0]?.id || null;
  const buyerTaxCode = docRes.rows[0]?.payload?.buyerTaxCode || "";
  const buyerAddress = docRes.rows[0]?.payload?.buyerAddress || (order.address + (order.city ? ", " + order.city : ""));
  const buyerEmail = docRes.rows[0]?.payload?.buyerEmail || order.email || "";

  const payload = buildInvoicePayload({
    ...order,
    buyer_tax_code: buyerTaxCode,
    buyer_address: buyerAddress,
    buyer_email: buyerEmail
  }, items, misa);

  const issued = await issueInvoice(misa, payload, { fetcher });

  const inserted = await pool.query(
    `INSERT INTO misa_einvoices(
       order_id, document_id, order_number, invoice_number, invoice_series,
       template_code, transaction_id, view_url, total_vnd,
       buyer_name, buyer_tax_code, buyer_address, buyer_email, buyer_phone,
       issued_at, status
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,now(),'issued')
     ON CONFLICT (order_id) DO NOTHING
     RETURNING *`,
    [
      order.id,
      documentId,
      order.order_number,
      issued.invoiceNumber,
      issued.invoiceSeries,
      issued.templateCode,
      issued.transactionId,
      issued.viewUrl,
      order.total_vnd,
      order.customer_name,
      buyerTaxCode,
      buyerAddress,
      buyerEmail,
      order.phone || ""
    ]
  );

  const row = inserted.rows[0] || (await pool.query("SELECT * FROM misa_einvoices WHERE order_id=$1", [order.id])).rows[0];

  try {
    await appendAudit(pool, {
      actor: { username: "system", role: "system" },
      action: "einvoice.issue",
      entityType: "order",
      entityId: order.id,
      metadata: {
        orderNumber: order.order_number,
        invoiceNumber: row.invoice_number,
        invoiceSeries: row.invoice_series,
        transactionId: row.transaction_id,
        viewUrl: row.view_url,
        provider: "misa_eshop"
      }
    });
  } catch {}

  return { success: true, einvoice: row };
}

async function issueInvoiceForDocument(pool, config, documentId, misaConfig, { fetcher = fetch, actor = { username: "system" } } = {}) {
  const docRes = await pool.query(
    "SELECT id, kind, period, reference, payload, status FROM business_documents WHERE id=$1 AND kind='invoice'",
    [documentId]
  );
  const doc = docRes.rows[0];
  if (!doc) throw Object.assign(new Error("Không tìm thấy chứng từ hóa đơn."), { status: 404 });
  if (doc.status !== "approved") throw Object.assign(new Error("Chỉ phát hành hóa đơn cho chứng từ đã duyệt."), { status: 409 });

  const orderId = doc.reference || doc.payload?.orderId;
  if (!orderId) throw Object.assign(new Error("Hồ sơ hóa đơn không liên kết với mã đơn hàng hợp lệ."), { status: 400 });

  const result = await autoIssueForOrder(pool, config, orderId, { fetcher });
  if (!result.success && !result.einvoice) {
    if (result.reason === "already_issued") {
      return { success: true, alreadyIssued: true, einvoice: result.einvoice };
    }
    throw Object.assign(new Error("Không thể phát hành hóa đơn MISA: " + (result.reason || "Lỗi xử lý")), { status: 409 });
  }

  return { success: true, einvoice: result.einvoice };
}

module.exports = {
  getMisaApiUrl,
  buildInvoicePayload,
  probeConnection,
  issueInvoice,
  autoIssueForOrder,
  issueInvoiceForDocument
};
