const test=require('node:test'),assert=require('node:assert/strict'),{parseHTML}=require('linkedom');
test('K9 description loops only the intro and uses a static single mic in chapters 1, 4 and 5',()=>{
 const html=require('../product-stories').render({slug:'gaeru-k9',name:'GAERU K9',description:'MIC CÀI ÁO GAERU K9',imageUrl:'/media/products/k9.webp',gallery:['/media/products/extra.webp']});
 const {document}=parseHTML(html),chapters=document.querySelectorAll('.product-feature-chapter');
 assert.equal(document.querySelectorAll('[data-k9-animate]').length,1);assert.ok(document.querySelector('.product-feature-intro img[data-k9-animate]'));
 for(const i of [0,3,4]){const svg=chapters[i].querySelector('.k9-story-single');assert.ok(svg);assert.equal(svg.querySelector('image').getAttribute('href'),'/assets/products/k9.webp');}
 assert.equal(document.querySelectorAll('.k9-story-single').length,3);assert.ok(chapters[2].querySelector('img'));
 assert.equal(require('../product-stories').render({slug:'gaeru-k9',description:'Owner edited description'}),null);
});
