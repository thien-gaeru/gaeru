'use strict';
const PRIMARY='https://gaeru.com';
const LOCAL_HOSTS=new Set(['localhost','127.0.0.1','::1','[::1]']);
const BRAND_HOST=/^(?:www\.)?gaeru\.(?:com|o[r]g)$/i;
const LEGACY_BRAND_TEXT=/\b(https?:\/\/)?(?:www\.)?gaeru\.o[r]g(?!\.[a-z0-9-])(?![\w-])/gi;
function normalizeBrandText(value){
  if(typeof value!=='string'||!value)return value;
  return value.replace(LEGACY_BRAND_TEXT,(_m,scheme)=>scheme?'https://gaeru.com':'gaeru.com');
}
function normalizePublicBase(value){
  if(!value)return value;
  const u=new URL(value);
  if(BRAND_HOST.test(u.hostname)){
    u.protocol='https:';
    u.hostname='gaeru.com';
    u.port='';
    return u.origin;
  }
  if(!LOCAL_HOSTS.has(String(u.hostname||'').toLowerCase())&&u.protocol==='http:'){
    u.protocol='https:';
    return u.origin;
  }
  return value;
}
function publicAliasRedirect(req,res,next){
  res.set('Strict-Transport-Security','max-age=31536000; includeSubDomains; preload');
  const forwardedProto=String(req.headers?.['x-forwarded-proto']||'').split(',')[0].trim().toLowerCase();
  const isPrimaryHost=BRAND_HOST.test(req.hostname||'');
  const isInternalRoute=/^\/(?:api|gaeru_ceo)(?:\/|$)/.test(req.path);
  const isSafeRead=['GET','HEAD'].includes(req.method);
  if(forwardedProto==='http'&&isPrimaryHost){
    const rawTarget=isSafeRead&&!isInternalRoute?require('../clean-urls').clean(req.originalUrl,PRIMARY):(req.originalUrl||'/');
    const target=new URL(rawTarget,PRIMARY);
    if(target.host!=='gaeru.com'||target.protocol!=='https:'||target.username||target.password)return res.sendStatus(400);
    return res.redirect(isSafeRead?301:308,target.href);
  }
  if(!isSafeRead||req.hostname==='gaeru.com'||!isPrimaryHost||isInternalRoute)return next();
  const target=new URL(require('../clean-urls').clean(req.originalUrl,PRIMARY),PRIMARY);
  if(target.host!=='gaeru.com'||target.protocol!=='https:'||target.username||target.password)return res.sendStatus(400);
  return res.redirect(301,target.href);
}
module.exports={PRIMARY,normalizePublicBase,normalizeBrandText,publicAliasRedirect};
