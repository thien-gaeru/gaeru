'use strict';
const fs=require('node:fs/promises');
async function operationalHealth(pool,config){
 const queues={};
 for(const table of ['order_email_outbox','order_admin_email_outbox','shopping_chat_email_outbox','care_email_outbox','warranty_email_outbox','marketing_email_recipients']){
  try{const rows=(await pool.query(`SELECT status,count(*)::int AS count FROM ${table} GROUP BY status`)).rows;queues[table]={status:'measured',counts:Object.fromEntries(rows.map(r=>[r.status,r.count]))};}
  catch{queues[table]={status:'unavailable',counts:{}};}
 }
 let storage={configured:Boolean(process.env.MEDIA_ROOT),status:'not_configured'};
 if(storage.configured)try{const root=require('./lib/filesystem-media').rootPath();await fs.access(root,fs.constants.R_OK|fs.constants.W_OK);storage.status='accessible';}catch{storage.status='unavailable';}
 const failed=Object.values(queues).reduce((n,q)=>n+(q.counts.failed||0)+(q.counts.unknown||0),0);
 return{storage,queues,queueStatus:failed?'attention':Object.values(queues).some(q=>q.status==='unavailable')?'unavailable':'measured',failedOrUnknown:failed,smtp:{status:config.smtp?'configured_unverified':'not_configured'},externalProviders:{status:'not_probed',note:'Chỉ xác minh qua thao tác Kiểm tra kết nối với tài khoản nhà cung cấp.'}};
}
module.exports={operationalHealth};
