
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

module.exports = {
  getMisaApiUrl,
  buildInvoicePayload,
  probeConnection,
  issueInvoice,
  autoIssueForOrder,
  issueInvoiceForDocument
};
