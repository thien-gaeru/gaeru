'use strict';
const map=require('../responsive-images.json');
function apply(document){
 if(!document.getElementById('responsive-artwork')){const manifest=document.createElement('script');manifest.id='responsive-artwork';manifest.type='application/json';manifest.textContent=JSON.stringify(map).replace(/</g,'\\u003c');document.head.prepend(manifest);}
 for(const image of document.querySelectorAll('img[src]')){
 if(!image.hasAttribute('decoding'))image.setAttribute('decoding','async');if(image.closest('[data-audio-art]'))continue;
 const source='/'+image.getAttribute('src').replace(/^\//,''),variants=map[source];
 if(/^\/api\/(?:news|catalog)-images\/[0-9a-f-]{36}(?:\?v=[a-zA-Z0-9-]+)?$/.test(source)){
   image.setAttribute('srcset',[480,800,1200].map(width=>source+(source.includes('?')?'&':'?')+'w='+width+' '+width+'w').join(', '));
   image.setAttribute('sizes',image.closest('.product-gallery-thumbnails')?'96px':image.classList.contains('news-cover')?'(max-width: 760px) calc(100vw - 40px), 1000px':image.closest('.product-detail-art')?'(max-width: 760px) calc(100vw - 40px), 640px':'(max-width: 760px) calc(100vw - 48px), 380px');
   continue;
 }
 if(/^\/assets\/products\/m3-description\/(?:1|2|3|4|6|7|8|9|10|11|12)\.webp$/.test(source)){
   image.setAttribute('srcset',[480,800].map(width=>source+'?w='+width+' '+width+'w').join(', ')+', '+source+' 842w');
   image.setAttribute('sizes','(max-width: 760px) calc(100vw - 40px), 380px');
   continue;
 }
 if(!variants)continue;
 image.setAttribute('srcset',variants.map(v=>v.url+' '+v.width+'w').join(', ')+', '+source+' '+variants[0].sourceWidth+'w');
 const isHero=Boolean(image.closest('.hero-art,.product-detail-art,.guide-hero'));
 image.setAttribute('sizes',isHero?'(max-width: 760px) calc(100vw - 40px), 640px':image.closest('.product-gallery-thumbnails')?'96px':image.closest('.category-art')?'144px':'(max-width: 760px) calc(100vw - 48px), 380px');
 if(isHero){image.setAttribute('fetchpriority','high');image.setAttribute('loading','eager');}
}}
module.exports={apply};
