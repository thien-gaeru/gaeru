const {createHash}=require('node:crypto');
const {z}=require('zod');
const {appendAudit}=require('./audit');
const fail=(message,status=409)=>Object.assign(Error(message),{status});
const restorationSchema=z.object({version:z.number().int().positive(),requestKey:z.string().uuid(),reason:z.string().trim().min(5).max(1000),confirmedUnpaid:z.literal(true)}).strict();

async function restoreOrder(client,{id,data,actor,inventory=require('./inventory'),audit=appendAudit}){
 if(!actor?.permissions?.includes('orders.write'))throw fail('Tài khoản không có quyền khôi phục đơn.',403);
 const order=(await client.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE',[id])).rows[0];if(!order)throw fail('Không tìm thấy đơn hàng.',404);
 const hash=createHash('sha256').update(JSON.stringify({id,version:data.version,reason:data.reason,confirmedUnpaid:data.confirmedUnpaid})).digest('hex');
 const previous=(await client.query('SELECT * FROM order_restoration_requests WHERE request_key=$1',[data.requestKey])).rows[0];
 if(previous){if(previous.order_id!==id||previous.request_hash!==hash||previous.actor_username!==actor.username)throw fail('Mã yêu cầu khôi phục đã được sử dụng cho nội dung khác.');return {...previous.result,alreadyRestored:true};}
 if(order.management_version!==data.version)throw fail('Đơn hàng vừa thay đổi. Tải lại trước khi khôi phục.');
 if(order.status!=='cancelled')throw fail('Chỉ khôi phục đơn đang ở trạng thái đã hủy.');
 if(order.return_completed_at||(await client.query("SELECT id FROM order_after_sales WHERE order_id=$1 AND kind='return' AND (return_type IS NULL OR return_type<>'exchange') AND status='resolved'",[id])).rows.length)throw fail('Đơn đã hoàn trả xong; không thể khôi phục xử lý lại.');
 if((await client.query("SELECT id FROM cod_return_intakes WHERE order_id=$1 LIMIT 1",[id])).rows.length)throw fail('Đơn COD đã tiếp nhận chuyển hoàn kho; không thể khôi phục.');
 if((await client.query("SELECT id FROM order_after_sales WHERE order_id=$1 AND status NOT IN ('resolved','rejected')",[id])).rows.length)throw fail('Hoàn tất hồ sơ hủy/hoàn trả đang mở trước khi khôi phục đơn.');
 const received=Number((await client.query('SELECT COALESCE(sum(amount_vnd),0) AS amount FROM sales_receipts WHERE order_id=$1',[id])).rows[0]?.amount||0);
 if(order.payment_status!=='pending'||received>0||(await client.query("SELECT id FROM payment_attempts WHERE order_id=$1 AND status='paid'",[id])).rows.length)throw fail('Đơn đã ghi nhận tiền cần đối soát/hoàn tiền riêng trước; không khôi phục tự động.');
 if(!['cod','bank_transfer'].includes(order.payment_method))throw fail('Đơn cổng thanh toán cần tạo đơn và phiên thanh toán mới; không tái dùng phiên của đơn đã hủy.');
 if(order.customer_id&&!(await client.query('SELECT id FROM customers WHERE id=$1 AND active=true AND deleted_at IS NULL',[order.customer_id])).rows.length)throw fail('Tài khoản khách không còn hoạt động. Cần xác minh lại trước khi khôi phục.');
 if((await client.query('SELECT order_id FROM order_reviews WHERE order_id=$1 AND resolved_at IS NULL',[id])).rows.length)throw fail('Đối chiếu yêu cầu xác minh đơn trước khi khôi phục.');
 const raw=(await client.query('SELECT variant_id AS "variantId",sum(quantity)::int AS quantity FROM order_items WHERE order_id=$1 GROUP BY variant_id ORDER BY variant_id',[id])).rows;
 if(!raw.length||raw.some(i=>!i.variantId))throw fail('Sản phẩm của đơn không còn đầy đủ; không thể khôi phục.');
 for(const item of raw){const valid=(await client.query('SELECT v.id FROM product_variants v JOIN products p ON p.id=v.product_id WHERE v.id=$1 AND v.active=true AND p.active=true AND p.deleted_at IS NULL FOR UPDATE OF v',[item.variantId])).rows[0];if(!valid)throw fail('Một sản phẩm/phiên bản đã ngừng bán. Tạo đơn mới với sản phẩm hiện tại.');}
 const netLoyalty = order.customer_id
  ? (await client.query(
   `SELECT COALESCE(SUM(CASE WHEN type='redeem' THEN ABS(points) WHEN type='refund' AND points > 0 THEN -points ELSE 0 END),0)::int AS active_redeemed,
           COALESCE(MAX(CASE WHEN type='redeem' THEN ABS(points) ELSE 0 END),0)::int AS last_redeemed
    FROM customer_loyalty_ledger
    WHERE customer_id=$1 AND order_id=$2`,
   [order.customer_id,id]
  )).rows[0]
  : null;
 if(order.voucher_code){
  const redemption=(await client.query('SELECT * FROM voucher_redemptions WHERE order_id=$1 FOR UPDATE',[id])).rows[0];
  if(!redemption||!redemption.released)throw fail('Voucher của đơn chưa được giải phóng đúng trạng thái. Cần đối soát trước.');
  const selection=await require('./marketing').eligible(client,order.voucher_code,order.customer_id,order.subtotal_vnd,true);
  const recordedVoucherVnd=Math.max(0,Number(redemption.discount_vnd)||0);
  const recordedLoyaltyVnd=Math.max(0,Number(netLoyalty?.last_redeemed)||0);
  const recordedBundleVnd=Math.max(0,(Number(order.discount_vnd)||0)-recordedVoucherVnd-recordedLoyaltyVnd);
  const remainingSubtotalAfterBundle=Math.max(0,(Number(order.subtotal_vnd)||0)-recordedBundleVnd);
  const expectedVoucherDiscount=Math.min(Number(selection.discountVnd),remainingSubtotalAfterBundle);
  if(selection.voucher.id!==redemption.voucher_id||expectedVoucherDiscount!==recordedVoucherVnd)throw fail('Điều kiện hoặc mức giảm voucher đã thay đổi. Tạo đơn mới để xác nhận giá.');
  await client.query('UPDATE voucher_redemptions SET released=false WHERE order_id=$1',[id]);
 }
 if(order.customer_id){
  if(Number(netLoyalty?.last_redeemed)>0 && Number(netLoyalty?.active_redeemed)===0){
   const {redeemPoints}=require('./loyalty-api');
   await redeemPoints(client,{
    customerId:order.customer_id,
    orderId:id,
    pointsToRedeem:Number(netLoyalty.last_redeemed),
    orderTotalVnd:Number(order.subtotal_vnd)||0,
    maxRedeemRatio:0.5,
    cycleKey:'restore:'+data.requestKey,
    reason:'Khôi phục đơn hàng #'+order.order_number,
    actor
   });
  }
 }
 await inventory.restoreOrderStock(client,{orderId:id,items:raw,requestKey:data.requestKey,actor});
 if(order.payment_method==='bank_transfer'&&order.total_vnd!==null&&Number(order.total_vnd)>0){
  const totalVnd=Number(order.total_vnd);
  const existingPending=await client.query("UPDATE payment_attempts SET amount_vnd=$2,expires_at=GREATEST(expires_at,now()+interval '24 hours'),updated_at=now() WHERE order_id=$1 AND provider='bank_transfer' AND status='pending'",[id,totalVnd]);
  if(!existingPending.rowCount){
   const reopened=await client.query(`UPDATE payment_attempts SET status='pending',amount_vnd=$2,expires_at=GREATEST(expires_at,now()+interval '24 hours'),updated_at=now() WHERE id=(SELECT id FROM payment_attempts WHERE order_id=$1 AND provider='bank_transfer' AND status='failed' ORDER BY updated_at DESC,created_at DESC LIMIT 1)`,[id,totalVnd]);
   if(!reopened.rowCount){
    const txRef=`${order.order_number||id.slice(0,8)}-BT-${require('node:crypto').randomBytes(3).toString('hex').toUpperCase()}`;
    await client.query(`INSERT INTO payment_attempts(order_id,provider,transaction_ref,amount_vnd,status,expires_at) VALUES($1,'bank_transfer',$2,$3,'pending',now()+interval '24 hours')`,[id,txRef,totalVnd]);
   }
  }
 }
 const restored=(await client.query("UPDATE orders SET status='pending',updated_at=now() WHERE id=$1 RETURNING id,order_number AS \"orderNumber\",status,payment_status AS \"paymentStatus\",management_version AS version",[id])).rows[0];
 await audit(client,{actor,action:'order.restore',entityType:'order',entityId:id,before:{status:'cancelled',version:order.management_version},after:restored,metadata:{requestKey:data.requestKey,reason:data.reason,confirmedUnpaid:true}});
 await client.query('INSERT INTO order_restoration_requests(request_key,order_id,request_hash,result,actor_username) VALUES($1,$2,$3,$4,$5)',[data.requestKey,id,hash,JSON.stringify(restored),actor.username]);
 return restored;
}
module.exports={restoreOrder,restorationSchema};
