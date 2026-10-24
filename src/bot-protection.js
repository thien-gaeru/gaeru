const {createHmac}=require('node:crypto');
const {ipKeyGenerator,rateLimit}=require('express-rate-limit');
function createBotProtection(pool,config,{fetchImpl=fetch}={}){
 const enabled=Boolean(config.TURNSTILE_SITE_KEY&&config.TURNSTILE_SECRET_KEY&&config.PUBLIC_BASE_URL);
 const limited=rateLimit({windowMs:900000,limit:300,standardHeaders:'draft-8',legacyHeaders:false,message:{error:'Quá nhiều yêu cầu. Vui lòng thử lại sau.'}});
 return function botProtection(req,res,next){
  if(!enabled||!req.path.startsWith('/api/')||!['POST','PUT','PATCH','DELETE'].includes(req.method)||req.path.startsWith('/api/payments/')||req.path==='/api/auth/activity')return next();
  return limited(req,res,()=>handle(req,res,next));
 };
 async function handle(req,res,next){
  const key=createHmac('sha256',config.SESSION_SECRET).update(ipKeyGenerator(req.ip||'unknown')).digest('hex');
  try{
   const row=(await pool.query('SELECT failures FROM bot_failures WHERE key=$1 AND expires_at>now()',[key])).rows[0];
   let verified=false;
   if((row?.failures||0)>=3){
    const token=req.get('x-bot-token');
    const challenge=()=>res.status(428).set('Cache-Control','no-store').json({code:'CAPTCHA_REQUIRED',siteKey:config.TURNSTILE_SITE_KEY,error:'Bạn đã nhập sai 3 lần. Vui lòng xác minh chống bot trước khi thử lại.'});
    if(!token||token.length>2048)return challenge();
    let result;
    try{const r=await fetchImpl('https://challenges.cloudflare.com/turnstile/v0/siteverify',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({secret:config.TURNSTILE_SECRET_KEY,response:token,remoteip:req.ip}),signal:AbortSignal.timeout(10000)});if(!r.ok)throw Error();result=await r.json();}catch{return res.status(503).json({error:'Chưa xác minh được chống bot. Vui lòng thử lại; thao tác chưa được thực hiện.'});}
    const age=Date.now()-Date.parse(result.challenge_ts);
    if(!result.success||result.hostname!==new URL(config.PUBLIC_BASE_URL).hostname||result.action!=='guarded_form'||!Number.isFinite(age)||age< -30000||age>300000)return challenge();
    verified=true;
   }
   const json=res.json.bind(res);let sent=false;
   res.json=function(body){if(sent)return res;sent=true;const status=res.statusCode;const ignored=/Vui lòng đăng nhập|không có quyền|Yêu cầu không hợp lệ. Hãy tải lại trang/i.test(String(body?.error||''));const failed=[400,401,403,422].includes(status)&&!ignored;
    (async()=>{if(failed)await pool.query("INSERT INTO bot_failures(key,failures,expires_at) VALUES($1,1,now()+interval '15 minutes') ON CONFLICT(key) DO UPDATE SET failures=CASE WHEN bot_failures.expires_at>now() THEN bot_failures.failures+1 ELSE 1 END,expires_at=now()+interval '15 minutes'",[key]);else if(verified&&status>=200&&status<300)await pool.query('DELETE FROM bot_failures WHERE key=$1',[key]);json(body);})().catch(()=>{res.status(503);json({error:'Chưa ghi nhận được kiểm tra bảo mật. Vui lòng thử lại.'});});return res;
   };
   next();
  }catch(e){next(e);}
 }
}
module.exports={createBotProtection};
