'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),sharp=require('sharp');
const {optimizeImage}=require('../src/lib/image-optimizer');
const decode=buffer=>sharp(buffer).rotate().toColourspace('srgb').ensureAlpha().raw().toBuffer();

test('full-size lossless WebP preserves fine coloured detail and partial transparency pixel for pixel',async()=>{
 const width=2048,height=600,raw=Buffer.alloc(width*height*4);
 for(let y=0;y<height;y++)for(let x=0;x<width;x++){
  const i=(y*width+x)*4;raw[i]=(x*17+y*3)%256;raw[i+1]=(x*5+y*19)%256;raw[i+2]=(x^y)%256;raw[i+3]=(x+y)%255+1;
 }
 const source=await sharp(raw,{raw:{width,height,channels:4}}).png().toBuffer();
 const output=await optimizeImage(source,'image/png');
 const info=await sharp(output.buffer).metadata();assert.equal(info.width,width);assert.equal(info.height,height);
 assert.deepEqual(await decode(output.buffer),await decode(source));
});

test('JPEG conversion preserves the decoded sRGB raster after EXIF rotation',async()=>{
 const svg=Buffer.from('<svg width="1800" height="200"><defs><linearGradient id="g"><stop stop-color="#1234ab"/><stop offset="1" stop-color="#fecd24"/></linearGradient></defs><rect width="1800" height="200" fill="url(#g)"/><text x="20" y="100" font-size="54">GAERU: chi tiết ảnh 123456789</text></svg>');
 const source=await sharp(svg).jpeg({quality:97}).withMetadata({orientation:6}).toBuffer();
 const output=await optimizeImage(source,'image/jpeg');const info=await sharp(output.buffer).metadata();
 assert.equal(info.width,200);assert.equal(info.height,1800);assert.equal(info.exif,undefined);assert.equal(info.icc,undefined);
 assert.deepEqual(await decode(output.buffer),await decode(source));
});

test('large existing WebP keeps its exact bytes and truncated WebP is rejected',async()=>{
 const source=await sharp({create:{width:2100,height:1200,channels:3,background:'#123456'}}).webp({quality:90}).toBuffer();
 assert.deepEqual((await optimizeImage(source,'image/webp')).buffer,source);
 await assert.rejects(optimizeImage(source.subarray(0,Math.floor(source.length/2)),'image/webp'),{status:400});
});

test('an output ceiling rejects instead of silently reducing resolution or quality',async()=>{
 const source=await sharp({create:{width:32,height:32,channels:3,background:'#12ab34'}}).png().toBuffer();
 await assert.rejects(optimizeImage(source,'image/png',{maxOutputBytes:1}),e=>e.status===413&&e.code==='IMAGE_OUTPUT_TOO_LARGE');
 assert.equal((await optimizeImage(source,'image/png')).mimeType,'image/webp');
});

test('a lossless output may exceed the compressed input limit without losing image detail',async()=>{
 const width=512,height=256,raw=Buffer.alloc(width*height*3);let seed=239;
 for(let i=0;i<raw.length;i++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;raw[i]=seed>>>24;}
 const source=await sharp(raw,{raw:{width,height,channels:3}}).jpeg({quality:35}).toBuffer();
 const output=await optimizeImage(source,'image/jpeg',{maxUploadBytes:source.length});
 assert.ok(output.buffer.length>source.length);assert.deepEqual(await decode(output.buffer),await decode(source));
});

test('optional background removal keeps full dimensions and enclosed white product detail',async()=>{
 const source=await sharp(Buffer.from('<svg width="2000" height="1200"><rect width="2000" height="1200" fill="white"/><rect x="400" y="200" width="1200" height="800" fill="#123456"/><rect x="800" y="400" width="400" height="400" fill="white"/></svg>')).png().toBuffer();
 const output=await optimizeImage(source,'image/png',{removeBackground:true});assert.equal(output.backgroundRemoved,true);
 const {data,info}=await sharp(output.buffer).ensureAlpha().raw().toBuffer({resolveWithObject:true});
 assert.equal(info.width,2000);assert.equal(info.height,1200);
 const pixel=(x,y)=>[...data.subarray((y*info.width+x)*4,(y*info.width+x)*4+4)];
 assert.equal(pixel(0,0)[3],0);assert.deepEqual(pixel(600,300),[18,52,86,255]);assert.deepEqual(pixel(1000,600),[255,255,255,255]);
});

test('chat optimization has the same decoded pixel bound even with a large upload allowance',async()=>{
 const source=await sharp({create:{width:5000,height:5000,channels:3,background:'#123456'}}).png().toBuffer();
 await assert.rejects(optimizeImage(source,'image/png',{maxUploadBytes:Infinity}),{status:400});
});

test('higher-depth input is rejected clearly rather than quantized under a lossless label',async()=>{
 const source=await sharp({create:{width:20,height:20,channels:3,background:'#1289ab'}}).toColourspace('rgb16').png().toBuffer();
 assert.equal((await sharp(source).metadata()).depth,'ushort');
 await assert.rejects(optimizeImage(source,'image/png'),e=>e.status===400&&e.code==='IMAGE_BIT_DEPTH_UNSUPPORTED');
});

test('fully transparent pixels keep alpha while visible and partially transparent colours stay exact',async()=>{
 const raw=Buffer.from([128,70,200,0,128,70,200,128,128,70,200,255]);
 const source=await sharp(raw,{raw:{width:3,height:1,channels:4}}).png().toBuffer();
 const output=await optimizeImage(source,'image/png'),decoded=await decode(output.buffer);
 assert.equal(decoded[3],0);assert.deepEqual(decoded.subarray(4),raw.subarray(4));
 // Hidden RGB is deliberately not asserted: WebP may normalize it. The
 // upload-original integration test proves the source file is retained exactly.
});
