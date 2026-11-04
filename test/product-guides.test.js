'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),express=require('express'),{once}=require('node:events'),{parseHTML}=require('linkedom');
const {createProductGuidePages}=require('../src/product-guides'),{cleanRoutes}=require('../src/clean-routes');

async function fixture(t){
 const products=['gaeru-k9','gaeru-m3','gaeru-p01','gaeru-p185','gaeru-g1-ultra'].map(slug=>({slug,name:slug.toUpperCase(),descriptor:'Fixture product',imageUrl:'/assets/products/k9.webp',variants:[]}));
 const pool={async query(sql){assert.match(sql,/p.active = true AND p.deleted_at IS NULL/);return {rows:structuredClone(products)};}};
 const app=express();app.use(cleanRoutes('https://gaeru.com'));app.use(createProductGuidePages(pool));
 const server=app.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>server.close(resolve)));
 return {base:'http://127.0.0.1:'+server.address().port,products};
}

test('every published guide has working section links, named navigation and one canonical URL across aliases',async t=>{
 const {base,products}=await fixture(t);
 for(const product of products){
   const canonical='https://gaeru.com/huong-dan/'+product.slug;
   for(const route of ['/huong-dan/','/ho-tro/san-pham/']){
     const response=await fetch(base+route+product.slug);assert.equal(response.status,200);
     const doc=parseHTML(await response.text()).document;
     assert.equal(doc.querySelector('base').getAttribute('href'),'/');
     assert.equal(doc.querySelector('link[rel=canonical]').href,canonical);
     assert.equal(doc.querySelector('nav.guide-breadcrumb').getAttribute('aria-label'),'Đường dẫn');
     assert.equal(doc.querySelector('[aria-current=page]').textContent,product.name);
     for(const link of doc.querySelectorAll('.guide-toc a'))assert.ok(doc.getElementById(new URL(link.getAttribute('href'),'https://gaeru.com').hash.slice(1)));
     assert.equal(doc.querySelector('[data-product-chat]').dataset.productChat,product.slug);
     assert.ok(doc.querySelector('a[href="/san-pham/'+product.slug+'"]'));
   }
 }
});

test('guide listing uses current catalog and missing models return a navigation path without leaking product text',async t=>{
 const {base,products}=await fixture(t),listing=await fetch(base+'/huong-dan');assert.equal(listing.status,200);
 const doc=parseHTML(await listing.text()).document;assert.equal(doc.querySelectorAll('.guide-card').length,products.length);
 const missing=await fetch(base+'/huong-dan/not-published');assert.equal(missing.status,404);const missingHtml=await missing.text(),missingDoc=parseHTML(missingHtml).document;assert.ok(missingDoc.querySelector('a[href="/huong-dan"]'));assert.doesNotMatch(missingHtml,/Fixture product/);
});
