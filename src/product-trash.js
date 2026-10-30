const {z}=require('zod');
const {requireAdminAction}=require('./admin-action');
const guardCatalogWrite=requireAdminAction('catalog.write');
const {withTransaction}=require('./db');
const {appendAudit}=require('./audit');
const fail=(message,status=409)=>Object.assign(Error(message),{status});
const uuid=z.string().uuid();
const version=z.number().int().positive();
function attachProductTrash(router,pool){
  const wrap=fn=>async(req,res,next)=>{try{if(!uuid.safeParse(req.params.id).success)throw fail('Không tìm thấy sản phẩm.',404);await fn(req,res);}catch(e){if(e instanceof z.ZodError)return res.status(400).json({error:'Kiểm tra xác nhận và phiên bản sản phẩm.'});if(e.code==='23503')return res.status(409).json({error:'Sản phẩm đã có chứng từ liên quan. Giữ trong khu vực đã xóa để bảo toàn lịch sử.'});if(e.status)return res.status(e.status).json({error:e.message});next(e);}};
  async function locked(client,id,expected){
    const product=(await client.query('SELECT id,name,slug,edit_version,deleted_variant_state FROM products WHERE id=$1 AND deleted_at IS NOT NULL FOR UPDATE',[id])).rows[0];
    if(!product)throw fail('Không tìm thấy sản phẩm trong khu vực đã xóa.',404);
    if(product.edit_version!==expected)throw fail('Sản phẩm vừa thay đổi. Tải lại trước khi thực hiện.');
    const variants=(await client.query('SELECT id,sku,active,stock_quantity FROM product_variants WHERE product_id=$1 ORDER BY id FOR UPDATE',[id])).rows;
    return {product,variants};
  }
  router.post('/gaeru_ceo/products/:id/restore',guardCatalogWrite,wrap(async(req,res)=>{
    const data=z.object({version,activate:z.boolean().default(false)}).strict().parse(req.body);
    await withTransaction(pool,async client=>{
      const {product,variants}=await locked(client,req.params.id,data.version);
      const states=new Map(product.deleted_variant_state.map(v=>[v.id,v.active===true]));
      const active=variants.filter(v=>states.has(v.id)?states.get(v.id):v.active);
      if(data.activate&&!active.length)throw fail('Chỉnh sửa và chọn ít nhất một biến thể đang bán trước khi kích hoạt.',400);
      for(const v of variants)await client.query('UPDATE product_variants SET active=$2,updated_at=now() WHERE id=$1',[v.id,states.has(v.id)?states.get(v.id):v.active]);
      await client.query("UPDATE products SET deleted_at=NULL,deleted_variant_state='[]'::jsonb,active=$2,updated_at=now() WHERE id=$1",[product.id,data.activate]);
      await appendAudit(client,{actor:req.admin,action:data.activate?'catalog.product.reactivate':'catalog.product.restore',entityType:'product',entityId:product.id,before:{deleted:true},after:{deleted:false,active:data.activate}});
    });
    res.json({message:data.activate?'Đã khôi phục và kích hoạt sản phẩm.':'Đã khôi phục sản phẩm về bản nháp.'});
  }));
  router.delete('/gaeru_ceo/products/:id/permanent',guardCatalogWrite,wrap(async(req,res)=>{
    if(!['owner','admin'].includes(req.admin?.role))throw fail('Chỉ chủ doanh nghiệp hoặc quản trị viên được xóa vĩnh viễn.',403);
    const data=z.object({version,confirmation:z.string().min(1).max(120)}).strict().parse(req.body);
    await withTransaction(pool,async client=>{
      const {product,variants}=await locked(client,req.params.id,data.version);
      if(data.confirmation!==product.slug)throw fail('Nhập đúng đường dẫn sản phẩm để xác nhận xóa vĩnh viễn.',400);
      const ids=variants.map(v=>v.id);
      if(variants.some(v=>v.stock_quantity>0)||(await client.query('SELECT 1 FROM warehouse_stock WHERE variant_id=ANY($1::uuid[]) AND quantity>0 LIMIT 1',[ids])).rows.length)throw fail('Sản phẩm còn tồn kho. Kiểm kê và xử lý tồn trước khi xóa vĩnh viễn.');
      // Historical records remain immutable. Never cascade away orders or stock documents.
      for(const table of ['order_items','inventory_movements','order_stock_allocations','purchase_order_items','goods_receipt_items']){
        if((await client.query(`SELECT 1 FROM ${table} WHERE variant_id=ANY($1::uuid[]) LIMIT 1`,[ids])).rows.length)throw fail('Sản phẩm đã có đơn hàng hoặc chứng từ kho. Giữ trong khu vực đã xóa để bảo toàn lịch sử.');
      }
      await appendAudit(client,{actor:req.admin,action:'catalog.product.purge',entityType:'product',entityId:product.id,before:{name:product.name,slug:product.slug,variants:variants.map(v=>({id:v.id,sku:v.sku}))},after:{permanentlyDeleted:true}});
      await client.query('DELETE FROM products WHERE id=$1',[product.id]);
    });
    res.status(204).end();
  }));
}
module.exports={attachProductTrash};
