const { Router } = require('express');
const { rateLimit } = require('express-rate-limit');
const { z } = require('zod');
const { requirePermission } = require('./staff-access');
const { requireCsrf } = require('./security');

const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
const money = value => value == null ? 'Chưa chốt' : new Intl.NumberFormat('vi-VN').format(Number(value)) + ' ₫';
const labels = {pending:'Chờ xác nhận',confirmed:'Đã xác nhận',processing:'Đang xử lý',shipped:'Đang giao',completed:'Hoàn tất',cancelled:'Đã hủy',cod:'Thanh toán khi nhận hàng',bank_transfer:'Chuyển khoản',vnpay:'VNPAY',momo:'MoMo',zalopay:'ZaloPay'};
const printSchema = z.object({ids:z.array(z.string().uuid()).min(1).max(100).refine(ids => new Set(ids).size === ids.length),format:z.enum(['invoice','label'])}).strict();
function due(order) {
  if (order.paymentMethod !== 'cod' || order.paymentStatus === 'paid') return 0;
  return Math.max(0, Number(order.totalVnd || 0) - Number(order.receivedVnd || 0));
}
function labelFits(order) {
  const lineCount = value => String(value ?? '').split(/\r?\n/).reduce((sum,line)=>sum+Math.max(1,Math.ceil(line.length / 37)),0);
  return lineCount(order.customerName) + lineCount(order.phone) + lineCount(String(order.address || '') + ', ' + String(order.city || '')) <= 8;
}
function compactItem(item) {
  const text = String(item.productName || '') + ' · ' + String(item.variantName || '');
  return escape(text.length > 48 ? text.slice(0,45) + '…' : text) + ' × ' + escape(item.quantity);
}
const CODE128_PATTERNS = [
  '212222','222122','222221','121223','121322','131222','122213','122312','132212','221213','221312','231212',
  '112232','122132','122231','113222','123122','123221','223211','221132','221231','213212','223112','312131',
  '311222','321122','321221','312212','322112','322211','212123','212321','232121','111323','131123','131321',
  '112313','132113','132311','211313','231113','231311','112133','112331','132131','113123','113321','133121',
  '313121','211331','231131','213113','213311','213131','311123','311321','331121','312113','312311','332111',
  '314111','221411','431111','111224','111422','121124','121421','141122','141221','112214','112412','122114',
  '122411','142112','142211','241211','221114','413111','241112','134111','111242','121142','121241','114212',
  '124112','124211','411212','421112','421211','212141','214121','412121','111143','111341','131141','114113',
  '114311','411113','411311','113141','114131','311141','411131','211412','211214','211232','2331112'
];
function orderScanSvg(text) {
  const clean = String(text || '').trim().slice(0, 32);
  if (!clean) return '';
  let sum = 104;
  const codes = [104];
  for (let i = 0; i < clean.length; i++) {
    const code = clean.charCodeAt(i);
    const val = code >= 32 && code <= 126 ? code - 32 : 31;
    codes.push(val);
    sum += (i + 1) * val;
  }
  codes.push(sum % 103, 106);
  let x = 8;
  const rects = [];
  for (const c of codes) {
    const pat = CODE128_PATTERNS[c] || CODE128_PATTERNS[31];
    for (let j = 0; j < pat.length; j++) {
      const w = Number(pat[j]);
      if (j % 2 === 0) rects.push(`<rect x="${x}" y="0" width="${w}" height="28"/>`);
      x += w;
    }
  }
  const totalW = x + 8;
  return `<svg class="order-scan-code" viewBox="0 0 ${totalW} 28" preserveAspectRatio="none" role="img" aria-label="Mã đơn ${escape(clean)}" fill="#111">${rects.join('')}</svg>`;
}
function renderOrderPrint(orders, format) {
  const label = format === 'label';
  const pages = orders.map(order => {
    const items = Array.isArray(order.items) ? order.items : [];
    const contact = `<strong>${escape(order.customerName)}</strong><br>${escape(order.phone)}<br>${escape(order.address)}${order.city ? ', ' + escape(order.city) : ''}`;
    const scanSvg = orderScanSvg(order.orderNumber);
    if (label) return `<article class="sheet label"><header><strong>GAERU</strong><span>Tem giao hàng GAERU</span></header><div class="label-code-row"><h1>${escape(order.orderNumber)}</h1>${scanSvg}</div><p class="carrier">${order.carrierName ? 'Khách chọn: ' + escape(order.carrierName) : 'Hãng vận chuyển: chưa được chỉ định'}</p><section class="sender-box"><h2>NGƯỜI GỬI / HOÀN HÀNG</h2><p><strong>GAERU Việt Nam</strong> · gaeru.com · business@gaeru.com</p></section><section><h2>NGƯỜI NHẬN</h2><p class="recipient">${contact}</p></section><section><h2>HÀNG HÓA · ${items.reduce((sum,item)=>sum+Number(item.quantity||0),0)} SẢN PHẨM</h2><ul>${items.slice(0,2).map(item => `<li>${compactItem(item)}</li>`).join('')}</ul>${items.length > 2 ? `<p>Và ${items.length - 2} dòng hàng khác; xem phiếu đơn hàng.</p>` : ''}</section><div class="cod"><span>${order.paymentMethod === 'cod' ? 'CẦN THU COD' : 'KHÔNG THU COD'}</span><strong>${money(due(order))}</strong></div><footer>Hàng hóa rút gọn; đối chiếu phiếu đơn. Tem nội bộ GAERU. Không thay thế nhãn hoặc mã vận đơn do hãng vận chuyển cấp.</footer></article>`;
    return `<article class="sheet invoice"><header><strong>GAERU</strong><span>Phiếu đơn hàng</span></header><div class="label-code-row"><h1>${escape(order.orderNumber)}</h1>${scanSvg}</div><p>${escape(new Date(order.createdAt).toLocaleString('vi-VN',{timeZone:'Asia/Ho_Chi_Minh'}))} · ${escape(labels[order.status] || order.status)}</p><div class="contact"><section><h2>NGƯỜI GỬI</h2><p><strong>GAERU Việt Nam</strong><br>gaeru.com<br>business@gaeru.com</p></section><section><h2>NGƯỜI NHẬN</h2><p>${contact}</p><p>${escape(order.email)}</p></section><section><h2>GIAO HÀNG & THANH TOÁN</h2><p>${escape(order.carrierName || 'Chưa chỉ định hãng vận chuyển')}<br>${escape(labels[order.paymentMethod] || order.paymentMethod)}<br>${order.paymentStatus === 'paid' ? 'Đã thanh toán' : 'Chưa thanh toán đủ'}</p></section></div><table><thead><tr><th>Sản phẩm / phiên bản</th><th>SKU</th><th>SL</th><th>Thành tiền</th></tr></thead><tbody>${items.map(item => `<tr><td>${escape(item.productName)}<br><small>${escape(item.variantName)}</small></td><td>${escape(item.sku || '—')}</td><td>${escape(item.quantity)}</td><td>${money(item.lineTotalVnd)}</td></tr>`).join('')}</tbody></table><dl><div><dt>Tạm tính</dt><dd>${money(order.subtotalVnd)}</dd></div><div><dt>Giảm giá</dt><dd>${money(order.discountVnd || 0)}</dd></div><div><dt>Phí giao hàng</dt><dd>${money(order.shippingFeeVnd)}</dd></div><div><dt>Tổng cộng</dt><dd>${money(order.totalVnd)}</dd></div><div><dt>Thu COD khi giao</dt><dd>${money(due(order))}</dd></div></dl>${order.note ? `<section><h2>GHI CHÚ</h2><p>${escape(order.note)}</p></section>` : ''}<footer>Phiếu phục vụ xử lý đơn hàng; không phải hóa đơn tài chính.</footer></article>`;
  }).join('');
  return `<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow,noarchive"><link rel="icon" type="image/webp" href="/assets/brand/gaeru-logo.webp"><title>GAERU · ${label ? 'Tem giao hàng' : 'Phiếu đơn hàng'}</title><style>@page{size:${label ? '100mm 150mm' : 'A4'};margin:${label ? '0' : '12mm'}}*{box-sizing:border-box}body{margin:0;background:#eceff2;font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",sans-serif;color:#111}.print-toolbar{position:sticky;top:0;background:#fff;padding:14px;text-align:center;border-bottom:1px solid #d2d2d7;z-index:10}.print-toolbar button{padding:10px 24px;font:inherit;font-weight:600;border:0;border-radius:999px;background:#0071e3;color:#fff;cursor:pointer}.print-toolbar button:hover{background:#005bb5}.print-toolbar p{margin:8px 0 0;font-size:12px;color:#515154}.sheet{background:#fff;margin:16px auto;break-after:page;page-break-after:always;overflow-wrap:anywhere}.sheet:last-child{break-after:auto;page-break-after:auto}.invoice{width:186mm;padding:8mm}.label{width:100mm;min-height:150mm;padding:4.5mm;font-size:11px;display:flex;flex-direction:column}.sheet header{display:flex;justify-content:space-between;align-items:baseline;gap:12px;border-bottom:2px solid #111;padding-bottom:8px}.sheet header strong{font-size:22px}.label-code-row{display:flex;align-items:center;justify-content:space-between;gap:10px;margin:8px 0 4px}.order-scan-code{width:140px;height:28px;flex:0 0 auto}h1{font-size:${label ? '16px' : '24px'};margin:0}h2{font-size:11px;margin:12px 0 5px}p{line-height:1.45}.recipient{font-size:12px;line-height:1.35}.carrier{font-size:10px;color:#333}.sender-box{padding:4px 6px;border:1px solid #d2d2d7;border-radius:4px;background:#f8f9fa;margin-top:4px}.sender-box p{font-size:10px;margin:2px 0 0}.contact{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}table{border-collapse:collapse;width:100%;font-size:13px;margin-top:12px}th,td{padding:10px 7px;text-align:left;border-bottom:1px solid #ccc}th:last-child,td:last-child{text-align:right}tr{break-inside:avoid}thead{display:table-header-group}dl{margin:20px 0 20px auto;max-width:340px}dl div{display:flex;justify-content:space-between;gap:16px;padding:5px}dd{margin:0}ul{padding-left:16px;line-height:1.5}.cod{border:2px solid #111;padding:10px;margin:10px 0;display:flex;justify-content:space-between;gap:8px;align-items:center}.cod strong{font-size:20px}.sheet footer{border-top:1px solid #999;padding-top:8px;font-size:10px;line-height:1.35;margin-top:auto}.label header{padding-bottom:4px}.label header strong{font-size:18px}.label .label-code-row{margin:5px 0 3px}.label h1{font-size:15px;line-height:1.2}.label h2{font-size:9px;margin:5px 0 2px}.label p{margin:2px 0;line-height:1.25}.label .recipient{font-size:11.5px}.label ul{font-size:10px;margin:3px 0;padding-left:14px;line-height:1.3}.label .cod{padding:6px;margin:6px 0}.label .cod strong{font-size:16px}.label footer{font-size:8.5px;line-height:1.15;padding-top:4px;margin-top:auto}@media print{body{background:white}.print-toolbar{display:none}.sheet{margin:0}.invoice{padding:0;width:auto}.label{height:150mm;min-height:0}.sheet a{color:inherit;text-decoration:none}}</style><script src="/gaeru_ceo/assets/order-print.js" defer></script></head><body><div class="print-toolbar"><button type="button" data-print-orders>In ${orders.length} ${label ? 'tem giao hàng' : 'phiếu đơn hàng'}</button><p>Kiểm tra nội dung và chọn đúng khổ giấy trước khi in.</p></div>${pages}</body></html>`;
}
const CARRIER_LABEL_HOSTS = Object.freeze({
  viettel: ['viettelpost.vn', 'viettelpost.com.vn'],
  spx: ['spx.vn', 'shp.ee'],
  jt: ['jtexpress.vn']
});
const ALL_CARRIER_LABEL_HOSTS = Object.freeze(Object.values(CARRIER_LABEL_HOSTS).flat());

