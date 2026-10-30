const {z}=require('zod');
const {requireAdminAction}=require('./admin-action');
const guardCatalogWrite=requireAdminAction('catalog.write');
const {withTransaction}=require('./db');
const {CatalogService,catalogError}=require('./domain/catalog/catalog-service');
const uuid=z.string().uuid();
const version=z.number().int().positive();
function attachProductTrash(router,pool){
  const wrap=fn=>async(req,res,next)=>{try{if(!uuid.safeParse(req.params.id).success)throw catalogError('Không tìm thấy sản phẩm.',404);await fn(req,res);}catch(e){if(e instanceof z.ZodError)return res.status(400).json({error:'Kiểm tra xác nhận và phiên bản sản phẩm.'});if(e.code==='23503')return res.status(409).json({error:'Sản phẩm đã có chứng từ liên quan. Giữ trong khu vực đã xóa để bảo toàn lịch sử.'});if(e.status)return res.status(e.status).json({error:e.message});next(e);}};
  router.post('/gaeru_ceo/products/:id/restore',guardCatalogWrite,wrap(async(req,res)=>{
    const data=z.object({version,activate:z.boolean().default(false)}).strict().parse(req.body);
    await withTransaction(pool,async client=>{
      await CatalogService.restoreProduct(client,{
        productId:req.params.id,
        expectedVersion:data.version,
        activate:data.activate,
        actor:req.admin
      });
    });
    res.json({message:data.activate?'Đã khôi phục và kích hoạt sản phẩm.':'Đã khôi phục sản phẩm về bản nháp.'});
  }));
  router.delete('/gaeru_ceo/products/:id/permanent',guardCatalogWrite,wrap(async(req,res)=>{
    if(!['owner','admin'].includes(req.admin?.role))throw catalogError('Chỉ chủ doanh nghiệp hoặc quản trị viên được xóa vĩnh viễn.',403);
    const data=z.object({version,confirmation:z.string().min(1).max(120)}).strict().parse(req.body);
    await withTransaction(pool,async client=>{
      await CatalogService.purgeProduct(client,{
        productId:req.params.id,
        expectedVersion:data.version,
        confirmation:data.confirmation,
        actor:req.admin
      });
    });
    res.status(204).end();
  }));
}
module.exports={attachProductTrash};
