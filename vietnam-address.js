(function(root,factory){
 const api=factory(root);
 if(typeof module==='object'&&module.exports)module.exports=api;
 else{
  root.GAERUAddress=api;
  const start=()=>{
   api.enhance(root.document);
   api.loadData().then(()=>api.enhance(root.document));
   new MutationObserver(rows=>{for(const row of rows)for(const node of row.addedNodes)if(node.nodeType===1)api.enhance(node);}).observe(root.document.body,{childList:true,subtree:true});
  };
  if(root.document.readyState==='loading')root.document.addEventListener('DOMContentLoaded',start,{once:true});else start();
 }
})(typeof window==='object'?window:globalThis,function(root){
 const provinces=['Hà Nội','Hải Phòng','Huế','Đà Nẵng','Hồ Chí Minh','Cần Thơ','An Giang','Bắc Ninh','Cà Mau','Cao Bằng','Đắk Lắk','Điện Biên','Đồng Nai','Đồng Tháp','Gia Lai','Hà Tĩnh','Hưng Yên','Khánh Hòa','Lai Châu','Lâm Đồng','Lạng Sơn','Lào Cai','Nghệ An','Ninh Bình','Phú Thọ','Quảng Ngãi','Quảng Ninh','Quảng Trị','Sơn La','Tây Ninh','Thái Nguyên','Thanh Hóa','Tuyên Quang','Vĩnh Long'].sort((a,b)=>a.localeCompare(b,'vi'));
 const key=value=>String(value||'').normalize('NFD').replace(/\p{Diacritic}/gu,'').toLowerCase().replace(/đ/g,'d').replace(/^(tinh|thanh pho|tp)\.?\s*/,'').trim();
 const canonical=value=>provinces.find(p=>key(p)===key(value))||'';
 let data=null,loading=null,serial=0,retryAt=0;
 const controls=new WeakMap();
 function setData(value){if(!Array.isArray(value?.provinces)||value.provinces.length!==34)throw Error('Danh mục địa chỉ chưa hợp lệ.');data=value;return data;}
 async function loadData(force=false){if(data)return data;if(!force&&Date.now()<retryAt)return null;if(!loading)loading=Promise.resolve().then(async()=>{if(!root.fetch)return null;const response=await root.fetch('/assets/data/vietnam-addresses.json',{credentials:'same-origin'});if(!response.ok)throw Error('Không tải được danh mục địa chỉ.');return setData(await response.json());}).catch(()=>{loading=null;retryAt=Date.now()+30000;for(const text of root.document?.querySelectorAll('.vn-address-fallback span')||[])text.textContent='Chưa tải được danh mục phường / xã. Bạn có thể thử lại. ';return null;});return loading;}
 function setValue(select,value,restore=true){
  select.value=canonical(value);
  if(value&&!select.value){select.setAttribute('data-legacy-city',String(value));select.title='Địa chỉ đã lưu: '+value+'. Chọn tỉnh/thành phố hiện hành.';}else{select.removeAttribute('data-legacy-city');select.removeAttribute('title');}
  const control=controls.get(select);if(control&&restore)control.restore(select.closest('form')?.querySelector('[name="address"]')?.value||'',value,true);
 }
 function event(node,type){const EventClass=node.ownerDocument.defaultView?.Event||Event;node.dispatchEvent(new EventClass(type,{bubbles:true}));}
 function selectProvince(node){
  const value=node.value,doc=node.ownerDocument,select=node.tagName==='SELECT'?node:doc.createElement('select');
  if(select!==node){for(const a of node.attributes)if(!['type','list','placeholder','maxlength','minlength','value'].includes(a.name))select.setAttribute(a.name,a.value);node.replaceWith(select);}
  select.dataset.vnCity='true';select.replaceChildren();const placeholder=doc.createElement('option');placeholder.value='';placeholder.textContent='Chọn tỉnh / thành phố';select.append(placeholder);
  for(const p of provinces){const option=doc.createElement('option');option.value=p;option.textContent=p;select.append(option);}setValue(select,value);return select;
 }
 function makeControl(city,form){
  const address=form.querySelector('[name="address"]');if(!address||controls.has(city)||!data)return;city._vnFallback?.remove();
  const doc=city.ownerDocument,id='vn-address-'+(++serial),wrap=doc.createElement('div');wrap.className='vn-address-picker';
  const label=city.closest('label');if(label)for(const node of label.childNodes)if(node.nodeType===3&&node.textContent.trim())node.textContent='Tỉnh / thành phố, phường / xã';
  city.parentNode.insertBefore(wrap,city);wrap.append(city);const required=city.hasAttribute('required');city.hidden=true;city.removeAttribute('required');city.setAttribute('aria-hidden','true');city.tabIndex=-1;
  const proxy=doc.createElement('input');proxy.type='text';proxy.className='vn-address-choice';proxy.placeholder='Chọn tỉnh / thành phố, phường / xã';proxy.autocomplete='off';proxy.required=required;proxy.setAttribute('role','combobox');proxy.setAttribute('aria-label','Chọn tỉnh / thành phố và phường / xã');proxy.setAttribute('aria-haspopup','dialog');proxy.setAttribute('aria-expanded','false');proxy.setAttribute('aria-controls',id);
  const panel=doc.createElement('div');panel.className='vn-address-panel';panel.id=id;panel.hidden=true;panel.setAttribute('role','dialog');panel.setAttribute('aria-label','Danh mục địa chỉ Việt Nam');
  const toolbar=doc.createElement('div');toolbar.className='vn-address-tabs';const back=doc.createElement('button');back.type='button';back.textContent='Tỉnh / thành phố';const wardTab=doc.createElement('span');wardTab.textContent='Phường / xã';toolbar.append(back,wardTab);
  const search=doc.createElement('input');search.type='search';search.className='vn-address-search';search.placeholder='Tìm tỉnh / thành phố';search.setAttribute('aria-label','Tìm địa chỉ');search.autocomplete='off';
  const list=doc.createElement('div');list.className='vn-address-options';list.setAttribute('role','group');list.setAttribute('aria-label','Các địa chỉ phù hợp');const status=doc.createElement('p');status.className='vn-address-status';status.setAttribute('aria-live','polite');
  panel.append(toolbar,search,list,status);wrap.append(proxy,panel);
  let stage='province',province=null,ward=null,legacy=false;
  const chosenText=()=>ward?province.name+', '+ward.name:province?province.name:'';
  const validity=()=>{const message=province&&!ward&&!legacy?'Chọn phường / xã để hoàn tất địa chỉ.':'';proxy.setCustomValidity?.(message);proxy.dataset.invalid=message?'true':'false';};
  const sync=()=>{proxy.value=chosenText();validity();};
  function close(){panel.hidden=true;proxy.setAttribute('aria-expanded','false');sync();}
  function render(){
   back.setAttribute('aria-current',stage==='province'?'step':'false');wardTab.setAttribute('aria-current',stage==='ward'?'step':'false');search.placeholder=stage==='province'?'Tìm tỉnh / thành phố':'Tìm phường / xã';
   const rows=(stage==='province'?data.provinces:(province?.wards||[])).filter(row=>key(row.name).includes(key(search.value)));list.replaceChildren();
   for(const row of rows){const button=doc.createElement('button');button.type='button';button.textContent=row.name;button.dataset.addressCode=row.code;button.addEventListener('click',clickEvent=>{
    clickEvent.preventDefault();clickEvent.stopPropagation();
    if(stage==='province'){province=row;ward=null;legacy=false;delete city.dataset.wardCode;city.value=canonical(row.name);stage='ward';search.value='';sync();event(city,'change');render();list.scrollTop=0;search.focus();}
    else{ward=row;legacy=false;city.dataset.wardCode=row.code;sync();event(city,'change');event(address,'input');close();proxy.focus();}
   });list.append(button);}status.textContent=rows.length?'':(stage==='province'?'Không tìm thấy tỉnh / thành phố.':'Không tìm thấy phường / xã.');
  }
  function open(){panel.hidden=false;proxy.setAttribute('aria-expanded','true');search.value='';render();search.focus();}
  back.addEventListener('click',()=>{stage='province';search.value='';render();search.focus();});
  proxy.addEventListener('click',open);proxy.addEventListener('keydown',e=>{if(['Enter','ArrowDown',' '].includes(e.key)){e.preventDefault();open();}});
  proxy.addEventListener('input',()=>{const query=proxy.value;open();search.value=query;render();});
  search.addEventListener('input',render);panel.addEventListener('keydown',e=>{if(e.key==='Escape'){e.preventDefault();close();proxy.focus();return;}if(!['ArrowDown','ArrowUp'].includes(e.key))return;const buttons=[...list.querySelectorAll('button')];if(!buttons.length)return;e.preventDefault();const index=buttons.indexOf(doc.activeElement);buttons[index<0?(e.key==='ArrowDown'?0:buttons.length-1):(index+(e.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length].focus();});
  doc.addEventListener('click',e=>{if(!wrap.contains(e.target)&&!panel.hidden)close();});
  form.addEventListener('reset',()=>{setTimeout(()=>{province=null;ward=null;legacy=false;city.value='';delete city.dataset.wardCode;close();},0);});
  const controller={restore(street,value,preserveLegacy){
   province=data.provinces.find(p=>p.name===canonical(value))||null;ward=null;legacy=Boolean(preserveLegacy&&street);delete city.dataset.wardCode;
   if(province){ward=province.wards.find(w=>String(street).endsWith(', '+w.name))||null;if(ward){address.value=String(street).slice(0,-ward.name.length-2);city.dataset.wardCode=ward.code;legacy=false;}}
   stage=province?'ward':'province';sync();
  },getAddress(validate=true){validity();if(validate&&province&&!ward&&!legacy){proxy.reportValidity?.();throw Error('Chọn phường / xã để hoàn tất địa chỉ.');}const street=String(address.value||'').trim();return ward&&street&&!street.endsWith(', '+ward.name)?street+', '+ward.name:street;},refresh:sync};
  controls.set(city,controller);city.addEventListener('change',()=>{if(city.value!==(province?.name||''))controller.restore(address.value,city.value,false);});controller.restore(address.value,city.value,true);
 }
 function unifyAddressForm(form,city){
  const address=form.querySelector('[name="address"]');if(!address)return;
  const streetLabel=address.closest('label'),cityLabel=city.closest('label'),nickname=form.querySelector('input[name="label"]');
  if(nickname){nickname.type='hidden';nickname.required=false;const old=nickname.closest('label');if(old){old.hidden=true;old.classList.add('vn-address-name-legacy');}if(!nickname.value)nickname.value='Địa chỉ giao hàng';}
  if(streetLabel){streetLabel.classList.add('vn-street-label');for(const node of streetLabel.childNodes)if(node.nodeType===3&&node.textContent.trim())node.textContent='Địa chỉ nhận hàng';if(cityLabel&&cityLabel.parentNode===streetLabel.parentNode&&streetLabel.nextElementSibling!==cityLabel)cityLabel.before(streetLabel);}
  address.placeholder='Số nhà, tên đường, thôn / tổ dân phố';
  if(!form.dataset.vnUnified){form.dataset.vnUnified='true';form.addEventListener('submit',()=>{const name=form.querySelector('input[name="label"]');if(name&&!name.value.trim())name.value='Địa chỉ giao hàng';},{capture:true});}
 }
 function enhance(target){
  const selector='input[name="city"],select[name="city"],select[data-delivery-city]';const nodes=[...(target.matches?.(selector)?[target]:[]),...(target.querySelectorAll?.(selector)||[])];
  for(let node of nodes){if(!node.dataset.vnCity)node=selectProvince(node);const form=node.closest('form');if(form&&!node.hasAttribute('data-delivery-city')){
   unifyAddressForm(form,node);
   if(!data&&form.querySelector('[name="address"]')&&!node._vnFallback){
    const help=node.ownerDocument.createElement('p');help.className='vn-address-fallback';const message=node.ownerDocument.createElement('span');message.textContent='Danh mục phường / xã đang tải. ';const retry=node.ownerDocument.createElement('button');retry.type='button';retry.textContent='Tải lại';help.append(message,retry);node.insertAdjacentElement('afterend',help);node._vnFallback=help;
    const refresh=async force=>{const ready=await loadData(force);if(ready)enhance(form);else message.textContent='Chưa tải được danh mục phường / xã. Bạn có thể thử lại. ';};retry.addEventListener('click',()=>refresh(true));node.addEventListener('focus',()=>refresh(false));
   }
   makeControl(node,form);
  }}
 }
 function setAddress(form,values){const address=form.querySelector('[name="address"]'),city=form.querySelector('[name="city"]');if(address&&values.address!==undefined)address.value=values.address||'';if(city){setValue(city,values.city||'',false);controls.get(city)?.restore(address?.value||'',values.city||'',true);}}
 function getAddress(form,{validate=true}={}){const city=form.querySelector('[name="city"]');return controls.get(city)?.getAddress(validate)??String(form.querySelector('[name="address"]')?.value||'').trim();}
 return {provinces,canonical,setValue,enhance,setData,loadData,setAddress,getAddress};
});
