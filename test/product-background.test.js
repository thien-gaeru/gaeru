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
