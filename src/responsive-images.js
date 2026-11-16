'use strict';
const fs=require('node:fs');
const path=require('node:path');
const map=require('../responsive-images.json');
const ROOT_DIR=path.join(__dirname,'..');
const avifExistsCache=new Map();
function hasAvifFile(publicUrl){
 if(!publicUrl||publicUrl.includes('..')||!/^\/assets\/[a-zA-Z0-9/_.-]+\.avif$/i.test(publicUrl))return false;
 if(!avifExistsCache.has(publicUrl))avifExistsCache.set(publicUrl,fs.existsSync(path.join(ROOT_DIR,publicUrl.slice(1))));
 return avifExistsCache.get(publicUrl);
}
function wrapPicture(document,image,avifSrcset,sizes){
 if(!avifSrcset||!image.parentNode||image.parentNode.tagName==='PICTURE')return;
 const picture=document.createElement('picture'),sourceEl=document.createElement('source');
 sourceEl.setAttribute('type','image/avif');sourceEl.setAttribute('srcset',avifSrcset);
 if(sizes)sourceEl.setAttribute('sizes',sizes);
 image.parentNode.insertBefore(picture,image);picture.appendChild(sourceEl);picture.appendChild(image);
}
function apply(document){
 if(!document.getElementById('responsive-artwork')){const manifest=document.createElement('script');manifest.id='responsive-artwork';manifest.type='application/json';manifest.textContent=JSON.stringify(map).replace(/</g,'\\u003c');document.head.prepend(manifest);}
 for(const image of document.querySelectorAll('img[src]')){
 if(!image.hasAttribute('decoding'))image.setAttribute('decoding','async');if(image.closest('[data-audio-art]'))continue;
 const source='/'+image.getAttribute('src').replace(/^\//,''),variants=map[source];
 if(/^\/api\/(?:news|catalog)-images\/[0-9a-f-]{36}(?:\?v=[a-zA-Z0-9-]+)?$/.test(source)){
   const sep=source.includes('?')?'&':'?';
   const sizes=image.closest('.product-gallery-thumbnails')?'96px':image.classList.contains('news-cover')?'(max-width: 760px) calc(100vw - 40px), 1000px':image.closest('.product-detail-art')?'(max-width: 760px) calc(100vw - 40px), 640px':'(max-width: 760px) calc(100vw - 48px), 380px';
   image.setAttribute('srcset',[480,800,1200].map(width=>source+sep+'format=webp&w='+width+' '+width+'w').join(', '));
   image.setAttribute('sizes',sizes);
   wrapPicture(document,image,[480,800,1200].map(width=>source+sep+'format=avif&w='+width+' '+width+'w').join(', '),sizes);
   continue;
 }
 if(/^\/assets\/products\/m3-description\/(?:1|2|3|4|6|7|8|9|10|11|12)\.webp$/.test(source)){
   const sizes='(max-width: 760px) calc(100vw - 40px), 380px',base=source.slice(0,-5);
   image.setAttribute('srcset',[480,800].map(width=>source+'?w='+width+'&format=webp '+width+'w').join(', ')+', '+source+'?format=webp 842w');
   image.setAttribute('sizes',sizes);
   wrapPicture(document,image,[480,800].map(width=>base+'-w'+width+'.avif '+width+'w').concat(base+'.avif 842w').join(', '),sizes);
   continue;
 }
 if(variants){
   image.setAttribute('srcset',variants.map(v=>v.url+'?format=webp '+v.width+'w').join(', ')+', '+source+'?format=webp '+variants[0].sourceWidth+'w');
   const isHero=Boolean(image.closest('.hero-art,.product-detail-art,.guide-hero'));
   const sizes=isHero?'(max-width: 760px) calc(100vw - 40px), 640px':image.closest('.product-gallery-thumbnails')?'96px':image.closest('.category-art')?'144px':'(max-width: 760px) calc(100vw - 48px), 380px';
   image.setAttribute('sizes',sizes);
   if(isHero){image.setAttribute('fetchpriority','high');image.setAttribute('loading','eager');}
   const avifParts=variants.filter(v=>v.avifUrl).map(v=>v.avifUrl+' '+v.width+'w'),fullAvif=source.replace(/\.webp$/i,'.avif');
   if(hasAvifFile(fullAvif))avifParts.push(fullAvif+' '+variants[0].sourceWidth+'w');
   wrapPicture(document,image,avifParts.join(', '),sizes);
   continue;
 }
 if(/^\/assets\/[^?#]+\.webp$/i.test(source)){
   const fullAvif=source.slice(0,-5)+'.avif';
   if(hasAvifFile(fullAvif))wrapPicture(document,image,fullAvif);
 }
}}
module.exports={apply};
