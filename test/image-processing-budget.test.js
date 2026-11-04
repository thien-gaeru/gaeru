'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');

// Hold actual encoding work open at the Sharp boundary so concurrency is
// observable without allocating several hundred MB inside the unit suite.
function fixture(){
 let working=0,maxWorking=0,started=0;
 const sharp=buffer=>{
  const size=buffer[0]===24?{width:5000,height:4800}:{width:4000,height:2000};
  const pipeline={metadata:async()=>({...size,format:'png',depth:'uchar'}),rotate(){return this;},toColourspace(){return this;},webp(){return this;},
   async toBuffer(){working++;started++;maxWorking=Math.max(maxWorking,working);try{await new Promise(resolve=>setTimeout(resolve,10));if(buffer[1]===1)throw Error('decode failed');return Buffer.from('encoded');}finally{working--;}}};
  return pipeline;
 };
 const module={exports:{}};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../src/lib/image-optimizer.js'),'utf8'),{module,Buffer,require:name=>{assert.equal(name,'sharp');return sharp;}});
 return {...module.exports,stats:()=>({maxWorking,started,working})};
}

test('two full-size images cannot decode simultaneously and a failed decode releases capacity',async()=>{
 const f=fixture();const output=await Promise.allSettled([f.optimizeImage(Buffer.from([24,1]),'image/png'),f.optimizeImage(Buffer.from([24,0]),'image/png')]);
 assert.equal(output[0].status,'rejected');assert.equal(output[1].status,'fulfilled');assert.equal(f.stats().maxWorking,1);assert.equal(f.stats().working,0);
 assert.equal((await f.optimizeImage(Buffer.from([24,0]),'image/png')).mimeType,'image/webp');assert.equal(f.stats().started,3);
});

test('smaller images retain parallel processing within the same decoded-pixel budget',async()=>{
 const f=fixture();await Promise.all([f.optimizeImage(Buffer.from([8,0]),'image/png'),f.optimizeImage(Buffer.from([8,0]),'image/png')]);
 assert.equal(f.stats().maxWorking,2);assert.equal(f.stats().working,0);
});
