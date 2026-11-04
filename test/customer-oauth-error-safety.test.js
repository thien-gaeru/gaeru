'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),express=require('express'),{once}=require('node:events');
const {rateLimit}=require('express-rate-limit');
const {createCustomerOAuthRouter,verifyGisCsrf}=require('../src/customer-oauth');

test('Google callback exceptions return a fixed public message without reflecting internal HTML',async t=>{
 const message='<svg onload="globalThis.__oauthInjected=true"></svg>',query=async sql=>{if(sql.includes('FROM auth_identities'))throw Error(message);return {rows:[]};};
 const pool={query,connect:async()=>({query,release(){}})},config={GOOGLE_CLIENT_ID:'isolated-client'};
 const oauthClient={async verifyIdToken(){return {getPayload:()=>({iss:'https://accounts.google.com',aud:config.GOOGLE_CLIENT_ID,sub:'isolated-user',email:'fixture@example.invalid',email_verified:true,exp:Math.floor(Date.now()/1000)+3600})};}};
 const router=createCustomerOAuthRouter(pool,{config,oauthClient}),app=express();app.use(express.urlencoded({extended:false,limit:'32kb'}));app.post(['/auth/google','/account.html'],rateLimit({windowMs:60000,limit:10,standardHeaders:false,legacyHeaders:false}),router.handleRedirectCallback);
 const server=app.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>server.close(resolve)));
 const base='http://127.0.0.1:'+server.address().port,options={method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded',Cookie:'g_csrf_token=fixture'},body:new URLSearchParams({credential:'isolated-token',g_csrf_token:'fixture'}),redirect:'manual'};
 const publicMessage='Không thể xác thực Google. Vui lòng quay lại trang tài khoản và thử lại.';
 const plain=await fetch(base+'/auth/google',options);assert.equal(plain.status,401);assert.match(plain.headers.get('content-type'),/^text\/plain\b/);const body=await plain.text();assert.equal(body,publicMessage);assert.doesNotMatch(body,/<svg|onload|__oauthInjected/);
 const redirect=await fetch(base+'/account.html',options);assert.equal(redirect.status,302);const location=redirect.headers.get('location');assert.equal(new URL(location,base).searchParams.get('oauthError'),publicMessage);assert.doesNotMatch(decodeURIComponent(location),/<svg|onload|__oauthInjected/);assert.equal(location.includes('<'),false);
});

test('GIS CSRF comparison rejects malformed types and unequal byte lengths without reflecting an exception',()=>{
 const markup='<svg onload="alert(1)">';
 for(const [cookie,body]of [[[],markup],[markup,{}],[null,markup],[markup,null],[markup,markup+'x'],['é','a']])assert.equal(verifyGisCsrf(cookie,body),false);
 assert.equal(verifyGisCsrf(markup,markup),true);
});
