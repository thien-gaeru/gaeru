'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),sharp=require('sharp');
const {removeWhiteBackground}=require('../src/lib/product-background');
test('removes only edge-connected white and preserves enclosed white detail and dark foreground pixels',async()=>{
 const svg=Buffer.from('<svg width="100" height="100"><rect width="100" height="100" fill="white"/><rect x="20" y="20" width="60" height="60" fill="#123456"/><rect x="40" y="40" width="20" height="20" fill="white"/></svg>');
 const source=await sharp(svg).png().toBuffer(),output=await removeWhiteBackground(source);assert.ok(output);
 const {data,info}=await sharp(output).ensureAlpha().raw().toBuffer({resolveWithObject:true}),pixel=(x,y)=>[...data.subarray((y*info.width+x)*4,(y*info.width+x)*4+4)];
 assert.equal(pixel(0,0)[3],0);assert.deepEqual(pixel(30,30),[18,52,86,255]);assert.deepEqual(pixel(50,50),[255,255,255,255]);
});
test('keeps photographs, existing cutouts and all-white input unchanged',async()=>{
 for(const background of ['#224466','#ffffff']){const b=await sharp({create:{width:30,height:30,channels:3,background}}).png().toBuffer();assert.equal(await removeWhiteBackground(b),null);}
 const transparent=await sharp({create:{width:30,height:30,channels:4,background:{r:255,g:255,b:255,alpha:0}}}).png().toBuffer();assert.equal(await removeWhiteBackground(transparent),null);
});
test('cuts out large enclosed holes like clip openings while preserving small letters',async()=>{
 const svg=Buffer.from('<svg width="200" height="200"><rect width="200" height="200" fill="white"/><rect x="20" y="20" width="160" height="160" fill="#123456"/><rect x="40" y="40" width="15" height="15" fill="white"/><rect x="85" y="85" width="35" height="35" fill="white"/></svg>');
 const source=await sharp(svg).png().toBuffer();
 const output=await removeWhiteBackground(source,{minHoleArea:450});
 assert.ok(output);
 const {data,info}=await sharp(output).ensureAlpha().raw().toBuffer({resolveWithObject:true});
 const pixel=(x,y)=>[...data.subarray((y*info.width+x)*4,(y*info.width+x)*4+4)];
 assert.equal(pixel(0,0)[3],0,'border background is transparent');
 assert.deepEqual(pixel(30,30),[18,52,86,255],'foreground is intact');
 assert.deepEqual(pixel(45,45),[255,255,255,255],'small white letter (15x15=225px) is preserved');
 assert.equal(pixel(100,100)[3],0,'large enclosed hole (35x35=1225px) is cut out to transparent');
});
test('auto-trims excess padding and centers product into ecommerce standard square canvas',async()=>{
 const svg=Buffer.from('<svg width="1600" height="800"><rect width="1600" height="800" fill="white"/><rect x="400" y="200" width="800" height="400" fill="#123456"/></svg>');
 const source=await sharp(svg).png().toBuffer();
 const output=await removeWhiteBackground(source,{autoCenterSquare:true,canvasSize:1000,paddingRatio:0.08});
 assert.ok(output);
 const meta=await sharp(output).metadata();
 assert.equal(meta.width,1000);
 assert.equal(meta.height,1000);
 const {data,info}=await sharp(output).ensureAlpha().raw().toBuffer({resolveWithObject:true});
 const pixel=(x,y)=>[...data.subarray((y*info.width+x)*4,(y*info.width+x)*4+4)];
 assert.equal(pixel(20,20)[3],0);
 assert.deepEqual(pixel(500,500),[18,52,86,255]);
});
test('processProductImage generates mainBuffer with drop shadow and thumbBuffer (400x400)',async()=>{
 const svg=Buffer.from('<svg width="1600" height="800"><rect width="1600" height="800" fill="white"/><rect x="400" y="200" width="800" height="400" fill="#123456"/></svg>');
 const source=await sharp(svg).png().toBuffer();
 const {processProductImage}=require('../src/lib/product-background');
 const result=await processProductImage(source,{enableShadow:true,mainSize:1000,thumbSize:400});
 assert.ok(result.mainBuffer);
 assert.ok(result.thumbBuffer);
 const mainMeta=await sharp(result.mainBuffer).metadata();
 const thumbMeta=await sharp(result.thumbBuffer).metadata();
 assert.equal(mainMeta.width,1000);
 assert.equal(mainMeta.height,1000);
 assert.equal(thumbMeta.width,400);
 assert.equal(thumbMeta.height,400);
 const mainPixels=await sharp(result.mainBuffer).ensureAlpha().raw().toBuffer();
 const pixel=(x,y)=>[...mainPixels.subarray((y*1000+x)*4,(y*1000+x)*4+4)];
 assert.deepEqual(pixel(500,500),[18,52,86,255],'foreground intact');
 assert.ok(pixel(500,750)[3]>0,'shadow is visible below product');
});
