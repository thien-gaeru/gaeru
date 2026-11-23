const {randomUUID}=require('node:crypto');
const {withTransaction}=require('./db');
const {getRelevantWebKnowledge}=require('./chat-web-knowledge');

let activeWakeup=null;
const AI_CHAT_WORKER_IPC_KEY = Symbol.for('gaeru.aiChatWorker.ipcRegistered');
if (typeof process.on === 'function' && !process[AI_CHAT_WORKER_IPC_KEY]) {
  process[AI_CHAT_WORKER_IPC_KEY] = true;
  process.on('message', (msg) => {
    if (msg?.type === 'AI_CHAT_WORKER_KICK' && typeof activeWakeup === 'function') {
      setImmediate(activeWakeup);
    }
  });
}
function kickAIChatWorker(){
  if(typeof activeWakeup==='function') {
    setImmediate(activeWakeup);
    return;
  }
  if (typeof process.send === 'function') {
    try { process.send({ type: 'AI_CHAT_WORKER_KICK' }); } catch (_) {}
  }
}

function requestsHuman(text){
  const value=String(text).normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/đ/g,'d').toLowerCase();
  if(/(?:khong|dung|khoi|ngung|thoi)\s+(?:can|muon|chuyen|ket noi|noi chuyen|lam phien|gap).{0,20}(?:nhan vien|nguoi that|tu van vien)/.test(value))return false;
  return /(?:gap|chuyen|ket noi|noi chuyen|lien he|goi).{0,35}(?:nhan vien|nguoi that|tu van vien)|(?:human|live agent)|khong muon.{0,12}(?:ai|bot)/.test(value);
}
async function handoff(client,id,reason,answer){
  const row=(await client.query('SELECT handling_mode,status FROM shopping_chat_threads WHERE id=$1 FOR UPDATE',[id])).rows[0];
  if(!row||row.status!=='open'||row.handling_mode==='human')return false;
  await client.query("UPDATE shopping_chat_threads SET handling_mode='human',handoff_offered_at=NULL,handoff_started_at=now(),handoff_reason=$2,awaiting_admin=true,version=version+1,updated_at=now() WHERE id=$1",[id,reason]);
  const body=(answer?answer+'\n\n':'')+'Đã chuyển hội thoại cho nhân viên GAERU. Bạn có thể tiếp tục để lại thông tin tại đây.'; await client.query("INSERT INTO shopping_chat_messages(thread_id,sender,body,request_key) VALUES($1,'ai',$2,$3)",[id,body,randomUUID()]); try{require('./realtime-sse').publishChatEvent(id,'chat:message',{threadId:id,sender:'ai',body});}catch(_){}
  await client.query("INSERT INTO shopping_chat_email_outbox(thread_id,account_key,bucket,kind) SELECT $1,account_key,floor(extract(epoch FROM now())/300)::bigint,'handoff' FROM shopping_chat_email_preferences WHERE enabled=true ON CONFLICT DO NOTHING",[id]);
  try{require('./shopping-chat-email').nudgeChatEmailWorker?.();}catch(_){}
  return true;
}
async function offerHandoff(client,id,reason,answer){
  const row=(await client.query('SELECT handling_mode,status,handoff_offered_at FROM shopping_chat_threads WHERE id=$1 FOR UPDATE',[id])).rows[0];
  if(!row||row.status!=='open'||row.handling_mode==='human'||row.handoff_offered_at)return false;
  await client.query('UPDATE shopping_chat_threads SET handoff_offered_at=now(),handoff_reason=$2,awaiting_admin=false,version=version+1,updated_at=now() WHERE id=$1',[id,reason]);
  const body=answer||'AI chưa thể tiếp tục trả lời. Chọn Gặp nhân viên để được hỗ trợ.'; await client.query("INSERT INTO shopping_chat_messages(thread_id,sender,body,request_key) VALUES($1,'ai',$2,$3)",[id,body,randomUUID()]); try{require('./realtime-sse').publishChatEvent(id,'chat:message',{threadId:id,sender:'ai',body});}catch(_){} return true;
}
async function resumeAI(client,id,reason='staff_timeout'){
  const row=(await client.query('SELECT handling_mode,status,handoff_started_at FROM shopping_chat_threads WHERE id=$1 FOR UPDATE',[id])).rows[0];
  if(!row||row.status!=='open'||row.handling_mode!=='human')return false;
  const staffReplied=(await client.query("SELECT EXISTS(SELECT 1 FROM shopping_chat_messages WHERE thread_id=$1 AND sender='admin' AND created_at>=COALESCE($2::timestamptz,'epoch'::timestamptz)) AS replied",[id,row.handoff_started_at])).rows[0]?.replied;
  if(staffReplied)return false;
  await client.query("UPDATE shopping_chat_threads SET handling_mode='ai',handoff_offered_at=NULL,handoff_started_at=NULL,handoff_reason=$2,awaiting_admin=false,version=version+1,updated_at=now() WHERE id=$1",[id,reason]);
  const body='Sau 5 phút chưa có nhân viên phản hồi, trợ lý GAERU AI đã tự động kích hoạt lại để tiếp tục hỗ trợ bạn ngay lập tức. Bạn cũng có thể gọi 082.919.1080 nếu cần gặp trực tiếp.'; await client.query("INSERT INTO shopping_chat_messages(thread_id,sender,body,request_key) VALUES($1,'ai',$2,$3)",[id,body,randomUUID()]); try{require('./realtime-sse').publishChatEvent(id,'chat:message',{threadId:id,sender:'ai',body});}catch(_){}
  return true;
}
async function resumeTimedOutHumanThreads(pool){
  let count=0;
  await withTransaction(pool,async c=>{
    const rows=(await c.query(`
      SELECT t.id
      FROM shopping_chat_threads t
      WHERE t.status='open'
        AND t.handling_mode='human'
        AND t.handoff_started_at IS NOT NULL
        AND t.handoff_started_at <= now() - interval '300 seconds'
        AND NOT EXISTS (
          SELECT 1 FROM shopping_chat_messages m
          WHERE m.thread_id = t.id
            AND m.sender = 'admin'
            AND m.created_at >= t.handoff_started_at
        )
      FOR UPDATE SKIP LOCKED
      LIMIT 10
    `)).rows;
    for(const r of rows){
      if(await resumeAI(c,r.id,'staff_timeout'))count++;
    }
  });
  return count;
}
async function processAIChat(pool,config,{decisionFn,transport}={}){
  const job=await withTransaction(pool,async c=>{
    const stale=(await c.query("UPDATE shopping_chat_ai_jobs SET status='failed' WHERE status='running' AND started_at<now()-interval '45 seconds' RETURNING thread_id")).rows;
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
  let result,reason='outside_capability',loadedCatalog=[],loadedHistory=[];
  try{
    if(requestsHuman(job.question)){reason='customer_request';result={handoff:true,answer:''};}
    else{
      const [usageRes,catalog,historyRes]=await Promise.all([
        pool.query("SELECT count(*)::int AS total FROM shopping_chat_ai_jobs WHERE thread_id=$1 AND status IN ('done','running') AND created_at>now()-interval '1 hour'",[job.thread_id]),
        require('./store-api').loadProducts(pool),
        pool.query('SELECT sender,body FROM shopping_chat_messages WHERE thread_id=$1 ORDER BY id DESC LIMIT 10',[job.thread_id])
      ]);
      loadedCatalog=catalog;
      loadedHistory=historyRes.rows.reverse();
      const usage=usageRes.rows[0].total;
      if(usage>40){reason='ai_limit';result={handoff:true,answer:'AI đã đạt giới hạn xử lý của phiên này.'};}
      else{
        const facts=p=>({id:p.id,slug:p.slug,category:p.category,descriptor:p.descriptor,name:p.name,shopeeUrl:p.shopeeUrl||'',tiktokShopUrl:p.tiktokShopUrl||'',description:String(p.description||'').slice(0,job.thread.product_id?2400:480),variants:(p.variants||[]).slice(0,12).map(v=>({id:v.id,name:v.name,sku:v.sku,options:v.options||null,priceVnd:v.priceVnd,originalPriceVnd:v.originalPriceVnd,activePromotion:v.activePromotion||v.promotion||null,stockQuantity:v.stockQuantity,active:v.active!==false,available:Number(v.stockQuantity)>0}))});
        const selected=catalog.find(p=>p.id===job.thread.product_id);
        if(job.thread.product_id&&!selected)throw Error('Product unavailable');
        const webKnowledge=decisionFn
          ? await getRelevantWebKnowledge(pool,{question:job.question,selectedProduct:selected,transport})
          : null;
        const product=selected
          ?{...facts(selected),...(webKnowledge?{webKnowledge}:{}),contact:{email:'business@gaeru.com',phone:'082 919 1080'}}
          :{name:'Hỗ trợ GAERU',products:catalog.slice(0,20).map(facts),...(webKnowledge?{webKnowledge}:{}),contact:{email:'business@gaeru.com',phone:'082 919 1080'}};
        const history=loadedHistory;
        if(decisionFn){
          result=await decisionFn({config,product,question:{current:job.question,recentMessages:history},decision:true,...(transport?{transport}:{})});
        }else{
          result=await require('./gaeru-ai-customer').answerCustomerChat({pool,config,thread:job.thread,question:job.question,history,product});
        }
        if(typeof result?.handoff!=='boolean'||typeof result.answer!=='string'||(!result.handoff&&!result.answer.trim()))throw Error('Invalid AI decision');
      }
    }
  }catch{
    try{
      result=await require('./gaeru-ai-customer').generateGaeruAiResponse({pool,thread:job.thread,question:job.question,catalog:loadedCatalog,history:loadedHistory});
      reason='gaeru_ai_resolved';
    }catch(_){
      reason='ai_unavailable';result={handoff:true,answer:'AI hiện chưa thể trả lời chính xác câu hỏi này.'};
    }
  }
  let handedOffToHuman=false,publishedAiBody=null;
  await withTransaction(pool,async c=>{
    const row=(await c.query('SELECT status,handling_mode FROM shopping_chat_threads WHERE id=$1 FOR UPDATE',[job.thread_id])).rows[0];
    const latest=(await c.query('SELECT id FROM shopping_chat_messages WHERE thread_id=$1 ORDER BY id DESC LIMIT 1',[job.thread_id])).rows[0];
    if(row?.status!=='open'||row.handling_mode!=='ai'||String(latest?.id)!==String(job.message_id)){
      await c.query("UPDATE shopping_chat_ai_jobs SET status='skipped' WHERE id=$1",[job.id]);return;
    }
    if(result.handoff){if(reason==='customer_request')handedOffToHuman=await handoff(c,job.thread_id,reason,result.answer.slice(0,2400));else await offerHandoff(c,job.thread_id,reason,result.answer.slice(0,2400));}
    else{
      const aiBody=result.answer.slice(0,3000); await c.query("INSERT INTO shopping_chat_messages(thread_id,sender,body,request_key) VALUES($1,'ai',$2,$3)",[job.thread_id,aiBody,job.id]);
      await c.query('UPDATE shopping_chat_threads SET awaiting_admin=false,version=version+1,updated_at=now() WHERE id=$1',[job.thread_id]);
      publishedAiBody=aiBody;
    }
    await c.query("UPDATE shopping_chat_ai_jobs SET status='done' WHERE id=$1",[job.id]);
  });
  if(publishedAiBody){
    try{require('./realtime-sse').publishChatEvent(job.thread_id,'chat:message',{threadId:job.thread_id,sender:'ai',body:publishedAiBody});}catch(_){}
  }
  if(handedOffToHuman){
    try{
      require('./admin-notifications').notifyAdminPushBackground(pool,config,{
        requiredPermissions:['customers.read'],
        title:'💬 Chat mua sắm · Khách cần gặp nhân viên',
        body:`${job.thread?.product_name||'Hội thoại mua sắm'}: ${String(job.question||'').slice(0,120)}`,
        target:'shopping-chat',
        tag:'shopping-chat:'+job.thread_id
      });
    }catch(_){}
  }
  return true;
}
function startAIChatWorker(pool,config,{intervalMs}={}){
  const isTestEnv=process.env.NODE_ENV==='test'||Boolean(process.env.NODE_TEST_CONTEXT);
  const pollMs=Number.isFinite(Number(intervalMs))&&Number(intervalMs)>0?Number(intervalMs):(isTestEnv?3000:20000);
  const resumeCheckIntervalMs=isTestEnv?0:30000;
  let stopped=false,running=false,pendingKick=false,lastResumeCheckAt=0;
  async function run(kicked=false){
    if(stopped)return;
    if(running){pendingKick=true;return;}
    running=true;
    try{
      do{
        pendingKick=false;
        const now=Date.now();
        if(!kicked&&(resumeCheckIntervalMs===0||now-lastResumeCheckAt>=resumeCheckIntervalMs)){
          lastResumeCheckAt=now;
          await resumeTimedOutHumanThreads(pool).catch(()=>{});
        }
        kicked=false;
        for(let i=0;i<12&&!stopped;i++){
          if(!await processAIChat(pool,config))break;
        }
      }while(pendingKick&&!stopped);
    }catch{
      console.error('AI chat queue temporarily unavailable');
    }finally{
      running=false;
    }
  }
  activeWakeup=()=>void run(true);
  const timer=setInterval(()=>void run(false),pollMs);
  timer.unref?.();
  void run(false);
  return()=>{
    stopped=true;
    if(activeWakeup)activeWakeup=null;
    clearInterval(timer);
  };
}
module.exports={requestsHuman,handoff,offerHandoff,resumeAI,resumeTimedOutHumanThreads,processAIChat,startAIChatWorker,kickAIChatWorker};
