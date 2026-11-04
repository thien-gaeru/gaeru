const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const script=fs.readFileSync(path.join(__dirname,'../news.js'),'utf8');
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
