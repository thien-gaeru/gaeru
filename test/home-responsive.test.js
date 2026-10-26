const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {parseHTML}=require('linkedom');const {createController}=require('../k9-loop');
test('K9 animation pauses offscreen, in background and for reduced motion',()=>{
 const {document,window}=parseHTML('<html><body><img data-k9-animate></body></html>');let callback,tick,clears=0;const motion={matches:false,addEventListener(n,fn){this.change=fn},removeEventListener(){}};
 window.matchMedia=()=>motion;window.IntersectionObserver=class{constructor(fn){callback=fn}observe(){}unobserve(){}disconnect(){}};window.setInterval=fn=>(tick=fn,1);window.clearInterval=()=>{clears++;tick=null};
 const controller=createController({window,document});controller.scan();const root=document.querySelector('[data-k9-loop]');assert.ok(root);assert.equal(tick,undefined);callback([{target:root,isIntersecting:true}]);tick();assert.equal(root.dataset.k9Frame,'single');root.querySelector('button').click();assert.equal(tick,null);root.querySelector('button').click();assert.equal(typeof tick,'function');motion.matches=true;motion.change();assert.equal(root.dataset.k9Frame,'double');assert.equal(tick,null);assert.ok(clears);controller.destroy();
});
test('guide artwork and menu match the approved products and labels',()=>{
 const guides=fs.readFileSync('guides.html','utf8');assert.match(guides,/m3-home-cutout.webp/);assert.match(guides,/\/assets\/products\/g1-ultra-[0-9a-f]{12}\.webp/);assert.match(guides,/data-k9-animate/);assert.doesNotMatch(guides,/assets\/products\/m3.webp/);
 const shell=fs.readFileSync('store-shell.js','utf8');assert.match(shell,/mobile-menu-link" href="account.html">Tài khoản/);assert.match(shell,/GAERU Care\+/);assert.match(fs.readFileSync('care.html','utf8'),/data-product-chat>Chat ngay/);
});

test('only the approved standalone G1 image is exposed by the fixed site media route',async t=>{
 const express=require('express'),{once}=require('node:events'),{createProductWorkspace}=require('../src/product-workspace');const approved='0779b270-eedf-4585-bc58-2275d25a06ac';
 const app=express();app.use('/api',createProductWorkspace({async query(sql,values){assert.equal(values[0],approved);return {rows:sql.includes('EXISTS')?[]:[{content:Buffer.from('approved-g1'),mime_type:'image/webp'}]};}}).publicApi);const server=app.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>server.close(resolve)));const base='http://127.0.0.1:'+server.address().port;
 const image=await fetch(base+'/api/site-media/g1-home',{redirect:'manual'});assert.equal(image.status,301);assert.match(image.headers.get('location'),/^\/assets\/products\/g1-ultra-[0-9a-f]{12}\.webp$/);assert.equal((await fetch(base+'/api/site-media/unknown')).status,404);assert.equal((await fetch(base+'/api/catalog-images/'+approved)).status,404);
});
