const test=require('node:test'),assert=require('node:assert/strict'),{render,paragraphs}=require('../product-description');
test('description places images before and after chosen paragraphs with safe captions',()=>{const html=render({description:'First paragraph\n\nSecond <script> paragraph',descriptionMedia:[{type:'image',url:'/image.png',alt:'Cover',caption:'<b>Caption</b>',afterParagraph:0},{type:'image',url:'/middle.png',alt:'Middle',afterParagraph:1},{type:'video',url:'/video.mp4',alt:'Demo',afterParagraph:null}]});assert.ok(html.indexOf('/image.png')<html.indexOf('First paragraph'));assert.ok(html.indexOf('First paragraph')<html.indexOf('/middle.png'));assert.ok(html.indexOf('/middle.png')<html.indexOf('Second &lt;script&gt; paragraph'));assert.ok(html.indexOf('Second &lt;script&gt; paragraph')<html.indexOf('/video.mp4'));assert.ok(!html.includes('<script>'));assert.match(html,/&lt;b&gt;Caption/);assert.match(html,/<video controls playsinline/);});
test('older media with no paragraph stays at end and an edited shorter description keeps each image once',()=>{assert.deepEqual(paragraphs(' A\n\n B '),['A','B']);const html=render({description:'Only paragraph',descriptionMedia:[{type:'image',url:'/last.png',alt:'Last'},{type:'image',url:'/clamped.png',alt:'Clamped',afterParagraph:9}]});assert.ok(html.indexOf('Only paragraph')<html.indexOf('/last.png'));assert.equal(html.split('/clamped.png').length,2);});

test('bold product text renders without exposing HTML markup',()=>{const html=render({description:'**Clear sound** and **<script>bad</script>**',descriptionMedia:[]});assert.ok(html.includes('<strong>Clear sound</strong>'));assert.ok(html.includes('<strong>&lt;script&gt;bad&lt;/script&gt;</strong>'));assert.ok(!html.includes('<script>'));});

test('M3 story includes all supplied artwork and qualified battery and range data',()=>{
  const html=render({slug:'gaeru-m3',description:'Old description'});
  const files=[...html.matchAll(/src="(\/assets\/products\/m3-description\/\d+\.png)"/g)].map(m=>m[1]);
  assert.equal(files.length,11);assert.equal(new Set(files).size,11);
  for(const file of files)assert.ok(require('node:fs').existsSync(require('node:path').join(__dirname,'..',file)));
  assert.match(html,/3,5 giờ/);assert.match(html,/luân phiên hai bộ phát/);assert.match(html,/không có vật cản/);
  assert.ok(!html.includes('Old description'));
});
