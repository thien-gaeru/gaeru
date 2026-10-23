const { safe } = require('./business-calculations');

// Latest posted purchase receipt up to the order date (Vietnam time).
// This is a reference purchase cost, not FIFO or perpetual weighted-average valuation.
async function snapshotStockCost(client, items, orderDate) {
  const result = await client.query(`
    SELECT v.id, v.sku, v.name AS "variantName", p.name AS "productName",
      receipt.id AS "receiptItemId", receipt.number AS "receiptNumber",
      receipt.unit_cost_vnd AS "unitCostVnd", receipt.created_at AS "receivedAt"
    FROM product_variants v JOIN products p ON p.id=v.product_id
    LEFT JOIN LATERAL (
      SELECT i.id,i.unit_cost_vnd,r.number,r.created_at
      FROM goods_receipt_items i JOIN goods_receipts r ON r.id=i.goods_receipt_id
      WHERE i.variant_id=v.id
        AND r.created_at < (($2::date + 1)::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh')
      ORDER BY r.created_at DESC,r.id DESC,i.id DESC LIMIT 1
    ) receipt ON true WHERE v.id=ANY($1::uuid[])`, [items.map(i=>i.variantId),orderDate]);
  const lines = items.map(item=>{
    const product=result.rows.find(row=>row.id===item.variantId);
    if(!product) throw Object.assign(Error('Sản phẩm liên kết không tồn tại.'),{status:400});
    const unitCostVnd=product.unitCostVnd===null?null:safe(BigInt(product.unitCostVnd));
    return {...item,...product,unitCostVnd,lineCostVnd:item.quantity===0?0:unitCostVnd===null?null:safe(BigInt(unitCostVnd)*BigInt(item.quantity))};
  });
  return {method:'latest_posted_receipt',asOf:orderDate,lines,
    cogsVnd:lines.some(i=>i.lineCostVnd===null)?null:safe(lines.reduce((sum,i)=>sum+BigInt(i.lineCostVnd),0n))};
}

module.exports={snapshotStockCost};
