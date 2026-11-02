(function(scope){
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 function render(target,products){if(!target||!Array.isArray(products))return;const seen=new Set(),rows=products.filter(p=>p&&p.active!==false&&!p.deletedAt&&typeof p.name==='string'&&typeof p.slug==='string'&&p.slug.length<=120&&/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(p.slug)&&!seen.has(p.slug)&&seen.add(p.slug));const signature=JSON.stringify(rows.map(p=>[p.slug,p.name]));if(target.dataset.footerSignature===signature)return;const link=p=>'<a href="/san-pham/'+encodeURIComponent(p.slug)+'">'+esc(p.name)+'</a>';target.innerHTML='<a href="/cua-hang">Cửa hàng</a>'+rows.map(link).join('');target.dataset.footerSignature=signature;}
 const api={render};if(typeof module==='object'&&module.exports)module.exports=api;else scope.GAERUFooterProducts=api;
})(typeof window==='object'?window:globalThis);
