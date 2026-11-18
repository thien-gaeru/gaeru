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
   const isThumb=Boolean(image.closest('.product-gallery-thumbnails'));
   const isCard=Boolean(image.closest('.news-card,.product-card,.catalog-card'));
   const sizes=isThumb?'74px':image.classList.contains('news-cover')?'(max-width: 760px) calc(100vw - 40px), (max-width: 1200px) 92vw, 1100px':image.closest('.product-detail-art')?'(max-width: 760px) 280px, (max-width: 1120px) 640px, 840px':image.closest('.news-card')?'(max-width: 760px) 220px, 350px':isCard?'(max-width: 760px) 240px, (max-width: 1120px) 460px, 560px':'(max-width: 760px) 240px, (max-width: 1120px) 460px, 560px';
   const targetWidths=isThumb?[160,480]:[480,800,1200,1600];
   image.setAttribute('srcset',targetWidths.map(width=>source+sep+'format=webp&w='+width+' '+width+'w').join(', '));
   image.setAttribute('sizes',sizes);
   wrapPicture(document,image,targetWidths.map(width=>source+sep+'format=avif&w='+width+' '+width+'w').join(', '),sizes);
   continue;
 }
 if(/^\/assets\/products\/m3-description\/(?:1|2|3|4|6|7|8|9|10|11|12)\.webp$/.test(source)){
   const sizes=image.closest('.discover-hero')?'(max-width: 760px) 240px, 460px':'(max-width: 760px) calc(100vw - 40px), (max-width: 1120px) 54vw, 660px',base=source.slice(0,-5);
   image.setAttribute('srcset',[480,800].map(width=>source+'?w='+width+'&format=webp '+width+'w').join(', ')+', '+source+'?format=webp 842w');
   image.setAttribute('sizes',sizes);
   wrapPicture(document,image,[480,800].map(width=>base+'-w'+width+'.avif '+width+'w').concat(base+'.avif 842w').join(', '),sizes);
   continue;
 }
 if(variants){
   image.setAttribute('srcset',variants.map(v=>v.url+'?format=webp '+v.width+'w').join(', ')+', '+source+'?format=webp '+variants[0].sourceWidth+'w');
   const isHero=Boolean(image.closest('.hero-art,.product-detail-art,.guide-hero,.discover-hero'));
   const isTightHero=Boolean(image.closest('.hero-art,.discover-hero'));
   const sizes=isHero?(isTightHero?'(max-width: 760px) 240px, (max-width: 1120px) 520px, 600px':'(max-width: 760px) 280px, (max-width: 1120px) 640px, 900px'):image.closest('.product-gallery-thumbnails')?'74px':image.closest('.category-art,.support-product-image')?'160px':'(max-width: 760px) 240px, (max-width: 1120px) 460px, 560px';
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
