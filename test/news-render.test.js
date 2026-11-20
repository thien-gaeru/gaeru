const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const script=fs.readFileSync(path.join(__dirname,'../news.js'),'utf8');
const guideScript=fs.readFileSync(path.join(__dirname,'../news-guide.js'),'utf8');
test('news article escapes stored text instead of executing HTML',async()=>{
 const article={innerHTML:'',textContent:''},description={};const post={title:'<img src=x onerror=alert(1)>',excerpt:'<script>bad()</script>',body:'<script>alert(1)</script>\n\nSecond paragraph',imageUrl:'/api/news-images/fixture',imageAlt:'" onload="bad()',publishedAt:'2026-10-23T08:00:00Z'};
 vm.runInNewContext(script,{document:{title:'',querySelector:s=>s==='[data-news-article]'?article:s==='meta[name=description]'?description:null},URLSearchParams,location:{search:'?slug=test'},fetch:async()=>({ok:true,json:async()=>({post})})});
 await new Promise(r=>setImmediate(r));assert.ok(article.innerHTML.includes('&lt;script&gt;'));assert.ok(!article.innerHTML.includes('<script>'));assert.ok(article.innerHTML.includes('&quot; onload=&quot;'));assert.ok(article.innerHTML.includes('<p>Second paragraph</p>'));
});
test('home news strip renders published images and supports horizontal controls',async()=>{
 const strip={innerHTML:'',clientWidth:500,insertAdjacentHTML(_,html){this.innerHTML+=html;},scrollBy(value){this.scrolled=value;}},status={},buttons=[-1,1].map(value=>({dataset:{newsScroll:String(value)},addEventListener(_,fn){this.click=fn;}}));
 const posts=[{slug:'news-one',title:'First post',excerpt:'Latest news',imageUrl:'/api/news-images/image-one',imageAlt:'Cover image',publishedAt:'2026-10-23T08:00:00Z'}];
 vm.runInNewContext(script,{document:{querySelector:s=>s==='[data-news-strip]'?strip:s==='[data-news-status]'?status:null,querySelectorAll:()=>buttons},fetch:async()=>({ok:true,json:async()=>({posts})}),matchMedia:()=>({matches:true})});
 await new Promise(r=>setImmediate(r));assert.match(strip.innerHTML,/news-article.html\?slug=news-one/);assert.match(strip.innerHTML,/Cover image/);buttons[1].click();assert.equal(strip.scrolled.left,425);assert.equal(strip.scrolled.behavior,'auto');
});
test('article sources are clickable HTTPS links while untrusted markup remains text',async()=>{
 const article={innerHTML:'',textContent:''};const post={title:'Source test',excerpt:'Safe sources',body:'Source https://www.bluetooth.com/media/le-audio/le-audio-faqs/\n<script>bad()</script> javascript:alert(1)',imageUrl:'/cover',imageAlt:'Cover',publishedAt:'2026-10-25T00:00:00Z'};
 vm.runInNewContext(script,{document:{querySelector:s=>s==='[data-news-article]'?article:s==='meta[name=description]'?{}:null},URLSearchParams,location:{search:'?slug=test'},fetch:async()=>({ok:true,json:async()=>({post})})});await new Promise(r=>setImmediate(r));assert.match(article.innerHTML,/<a href="https:\/\/www.bluetooth.com\/media\/le-audio\/le-audio-faqs\/" target="_blank" rel="noopener noreferrer">/);assert.doesNotMatch(article.innerHTML,/<script>|href="javascript:/);
});

test('edited guides render matching, accessible sections on the server and browser',async()=>{
 const {articleBody}=require('../src/seo-pages'),{parseHTML}=require('linkedom');
 const slug='so-sanh-chi-tiet-micro-gaeru-k9-va-gaeru-m3';
 const post={slug,title:'So sánh hai bộ micro',excerpt:'Chọn bộ micro theo cách thu.',
   coverId:'00000000-0000-4000-8000-000000000099',imageAlt:'Hai bộ micro',publishedAt:'2026-11-17T15:15:29Z',
   body:'## Chọn theo nhu cầu\nGhi lại **một câu**.\n\n- Thu riêng\n- Nghe lại\n\n## Đối chiếu\n\n| Tiêu chí | Bộ A | Bộ B |\n| --- | --- | --- |\n| Nguồn | USB | Pin |\n\n1. [Xem sản phẩm](/san-pham/gaeru-k9)\n2. Đọc [nguồn](https://gaeru.com/care)\n\nChữ <em>được giữ nguyên</em>.'};
 post.imageUrl='/api/news-images/'+post.coverId;
 post.updatedAt='2026-11-20T10:00:00Z';
 const browser={innerHTML:''}, context=vm.createContext({document:{querySelector:s=>s==='[data-news-article]'?browser:s==='meta[name=description]'?{}:null},
   URLSearchParams,URL,location:{search:'?slug='+slug},fetch:async()=>({ok:true,json:async()=>({post})})});
 vm.runInContext(guideScript,context);vm.runInContext(script,context);
 await new Promise(resolve=>setImmediate(resolve));
 for(const html of [articleBody(post),browser.innerHTML]){
   const {document}=parseHTML('<html><body>'+html+'</body></html>');
   assert.equal(document.querySelector('h1').textContent,post.title);
   assert.equal(document.querySelector('time').getAttribute('datetime'),'2026-11-17T15:15:29.000Z');
   assert.equal(document.querySelector('time:nth-of-type(2)').textContent,'Cập nhật 20/11/2026');
   assert.equal(document.querySelector('.news-cover').getAttribute('alt'),post.imageAlt);
   assert.equal(document.querySelector('figure.guide-art figcaption').textContent,'Ảnh sản phẩm của GAERU.');
   assert.deepEqual([...document.querySelectorAll('.guide-contents a')].map(a=>a.getAttribute('href')),['/tin-tuc/'+slug+'#muc-1','/tin-tuc/'+slug+'#muc-2']);
   assert.deepEqual([...document.querySelectorAll('.guide-copy h2')].map(h=>h.id),['muc-1','muc-2']);
   assert.equal(document.querySelector('.guide-copy ol a').getAttribute('href'),'/san-pham/gaeru-k9');
   assert.equal(document.querySelector('.guide-copy ul').children.length,2);
   assert.equal(document.querySelector('.guide-copy strong').textContent,'một câu');
   assert.equal(document.querySelector('th[scope=row]').textContent,'Nguồn');
   assert.equal(document.querySelectorAll('th[scope=col]').length,3);
   assert.equal(document.querySelector('em,.article-product-recommend,.article-bottom-cta'),null);
 }
 // A change to a different post or an old-format revision retains the plain-text renderer.
 const reader=require('../news-guide');
 assert.match(reader.render({...post,slug:'thu-am-podcast-phong-van-hai-nguoi-can-bang-am-luong'},''),/<figcaption>Ảnh minh họa tạo bằng AI\.<\/figcaption>/);
 assert.equal(reader.isGuide({...post,slug:'other-news'}),false);
 assert.equal(reader.isGuide({...post,body:'Chữ thông thường.'}),false);
});
