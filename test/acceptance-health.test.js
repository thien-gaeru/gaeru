const test=require('node:test');
const assert=require('node:assert/strict');
const session=require('express-session');
const {createApp}=require('../src/app');
test('public health reports the observed request transport, without claiming TLS is enforced',async()=>{
 const pool={query:async()=>({rows:[]})};
 const app=createApp({config:{NODE_ENV:'test',SESSION_SECRET:'acceptance-health-only-secret',ADMIN_USERNAME:'fixture',ADMIN_PASSWORD_HASH:'unused',PUBLIC_BASE_URL:'https://gaeru.com'},pool,sessionStore:new session.MemoryStore()});
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 try{
  const base='http://127.0.0.1:'+server.address().port;
  const plain=await fetch(base+'/api/health');assert.equal(plain.status,200);assert.equal(plain.headers.get('x-gaeru-web-tls'),'observed_http');
  const scriptPolicy=plain.headers.get('content-security-policy').split(';').find(d=>d.trim().startsWith('script-src '));assert.ok(scriptPolicy.includes(require('../src/speculation-policy').cspHash));assert.ok(!scriptPolicy.includes("'unsafe-inline'"));
  const forwarded=await fetch(base+'/api/health',{headers:{'X-Forwarded-Proto':'https'}});assert.equal(forwarded.headers.get('x-gaeru-web-tls'),'observed_https');
 }finally{await new Promise(r=>server.close(r));}
});
test('CSP authorizes the exact SSR and client speculation data, while excluding private routes',()=>{
 const {text,cspHash}=require('../src/speculation-policy'),{createHash}=require('node:crypto'),{parseHTML}=require('linkedom');
 const html=require('../src/clean-routes').enrich('<html><head><title>Test</title></head><body><main>Test</main></body></html>','/cua-hang','https://gaeru.com');
 const rendered=parseHTML(html).document.querySelector('script[type="speculationrules"]').textContent;
 assert.equal(rendered,text);assert.equal(cspHash,"'sha256-"+createHash('sha256').update(rendered).digest('base64')+"'");
 const source=require('node:fs').readFileSync(require('node:path').join(__dirname,'../store-shell.js'),'utf8'),start=source.indexOf('spec.textContent = JSON.stringify('),end=source.indexOf('document.head.appendChild(spec);',start);
 const fallback=require('node:vm').runInNewContext('const spec={};'+source.slice(start,end)+';spec.textContent');assert.equal(fallback,text);
 const rules=JSON.parse(text).prerender[0].where.and;for(const prefix of ['/tai-khoan*','/gio-hang*','/thanh-toan*','/gaeru_ceo*','/api/*'])assert.ok(rules.some(r=>r.not?.href_matches===prefix));
});
