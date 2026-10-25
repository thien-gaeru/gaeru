'use strict';
const compression=require('compression');
function shouldCompress(req,res){
 // Mounted routers rewrite req.url/path; originalUrl preserves the privacy boundary.
 const route=req.originalUrl.split('?')[0].toLowerCase();
 if(/^\/api(?:\/|$)/.test(route)&&!/^\/api\/(?:products|news)(?:\/|$)/.test(route))return false;
 if(/^\/(?:gaeru_ceo|admin)(?:\/|$)/.test(route))return false;
 return compression.filter(req,res);
}
module.exports={publicCompression:()=>compression({threshold:1024,filter:shouldCompress}),shouldCompress};
