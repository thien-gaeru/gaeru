const test=require('node:test'),assert=require('node:assert/strict'),{render,paragraphs}=require('../product-description');
test('description places images before and after chosen paragraphs with safe captions',()=>{const html=render({description:'First paragraph\n\nSecond <script> paragraph',descriptionMedia:[{type:'image',url:'/image.png',alt:'Cover',caption:'<b>Caption</b>',afterParagraph:0},{type:'image',url:'/middle.png',alt:'Middle',afterParagraph:1},{type:'video',url:'/video.mp4',alt:'Demo',afterParagraph:null}]});assert.ok(html.indexOf('/image.png')<html.indexOf('First paragraph'));assert.ok(html.indexOf('First paragraph')<html.indexOf('/middle.png'));assert.ok(html.indexOf('/middle.png')<html.indexOf('Second &lt;script&gt; paragraph'));assert.ok(html.indexOf('Second &lt;script&gt; paragraph')<html.indexOf('/video.mp4'));assert.ok(!html.includes('<script>'));assert.match(html,/&lt;b&gt;Caption/);assert.match(html,/<video controls playsinline/);});
test('older media with no paragraph stays at end and an edited shorter description keeps each image once',()=>{assert.deepEqual(paragraphs(' A\n\n B '),['A','B']);const html=render({description:'Only paragraph',descriptionMedia:[{type:'image',url:'/last.png',alt:'Last'},{type:'image',url:'/clamped.png',alt:'Clamped',afterParagraph:9}]});assert.ok(html.indexOf('Only paragraph')<html.indexOf('/last.png'));assert.equal(html.split('/clamped.png').length,2);});

test('bold product text renders without exposing HTML markup',()=>{const html=render({description:'**Clear sound** and **<script>bad</script>**',descriptionMedia:[]});assert.ok(html.includes('<strong>Clear sound</strong>'));assert.ok(html.includes('<strong>&lt;script&gt;bad&lt;/script&gt;</strong>'));assert.ok(!html.includes('<script>'));});

test('K9 story includes all 8 supplied infographics and qualified range and features',()=>{
  const html=render({slug:'gaeru-k9',...require('../k9-description').content()});
  const files=[...html.matchAll(/src="(\/assets\/products\/k9-description\/\d+\.webp)"/g)].map(m=>m[1]);
  assert.equal(files.length,8);assert.equal(new Set(files).size,8);
  for(const file of files)assert.ok(require('node:fs').existsSync(require('node:path').join(__dirname,'..',file)));
  assert.match(html,/Cắm là dùng/);assert.match(html,/20 mét/);assert.match(html,/360°/);assert.match(html,/id="product-specs"/);assert.match(html,/2,5/);
});

test('M3 story includes all supplied artwork and qualified battery and range data',()=>{
  const html=render({slug:'gaeru-m3',...require('../m3-description').content()});
  const files=[...html.matchAll(/src="(\/assets\/products\/m3-description\/\d+\.webp)"/g)].map(m=>m[1]);
  assert.equal(files.length,11);assert.equal(new Set(files).size,11);
  for(const file of files)assert.ok(require('node:fs').existsSync(require('node:path').join(__dirname,'..',file)));
  assert.match(html,/3,5 giờ/);assert.match(html,/luân phiên hai bộ phát/);assert.match(html,/không có vật cản/);
  assert.ok(!html.includes('Old description'));
});

test('M3 edits and explicit removal of media use editable description, not the curated fallback',()=>{
 const defaults=require('../m3-description').content();
 const changed=render({slug:'gaeru-m3',...defaults,description:'My edited text'});
 assert.match(changed,/My edited text/);assert.ok(!changed.includes('m3-story'));
 const removed=render({slug:'gaeru-m3',description:'My edited text',descriptionMedia:[]});
 assert.match(removed,/My edited text/);assert.ok(!removed.includes('m3-story'));
});

test('editable M3 artwork uses reviewed static paths and rejects traversal',()=>{
 const {schema}=require('../src/product-workspace');const urls=require('../m3-description').content().descriptionMedia;
 assert.equal(schema.shape.descriptionMedia.safeParse(urls).success,true);
 for(const ext of ['png','webp']) {
   assert.equal(schema.shape.gallery.safeParse(['/assets/products/m3-description/1.'+ext]).success,true);
   for(const url of ['/assets/products/m3-description/../secret.'+ext,'/assets/products/m3-description/5.'+ext,'https://other.test/a.'+ext])assert.equal(schema.shape.gallery.safeParse([url]).success,false);
 }
});

test('K9, P185 and G1 legacy descriptions become model-specific chapters while custom editor content remains editable',()=>{
 for(const [slug,description,expected]of [['gaeru-k9','MIC CÀI ÁO GAERU K9','Không cần'],['gaeru-p185','Gậy chụp ảnh P185 có remote bluetooth','Bluetooth'],['gaeru-g1-ultra','Ghi trọn câu chuyện.','kiểm âm']]){
  const product={slug,name:slug.toUpperCase(),description,imageUrl:'/assets/products/k9.webp',gallery:[],descriptionMedia:[]};
  const html=render(product);assert.match(html,/product-feature-story/);assert.match(html,/product-feature-specs/);assert.match(html,new RegExp('/huong-dan/'+slug));assert.ok(!html.includes('90%'));
  const custom=render({...product,description:'Bản mô tả mới của cửa hàng',descriptionMedia:[{type:'image',url:'/custom.webp',alt:'Ảnh riêng',afterParagraph:1}]});assert.match(custom,/Bản mô tả mới/);assert.match(custom,/custom.webp/);assert.ok(!custom.includes('product-feature-story'));
 }
});

test('Apple-style typography hierarchy and scannability elements exist in K9 and M3 stories', () => {
  const k9Html = require('../k9-description')();
  assert.ok(k9Html.includes('chapter-statement'), 'K9 should feature punchy statement leads');
  assert.ok(k9Html.includes('chapter-body-text'), 'K9 should have readable body copy');
  assert.ok(k9Html.includes('tech-highlight'), 'K9 should highlight core specs');

  const m3Html = require('../m3-description')();
  assert.ok(m3Html.includes('chapter-statement'), 'M3 should feature statement leads');
  assert.ok(m3Html.includes('chapter-body-text'), 'M3 should have readable body copy');
  assert.ok(m3Html.includes('tech-highlight'), 'M3 should highlight core specs');
});

test('k9-description.js is registered in public files, product.html and admin editor', () => {
  const publicFiles = require('../src/public-files');
  assert.ok(publicFiles.has('k9-description.js'), 'k9-description.js must be in publicFiles Set');

  const fsNode = require('node:fs');
  const pathNode = require('node:path');
  const prodHtml = fsNode.readFileSync(pathNode.join(__dirname, '../product.html'), 'utf8');
  assert.match(prodHtml, /k9-description\.js/);

  const editorHtml = fsNode.readFileSync(pathNode.join(__dirname, '../admin/product-editor.html'), 'utf8');
  assert.match(editorHtml, /k9-description\.js/);
});

test('M3 fallback story handles jsonb key reordering gracefully', () => {
  const defaults = require('../m3-description').content();
  const reorderedMedia = defaults.descriptionMedia.map(m => ({
    afterParagraph: m.afterParagraph,
    caption: m.caption,
    alt: m.alt,
    url: m.url,
    type: m.type
  }));
  const html = render({ slug: 'gaeru-m3', description: defaults.description, descriptionMedia: reorderedMedia });
  assert.match(html, /m3-story/);
});
