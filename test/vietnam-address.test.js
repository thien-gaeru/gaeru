const test=require('node:test'),assert=require('node:assert/strict'),{parseHTML}=require('linkedom'),address=require('../vietnam-address');
test('Vietnam province choices are unique and do not guess merged legacy provinces',()=>{assert.equal(new Set(address.provinces).size,34);assert.equal(address.canonical('Thành phố Hồ Chí Minh'),'Hồ Chí Minh');assert.equal(address.canonical('Tỉnh Ninh Bình'),'Ninh Bình');assert.equal(address.canonical('Nam Định'),'');assert.equal(address.canonical(''),'');});
test('all city inputs and delivery selectors become province selectors without losing form attributes',()=>{const {document}=parseHTML('<html><body><label>Tỉnh<input name="city" required autocomplete="address-level1"></label><select data-delivery-city><option>Toàn quốc</option></select></body></html>');address.enhance(document);const nodes=[...document.querySelectorAll('select')];assert.equal(nodes.length,2);assert.equal(nodes[0].name,'city');assert.ok(nodes[0].hasAttribute('required'));assert.equal(nodes[0].getAttribute('autocomplete'),'address-level1');for(const node of nodes)assert.equal(node.querySelectorAll('option').length,35);address.enhance(document);assert.equal(nodes[0].querySelectorAll('option').length,35);});

test('full address picker preserves selected wards through save and edit without guessing old addresses',()=>{
 const data=require('../assets/data/vietnam-addresses.json');address.setData(data);
 const {document,window}=parseHTML('<html><body><form><label>Địa chỉ<input name="address" value="12 Đường chính"></label><label>Tỉnh<input name="city" required></label></form></body></html>');
 const form=document.querySelector('form');address.enhance(document);const city=form.querySelector('[name=city]'),proxy=form.querySelector('.vn-address-choice');
 // Linkedom does not implement the browser's select.value setter.
 let cityValue='';Object.defineProperty(city,'value',{configurable:true,get:()=>cityValue,set:value=>{cityValue=value;}});
 assert.equal(form.querySelectorAll('.vn-address-picker').length,1);assert.equal(city.hidden,true);assert.equal(proxy.required,true);
 proxy.dispatchEvent(new window.Event('click',{bubbles:true}));const province=form.querySelector('[data-address-code="01"]');province.click();assert.equal(city.value,'Hà Nội');assert.throws(()=>address.getAddress(form),/phường \/ xã/);
 form.querySelector('[data-address-code="00004"]').click();assert.equal(address.getAddress(form),'12 Đường chính, Phường Ba Đình');
 address.setAddress(form,{address:'12 Đường chính, Phường Ba Đình',city:'Hà Nội'});assert.equal(form.querySelector('[name=address]').value,'12 Đường chính');assert.equal(address.getAddress(form),'12 Đường chính, Phường Ba Đình');assert.equal(city.dataset.wardCode,'00004');
 address.setAddress(form,{address:'Ngõ cũ, khu phố ghi trên hồ sơ',city:'Hà Nội'});assert.equal(address.getAddress(form),'Ngõ cũ, khu phố ghi trên hồ sơ');assert.equal(city.dataset.wardCode,undefined);
 address.enhance(document);assert.equal(form.querySelectorAll('.vn-address-picker').length,1);
});
test('address picker supports text search and Escape while delivery estimates remain province only',()=>{
 address.setData(require('../assets/data/vietnam-addresses.json'));
 const {document,window}=parseHTML('<html><body><form><input name="address"><label>Tỉnh<input name="city"></label></form><select data-delivery-city></select></body></html>');address.enhance(document);
 const proxy=document.querySelector('.vn-address-choice');const openEvent=new window.Event('keydown',{bubbles:true});openEvent.key='ArrowDown';proxy.dispatchEvent(openEvent);assert.equal(proxy.getAttribute('aria-expanded'),'true');
 const search=document.querySelector('.vn-address-search');search.value='ha noi';search.dispatchEvent(new window.Event('input',{bubbles:true}));assert.equal(document.querySelectorAll('.vn-address-options button').length,1);assert.equal(document.querySelector('.vn-address-options button').textContent,'Hà Nội');
 const closeEvent=new window.Event('keydown',{bubbles:true});closeEvent.key='Escape';search.dispatchEvent(closeEvent);assert.equal(proxy.getAttribute('aria-expanded'),'false');assert.equal(document.querySelector('[data-delivery-city]').hidden,false);assert.equal(document.querySelector('[data-delivery-city]').querySelectorAll('option').length,35);
});
