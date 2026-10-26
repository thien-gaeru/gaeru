const { Router } = require('express');
const { rateLimit } = require('express-rate-limit');
const { z } = require('zod');
const { requirePermission } = require('./staff-access');
const { requireCsrf } = require('./security');

const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
const money = value => value == null ? 'Chưa chốt' : new Intl.NumberFormat('vi-VN').format(Number(value)) + ' ₫';
const labels = {pending:'Chờ xác nhận',confirmed:'Đã xác nhận',processing:'Đang xử lý',shipped:'Đang giao',completed:'Hoàn tất',cancelled:'Đã hủy',cod:'Thanh toán khi nhận hàng',bank_transfer:'Chuyển khoản',vnpay:'VNPAY','9pay':'9Pay'};
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
function renderOrderPrint(orders, format) {
  const label = format === 'label';
  const pages = orders.map(order => {
    const items = Array.isArray(order.items) ? order.items : [];
    const contact = `<strong>${escape(order.customerName)}</strong><br>${escape(order.phone)}<br>${escape(order.address)}${order.city ? ', ' + escape(order.city) : ''}`;
    if (label) return `<article class="sheet label"><header><strong>GAERU</strong><span>Tem giao hàng GAERU</span></header><h1>${escape(order.orderNumber)}</h1><p class="carrier">${order.carrierName ? 'Khách chọn: ' + escape(order.carrierName) : 'Hãng vận chuyển: chưa được chỉ định'}</p><section><h2>NGƯỜI NHẬN</h2><p class="recipient">${contact}</p></section><section><h2>HÀNG HÓA · ${items.reduce((sum,item)=>sum+Number(item.quantity||0),0)} SẢN PHẨM</h2><ul>${items.slice(0,2).map(item => `<li>${compactItem(item)}</li>`).join('')}</ul>${items.length > 2 ? `<p>Và ${items.length - 2} dòng hàng khác; xem phiếu đơn hàng.</p>` : ''}</section><div class="cod"><span>${order.paymentMethod === 'cod' ? 'CẦN THU COD' : 'KHÔNG THU COD'}</span><strong>${money(due(order))}</strong></div><footer>Hàng hóa rút gọn; đối chiếu phiếu đơn. Tem nội bộ GAERU. Không thay thế nhãn hoặc mã vận đơn do hãng vận chuyển cấp.</footer></article>`;
    return `<article class="sheet invoice"><header><strong>GAERU</strong><span>Phiếu đơn hàng</span></header><h1>${escape(order.orderNumber)}</h1><p>${escape(new Date(order.createdAt).toLocaleString('vi-VN',{timeZone:'Asia/Ho_Chi_Minh'}))} · ${escape(labels[order.status] || order.status)}</p><div class="contact"><section><h2>NGƯỜI NHẬN</h2><p>${contact}</p><p>${escape(order.email)}</p></section><section><h2>GIAO HÀNG & THANH TOÁN</h2><p>${escape(order.carrierName || 'Chưa chỉ định hãng vận chuyển')}<br>${escape(labels[order.paymentMethod] || order.paymentMethod)}<br>${order.paymentStatus === 'paid' ? 'Đã thanh toán' : 'Chưa thanh toán đủ'}</p></section></div><table><thead><tr><th>Sản phẩm / phiên bản</th><th>SKU</th><th>SL</th><th>Thành tiền</th></tr></thead><tbody>${items.map(item => `<tr><td>${escape(item.productName)}<br><small>${escape(item.variantName)}</small></td><td>${escape(item.sku || '—')}</td><td>${escape(item.quantity)}</td><td>${money(item.lineTotalVnd)}</td></tr>`).join('')}</tbody></table><dl><div><dt>Tạm tính</dt><dd>${money(order.subtotalVnd)}</dd></div><div><dt>Giảm giá</dt><dd>${money(order.discountVnd || 0)}</dd></div><div><dt>Phí giao hàng</dt><dd>${money(order.shippingFeeVnd)}</dd></div><div><dt>Tổng cộng</dt><dd>${money(order.totalVnd)}</dd></div><div><dt>Thu COD khi giao</dt><dd>${money(due(order))}</dd></div></dl>${order.note ? `<section><h2>GHI CHÚ</h2><p>${escape(order.note)}</p></section>` : ''}<footer>Phiếu phục vụ xử lý đơn hàng; không phải hóa đơn tài chính.</footer></article>`;
  }).join('');
  return `<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow,noarchive"><title>GAERU · ${label ? 'Tem giao hàng' : 'Phiếu đơn hàng'}</title><style>@page{size:${label ? '100mm 150mm' : 'A4'};margin:${label ? '0' : '12mm'}}*{box-sizing:border-box}body{margin:0;background:#eceff2;font-family:Arial,sans-serif;color:#111}.print-toolbar{position:sticky;top:0;background:#fff;padding:14px;text-align:center;border-bottom:1px solid #ccc}.print-toolbar button{padding:10px 24px;font:inherit}.sheet{background:#fff;margin:16px auto;break-after:page;page-break-after:always;overflow-wrap:anywhere}.sheet:last-child{break-after:auto;page-break-after:auto}.invoice{width:186mm;padding:8mm}.label{width:100mm;min-height:150mm;padding:5mm;font-size:11px}.sheet header{display:flex;justify-content:space-between;gap:12px;border-bottom:2px solid #111;padding-bottom:8px}.sheet header strong{font-size:22px}h1{font-size:${label ? '16px' : '24px'};margin:12px 0}h2{font-size:11px;margin:14px 0 6px}p{line-height:1.5}.recipient{font-size:12px;line-height:1.35}.carrier{font-size:10px}.contact{display:grid;grid-template-columns:1fr 1fr;gap:20px}table{border-collapse:collapse;width:100%;font-size:13px}th,td{padding:10px 7px;text-align:left;border-bottom:1px solid #ccc}th:last-child,td:last-child{text-align:right}tr{break-inside:avoid}thead{display:table-header-group}dl{margin:20px 0 20px auto;max-width:340px}dl div{display:flex;justify-content:space-between;gap:16px;padding:5px}dd{margin:0}ul{padding-left:16px;line-height:1.5}.cod{border:2px solid #111;padding:10px;margin:12px 0;display:flex;justify-content:space-between;gap:8px;align-items:center}.cod strong{font-size:20px}.sheet footer{border-top:1px solid #999;padding-top:8px;font-size:10px;line-height:1.4;margin-top:14px}.label header{padding-bottom:4px}.label header strong{font-size:18px}.label h1{margin:4px 0;line-height:1.2}.label h2{font-size:9px;margin:6px 0 3px}.label p{margin:3px 0;line-height:1.2}.label .recipient{font-size:12px}.label ul{font-size:10px;margin:3px 0;padding-left:14px;line-height:1.3}.label .cod{padding:6px;margin:4px 0}.label .cod strong{font-size:16px}.label footer{font-size:9px;line-height:1.1;padding-top:3px;margin-top:5px}@media print{body{background:white}.print-toolbar{display:none}.sheet{margin:0}.invoice{padding:0;width:auto}.label{height:150mm;min-height:0}.sheet a{color:inherit;text-decoration:none}}</style><script src="/gaeru_ceo/assets/order-print.js" defer></script></head><body><div class="print-toolbar"><button type="button" data-print-orders>In ${orders.length} ${label ? 'tem giao hàng' : 'phiếu đơn hàng'}</button><p>Kiểm tra nội dung và chọn đúng khổ giấy trước khi in.</p></div>${pages}</body></html>`;
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
  return router;
}
module.exports={createOrderPrint,renderOrderPrint,due,labelFits};
