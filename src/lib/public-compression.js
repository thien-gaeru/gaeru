'use strict';
const compression=require('compression');
function shouldCompress(req,res){
 // Mounted routers rewrite req.url/path; originalUrl preserves the privacy boundary.
 const route=req.originalUrl.split('?')[0].toLowerCase();
 const adminStatic=/^\/gaeru_ceo\/assets\/[a-z0-9-]+\.(?:js|css)$/.test(route);
 const privateRoute=(/^\/api(?:\/|$)/.test(route)&&!/^\/api\/(?:products|news)(?:\/|$)/.test(route))||(/^\/(?:gaeru_ceo|admin)(?:\/|$)/.test(route)&&!adminStatic);
 if(privateRoute){const cache=String(res.getHeader('Cache-Control')||'private, no-store');if(!cache.includes('no-transform'))res.setHeader('Cache-Control',cache+', no-transform');return false;}
 return compression.filter(req,res);
}
module.exports={publicCompression:()=>compression({threshold:1024,filter:shouldCompress}),shouldCompress};
