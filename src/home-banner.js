'use strict';
const {Router}=require('express');
const {z}=require('zod');
const sharp=require('sharp');
const {requirePermission}=require('./staff-access');
const {requireCsrf}=require('./security');
const {withTransaction}=require('./db');
const {appendAudit}=require('./audit');
const {readStoredImage}=require('./lib/stored-images');
const KEY='homepage_banner';
const defaults=()=>({version:0,enabled:false,desktopImageId:null,mobileImageId:null,alt:'',href:''});
const safeHref=value=>!value||(/^\/(?!\/)/.test(value)&&!/[\\\s\u0000-\u001f]/.test(value))||(/^https:\/\//i.test(value)&&!/[\s\u0000-\u001f]/.test(value)&&(()=>{try{return !new URL(value).username&&!new URL(value).password;}catch{return false;}})());
const schema=z.object({version:z.number().int().min(0),enabled:z.boolean(),desktopImageId:z.string().uuid().nullable(),mobileImageId:z.string().uuid().nullable(),alt:z.string().trim().max(240),href:z.string().trim().max(2048).refine(safeHref)}).strict().refine(v=>!v.enabled||!!v.desktopImageId&&!!v.alt);
async function readHomeBanner(pool){const row=(await pool.query('SELECT setting_value FROM store_settings WHERE setting_key=$1',[KEY])).rows[0];return {...defaults(),...row?.setting_value};}
async function imageInfo(pool,id){if(!id)return null;const row=(await pool.query('SELECT content,mime_type FROM marketing_banner_images WHERE id=$1',[id])).rows[0];if(!row)throw Object.assign(Error('Ảnh banner không tồn tại. Chọn và tải lại ảnh.'),{status:400});const buffer=await readStoredImage(row.content);const info=await sharp(buffer).metadata();return {width:info.width,height:info.height};}
function createHomeBanner(pool){
 const admin=Router(),publicApi=Router();
 admin.get('/marketing/home-banner',requirePermission('marketing.read'),async(_req,res,next)=>{try{res.set('Cache-Control','private, no-store').json(await readHomeBanner(pool));}catch(e){next(e);}});
 admin.put('/marketing/home-banner',requirePermission('marketing.write'),requireCsrf,async(req,res,next)=>{try{
  const data=schema.parse(req.body);
  const saved=await withTransaction(pool,async c=>{
   await c.query("SELECT pg_advisory_xact_lock(hashtext('gaeru:homepage-banner'))");
   const old=await readHomeBanner(c);if(old.version!==data.version)throw Object.assign(Error('Banner đã thay đổi. Tải lại trước khi lưu.'),{status:409});
   const desktop=await imageInfo(c,data.desktopImageId),mobile=await imageInfo(c,data.mobileImageId);
   const value={...data,desktop,mobile,version:data.version+1};
   await c.query('INSERT INTO store_settings(setting_key,setting_value) VALUES($1,$2) ON CONFLICT(setting_key) DO UPDATE SET setting_value=EXCLUDED.setting_value,updated_at=now()',[KEY,JSON.stringify(value)]);
   await appendAudit(c,{actor:req.admin,action:'marketing.home_banner.update',entityType:'settings',entityId:KEY,metadata:{enabled:value.enabled,version:value.version,desktopImageId:value.desktopImageId,mobileImageId:value.mobileImageId}});
   return value;
  });
  require('./cache').clearHtmlCacheOnly();res.json(saved);
 }catch(e){if(e.name==='ZodError')return res.status(400).json({error:'Chọn ảnh, nhập mô tả ảnh và đường dẫn nội bộ hoặc HTTPS hợp lệ.'});next(e);}});
 publicApi.get('/home-banner/images/:id',async(req,res,next)=>{try{
  if(!z.string().uuid().safeParse(req.params.id).success)return res.sendStatus(404);
  const setting=await readHomeBanner(pool);
  if(!setting.enabled||![setting.desktopImageId,setting.mobileImageId].includes(req.params.id))return res.sendStatus(404);
  const row=(await pool.query('SELECT content,mime_type FROM marketing_banner_images WHERE id=$1',[req.params.id])).rows[0];if(!row)return res.sendStatus(404);
  res.type(row.mime_type).set({'Cache-Control':'public, max-age=60, must-revalidate','X-Content-Type-Options':'nosniff'}).send(await readStoredImage(row.content));
 }catch(e){next(e);}});
 return {admin,publicApi};
}
function renderHomeBanner(setting){
 if(!setting.enabled||!setting.desktopImageId||!setting.alt||!safeHref(setting.href))return '';
 const esc=value=>String(value||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const url=id=>'/api/home-banner/images/'+encodeURIComponent(id)+'?v='+Number(setting.version);
 const size=info=>info?.width&&info?.height?' width="'+Number(info.width)+'" height="'+Number(info.height)+'"':'';
 const picture='<picture>'+(setting.mobileImageId?'<source media="(max-width: 734px)" srcset="'+url(setting.mobileImageId)+'"'+size(setting.mobile)+'>':'')+'<img src="'+url(setting.desktopImageId)+'" alt="'+esc(setting.alt)+'"'+size(setting.desktop)+' fetchpriority="high" decoding="async"></picture>';
 return '<section class="homepage-banner" aria-label="Thông tin nổi bật GAERU">'+(setting.href?'<a href="'+esc(setting.href)+'">'+picture+'</a>':picture)+'</section>';
}
async function applyHomeBanner(document,pool){const html=renderHomeBanner(await readHomeBanner(pool));if(!html)return;const anchor=document.querySelector('main > .announcement');if(anchor)anchor.insertAdjacentHTML('afterend',html);}
module.exports={KEY,schema,safeHref,readHomeBanner,renderHomeBanner,applyHomeBanner,createHomeBanner};
