const test=require('node:test'),assert=require('node:assert/strict'),express=require('express'),{once}=require('node:events'),{normalizePublicBase,normalizeBrandText,publicAliasRedirect}=require('../src/primary-domain');
test('gaeru.com is canonical, legacy brand domains normalize to https://gaeru.com, and remote origins always use https',()=>{
  const legacy='gaeru.'+'org';
  assert.equal(normalizePublicBase('http://www.gaeru.com'),'https://gaeru.com');
  assert.equal(normalizePublicBase('http://gaeru.com'),'https://gaeru.com');
  assert.equal(normalizePublicBase('https://gaeru.com'),'https://gaeru.com');
  assert.equal(normalizePublicBase('https://'+legacy),'https://gaeru.com');
  assert.equal(normalizePublicBase('http://www.'+legacy),'https://gaeru.com');
  assert.equal(normalizePublicBase('http://store.example'),'https://store.example');
  assert.equal(normalizePublicBase('https://store.example'),'https://store.example');
  assert.equal(normalizeBrandText(`Xem tại https://${legacy}/support.html hoặc liên hệ business@${legacy} trên ${legacy}.`),'Xem tại https://gaeru.com/support.html hoặc liên hệ business@gaeru.com trên gaeru.com.');
  assert.equal(require('../clean-urls').clean('https://www.gaeru.com/product.html?id=gaeru-k9','https://gaeru.com'),'/san-pham/gaeru-k9');
  assert.equal(require('../clean-urls').clean(`https://${legacy}/product.html?id=gaeru-k9`,'https://gaeru.com'),'/san-pham/gaeru-k9');
});
test('secondary domain redirects public reads, enforces HSTS, and upgrades plain HTTP requests on gaeru.com to HTTPS',async t=>{
  const app=express();
  app.use(publicAliasRedirect);
  app.use((req,res)=>res.send('ok'));
  const server=app.listen(0,'127.0.0.1');
  await once(server,'listening');
  t.after(()=>new Promise(r=>server.close(r)));
  const send=(path,method='GET',host='www.gaeru.com',extraHeaders={})=>new Promise((resolve,reject)=>{
    const req=require('node:http').request({hostname:'127.0.0.1',port:server.address().port,path,method,headers:{Host:host,...extraHeaders}},res=>{res.resume();res.on('end',()=>resolve(res))});
    req.on('error',reject);
    req.end();
  });
  let r=await send('/san-pham/gaeru-k9?utm_source=test');
  assert.equal(r.statusCode,301);
  assert.equal(r.headers.location,'https://gaeru.com/san-pham/gaeru-k9?utm_source=test');
  assert.ok(String(r.headers['strict-transport-security']).includes('max-age=31536000'));

  let httpGet=await send('/san-pham/gaeru-k9?x=1','GET','gaeru.com',{'X-Forwarded-Proto':'http'});
  assert.equal(httpGet.statusCode,301);
  assert.equal(httpGet.headers.location,'https://gaeru.com/san-pham/gaeru-k9?x=1');

  let httpPost=await send('/api/orders','POST','gaeru.com',{'X-Forwarded-Proto':'http'});
  assert.equal(httpPost.statusCode,308);
  assert.equal(httpPost.headers.location,'https://gaeru.com/api/orders');

  for(const [path,method]of [['/api/payments/vnpay/ipn','POST'],['/api/gaeru_ceo/orders','GET'],['/gaeru_ceo','GET']])assert.equal((await send(path,method)).statusCode,200);
  assert.equal((await send('/','GET','outside.invalid')).statusCode,200);
});
