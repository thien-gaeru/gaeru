'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {parseHTML}=require('linkedom');
const art=require('../product-art');
test('K9 artwork follows microphone count while preserving other product artwork',()=>{
 for(const count of [1,2])for(const connector of ['Type C','Lightning'])assert.deepEqual(art.variantImage({slug:'gaeru-k9',imageUrl:'/default.webp'},{name:'K9',options:{connector,'Lựa chọn':`Bộ ${count} Micro`}}),{url:'/assets/products/k9.webp',micCount:count});
 assert.equal(art.variantImage({slug:'k9'},{name:'K9 · 1 mic · Type C'}).micCount,1);
 assert.deepEqual(art.variantImage({slug:'gaeru-m3',imageUrl:'/default.webp'},{name:'Bộ 2 Micro',imageUrl:'/variant.webp'}),{url:'/variant.webp',micCount:null});
 assert.equal(art.variantImage({slug:'gaeru-k9',imageUrl:'/default.webp'},{name:'Type C'}).micCount,null);
});
test('opening a gallery image clears K9 crop and stale responsive sources',()=>{
 const {document}=parseHTML('<img src="/old.webp" srcset="/old-480.webp 480w" sizes="480px">'),img=document.querySelector('img');
 art.updateImage(img,'/assets/products/k9.webp',{micCount:1});assert.equal(img.dataset.k9MicCount,'1');
 art.updateImage(img,'/media/products/gallery.webp');assert.equal(img.dataset.k9MicCount,undefined);assert.equal(img.getAttribute('srcset'),null);assert.equal(img.getAttribute('sizes'),null);assert.equal(img.src,'/media/products/gallery.webp');
});
