'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs/promises'),crypto=require('node:crypto'),sharp=require('sharp');
const artwork=require('../product-art'),variants=require('../responsive-images.json');
test('P185 home uses content-addressed transparent artwork at every responsive size',async()=>{
 const url=artwork.image({slug:'gaeru-p185',imageUrl:'/api/catalog-images/old-white-background'});
 assert.match(url,/^\/assets\/products\/p185-cutout-[a-f0-9]{12}\.webp$/);
 for(const row of [{url},...variants[url]]){
  const bytes=await fs.readFile(path.join(__dirname,'..',row.url));
  const hash=crypto.createHash('sha256').update(bytes).digest('hex');assert.ok(row.url.endsWith(hash.slice(0,12)+'.webp'));
  const info=await sharp(bytes).metadata();assert.equal(info.hasAlpha,true);if(row.width)assert.equal(info.width,row.width);
  const {data}=await sharp(bytes).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  let clear=0,opaque=0;for(let i=3;i<data.length;i+=4){if(data[i]===0)clear++;if(data[i]>240)opaque++;}
  assert.ok(clear>info.width*info.height*.75,'background is genuinely transparent');assert.ok(opaque>info.width*info.height*.05,'product/text remain visible');
  assert.equal(data[3],0);assert.equal(data[data.length-1],0);
 }
 assert.match(artwork.attributes(url),/480w/);assert.match(artwork.attributes(url),/800w/);
});
test('server-rendered P185 panel advertises the same transparent responsive assets',()=>{
 const {parseHTML}=require('linkedom'),{document}=parseHTML('<html><body><section id="gaeru-m3"></section></body></html>');
 require('../src/brand-story').applyP185(document,[{slug:'gaeru-p185',name:'GAERU P185',imageUrl:'/api/catalog-images/old-white-background'}]);
 const img=document.querySelector('#home-gaeru-p185 img');assert.equal(img.getAttribute('src'),artwork.image({slug:'gaeru-p185'}));assert.match(img.getAttribute('srcset'),/p185-cutout-display-480/);assert.equal(img.getAttribute('decoding'),'async');
});
