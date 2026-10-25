const {randomUUID}=require('node:crypto');
const {withTransaction}=require('./db');
function requestsHuman(text){
  const value=String(text).normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/đ/g,'d').toLowerCase();
  if(/khong (?:can|muon) (?:gap |noi chuyen voi )?nhan vien/.test(value))return false;
  return /(?:gap|chuyen|ket noi|noi chuyen|lien he|goi).{0,35}(?:nhan vien|nguoi that|tu van vien)|(?:human|live agent)|khong muon.{0,12}(?:ai|bot)/.test(value);
}
async function handoff(client,id,reason,answer){
  const row=(await client.query('SELECT handling_mode,status FROM shopping_chat_threads WHERE id=$1 FOR UPDATE',[id])).rows[0];
  if(!row||row.status!=='open'||row.handling_mode==='human')return false;
  await client.query("UPDATE shopping_chat_threads SET handling_mode='human',handoff_offered_at=NULL,handoff_started_at=now(),handoff_reason=$2,awaiting_admin=true,version=version+1,updated_at=now() WHERE id=$1",[id,reason]);
  await client.query("INSERT INTO shopping_chat_messages(thread_id,sender,body,request_key) VALUES($1,'ai',$2,$3)",[id,(answer?answer+'\n\n':'')+'Đã chuyển hội thoại cho nhân viên GAERU. Bạn có thể tiếp tục để lại thông tin tại đây.',randomUUID()]);
  await client.query("INSERT INTO shopping_chat_email_outbox(thread_id,account_key,bucket,kind) SELECT $1,account_key,floor(extract(epoch FROM now())/300)::bigint,'handoff' FROM shopping_chat_email_preferences WHERE enabled=true ON CONFLICT DO NOTHING",[id]);
  return true;
}
async function offerHandoff(client,id,reason,answer){
  const row=(await client.query('SELECT handling_mode,status,handoff_offered_at FROM shopping_chat_threads WHERE id=$1 FOR UPDATE',[id])).rows[0];
  if(!row||row.status!=='open'||row.handling_mode==='human'||row.handoff_offered_at)return false;
  await client.query('UPDATE shopping_chat_threads SET handoff_offered_at=now(),handoff_reason=$2,awaiting_admin=false,version=version+1,updated_at=now() WHERE id=$1',[id,reason]);
  await client.query("INSERT INTO shopping_chat_messages(thread_id,sender,body,request_key) VALUES($1,'ai',$2,$3)",[id,answer||'AI chưa thể tiếp tục trả lời. Chọn Gặp nhân viên để được hỗ trợ.',randomUUID()]);return true;
}
async function processAIChat(pool,config,{decisionFn,transport}={}){
  const job=await withTransaction(pool,async c=>{
    const stale=(await c.query("UPDATE shopping_chat_ai_jobs SET status='failed' WHERE status='running' AND started_at<now()-interval '2 minutes' RETURNING thread_id")).rows;
    for(const row of stale)await offerHandoff(c,row.thread_id,'ai_interrupted','AI hiện chưa thể tiếp tục trả lời. Chọn Gặp nhân viên để được hỗ trợ.');
    const row=(await c.query("SELECT * FROM shopping_chat_ai_jobs WHERE status='pending' ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1")).rows[0];
    if(!row)return null;
    const thread=(await c.query('SELECT * FROM shopping_chat_threads WHERE id=$1',[row.thread_id])).rows[0];
    const latest=(await c.query('SELECT id,body,sender FROM shopping_chat_messages WHERE thread_id=$1 ORDER BY id DESC LIMIT 1',[row.thread_id])).rows[0];
    if(!thread||thread.status!=='open'||thread.handling_mode!=='ai'||(thread.handoff_offered_at&&!requestsHuman(latest?.body))||String(latest?.id)!==String(row.message_id)){
      await c.query("UPDATE shopping_chat_ai_jobs SET status='skipped' WHERE id=$1",[row.id]);return {skipped:true};
    }
    await c.query("UPDATE shopping_chat_ai_jobs SET status='running',started_at=now() WHERE id=$1",[row.id]);
    return {...row,thread,question:latest.body};
  });
  if(!job)return false;if(job.skipped)return true;
  let result,reason='outside_capability';
  const settings=decisionFn?null:await require('./chat-ai-provider').getChatAIConfig(pool,config);
  try{
    if(requestsHuman(job.question)){reason='customer_request';result={handoff:true,answer:''};}
    else if(!decisionFn&&(!settings.enabled||!settings.apiKey)){reason='ai_unavailable';result={handoff:true,answer:'AI hiện chưa kết nối được.'};}
    else{
      const usage=(await pool.query("SELECT count(*)::int AS total FROM shopping_chat_ai_jobs WHERE thread_id=$1 AND status IN ('done','running') AND created_at>now()-interval '1 hour'",[job.thread_id])).rows[0].total;
      if(usage>40){reason='ai_limit';result={handoff:true,answer:'AI đã đạt giới hạn xử lý của phiên này.'};}
      else{
        const catalog=await require('./store-api').loadProducts(pool);
        const facts=p=>({name:p.name,description:p.description.slice(0,job.thread.product_id?10000:700),variants:p.variants.slice(0,12).map(v=>({name:v.name,priceVnd:v.priceVnd,available:Number(v.stockQuantity)>0}))});
        const selected=catalog.find(p=>p.id===job.thread.product_id);
        if(job.thread.product_id&&!selected)throw Error('Product unavailable');
        const product=selected?facts(selected):{name:'Hỗ trợ GAERU',products:catalog.slice(0,20).map(facts),contact:{email:'business@gaeru.com',phone:'082 919 1080'}};
        const history=(await pool.query('SELECT sender,body FROM shopping_chat_messages WHERE thread_id=$1 ORDER BY id DESC LIMIT 8',[job.thread_id])).rows.reverse();
        const run=decisionFn||require('./shopping-chat-extras').answerAI;
        result=await run({config:{...config,chatAI:settings},product,question:{current:job.question,recentMessages:history},decision:true,...(transport?{transport}:{})});
        if(typeof result?.handoff!=='boolean'||typeof result.answer!=='string'||(!result.handoff&&!result.answer.trim()))throw Error('Invalid AI decision');
      }
    }
  }catch{reason='ai_unavailable';result={handoff:true,answer:'AI hiện chưa thể trả lời chính xác câu hỏi này.'};}
  await withTransaction(pool,async c=>{
    const row=(await c.query('SELECT status,handling_mode FROM shopping_chat_threads WHERE id=$1 FOR UPDATE',[job.thread_id])).rows[0];
    const latest=(await c.query('SELECT id FROM shopping_chat_messages WHERE thread_id=$1 ORDER BY id DESC LIMIT 1',[job.thread_id])).rows[0];
    if(row?.status!=='open'||row.handling_mode!=='ai'||String(latest?.id)!==String(job.message_id)){
      await c.query("UPDATE shopping_chat_ai_jobs SET status='skipped' WHERE id=$1",[job.id]);return;
    }
    if(result.handoff){if(reason==='customer_request')await handoff(c,job.thread_id,reason,result.answer.slice(0,2400));else await offerHandoff(c,job.thread_id,reason,result.answer.slice(0,2400));}
    else{
      await c.query("INSERT INTO shopping_chat_messages(thread_id,sender,body,request_key) VALUES($1,'ai',$2,$3)",[job.thread_id,result.answer.slice(0,3000),job.id]);
      await c.query('UPDATE shopping_chat_threads SET awaiting_admin=false,version=version+1,updated_at=now() WHERE id=$1',[job.thread_id]);
    }
    await c.query("UPDATE shopping_chat_ai_jobs SET status='done' WHERE id=$1",[job.id]);
  });return true;
}
function startAIChatWorker(pool,config){let stopped=false,running=false;async function run(){if(stopped||running)return;running=true;try{for(let i=0;i<5&&!stopped;i++){if(!await processAIChat(pool,config))break;}}catch{console.error('AI chat queue temporarily unavailable');}finally{running=false;}}const timer=setInterval(run,2000);timer.unref?.();void run();return()=>{stopped=true;clearInterval(timer);};}
module.exports={requestsHuman,handoff,offerHandoff,processAIChat,startAIChatWorker};
