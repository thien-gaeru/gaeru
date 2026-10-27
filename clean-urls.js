(function(scope){
 const paths={'index.html':'/','shop.html':'/cua-hang','news.html':'/tin-tuc','story.html':'/cau-chuyen','support.html':'/ho-tro','care.html':'/care','guides.html':'/huong-dan','account.html':'/tai-khoan','cart.html':'/gio-hang','checkout.html':'/thanh-toan','payment-result.html':'/ket-qua-thanh-toan','warranty-activation.html':'/dang-ky-bao-hanh','privacy.html':'/chinh-sach/quyen-rieng-tu','terms.html':'/chinh-sach/dieu-khoan','pricing.html':'/chinh-sach/gia','payment.html':'/chinh-sach/thanh-toan','delivery-returns.html':'/chinh-sach/giao-hang-doi-tra','legal.html':'/phap-ly','complaints.html':'/khieu-nai','sitemap.html':'/so-do-trang-web','product-support.html':'/ho-tro/san-pham'};
 for(const id of ['k9','m3','p01','g1-ultra']){paths['discover-'+id+'.html']='/kham-pha/gaeru-'+id;paths['guide-'+id+'.html']='/huong-dan/gaeru-'+id;}
 function clean(value,origin='https://gaeru.com'){
  if(typeof value!=='string'||!value||value.startsWith('#')||/^(?:mailto:|tel:|javascript:|data:)/i.test(value))return value;
  let u;try{u=new URL(value,origin+'/')}catch{return value}const brand=url=>['http:','https:'].includes(url.protocol)&&['gaeru.com','www.gaeru.com'].includes(url.hostname)&&!url.username&&!url.password;const owned=brand(u)&&brand(new URL(origin));if(u.origin!==origin&&!owned)return value;
  const file=u.pathname.replace(/^\//,'');let target=paths[file];if(file==='gaeru-k9'||file==='gaeru-k9/')target='/kham-pha/gaeru-k9';
  if(file==='product.html'&&u.searchParams.get('id')){target='/san-pham/'+encodeURIComponent(u.searchParams.get('id'));u.searchParams.delete('id');}
  if(file==='news-article.html'&&u.searchParams.get('slug')){target='/tin-tuc/'+encodeURIComponent(u.searchParams.get('slug'));u.searchParams.delete('slug');}
  if(!target&&u.pathname.endsWith('/')){const p=u.pathname.slice(0,-1);if(Object.values(paths).includes(p)||/^\/(?:san-pham|tin-tuc|trang)\/[a-z0-9-]+$/.test(p))target=p;}
  return target?target+(u.searchParams.size?'?'+u.searchParams.toString():'')+u.hash:owned?u.pathname+u.search+u.hash:value;
 }
 const api={paths,clean};if(typeof module==='object'&&module.exports)module.exports=api;else{
  scope.GAERUUrls=api;
  const updateElement=el=>{for(const key of ['href','action','src','poster'])if(el.hasAttribute(key)){const old=el.getAttribute(key),next=old?.startsWith('#')&&key==='href'?location.pathname+location.search+old:clean(old,location.origin);if(next!==old)el.setAttribute(key,next);}if(el.hasAttribute('srcset')&&!el.getAttribute('srcset').includes('data:')){const old=el.getAttribute('srcset'),next=old.split(',').map(item=>{const parts=item.trim().split(/\s+/);parts[0]=clean(parts[0],location.origin);return parts.join(' ')}).join(', ');if(next!==old)el.setAttribute('srcset',next)}};
  const update=root=>{for(const el of root.querySelectorAll('[href],[action],[src],[poster],[srcset]'))updateElement(el)};
  update(document);new MutationObserver(records=>{for(const r of records){if(r.type==='attributes')updateElement(r.target);else for(const n of r.addedNodes)if(n.nodeType===1)update(n.parentNode||n)}}).observe(document.documentElement,{subtree:true,childList:true,attributes:true,attributeFilter:['href','action','src','poster','srcset']});
 }
})(typeof window==='object'?window:globalThis);
