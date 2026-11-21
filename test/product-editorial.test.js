const test=require('node:test'),assert=require('node:assert/strict'),{render,informationHeader}=require('../product-description');
test('both published products use the original G1 feature layout',()=>{
 const {productBody}=require('../src/seo-pages');
 const {parseHTML}=require('linkedom');
 const catalog=require('../content/product-stories.json');
 for(const item of catalog){
   const isP01=item.slug==='gaeru-p01';
   const product={...item,name:isP01?'GAERU P01':'GAERU G1 ULTRA',variants:[]};
   const section=parseHTML(productBody(product)).document.querySelector('#product-information');
   assert.equal(section.querySelector('header').outerHTML,informationHeader(item.slug));
   assert.equal(section.querySelector('h2').textContent,product.name+'. Chi tiết cho lựa chọn của bạn.');
   const story=section.querySelector('.product-feature-story');
   assert.equal(story.querySelector('h3').textContent,isP01?'Tự quay khi cả hai tay đang bận':'Thêm kết nối. Mở rộng cách kể.');
   assert.equal(story.querySelectorAll('.product-feature-highlights strong').length,3);
   assert.equal(story.querySelectorAll('.product-feature-chapter').length,5);
   assert.equal(story.querySelectorAll('#product-specs dt').length,isP01?6:5);
   assert.equal(story.querySelector('a.text-link').getAttribute('href'),'/huong-dan/'+item.slug);
   assert.equal(story.querySelector('details'),null);
   const imgs=[...story.querySelectorAll('figure img')];
   assert.equal(imgs.length,6);
   if(isP01){
     assert.deepEqual(imgs.map(img=>img.getAttribute('src')),item.descriptionMedia.map(m=>m.url));
     assert.deepEqual(imgs.map(img=>img.getAttribute('alt')),item.descriptionMedia.map(m=>m.alt));
   } else {
     const cables='/api/catalog-images/4f759b58-91af-4113-907d-ca10a6e57feb';
     assert.deepEqual(imgs.map(img=>img.getAttribute('src')),['/assets/products/g1-ultra-874bf1d3db77.webp',cables,...item.gallery.slice(1,5)]);
     assert.match(imgs[1].getAttribute('alt'),/dây.*3,5 mm/);
   }
 }
 assert.equal(informationHeader('gaeru-k9'),'');
});
test('G1 keeps the cable photo with the connection chapter when the gallery order changes',()=>{
 const {parseHTML}=require('linkedom');
 const item=require('../content/product-stories.json').find(row=>row.slug==='gaeru-g1-ultra');
 const cable=item.gallery.at(-1);
 const gallery=[cable+'?v=gallery',...item.gallery,'/assets/products/g1-ultra-clean.avif'];
 const story=parseHTML(render({...item,gallery})).document;
 const images=[...story.querySelectorAll('figure img')].map(img=>img.getAttribute('src').split('?')[0]);
 assert.equal(images[1],cable);
 assert.equal(new Set(images).size,6);
 assert.deepEqual(images.slice(2),item.gallery.slice(1,5));
});
test('each discovery page illustrates its features and preparation with three separate gallery photos',()=>{
 const fs=require('node:fs'),path=require('node:path'),{parseHTML}=require('linkedom');
 for(const item of require('../content/product-stories.json')){
   const file='discover-'+item.slug.slice(6)+'.html';
   const doc=parseHTML(fs.readFileSync(path.join(__dirname,'..',file),'utf8')).document;
   const photos=[...doc.querySelectorAll('#features img,.discover-split-art img')];
   const selected=item.slug==='gaeru-p01'?[4,6,5]:[3,6,7];
   assert.deepEqual(photos.map(img=>img.getAttribute('src')),selected.map(i=>item.gallery[i-1]));
   for(const img of photos){
     const source=img.getAttribute('src');
     assert.match(source,/^\/api\/catalog-images\//);
     assert.ok(img.getAttribute('srcset').split(',').every(entry=>entry.trim().startsWith(source)));
   }
 }
});
test('P01 feature chapters follow later edits to copy and photo captions',()=>{
 const {parseHTML}=require('linkedom');
 const item=require('../content/product-stories.json').find(row=>row.slug==='gaeru-p01');
 const description=item.description.replace('Giữ nguyên góc máy bằng một cử chỉ','Dừng xoay <theo yêu cầu>');
 const descriptionMedia=item.descriptionMedia.map((m,i)=>i===0?{...m,caption:'Ảnh <đã sửa>'}:m);
 const story=parseHTML(render({...item,description,descriptionMedia})).document;
 assert.equal(story.querySelectorAll('.product-feature-chapter h3')[1].textContent,'Dừng xoay <theo yêu cầu>');
 assert.equal(story.querySelector('figcaption').textContent,'Ảnh <đã sửa>');
});
test('G1 and P01 stories interleave editable text and media and retain expandable specifications',()=>{for(const slug of ['gaeru-g1-ultra','gaeru-p01']){const html=render({slug,name:'Product',description:'First heading\nEditable copy\n\nSecond heading\nMore copy\n\nThông số và thông tin sản phẩm\nOriginal specs',descriptionMedia:[{type:'image',url:'/first.webp',alt:'First',afterParagraph:1},{type:'image',url:'/second.webp',alt:'Second',afterParagraph:2}]});assert.match(html,/product-editorial-story/);assert.ok(html.indexOf('Editable copy')<html.indexOf('/first.webp'));assert.ok(html.indexOf('/first.webp')<html.indexOf('Second heading'));assert.match(html,/<details class="product-story-specs">/);assert.match(html,/Original specs/);assert.equal(html.split('/second.webp').length,2);}});
test('Editorial headings, copy and image attributes escape stored markup',()=>{const html=render({slug:'gaeru-p01',name:'<script>bad</script>',description:'<img src=x>\n<script>bad()</script>',descriptionMedia:[{type:'image',url:'/photo.webp',alt:'" onerror="bad()',afterParagraph:1}]});assert.ok(!html.includes('<script>'));assert.ok(!html.includes('<img src=x>'));assert.match(html,/&quot; onerror=&quot;/);});
