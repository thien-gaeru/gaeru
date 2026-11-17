'use strict';
const fs=require('node:fs'),path=require('node:path'),{parseHTML}=require('linkedom'),{paths,clean}=require('../clean-urls'),{normalizePublicBase,normalizeBrandText}=require('./primary-domain');
const escapeHtml=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function setSafeTitle(doc,rawTitle){const cleanTitle=normalizeBrandText(String(rawTitle??''));if(doc)doc.title=escapeHtml(cleanTitle);return cleanTitle;}
const projectRoot=path.join(__dirname,'..');
const publicFiles=require('./public-files');
const {getAssetHash12}=require('./lib/static-asset-cache');

function versionedPublicAssetUrl(rawUrl){
 if(typeof rawUrl!=='string')return rawUrl;
 const trimmed=rawUrl.trim();
 if(!trimmed||/^(?:[a-z]+:|\/\/)/i.test(trimmed))return rawUrl;
 const hashSplit=trimmed.split('#');
 const [pathname,query='']=hashSplit[0].split('?');
 const filename=pathname.replace(/^\/+/,'');
 if(!filename||filename.includes('/')||!publicFiles.has(filename))return rawUrl;
 const hash12=getAssetHash12(projectRoot,filename);
 if(!hash12)return rawUrl;
 const params=new URLSearchParams(query);
 params.set('v',hash12);
 const fragment=hashSplit.length>1?'#'+hashSplit.slice(1).join('#'):'';
 return '/'+filename+'?'+params.toString()+fragment;
}
const reverse=Object.fromEntries(Object.entries(paths).filter(([,p])=>p!=='/').map(([f,p])=>[p,'/'+f]));
function legacy(url){const u=new URL(url,'https://gaeru.com');let target=reverse[u.pathname];const product=u.pathname.match(/^\/san-pham\/([a-z0-9-]+)$/),post=u.pathname.match(/^\/tin-tuc\/([a-z0-9-]+)$/);if(product){target='/product.html';u.searchParams.set('id',product[1])}if(post){target='/news-article.html';u.searchParams.set('slug',post[1])}return target?target+(u.searchParams.size?'?'+u.searchParams:''):null;}
function enrich(html,original,origin,override){if(typeof html==='string'&&html.includes('/clean-urls.js?v=')&&(!override||html.includes('data-gaeru-enriched="1"')))return html;origin=normalizePublicBase(origin);const {document:doc}=parseHTML(normalizeBrandText(html));if(!doc.head||!doc.querySelector('main'))return normalizeBrandText(html);doc.documentElement.setAttribute('data-gaeru-enriched','1');
 require('./responsive-images').apply(doc);
 for(const style of doc.querySelectorAll('link[href]')){const rel=String(style.getAttribute('rel')||'').toLowerCase();if(!rel||rel==='stylesheet'||rel==='preload'){style.setAttribute('href',versionedPublicAssetUrl(style.getAttribute('href')||''));}}
 for(const script of doc.querySelectorAll('script[src]')){script.setAttribute('src',versionedPublicAssetUrl(script.getAttribute('src')||''));}
 let pageTitle=setSafeTitle(doc,doc.title),descriptionNode=doc.head.querySelector('meta[name=description]'),rawDescription=normalizeBrandText(descriptionNode?.content||'');if(override){pageTitle=setSafeTitle(doc,override.title);rawDescription=normalizeBrandText(override.description);if(!descriptionNode){descriptionNode=doc.createElement('meta');descriptionNode.name='description';doc.head.append(descriptionNode)}descriptionNode.content=escapeHtml(rawDescription);}else if(descriptionNode){descriptionNode.content=escapeHtml(rawDescription);}
 doc.documentElement.setAttribute('lang','vi');let base=doc.head.querySelector('base');if(!base){base=doc.createElement('base');base.setAttribute('href','/');doc.head.prepend(base)}
 const footerNode=doc.getElementById('site-footer')||doc.querySelector('#site-footer');
 if(footerNode&&!footerNode.querySelector('.site-footer')){
  footerNode.innerHTML=require('./site-footer').SITE_FOOTER_HTML;
 }
 for(const el of doc.querySelectorAll('[href],[action],[src],[poster]'))for(const key of ['href','action','src','poster'])if(el.hasAttribute(key))el.setAttribute(key,clean(el.getAttribute(key),origin));
 if(!doc.querySelector('script[src^="/clean-urls.js"]')){const script=doc.createElement('script');script.src=versionedPublicAssetUrl('/clean-urls.js');script.defer=true;doc.head.append(script)}
 const u=new URL('/'+String(original||'/').replace(/^[\/\\]+/,''),origin);const safePathname=u.pathname.replace(/\\/g,'/').replace(/^\/+/,'/');for(const a of doc.querySelectorAll('a[href^="#"]'))a.setAttribute('href',safePathname+a.getAttribute('href'));
 const canonical=doc.head.querySelector('link[rel=canonical]')?.getAttribute('href')||origin+u.pathname;
 const meta=(key,value,property=false)=>{const attr=property?'property':'name';let n=doc.head.querySelector('meta['+attr+'="'+key+'"]');if(!n){n=doc.createElement('meta');n.setAttribute(attr,key);doc.head.append(n)}n.setAttribute('content',value)};
 const canonicalUrl=new URL(clean(canonical,origin),origin).href;let link=doc.head.querySelector('link[rel=canonical]');if(!link){link=doc.createElement('link');link.rel='canonical';doc.head.append(link)}link.href=canonicalUrl;
 for(const el of doc.querySelectorAll('[srcset]'))if(!el.getAttribute('srcset').includes('data:'))el.setAttribute('srcset',el.getAttribute('srcset').split(',').map(item=>{const parts=item.trim().split(/\s+/);parts[0]=clean(parts[0],origin);return parts.join(' ')}).join(', '));
 const summary=rawDescription||doc.querySelector('main p')?.textContent||'',image=doc.head.querySelector('meta[property="og:image"]')?.content||origin+'/assets/brand/gaeru-logo.webp';
 for(const [key,value]of Object.entries({'og:url':canonicalUrl,'og:title':escapeHtml(pageTitle),'og:description':escapeHtml(summary),'og:image':image,'og:type':u.pathname.startsWith('/tin-tuc/')?'article':'website','og:locale':'vi_VN'}))meta(key,key==='og:image'?new URL(clean(value,origin),origin).href:value,true);
 for(const [key,value]of Object.entries({'twitter:card':'summary_large_image','twitter:title':escapeHtml(pageTitle),'twitter:description':escapeHtml(summary),'twitter:image':image}))meta(key,key==='twitter:image'?new URL(clean(value,origin),origin).href:value);
 const add=value=>{const n=doc.createElement('script');n.type='application/ld+json';n.textContent=JSON.stringify(value).replace(/</g,'\\u003c');doc.head.append(n)};
 add({'@context':'https://schema.org','@type':'Organization','@id':origin+'/#organization',name:'GAERU',url:origin+'/',logo:origin+'/assets/brand/gaeru-logo.webp'});
 const crumbs=[{'@type':'ListItem',position:1,name:'Trang chủ',item:origin+'/'}];if(u.pathname!=='/'){if(u.pathname.startsWith('/san-pham/'))crumbs.push({'@type':'ListItem',position:2,name:'Cửa hàng',item:origin+'/cua-hang'});else if(u.pathname.startsWith('/tin-tuc/'))crumbs.push({'@type':'ListItem',position:2,name:'Tin tức',item:origin+'/tin-tuc'});crumbs.push({'@type':'ListItem',position:crumbs.length+1,name:doc.querySelector('h1')?.textContent||pageTitle,item:canonicalUrl});add({'@context':'https://schema.org','@type':'BreadcrumbList',itemListElement:crumbs})}
 const faq=[...doc.querySelectorAll('.discover-faq details')].map(d=>({'@type':'Question',name:d.querySelector('summary')?.textContent,acceptedAnswer:{'@type':'Answer',text:d.querySelector('p')?.textContent}})).filter(q=>q.name&&q.acceptedAnswer.text);if(faq.length)add({'@context':'https://schema.org','@type':'FAQPage',mainEntity:faq});
 if(['/tai-khoan','/gio-hang','/thanh-toan','/ket-qua-thanh-toan'].includes(u.pathname))meta('robots','noindex, follow');
 if(!doc.querySelector('script[type="speculationrules"]')){const spec=doc.createElement('script');spec.type='speculationrules';spec.textContent=require('./speculation-policy').text;if(doc.body)doc.body.append(spec);else doc.head.append(spec);}
 const { isDcbEnabled } = require('./lib/compression-dictionary'); if(isDcbEnabled() && !doc.head.querySelector('link[rel="compression-dictionary"]')){const dl=doc.createElement('link');dl.setAttribute('rel','compression-dictionary');dl.setAttribute('href','/dict/shared-template.dict');doc.head.append(dl);}
 const mainStyle=doc.head.querySelector('link[rel="stylesheet"][href^="/styles.css"]');if(mainStyle&&!doc.head.querySelector('link[rel="preload"][href^="/styles.css"]')){const preload=doc.createElement('link');preload.setAttribute('rel','preload');preload.setAttribute('as','style');preload.setAttribute('href',mainStyle.getAttribute('href'));base.after(preload);}
 if(doc.querySelector('script[src*="store-shell.js"]')&&!['/thanh-toan','/tai-khoan','/dang-ky-bao-hanh','/kich-hoat-bao-hanh'].includes(u.pathname)){for(const css of doc.head.querySelectorAll('link[rel="stylesheet"]')){if(css.hasAttribute('data-deferred-css')||css.closest('noscript'))continue;const href=css.getAttribute('href')||'';if(/^\/(shopping-chat|quick-purchase|action-feedback|bot-protection|vietnam-address)\.css(?:\?|$)/.test(href)){css.setAttribute('media','print');css.setAttribute('data-deferred-css','');const ns=doc.createElement('noscript');const nsLink=doc.createElement('link');nsLink.setAttribute('rel','stylesheet');nsLink.setAttribute('href',href);ns.append(nsLink);css.after(ns);}}}
 return normalizeBrandText('<!doctype html>'+doc.documentElement.outerHTML);
}
const PRIVATE_DCB_EXCLUSION_RE=/^\/(?:tai-khoan|thanh-toan|gio-hang|ket-qua-thanh-toan|account|checkout|cart|payment-result)(?:\/|$|\.)/i;
function cleanRoutes(origin){origin=normalizePublicBase(origin);return(req,res,next)=>{
 if(!['GET','HEAD'].includes(req.method)||/^\/(?:api|gaeru_ceo)(?:\/|$)/.test(req.path))return next();
 const rawUrl='/'+String(req.originalUrl||'/').replace(/^[\/\\]+/,'');const target=clean(rawUrl,origin);if(target!==rawUrl&&/^\/(?!\/|\\)/.test(target))return res.redirect(301,target);
 const send=res.send.bind(res),prepare=body=>typeof body==='string'&&String(res.get('Content-Type')).includes('html')?enrich(body,req.originalUrl,origin,req.sitePage):body;
 // Cache the final document, including metadata, rather than the unprocessed template.
 const {isDcbEnabled,isDcbEligible,compressDcb}=require('./lib/compression-dictionary');
 const customSend=body=>{
  const prepared=res.locals.__gaeruHtmlPrepared?body:prepare(body);
  res.locals.__gaeruHtmlPrepared=false;
  if(req.headers['sec-purpose']?.includes('prerender'))req.isPrerender=true;
  const cacheControlHeader=String(res.getHeader('Cache-Control')||'');
  const isPrivateResponse=PRIVATE_DCB_EXCLUSION_RE.test(req.path)||/no-store|private/i.test(cacheControlHeader);
  if(typeof prepared==='string'&&!isPrivateResponse&&isDcbEligible(req)){
   const dcbPayload=compressDcb(Buffer.from(prepared,'utf8'));
   res.setHeader('Content-Encoding','dcb');
   res.setHeader('Vary','Accept-Encoding, Available-Dictionary, Sec-Purpose');
   res.setHeader('X-Accel-Buffering','no');
   res.setHeader('Cache-Control','public, max-age=0, must-revalidate, no-transform');
   let etag=res.getHeader('ETag');
   if(!etag){
    const crypto=require('node:crypto');
    etag='"'+crypto.createHash('md5').update(dcbPayload).digest('hex')+'-dcb"';
    res.setHeader('ETag',etag);
   }else{
    etag=String(etag).replace(/"$/,'-dcb"');
    res.setHeader('ETag',etag);
   }
   res.setHeader('Content-Type','text/html; charset=utf-8');
   res.setHeader('Content-Length',dcbPayload.length);
   if(etag&&req.headers['if-none-match']===res.getHeader('ETag'))return res.status(304).end();
   return send(dcbPayload);
  }
  res.vary('Accept-Encoding');
  if(isDcbEnabled()){
   res.vary('Available-Dictionary');
   res.vary('Sec-Purpose');
  }
  return send(prepared);
 };
 res.locals.publicHtml={prepare:body=>{res.locals.__gaeruHtmlPrepared=true;return prepare(body);},send:customSend};
 res.send=customSend;
 const internal=legacy(req.originalUrl);if(internal)req.url=internal;next();
}}
const htmlTemplates=new Map();function readHtmlTemplate(file){let content=htmlTemplates.get(file);if(content===undefined){content=fs.readFileSync(path.join(__dirname,'..',file),'utf8');htmlTemplates.set(file,content);}return content;}
function staticHtml(req,res,next){if(!['GET','HEAD'].includes(req.method))return next();const file=req.path.slice(1);if(!file.endsWith('.html')||!require('./public-files').has(file))return next();res.set('Cache-Control',/^(account|checkout|cart|payment-result)\.html$/.test(file)?'no-store':'no-cache').type('html').send(readHtmlTemplate(file))}
module.exports={legacy,enrich,cleanRoutes,staticHtml,readHtmlTemplate,setSafeTitle,escapeHtml};
