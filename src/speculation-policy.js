'use strict';
const {createHash}=require('node:crypto');
// A fixed policy lets CSP allow this data block without allowing inline JavaScript.
const text=JSON.stringify({prerender:[{where:{and:[{href_matches:'/*'},{not:{href_matches:'/tai-khoan*'}},{not:{href_matches:'/gio-hang*'}},{not:{href_matches:'/thanh-toan*'}},{not:{href_matches:'/admin*'}},{not:{href_matches:'/gaeru_ceo*'}},{not:{href_matches:'/api/*'}}]},eagerness:'moderate'}]});
const cspHash="'sha256-"+createHash('sha256').update(text).digest('base64')+"'";
module.exports={text,cspHash};
