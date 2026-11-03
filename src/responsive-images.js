'use strict';
const map=require('../responsive-images.json');
function apply(document){
 if(!document.getElementById('responsive-artwork')){const manifest=document.createElement('script');manifest.id='responsive-artwork';manifest.type='application/json';manifest.textContent=JSON.stringify(map).replace(/</g,'\\u003c');document.head.prepend(manifest);}
 for(const image of document.querySelectorAll('img[src]')){
 if(image.closest('[data-audio-art]'))continue;
 const source='/'+image.getAttribute('src').replace(/^\//,''),variants=map[source];if(!variants)continue;
 image.setAttribute('srcset',variants.map(v=>v.url+' '+v.width+'w').join(', ')+', '+source+' '+variants[0].sourceWidth+'w');
 const isHero=Boolean(image.closest('.hero-art,.product-detail-art,.guide-hero'));
 image.setAttribute('sizes',isHero?'(max-width: 760px) calc(100vw - 40px), 640px':'(max-width: 760px) calc(100vw - 48px), 480px');
 if(isHero){image.setAttribute('fetchpriority','high');image.setAttribute('loading','eager');}
}}
module.exports={apply};
