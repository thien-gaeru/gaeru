const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
async function render(fullName,securityOverrides={}){
  const root={innerHTML:'',addEventListener(){},querySelector(){return null}};
  const data={checkedAt:'2026-10-24T00:00:00Z',owner:{username:'owner-login',fullName,company:'Demo'},counts:{staffActive:0,staffTotal:0,openOrders:0,openCare:0},runtime:{node:'test',mode:'test',uptimeSeconds:60,memoryRssBytes:1048576},services:{ordersEnabled:false,emailConfigured:true},security:{databaseTls:null,ownerMfa:'off',webTlsEnforced:true,...securityOverrides},integrations:{shopee:{saved:true}}};
  const window={GAERUAdmin:{user:{role:'owner',source:'bootstrap'},request:async()=>data},GAERUConfiguration:{mountProfile:async()=>{},mountOperations:async()=>{}}};
  vm.runInNewContext(fs.readFileSync('admin/owner.js','utf8'),{window,document:{querySelector:()=>root},Date});
  await window.GAERUOwner.load();
  return root.innerHTML;
}
test('owner overview uses saved name, displays database backend TLS & web TLS, and distinguishes configuration from verification',async()=>{
  const html=await render('Owner Example',{databaseTls:true,databaseCertificateVerified:true,databaseBackendTls:true,databaseTlsProtocol:'TLSv1.3',databaseTlsCipher:'TLS_AES_256_GCM_SHA384'});
  assert.ok(html.includes('Owner Example</strong>'));
  assert.ok(html.includes('Chưa kiểm tra gửi thư'));
  assert.ok(html.includes('Đã lưu cấu hình'));
  assert.ok(html.includes('Chưa cấp quyền và xác minh đồng bộ'));
  assert.ok(html.includes('Đang tạm dừng'));
  assert.ok(html.includes('TLS phía máy chủ dữ liệu'));
  assert.ok(html.includes('Máy chủ báo dùng TLS (TLSv1.3 · TLS_AES_256_GCM_SHA384)'));
  assert.ok(html.includes('TLS Web (HTTPS)'));
  assert.ok(html.includes('Kiểm tra TLS máy chủ dữ liệu'));
});
test('owner name is escaped and missing name falls back to username',async()=>{
  assert.ok((await render('<img src=x onerror=alert(1)>')).includes('&lt;img'));
  assert.ok(!(await render('<img src=x>')).includes('<img src=x>'));
  assert.ok((await render('')).includes('owner-login</strong>'));
});
