'use strict';
const PRIMARY='https://gaeru.com';
function normalizePublicBase(value){if(!value)return value;const u=new URL(value);if(['gaeru.org','gaeru.com'].includes(u.hostname)){u.protocol='https:';u.hostname='gaeru.com';u.port='';return u.origin}return value}
function publicAliasRedirect(req,res,next){if(!['GET','HEAD'].includes(req.method)||req.hostname!=='gaeru.org'||/^\/(?:api|gaeru_ceo)(?:\/|$)/.test(req.path))return next();return res.redirect(301,PRIMARY+req.originalUrl)}
module.exports={PRIMARY,normalizePublicBase,publicAliasRedirect};