function isAllowedCarrierLabelUrl(rawUrl, carrierId) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl || ''));
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return false;
  const host = parsed.hostname.toLowerCase();
  const allowedDomains = CARRIER_LABEL_HOSTS[carrierId] || ALL_CARRIER_LABEL_HOSTS;
  return allowedDomains.some(domain => host === domain || host.endsWith('.' + domain));
}

function createOrderPrint(pool) {
  const router = Router();
  router.post('/orders/print',requirePermission('orders.read'),requireCsrf,rateLimit({windowMs:60000,limit:15,standardHeaders:'draft-8',legacyHeaders:false}),async(req,res,next)=>{
    try {
      const parsed=printSchema.safeParse(req.body);
      if(!parsed.success)return res.status(400).json({error:'Chọn từ 1 đến 100 đơn hàng khác nhau và loại bản in hợp lệ.'});
      const {ids,format}=parsed.data;
      const result=await pool.query(`SELECT o.id,o.order_number AS "orderNumber",o.customer_name AS "customerName",o.email,o.phone,o.address,o.city,o.note,o.status,o.payment_method AS "paymentMethod",o.payment_status AS "paymentStatus",o.created_at AS "createdAt",o.subtotal_vnd AS "subtotalVnd",o.discount_vnd AS "discountVnd",o.shipping_fee_vnd AS "shippingFeeVnd",o.total_vnd AS "totalVnd",s.carrier_name AS "carrierName",s.carrier_id AS "carrierId",COALESCE((SELECT SUM(r.amount_vnd) FROM sales_receipts r WHERE r.order_id=o.id),0)::bigint AS "receivedVnd",COALESCE((SELECT jsonb_agg(jsonb_build_object('productName',i.product_name,'variantName',i.variant_name,'sku',i.sku,'quantity',i.quantity,'lineTotalVnd',i.line_total_vnd) ORDER BY i.id) FROM order_items i WHERE i.order_id=o.id),'[]'::jsonb) AS items FROM orders o LEFT JOIN order_shipping_selection s ON s.order_id=o.id WHERE o.id=ANY($1::uuid[]) AND NOT EXISTS(SELECT 1 FROM order_reviews v WHERE v.order_id=o.id AND v.resolved_at IS NULL) ORDER BY array_position($1::uuid[],o.id)`,[ids]);
      if(result.rows.length!==ids.length)return res.status(409).json({error:'Có đơn không còn tồn tại hoặc đang chờ xác minh. Tải lại và kiểm tra danh sách trước khi in.'});
      if(format==='label'&&result.rows.some(order=>order.status==='cancelled'||order.totalVnd==null))return res.status(409).json({error:'Không thể in tem cho đơn đã hủy hoặc chưa chốt tổng tiền.'});
      if(format==='label'&&result.rows.some(order=>!labelFits(order)))return res.status(409).json({error:'Thông tin người nhận quá dài cho tem 100 × 150 mm. Kiểm tra địa chỉ hoặc in phiếu đơn hàng A4 để giữ đầy đủ thông tin.'});
      res.set({'Cache-Control':'no-store','Pragma':'no-cache','X-Robots-Tag':'noindex, nofollow, noarchive'}).type('html').send(renderOrderPrint(result.rows,format));
    }catch(error){next(error);}
  });
  router.get('/orders/:id/carrier-label',requirePermission('orders.read'),rateLimit({windowMs:60000,limit:30,standardHeaders:'draft-8',legacyHeaders:false}),async(req,res,next)=>{
    try {
      const orderId=z.string().uuid().parse(req.params.id);
      const result=await pool.query(
        `SELECT s.tracking_number, s.label_url, s.carrier_id, o.order_number
         FROM carrier_shipments s
         JOIN orders o ON o.id = s.order_id
         WHERE s.order_id = $1 AND s.status != 'cancelled'
         ORDER BY s.created_at DESC LIMIT 1`,
        [orderId]
      );
      if(!result.rows.length||!result.rows[0].label_url){
        return res.status(404).json({error:'Đơn hàng chưa có nhãn in từ hãng vận chuyển. Vui lòng tạo vận đơn trước.'});
      }
      const labelRow = result.rows[0];
      if (!isAllowedCarrierLabelUrl(labelRow.label_url, labelRow.carrier_id)) {
        return res.status(400).json({error:'URL nhãn vận chuyển không thuộc tên miền hãng vận chuyển hợp lệ.'});
      }
      res.redirect(labelRow.label_url);
    }catch(error){next(error);}
  });
  return router;
}
module.exports={createOrderPrint,renderOrderPrint,due,labelFits};
