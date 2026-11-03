'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),express=require('express'),{once}=require('node:events'),{parseHTML}=require('linkedom');
const {generateCode128Svg,createBarcodeApi}=require('../src/barcode-api');

function assertSafeBarcode(svg,code){
 const root=parseHTML(svg).document.querySelector('svg');assert.ok(root);
 assert.equal(root.getAttribute('aria-label'),'Mã vạch '+code);
 assert.deepEqual([...root.attributes].map(attribute=>attribute.name).sort(),['aria-label','height','role','viewBox','width','xmlns'].sort());
 assert.equal(root.querySelector('text').textContent,code);
 assert.equal(root.querySelectorAll('script,foreignObject,image,a,[onload],[onfocus],[onclick]').length,0);
}

test('Code 128 treats quote-containing codes as literal accessible text instead of SVG attributes',()=>{
 for(const code of ['SKU" onload="globalThis.__barcodeInjected=true','SKU" autofocus="true" onfocus="globalThis.__barcodeInjected=true',`SKU' &<>"`,'SKU&quot; onload=&quot;alert(1)'])assertSafeBarcode(generateCode128Svg(code).svg,code);
});

test('barcode JSON and standalone SVG render endpoints preserve quoted codes without executable attributes',async t=>{
 const app=express();app.use((req,_res,next)=>{req.admin={username:'fixture',permissions:['inventory.read']};next();});app.use('/api/gaeru_ceo',createBarcodeApi({}).admin);
 const server=app.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>server.close(resolve)));
 const code='SKU" onload="globalThis.__barcodeInjected=true',url='http://127.0.0.1:'+server.address().port+'/api/gaeru_ceo/barcode/render?code='+encodeURIComponent(code);
 const json=await fetch(url);assert.equal(json.status,200);const result=await json.json();assert.equal(result.text,code);assertSafeBarcode(result.svg,code);
 const svg=await fetch(url,{headers:{Accept:'image/svg+xml'}});assert.equal(svg.status,200);assert.match(svg.headers.get('content-type'),/^image\/svg\+xml/);assertSafeBarcode(await svg.text(),code);
});
