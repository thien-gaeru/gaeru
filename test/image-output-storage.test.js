'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {storeMedia,readMedia}=require('../src/lib/stored-media');
test('persistent public image storage has room for larger lossless outputs without expanding upload input limits',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'gaeru-image-output-')),previous=process.env.MEDIA_ROOT;process.env.MEDIA_ROOT=root;
 t.after(async()=>{previous===undefined?delete process.env.MEDIA_ROOT:process.env.MEDIA_ROOT=previous;assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep));await fs.rm(root,{recursive:true,force:true});});
 const encoded=Buffer.alloc(8*1024*1024+1,23);
 for(const scope of ['products','news','banners']){
  const stored=await storeMedia(scope,encoded,'image/webp');assert.deepEqual(await readMedia(stored),encoded);
 }
 await assert.rejects(require('../src/lib/image-optimizer').optimizeImage(encoded,'image/png'),{status:400});
});
