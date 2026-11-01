const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {parseHTML}=require('linkedom');

test('personal information summary contains contacts and the editable profile form mount',()=>{
  const {document}=parseHTML(fs.readFileSync(path.join(__dirname,'../account.html'),'utf8'));
  const details=document.querySelector('[data-profile-details]');
  assert.ok(details);
  assert.equal(details.firstElementChild.tagName,'SUMMARY');
  assert.equal(details.firstElementChild.textContent.trim(),'Thông tin cá nhân');
  for(const selector of ['[data-customer-email]','[data-customer-phone]','[data-profile-editor-slot]']){
    assert.equal(details.querySelector(selector)?.closest('details'),details,`${selector} should be inside the personal information disclosure`);
  }
  const experience=fs.readFileSync(path.join(__dirname,'../customer-experience.js'),'utf8');
  assert.match(experience,/profile\.querySelector\('\[data-profile-editor-slot\]'\)/);
  assert.match(experience,/data-profile-form/);
});
