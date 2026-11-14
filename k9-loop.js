(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else{root.GAERUK9Loop=api;if(root.document.readyState==='loading')root.document.addEventListener('DOMContentLoaded',()=>api.mountHome(),{once:true});else api.mountHome();}})(typeof window==='object'?window:globalThis,function(){
 let serial=0,singleton;
 function createController(env={}){
  const win=env.window||window,doc=env.document||win.document,motion=win.matchMedia('(prefers-reduced-motion: reduce)'),entries=new Map();let timer=null;
  const paint=state=>{state.root.dataset.k9Frame=state.frame;state.root.querySelector('svg').setAttribute('aria-label','GAERU K9 · '+(state.frame==='single'?'một mic':'hai mic'));};
  const active=s=>s.root.isConnected&&s.visible&&!s.paused&&!s.root.closest('[hidden]');
  function sync(){if(motion.matches)for(const state of entries.values()){state.frame='double';paint(state);}const run=!doc.hidden&&!motion.matches&&[...entries.values()].some(active);if(!run&&timer!==null){win.clearInterval(timer);timer=null;}if(run&&timer===null)timer=win.setInterval(()=>{if(doc.hidden||motion.matches){sync();return;}for(const state of entries.values())if(active(state)){state.frame=state.frame==='double'?'single':'double';paint(state);}},4200);}
  const observer=win.IntersectionObserver?new win.IntersectionObserver(rows=>{for(const row of rows){const state=entries.get(row.target);if(state)state.visible=row.isIntersecting;}sync();},{threshold:.15}):null;
  function mount(img){if(!img||img.closest('[data-k9-loop]'))return;const root=doc.createElement('span'),clip='k9-single-'+(++serial);root.className='k9-loop '+(img.className||'');root.setAttribute('data-k9-loop','');
   // Both views reuse the exact source pixels. The single view clips the right mic,
   // then centers the left mic; no hardware is generated or stretched.
   const target=Math.min(img.parentElement?.clientWidth||win.innerWidth||640,720)*(win.devicePixelRatio||1);
   const candidates=(img.getAttribute?.('srcset')||'').split(',').map(value=>{const [url,width]=value.trim().split(/\s+/);return {url,width:parseInt(width,10)};}).filter(v=>/^\/assets\/products\/[a-z0-9._-]+\.webp$/i.test(v.url)&&v.width).sort((a,b)=>a.width-b.width);
   const displaySource=(candidates.find(v=>v.width>=target)||candidates.at(-1))?.url||'/assets/products/k9.webp';
   const createSvg=tag=>typeof doc.createElementNS==='function'?doc.createElementNS('http://www.w3.org/2000/svg',tag):doc.createElement(tag);
   const svg=createSvg('svg');svg.setAttribute('viewBox','0 0 1280 1280');svg.setAttribute('preserveAspectRatio','xMidYMid meet');svg.setAttribute('role','img');
   const defs=createSvg('defs'),clipPath=createSvg('clipPath'),rect=createSvg('rect');
   clipPath.setAttribute('id',clip);rect.setAttribute('x','0');rect.setAttribute('y','0');rect.setAttribute('width','640');rect.setAttribute('height','1280');
   clipPath.appendChild(rect);defs.appendChild(clipPath);svg.appendChild(defs);
   const dblImg=createSvg('image');dblImg.setAttribute('class','k9-double');dblImg.setAttribute('href',displaySource);dblImg.setAttribute('width','1280');dblImg.setAttribute('height','1280');
   const g=createSvg('g');g.setAttribute('class','k9-single');g.setAttribute('transform','translate(256 0)');g.setAttribute('clip-path','url(#'+clip+')');
   const sglImg=createSvg('image');sglImg.setAttribute('href',displaySource);sglImg.setAttribute('width','1280');sglImg.setAttribute('height','1280');
   g.appendChild(sglImg);svg.appendChild(dblImg);svg.appendChild(g);root.replaceChildren(svg);
   img.replaceWith(root);const state={root,frame:'double',paused:false,visible:!observer};entries.set(root,state);paint(state);observer?.observe(root);sync();return root;
  }
  function scan(){for(const [root]of entries)if(!root.isConnected){observer?.unobserve(root);entries.delete(root);}for(const img of doc.querySelectorAll('img[data-k9-animate],body.home-page #top .hero-art>img,body.home-page .product-grid #gaeru-k9>img.product-image,body.home-page .product-grid #k9>img.product-image'))mount(img);sync();}
  doc.addEventListener('visibilitychange',sync);motion.addEventListener?.('change',sync);
  return {mount,scan,destroy(){if(timer!==null)win.clearInterval(timer);observer?.disconnect();doc.removeEventListener('visibilitychange',sync);motion.removeEventListener?.('change',sync);entries.clear();timer=null;}};
 }
 function mountHome(){if(typeof window==='undefined')return;singleton||=createController();singleton.scan();}
 return {createController,mountHome};
});
