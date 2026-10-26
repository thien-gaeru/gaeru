(function(scope){
 const paths={'index.html':'/','shop.html':'/cua-hang','news.html':'/tin-tuc','story.html':'/cau-chuyen','support.html':'/ho-tro','care.html':'/care','guides.html':'/huong-dan','account.html':'/tai-khoan','cart.html':'/gio-hang','checkout.html':'/thanh-toan','payment-result.html':'/ket-qua-thanh-toan','warranty-activation.html':'/dang-ky-bao-hanh','privacy.html':'/chinh-sach/quyen-rieng-tu','terms.html':'/chinh-sach/dieu-khoan','pricing.html':'/chinh-sach/gia','payment.html':'/chinh-sach/thanh-toan','delivery-returns.html':'/chinh-sach/giao-hang-doi-tra','legal.html':'/phap-ly','complaints.html':'/khieu-nai','sitemap.html':'/so-do-trang-web','product-support.html':'/ho-tro/san-pham'};
 for(const id of ['k9','m3','p01','g1-ultra']){paths['discover-'+id+'.html']='/kham-pha/gaeru-'+id;paths['guide-'+id+'.html']='/huong-dan/gaeru-'+id;}
 function clean(value,origin='https://gaeru.org'){
  if(typeof value!=='string'||!value||value.startsWith('#')||/^(?:mailto:|tel:|javascript:|data:)/i.test(value))return value;
  let u;try{u=new URL(value,origin+'/')}catch{return value}if(u.origin!==origin)return value;
  const file=u.pathname.replace(/^\//,'');let target=paths[file];
  if(file==='product.html'&&u.searchParams.get('id')){target='/san-pham/'+encodeURIComponent(u.searchParams.get('id'));u.searchParams.delete('id');}
  if(file==='news-article.html'&&u.searchParams.get('slug')){target='/tin-tuc/'+encodeURIComponent(u.searchParams.get('slug'));u.searchParams.delete('slug');}
  if(!target&&u.pathname.endsWith('/')){const p=u.pathname.slice(0,-1);if(Object.values(paths).includes(p)||/^\/(?:san-pham|tin-tuc|trang)\/[a-z0-9-]+$/.test(p))target=p;}
  return target?target+(u.searchParams.size?'?'+u.searchParams.toString():'')+u.hash:value;
 }
 const api={paths,clean};if(typeof module==='object'&&module.exports)module.exports=api;else{
  scope.GAERUUrls=api;const update=root=>{for(const el of root.querySelectorAll('a[href],form[action]')){const key=el.tagName==='FORM'?'action':'href',old=el.getAttribute(key),next=old?.startsWith('#')?location.pathname+location.search+old:clean(old,location.origin);if(next!==old)el.setAttribute(key,next)}};
  update(document);new MutationObserver(records=>{for(const r of records){if(r.type==='attributes'){const el=r.target,key=el.tagName==='FORM'?'action':'href',old=el.getAttribute(key),next=old?.startsWith('#')?location.pathname+location.search+old:clean(old,location.origin);if(next!==old)el.setAttribute(key,next)}else for(const n of r.addedNodes)if(n.nodeType===1){update(n.parentNode||n)}}}).observe(document.documentElement,{subtree:true,childList:true,attributes:true,attributeFilter:['href','action']});
 }
})(typeof window==='object'?window:globalThis);
