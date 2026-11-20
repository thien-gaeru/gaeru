const test=require('node:test'),assert=require('node:assert/strict'),{render,informationHeader}=require('../product-description');
test('both product stories open with their own section heading and editable chapter titles',()=>{
 const {productBody}=require('../src/seo-pages');
 const {parseHTML}=require('linkedom');
 for(const [slug,title] of [['gaeru-p01','Tự quay với GAERU P01'],['gaeru-g1-ultra','Thu âm hai người với GAERU G1 ULTRA']]){
   const product={slug,name:'GAERU',variants:[],description:'Chương đầu\nNội dung đã sửa'};
   const section=parseHTML(productBody(product)).document.querySelector('#product-information');
   assert.equal(section.querySelector('header').outerHTML,informationHeader(slug));
   assert.equal(section.querySelector('h2').textContent,title);
   assert.equal(section.querySelector('h3').textContent,'Chương đầu');
   assert.equal(section.querySelector('.product-story-copy .eyebrow'),null);
 }
 assert.equal(informationHeader('gaeru-k9'),'');
});
test('G1 and P01 stories interleave editable text and media and retain expandable specifications',()=>{for(const slug of ['gaeru-g1-ultra','gaeru-p01']){const html=render({slug,name:'Product',description:'First heading\nEditable copy\n\nSecond heading\nMore copy\n\nThông số và thông tin sản phẩm\nOriginal specs',descriptionMedia:[{type:'image',url:'/first.webp',alt:'First',afterParagraph:1},{type:'image',url:'/second.webp',alt:'Second',afterParagraph:2}]});assert.match(html,/product-editorial-story/);assert.ok(html.indexOf('Editable copy')<html.indexOf('/first.webp'));assert.ok(html.indexOf('/first.webp')<html.indexOf('Second heading'));assert.match(html,/<details class="product-story-specs">/);assert.match(html,/Original specs/);assert.equal(html.split('/second.webp').length,2);}});
test('Editorial headings, copy and image attributes escape stored markup',()=>{const html=render({slug:'gaeru-p01',name:'<script>bad</script>',description:'<img src=x>\n<script>bad()</script>',descriptionMedia:[{type:'image',url:'/photo.webp',alt:'" onerror="bad()',afterParagraph:1}]});assert.ok(!html.includes('<script>'));assert.ok(!html.includes('<img src=x>'));assert.match(html,/&quot; onerror=&quot;/);});
