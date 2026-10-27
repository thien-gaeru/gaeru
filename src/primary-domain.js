'use strict';
const PRIMARY='https://gaeru.com';
function normalizePublicBase(value){if(!value)return value;const u=new URL(value);if(['gaeru.com','www.gaeru.com'].includes(u.hostname)){u.protocol='https:';u.hostname='gaeru.com';u.port='';return u.origin}return value}
function publicAliasRedirect(req,res,next){if(!['GET','HEAD'].includes(req.method)||req.hostname!=='www.gaeru.com'||/^\/(?:api|gaeru_ceo)(?:\/|$)/.test(req.path))return next();const target=new URL(require('../clean-urls').clean(req.originalUrl,PRIMARY),PRIMARY);if(target.host!=='gaeru.com'||target.protocol!=='https:'||target.username||target.password)return res.sendStatus(400);return res.redirect(301,target.href)}
module.exports={PRIMARY,normalizePublicBase,publicAliasRedirect};
