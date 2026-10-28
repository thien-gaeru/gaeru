'use strict';
const fs=require('node:fs'),path=require('node:path'),{parseHTML}=require('linkedom'),{paths,clean}=require('../clean-urls'),{normalizePublicBase,normalizeBrandText}=require('./primary-domain');
const reverse=Object.fromEntries(Object.entries(paths).filter(([,p])=>p!=='/').map(([f,p])=>[p,'/'+f]));
function legacy(url){const u=new URL(url,'https://gaeru.com');let target=reverse[u.pathname];const product=u.pathname.match(/^\/san-pham\/([a-z0-9-]+)$/),post=u.pathname.match(/^\/tin-tuc\/([a-z0-9-]+)$/);if(product){target='/product.html';u.searchParams.set('id',product[1])}if(post){target='/news-article.html';u.searchParams.set('slug',post[1])}return target?target+(u.searchParams.size?'?'+u.searchParams:''):null;}
function enrich(html,original,origin,override){origin=normalizePublicBase(origin);const {document:doc}=parseHTML(normalizeBrandText(html));if(!doc.head||!doc.querySelector('main'))return normalizeBrandText(html);
 if(override){doc.title=normalizeBrandText(override.title);let description=doc.head.querySelector('meta[name=description]');if(!description){description=doc.createElement('meta');description.name='description';doc.head.append(description)}description.content=normalizeBrandText(override.description)}
 doc.documentElement.setAttribute('lang','vi');let base=doc.head.querySelector('base');if(!base){base=doc.createElement('base');base.setAttribute('href','/');doc.head.prepend(base)}
 for(const el of doc.querySelectorAll('[href],[action],[src],[poster]'))for(const key of ['href','action','src','poster'])if(el.hasAttribute(key))el.setAttribute(key,clean(el.getAttribute(key),origin));
 if(!doc.querySelector('script[src^="/clean-urls.js"]')){const script=doc.createElement('script');script.src='/clean-urls.js?v=20261027-gaeru-com';script.defer=true;doc.head.append(script)}
 const u=new URL(original,origin);for(const a of doc.querySelectorAll('a[href^="#"]'))a.setAttribute('href',u.pathname+u.search+a.getAttribute('href'));
 const canonical=doc.head.querySelector('link[rel=canonical]')?.getAttribute('href')||origin+u.pathname;
 const meta=(key,value,property=false)=>{const attr=property?'property':'name';let n=doc.head.querySelector('meta['+attr+'="'+key+'"]');if(!n){n=doc.createElement('meta');n.setAttribute(attr,key);doc.head.append(n)}n.setAttribute('content',value)};
 const canonicalUrl=new URL(clean(canonical,origin),origin).href;let link=doc.head.querySelector('link[rel=canonical]');if(!link){link=doc.createElement('link');link.rel='canonical';doc.head.append(link)}link.href=canonicalUrl;
 for(const el of doc.querySelectorAll('[srcset]'))if(!el.getAttribute('srcset').includes('data:'))el.setAttribute('srcset',el.getAttribute('srcset').split(',').map(item=>{const parts=item.trim().split(/\s+/);parts[0]=clean(parts[0],origin);return parts.join(' ')}).join(', '));
 const summary=doc.head.querySelector('meta[name=description]')?.content||doc.querySelector('main p')?.textContent||'',image=doc.head.querySelector('meta[property="og:image"]')?.content||origin+'/assets/brand/gaeru-logo.webp';
 for(const [key,value]of Object.entries({'og:url':canonicalUrl,'og:title':doc.title,'og:description':summary,'og:image':image,'og:type':u.pathname.startsWith('/tin-tuc/')?'article':'website','og:locale':'vi_VN'}))meta(key,key==='og:image'?new URL(clean(value,origin),origin).href:value,true);
 for(const [key,value]of Object.entries({'twitter:card':'summary_large_image','twitter:title':doc.title,'twitter:description':summary,'twitter:image':image}))meta(key,key==='twitter:image'?new URL(clean(value,origin),origin).href:value);
 const add=value=>{const n=doc.createElement('script');n.type='application/ld+json';n.textContent=JSON.stringify(value).replace(/</g,'\\u003c');doc.head.append(n)};
 add({'@context':'https://schema.org','@type':'Organization','@id':origin+'/#organization',name:'GAERU',url:origin+'/',logo:origin+'/assets/brand/gaeru-logo.webp'});
 const crumbs=[{'@type':'ListItem',position:1,name:'Trang chủ',item:origin+'/'}];if(u.pathname!=='/'){if(u.pathname.startsWith('/san-pham/'))crumbs.push({'@type':'ListItem',position:2,name:'Cửa hàng',item:origin+'/cua-hang'});else if(u.pathname.startsWith('/tin-tuc/'))crumbs.push({'@type':'ListItem',position:2,name:'Tin tức',item:origin+'/tin-tuc'});crumbs.push({'@type':'ListItem',position:crumbs.length+1,name:doc.querySelector('h1')?.textContent||doc.title,item:canonicalUrl});add({'@context':'https://schema.org','@type':'BreadcrumbList',itemListElement:crumbs})}
 const faq=[...doc.querySelectorAll('.discover-faq details')].map(d=>({'@type':'Question',name:d.querySelector('summary')?.textContent,acceptedAnswer:{'@type':'Answer',text:d.querySelector('p')?.textContent}})).filter(q=>q.name&&q.acceptedAnswer.text);if(faq.length)add({'@context':'https://schema.org','@type':'FAQPage',mainEntity:faq});
 if(['/tai-khoan','/gio-hang','/thanh-toan','/ket-qua-thanh-toan'].includes(u.pathname))meta('robots','noindex, follow');
 return normalizeBrandText('<!doctype html>'+doc.documentElement.outerHTML);
}
function cleanRoutes(origin){origin=normalizePublicBase(origin);return(req,res,next)=>{
 if(!['GET','HEAD'].includes(req.method)||/^\/(?:api|gaeru_ceo)(?:\/|$)/.test(req.path))return next();
 const target=clean(req.originalUrl,origin);if(target!==req.originalUrl)return res.redirect(301,target);
 const send=res.send.bind(res);res.send=body=>send(typeof body==='string'&&String(res.get('Content-Type')).includes('html')?enrich(body,req.originalUrl,origin,req.sitePage):body);
 const internal=legacy(req.originalUrl);if(internal)req.url=internal;next();
}}
function staticHtml(req,res,next){if(!['GET','HEAD'].includes(req.method))return next();const file=req.path.slice(1);if(!file.endsWith('.html')||!require('./public-files').has(file))return next();res.set('Cache-Control',/^(account|checkout|cart|payment-result)\.html$/.test(file)?'no-store':'no-cache').type('html').send(fs.readFileSync(path.join(__dirname,'..',file),'utf8'))}
module.exports={legacy,enrich,cleanRoutes,staticHtml};
