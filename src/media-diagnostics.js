'use strict';
const {Router}=require('express'),{rateLimit}=require('express-rate-limit'),{requireCsrf}=require('./security');
function createMediaDiagnostics(){const router=Router();router.post('/owner/media-storage/probe',(req,res,next)=>req.admin?.role==='owner'&&req.admin?.source==='bootstrap'?next():res.status(403).json({error:'Chỉ chủ doanh nghiệp được kiểm tra lưu trữ.'}),requireCsrf,rateLimit({windowMs:60000,limit:6,standardHeaders:'draft-8',legacyHeaders:false}),async(req,res,next)=>{try{const result=await require('./lib/filesystem-media').probe();res.set('Cache-Control','no-store').json(result);}catch(e){next(e);}});return router;}
module.exports={createMediaDiagnostics};
