// admin/configuration-channels.js
// Kết nối kênh: cổng thanh toán, đơn vị vận chuyển và đăng nhập Google (OAuth).
// Module chỉ khai báo metadata + controller; configuration.js khởi tạo controller với ngữ cảnh dùng chung.
(()=>{
const esc=window.GAERUAdminShared.escapeHtml;

const SHIPPING_CONFIG_IDS=['shipping_ghn','shipping_ghtk','shipping_viettel','shipping_jt','shipping_spx'];
const GATEWAY_CONFIG_IDS=['vnpay','payment_9pay','payment_momo','payment_zalopay'];
const OFFLINE_PAYMENT_CONFIG_IDS=['payment_cod','payment_bank_transfer'];

const titles={
 shipping_ghn:'Giao Hàng Nhanh (GHN)',
 shipping_ghtk:'Giao Hàng Tiết Kiệm (GHTK)',
 shipping_viettel:'Viettel Post',
 shipping_jt:'J&T Express',
 shipping_spx:'Shopee Express (SPX Express)',
 payment_cod:'Thanh toán khi nhận hàng (COD)',
 payment_bank_transfer:'Chuyển khoản ngân hàng (VietQR)',
 vnpay:'Cổng thanh toán VNPAY',
 payment_9pay:'Cổng thanh toán 9Pay',
 payment_momo:'Ví điện tử MoMo',
 payment_zalopay:'Ví điện tử ZaloPay',
 oauth:'Đăng nhập Google (OAuth)'
};

const paymentMap={cod:'payment_cod',bank_transfer:'payment_bank_transfer',vnpay:'vnpay','9pay':'payment_9pay',momo:'payment_momo',zalopay:'payment_zalopay'};
const paymentIds=new Set(['payments','vnpay','payment_cod','payment_bank_transfer','payment_9pay','payment_momo','payment_zalopay']);

function authenticatedPaymentProof(channel){
 if(!channel?.verified||['cod','bank_transfer'].includes(channel.id))return false;
 if(channel.verificationScope==='callback_signature')return channel.method==='signed_callback';
 return channel.verificationScope==='api_credentials'&&['authenticated_api','provider_order_create'].includes(channel.method);
}

function paymentVerificationBadge(channel){
 if(channel.supported===false||channel.id==='9pay')return '<span class="payment-badge badge-pending">Chưa hỗ trợ nhận thanh toán</span>';
 if(['cod','bank_transfer'].includes(channel.id))return channel.method==='configuration_validation'
  ?'<span class="payment-badge badge-pending">Đã kiểm tra cấu hình</span>'
  :'<span class="payment-badge badge-unconfigured">'+(channel.configured?'Đã lưu cấu hình':'Chưa cấu hình')+'</span>';
 if(authenticatedPaymentProof(channel)){
  const label=channel.verificationScope==='callback_signature'?'Đã xác thực phản hồi thanh toán':channel.callbackVerified?'Đã xác thực API và phản hồi':'Đã xác thực API · Chưa kiểm tra phản hồi';
  return '<span class="payment-badge badge-verified">✓ '+label+'</span>';
 }
 if(channel.reachable)return '<span class="payment-badge badge-pending">Liên lạc được · Chưa xác minh</span>';
 return '<span class="payment-badge '+(channel.configured?'badge-pending':'badge-unconfigured')+'">'+(channel.configured?'Chưa xác minh tài khoản':'Chưa cấu hình')+'</span>';
}

const fieldPlaceholders={
 payment_cod:{maxAmountVnd:'50000000',instructions:'Thanh toán tiền mặt trực tiếp cho bưu tá khi nhận hàng.'},
 payment_bank_transfer:{bankName:'VD: Vietcombank, Techcombank, MB...',accountNumber:'VD: 1903888999 (hệ thống tự lọc khoảng trắng)',accountHolder:'VD: NGUYEN VAN A hoặc CÔNG TY TNHH...',branch:'VD: Sở Giao Dịch, CN Sài Gòn (tùy chọn)',transferSyntax:'Cú pháp: GAERU {MA_DON}'},
 vnpay:{tmnCode:'Mã website 8 ký tự (VD: GAERUVN1)'},
 payment_9pay:{merchantKey:'Merchant Key do 9Pay cấp'},
 payment_momo:{partnerCode:'Partner Code do MoMo cấp',accessKey:'Access Key do MoMo cấp'},
 payment_zalopay:{appId:'App ID (dãy số do ZaloPay cấp, VD: 2554)'}
};

const fields={
 payment_cod:[['maxAmountVnd','Hạn mức tối đa đơn COD (₫)','number'],['instructions','Hướng dẫn thanh toán khi nhận hàng']],
 payment_bank_transfer:[['bankName','Tên ngân hàng thụ hưởng'],['accountNumber','Số tài khoản'],['accountHolder','Chủ tài khoản'],['branch','Chi nhánh (không bắt buộc)'],['transferSyntax','Cú pháp nội dung chuyển khoản']],
 vnpay:[['tmnCode','Mã website / TmnCode'],['hashSecret','Hash secret','password']],
 payment_9pay:[['merchantKey','Merchant Key'],['secretKey','Secret Key','password'],['checksumKey','Checksum Key','password']],
 payment_momo:[['partnerCode','Partner Code'],['accessKey','Access Key'],['secretKey','Secret Key','password']],
 payment_zalopay:[['appId','App ID'],['key1','Key 1 (Khóa tạo đơn)','password'],['key2','Key 2 (Khóa đối soát callback)','password']],
 oauth:[['googleClientId','Google Client ID (từ Google Cloud Console)']]
};

for(const id of SHIPPING_CONFIG_IDS){
 fields[id]=[
  ['accountId',id==='shipping_ghn'?'Shop ID':'Mã khách hàng / tài khoản API'],
  ['partnerCode','Mã đối tác / API account (nếu hãng cấp)'],
  ['secret',id==='shipping_jt'?'Khóa API / private key':'API Token','password'],
  ['pickupName','Tên người gửi'],
  ['pickupPhone','Điện thoại lấy hàng'],
  ['pickupAddress','Địa chỉ kho lấy hàng']
 ];
}

const channelMeta={
 cod:{title:'COD · Tiền mặt khi nhận hàng',sub:'Giao hàng thu tiền mặt tận nơi',icon:'<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#059669" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="20" height="12" rx="2"></rect><circle cx="12" cy="12" r="2"></circle><path d="M6 12h.01M18 12h.01"></path></svg>'},
 bank_transfer:{title:'Chuyển khoản VietQR',sub:'Thông tin nhận chuyển khoản, xác nhận sau đối chiếu',icon:'<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#0284c7" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21h18M3 10h18M5 10v11M9 10v11M15 10v11M19 10v11M12 2L2 7h20L12 2z"></path></svg>'},
 vnpay:{title:'Cổng thanh toán VNPAY',sub:'VNPAY-QR, Thẻ ATM nội địa & Quốc tế Visa/Master',icon:'<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#005baa" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="20" height="14" rx="2"></rect><line x1="2" y1="10" x2="22" y2="10"></line><path d="M7 15h2M12 15h5"></path></svg>'},
 '9pay':{title:'Cổng thanh toán 9Pay',sub:'Ví điện tử 9Pay, Thẻ ATM/Visa/Master, 9Pay QR',icon:'<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#ea580c" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 22 8.5 22 15.5 12 22 2 15.5 2 8.5 12 2"></polygon><line x1="12" y1="22" x2="12" y2="12"></line><line x1="2" y1="8.5" x2="12" y2="12"></line><line x1="22" y1="8.5" x2="12" y2="12"></line></svg>'},
 momo:{title:'Ví điện tử MoMo',sub:'Ví MoMo, MoMo QR, Ví trả sau, thẻ liên kết',icon:'<svg width="26" height="26" viewBox="0 0 24 24"><rect width="24" height="24" rx="5" fill="#d82d8b"/><path d="M6 16V8h2.2l1.9 4.2L12 8h2.2v8h-1.8v-5.2l-1.7 3.8h-1.4l-1.7-3.8V16H6z" fill="#fff"/></svg>'},
 zalopay:{title:'Ví điện tử ZaloPay',sub:'ZaloPay Gateway, ZaloPay QR, ví Zalo',icon:'<svg width="26" height="26" viewBox="0 0 24 24"><rect width="24" height="24" rx="5" fill="#0068ff"/><path d="M7 8h10l-6.5 6.5H17V17H7l6.5-6.5H7V8z" fill="#fff"/></svg>'}
};

const shippingMeta={
 shipping_ghn:{id:'ghn',name:'Giao Hàng Nhanh (GHN)',sub:'Mạng lưới bưu cục toàn quốc, giao nhanh 24h',icon:'<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#f97316" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="3" width="15" height="13"></rect><polygon points="16 8 20 8 23 11 23 16 16 16 8"></polygon><circle cx="5.5" cy="18.5" r="2.5"></circle><circle cx="18.5" cy="18.5" r="2.5"></circle></svg>'},
 shipping_ghtk:{id:'ghtk',name:'Giao Hàng Tiết Kiệm (GHTK)',sub:'Tối ưu chi phí cho shop online, giao hàng nội ngoại tỉnh',icon:'<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#16a34a" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18.5" cy="17.5" r="3.5"></circle><circle cx="5.5" cy="17.5" r="3.5"></circle><circle cx="15" cy="5" r="1"></circle><path d="M12 17.5V14l-3-3 4-3 2 3h2"></path></svg>'},
 shipping_viettel:{id:'viettel',name:'Viettel Post',sub:'Chuyển phát bưu chính quân đội, phủ sóng đến từng xã đảo',icon:'<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#dc2626" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"></path><polyline points="22,6 12,13 2,6"></polyline></svg>'},
 shipping_jt:{id:'jt',name:'J&T Express',sub:'Chuyển phát nhanh tiêu chuẩn & dịch vụ hỏa tốc toàn quốc',icon:'<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#e11d48" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M12 5l7 7-7 7"></path></svg>'},
 shipping_spx:{id:'spx',name:'Shopee Express (SPX)',sub:'Vận chuyển Shopee Express, mạng lưới bưu cục và giao nhanh toàn quốc',icon:'<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#ee4d2d" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"></path></svg>'}
};

const GOOGLE_ICON='<svg width="26" height="26" viewBox="0 0 18 18" fill="none" aria-hidden="true"><path d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.717v2.258h2.908c1.702-1.567 2.684-3.874 2.684-6.616z" fill="#4285F4"/><path d="M9 18c2.43 0 4.467-.806 5.956-2.184l-2.908-2.258c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 009 18z" fill="#34A853"/><path d="M3.964 10.707c-.18-.54-.282-1.117-.282-1.707s.102-1.167.282-1.707V4.961H.957A8.996 8.996 0 000 9c0 1.452.348 2.827.957 4.039l3.007-2.332z" fill="#FBBC05"/><path d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 00.957 4.961L3.964 7.293C4.672 5.166 6.656 3.58 9 3.58z" fill="#EA4335"/></svg>';

const configModalMeta={
 payment_cod:{title:'Cấu hình & Khóa · Thanh toán khi nhận hàng (COD)',sub:'Hạn mức COD và hướng dẫn người mua thanh toán tiền mặt',icon:channelMeta.cod.icon},
 payment_bank_transfer:{title:'Cấu hình & Khóa · Chuyển khoản VietQR',sub:'Tài khoản thụ hưởng và hướng dẫn đối chiếu tiền vào',icon:channelMeta.bank_transfer.icon},
 vnpay:{title:'Cấu hình & Khóa bảo mật · Cổng VNPAY',sub:'Mã website TMN, Khóa Hash Secret & URLs đối soát IPN',icon:channelMeta.vnpay.icon},
 payment_9pay:{title:'Cấu hình & Khóa bảo mật · Cổng 9Pay',sub:'Merchant Key, Secret Key, Checksum Key & URLs IPN/Webhook',icon:channelMeta['9pay'].icon},
 payment_momo:{title:'Cấu hình & Khóa bảo mật · Ví MoMo',sub:'Partner Code, Access Key, Secret Key & URLs IPN/Webhook',icon:channelMeta.momo.icon},
 payment_zalopay:{title:'Cấu hình & Khóa bảo mật · Ví ZaloPay',sub:'App ID, Khóa Key 1, Khóa Key 2 & Callback URLs',icon:channelMeta.zalopay.icon},
 shipping_ghn:{title:'Cấu hình & Khóa API · Giao Hàng Nhanh (GHN)',sub:'Shop ID, API Token và thông tin kho lấy hàng',icon:shippingMeta.shipping_ghn.icon},
 shipping_ghtk:{title:'Cấu hình & Khóa API · Giao Hàng Tiết Kiệm (GHTK)',sub:'Mã tài khoản, API Token và thông tin kho lấy hàng',icon:shippingMeta.shipping_ghtk.icon},
 shipping_viettel:{title:'Cấu hình & Khóa API · Viettel Post',sub:'Mã đối tác, API Token và thông tin kho lấy hàng',icon:shippingMeta.shipping_viettel.icon},
 shipping_jt:{title:'Cấu hình & Khóa API · J&T Express',sub:'Mã khách hàng, Khóa API Private Key và thông tin kho lấy hàng',icon:shippingMeta.shipping_jt.icon},
 shipping_spx:{title:'Cấu hình & Khóa API · Shopee Express (SPX)',sub:'Mã khách hàng / Shop ID, API Key / Token SPX và thông tin kho lấy hàng',icon:shippingMeta.shipping_spx.icon},
 oauth:{title:'Cấu hình & Khóa · Đăng nhập Google',sub:'Google Client ID cho phép khách hàng đăng nhập nhanh qua Google',icon:GOOGLE_ICON}
};

function renderWebhookBox(configId,callbacks={}){
 let rows=[];
 let note='';
 if(configId==='vnpay'){
  rows=[
   {label:'Return URL',url:callbacks.vnpayReturn||'https://gaeru.com/api/payments/vnpay/return'},
   {label:'IPN URL',url:callbacks.vnpayIpn||'https://gaeru.com/api/payments/vnpay/ipn'}
  ];
  note='Đăng ký 2 URL này vào trang Merchant VNPAY để nhận kết quả thanh toán & tự động duyệt đơn.';
 }else if(configId==='payment_9pay'){
  rows=[
   {label:'Return URL',url:callbacks.ninepayReturn||'https://gaeru.com/api/payments/9pay/return'},
   {label:'IPN URL',url:callbacks.ninepayIpn||'https://gaeru.com/api/payments/9pay/ipn'}
  ];
  note='9Pay chưa hỗ trợ nhận thanh toán trong phiên bản này. Có thể lưu thông tin cấu hình; chưa bật cho người mua.';
 }else if(configId==='payment_momo'){
  rows=[
   {label:'Return URL',url:callbacks.momoReturn||'https://gaeru.com/api/payments/momo/return'},
   {label:'IPN URL',url:callbacks.momoIpn||'https://gaeru.com/api/payments/momo/ipn'}
  ];
  note='Điền IPN URL vào Cổng đối tác MoMo Developers để tự động chuyển đơn sang Chờ gửi hàng.';
 }else if(configId==='payment_zalopay'){
  rows=[
   {label:'Return URL',url:callbacks.zalopayReturn||'https://gaeru.com/api/payments/zalopay/return'},
   {label:'Callback URL',url:callbacks.zalopayIpn||'https://gaeru.com/api/payments/zalopay/ipn'}
  ];
  note='Cài đặt Callback URL trên ZaloPay Portal để nhận thông báo thanh toán thành công.';
 }else if(configId==='payment_bank_transfer'){
  note='Đối chiếu tiền vào tài khoản trước khi xác nhận thủ công. Hệ thống chưa kết nối dịch vụ biến động số dư hoặc xác minh chủ tài khoản ngân hàng.';
 }
 if(!rows.length&&!note)return '';
 const noteHtml=note?'<p style="margin:0 0 8px;font-size:12px;color:#475569;line-height:1.4;">'+esc(note)+'</p>':'';
 const rowsHtml=rows.map(r=>'<div class="config-url-row"><span class="config-url-label">'+esc(r.label)+':</span><code class="config-url-code">'+esc(r.url)+'</code><button type="button" class="config-copy-btn" data-copy="'+esc(r.url)+'">Sao chép</button></div>').join('');
 return '<div class="config-url-list">'+noteHtml+rowsHtml+'</div>';
}

// Các giá trị được nhập dạng chữ phải được cắt khoảng trắng trước khi gửi lên máy chủ.
function readChannelToggles(id,f,values){
 if(GATEWAY_CONFIG_IDS.includes(id)){
  if(f.elements.environment)values.environment=f.elements.environment.value;
  if(f.elements.enabled)values.enabled=f.elements.enabled.checked;
 }
 if(OFFLINE_PAYMENT_CONFIG_IDS.includes(id)){
  if(f.elements.enabled)values.enabled=f.elements.enabled.checked;
 }
}

function normalizeChannelValues(id,values){
 if(id==='payment_bank_transfer'){
  if(typeof values.accountNumber==='string')values.accountNumber=values.accountNumber.replace(/[\s.-]/g,'');
  if(typeof values.bankName==='string')values.bankName=values.bankName.trim();
  if(typeof values.accountHolder==='string')values.accountHolder=values.accountHolder.trim();
  if(typeof values.branch==='string')values.branch=values.branch.trim();
  if(typeof values.transferSyntax==='string')values.transferSyntax=values.transferSyntax.trim();
 }
 if(id==='vnpay'&&typeof values.tmnCode==='string')values.tmnCode=values.tmnCode.trim();
 if(id==='payment_9pay'&&typeof values.merchantKey==='string')values.merchantKey=values.merchantKey.trim();
 if(id==='payment_momo'){
  if(typeof values.partnerCode==='string')values.partnerCode=values.partnerCode.trim();
  if(typeof values.accessKey==='string')values.accessKey=values.accessKey.trim();
 }
 if(id==='payment_zalopay'&&typeof values.appId==='string')values.appId=values.appId.trim();
}

// Trả về {message, focus} khi dữ liệu kênh thanh toán không hợp lệ; null khi được phép gửi.
function validateChannelValues(id,values,curVersion){
 if(id==='vnpay'){
  if(!values.tmnCode||!/^[a-zA-Z0-9]{8}$/.test(values.tmnCode)){
   return {focus:'tmnCode',message:'Mã website VNPAY (TmnCode) cần đúng 8 ký tự chữ hoặc số (VD: GAERUVN1).'};
  }
  if(!curVersion&&!values.hashSecret){
   return {focus:'hashSecret',message:'Vui lòng nhập khóa bí mật (Hash Secret) cho lần cấu hình đầu tiên.'};
  }
 }
 if(id==='payment_9pay'&&!curVersion&&(!values.secretKey||!values.checksumKey)){
  return {message:'Vui lòng nhập Secret Key và Checksum Key cho lần cấu hình đầu tiên.'};
 }
 if(id==='payment_momo'&&!curVersion&&!values.secretKey){
  return {message:'Vui lòng nhập Secret Key MoMo cho lần cấu hình đầu tiên.'};
 }
 if(id==='payment_zalopay'&&!curVersion&&(!values.key1||!values.key2)){
  return {message:'Vui lòng nhập Key 1 và Key 2 ZaloPay cho lần cấu hình đầu tiên.'};
 }
 if(id==='payment_bank_transfer'&&values.accountNumber&&values.accountNumber.length<6){
  return {message:'Số tài khoản ngân hàng từ 6 đến 30 ký tự số/chữ.'};
 }
 if(id==='payment_cod'){
  const max=Number(values.maxAmountVnd);
  if(isNaN(max)||max<100000||max>2000000000){
   return {message:'Hạn mức tối đa đơn COD hợp lệ từ 100.000₫ đến 2.000.000.000₫.'};
  }
 }
 return null;
}

function clearCredentials(form){
 if(form&&form.elements&&form.elements.password)form.elements.password.value='';
 if(form&&form.elements&&form.elements.factorCode)form.elements.factorCode.value='';
 if(form)delete form.dataset.challenge;
}

function setModalStatusClass(status,stateClass){
 if(status&&status.classList&&status.classList.contains('config-modal-status')){
  status.className='config-modal-status is-visible '+stateClass;
 }
}

// ctx = { admin, owner, read, getData, form, openConfigModal }
function createChannelsController(ctx){
 const {admin,owner,read,form,openConfigModal}=ctx;

 async function mountOAuth(){
  const root=document.querySelector('#oauth-configuration');
  if(!root)return;
  if(!owner()){root.textContent='Chỉ chủ doanh nghiệp được thiết lập cấu hình đăng nhập Google.';return;}
  const data=await read();
  const record=data?.records?.oauth||{version:0,data:{}};
  const v=record.data||{};
  const googleId=v.googleClientId||'';
  const googleActive=Boolean(googleId);
  const maskedGoogleId=googleId?(googleId.length>30?googleId.slice(0,14)+'…'+googleId.slice(-14):googleId):'Chưa thiết lập';

  const introHtml='<div class="payment-hub-intro"><div><p><strong>Cấu hình Đăng nhập một chạm Google (OAuth):</strong> Thiết lập Google Client ID để khách hàng có thể đăng nhập hoặc tạo tài khoản GAERU tức thì bằng tài khoản Google an toàn, nhanh chóng.</p><p style="margin-top:6px;font-size:12px;color:#059669;">✓ Sau khi lưu, nút Đăng nhập với Google trên website (/tai-khoan) sẽ tự động kích hoạt.</p></div>'
   +'<div class="payment-hub-stats"><span class="payment-stat-pill">Google: <strong>'+(googleActive?'✓ Đã cấu hình':'○ Chưa thiết lập')+'</strong></span></div></div>';

  const badgesHtml=googleActive
   ?'<span class="payment-badge badge-enabled">● Đang hoạt động</span><span class="payment-badge badge-verified">✓ Đã có Client ID</span>'
   :'<span class="payment-badge badge-disabled">○ Chưa hoạt động</span><span class="payment-badge badge-unconfigured">Chưa cấu hình</span>';

  const googleCard='<article class="payment-card configuration-panel '+(googleActive?'card-enabled':'')+'" id="config-panel-oauth-google">'
   +'<div class="payment-card-header"><div class="payment-card-icon">'+GOOGLE_ICON+'</div><div class="payment-card-header-main"><h3 class="payment-card-title">Google One Tap &amp; Sign-In</h3><p class="payment-card-sub">Đăng nhập tài khoản Google qua Google Identity Services</p><div class="payment-card-badges">'+badgesHtml+'</div></div></div>'
   +'<div class="payment-card-body">'
   +'<div class="payment-snapshot-item"><span class="payment-snapshot-label">Google Client ID:</span><span class="payment-snapshot-val"><code>'+esc(maskedGoogleId)+'</code></span></div>'
   +'<div class="payment-snapshot-item"><span class="payment-snapshot-label">JS Origin:</span><span class="payment-snapshot-val"><code>https://gaeru.com</code></span></div>'
   +'<div class="payment-snapshot-item"><span class="payment-snapshot-label">Redirect URI:</span><span class="payment-snapshot-val"><code>https://gaeru.com/account.html</code></span></div>'
   +'<p class="help-text" style="margin-top:8px;">Lấy mã tại: <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noopener">Google Cloud Console ↗</a> (APIs &amp; Services &gt; Credentials &gt; OAuth 2.0 Client IDs).</p>'
   +'</div>'
   +'<div class="payment-card-actions"><button type="button" class="payment-action-btn payment-btn-setup" data-open-config-popup="oauth">⚙ Cấu hình Client ID</button><a href="/account.html" target="_blank" rel="noopener" class="payment-action-btn payment-btn-test" style="text-decoration:none;display:inline-flex;align-items:center;justify-content:center;">Xem trang đăng nhập ↗</a></div>'
   +'</article>';

  const formSection='<div class="editor-card" style="margin-top:20px;"><div class="editor-heading"><div><h3>Thiết lập mã Google Client ID</h3><p class="help-text">Nhập mã định danh vào ô bên dưới và bấm Lưu cài đặt để áp dụng ngay.</p></div></div>'+form('oauth')+'</div>';

  root.innerHTML=introHtml+'<div class="payment-channel-grid">'+googleCard+'</div>'+formSection;
 }

 function shippingCardHtml(configId,carriers,data){
  const meta=shippingMeta[configId];
  const carrier=carriers.find(c=>c.id===meta.id)||{id:meta.id,verified:false,enabled:false,supported:true};
  const record=data?.records?.[configId]||{version:0,data:{}};
  const v=record.data||{};

  const statusPill=carrier.enabled?'<span class="payment-badge badge-enabled">● Đang bật</span>':'<span class="payment-badge badge-disabled">○ Đang tắt</span>';
  const verifyPill=carrier.verified?'<span class="payment-badge badge-verified">✓ Đã xác minh</span>':record.version?'<span class="payment-badge badge-pending">⏳ Chưa xác minh</span>':'<span class="payment-badge badge-unconfigured">Chưa cấu hình</span>';

  const snapshotHtml='<div class="payment-snapshot-item"><span class="payment-snapshot-label">'+(meta.id==='ghn'?'Shop ID:':'Mã tài khoản / KH:')+'</span><span class="payment-snapshot-val"><code>'+esc(v.accountId||'Chưa thiết lập')+'</code></span></div>'
   +'<div class="payment-snapshot-item"><span class="payment-snapshot-label">Người gửi:</span><span class="payment-snapshot-val">'+esc(v.pickupName||'Chưa thiết lập')+'</span></div>'
   +'<div class="payment-snapshot-item"><span class="payment-snapshot-label">Kho lấy hàng:</span><span class="payment-snapshot-val">'+esc(v.pickupAddress||'Chưa thiết lập')+'</span></div>'
   +'<div class="payment-snapshot-item"><span class="payment-snapshot-label">Khóa kết nối:</span><span class="payment-snapshot-val">'+(v.secretConfigured?'✓ Đã mã hóa':'Chưa nhập khóa')+'</span></div>';

  const carrierActions=carrier.supported
   ?'<button type="button" class="payment-action-btn '+(carrier.enabled?'payment-btn-disable':'payment-btn-enable')+'" data-shipping-enable="'+carrier.id+'" data-enabled="'+(!carrier.enabled)+'">'+(carrier.enabled?'Tắt hãng':'Bật hãng')+'</button>'
    +'<button type="button" class="payment-action-btn payment-btn-test" data-shipping-test="'+carrier.id+'">Kiểm tra kết nối</button>'
   :'<p>Chưa hoàn tất tích hợp API.</p>';

  return '<article class="payment-card configuration-panel '+(carrier.enabled?'card-enabled':'')+'" id="config-panel-'+configId+'" data-carrier-id="'+meta.id+'">'
   +'<div class="payment-card-header"><div class="payment-card-icon">'+meta.icon+'</div><div class="payment-card-header-main"><h3 class="payment-card-title">'+esc(meta.name)+'</h3><p class="payment-card-sub">'+esc(meta.sub)+'</p><div class="payment-card-badges">'+statusPill+verifyPill+'</div></div></div>'
   +'<div class="payment-card-body">'+snapshotHtml+'</div>'
   +'<div class="payment-card-actions"><button type="button" class="payment-action-btn payment-btn-setup" data-open-config-popup="'+configId+'">⚙ Cấu hình &amp; Khóa API</button>'+carrierActions+'<p role="status" class="payment-card-status" data-shipping-result></p></div>'
   +'<details class="payment-card-drawer" id="drawer-'+configId+'" style="display:none"><summary class="payment-drawer-summary"><span>⚙ Chi tiết cấu hình</span></summary>'+form(configId)+'</details>'
   +'</article>';
 }

 async function mountShipping(){
  const root=document.querySelector('#shipping-configuration');
  if(!root)return;
  if(!owner()){root.textContent='Chỉ chủ doanh nghiệp được thiết lập khóa kết nối vận chuyển.';return;}
  const data=await read();
  const info=await admin.request('/api/gaeru_ceo/owner/shipping');
  const carriers=info.carriers||[];
  const activeCount=carriers.filter(c=>c.enabled).length;
  const verifiedCount=carriers.filter(c=>c.verified).length;

  const introHtml='<div class="payment-hub-intro"><div><p><strong>Quản lý kết nối vận chuyển:</strong> Thiết lập tài khoản API, mã hóa Token kết nối của các đơn vị vận chuyển hàng đầu tại Việt Nam. Bật đơn vị vận chuyển đã xác minh để người mua tự do lựa chọn khi đặt hàng.</p><p style="margin-top:6px;font-size:12px;color:#059669;">✓ Phí giao hàng áp dụng linh hoạt theo cấu hình bảng giá tỉnh/thành phố GAERU.</p></div>'
   +'<div class="payment-hub-stats"><span class="payment-stat-pill">● Đang bật: <strong>'+activeCount+'/5</strong></span><span class="payment-stat-pill">🛡️ Đã xác minh: <strong>'+verifiedCount+'/5</strong></span></div></div>';

  const cardsHtml=SHIPPING_CONFIG_IDS.map(configId=>shippingCardHtml(configId,carriers,data)).join('');
  root.innerHTML=introHtml+'<div class="payment-channel-grid shipping-channel-grid">'+cardsHtml+'</div>';
 }

 function snapshotItem(label,valueHtml){
  return '<div class="payment-snapshot-item"><span class="payment-snapshot-label">'+label+'</span><span class="payment-snapshot-val">'+valueHtml+'</span></div>';
 }

 function paymentSnapshotHtml(chId,v){
  const environment=v.environment==='production'?'Chính thức':'Thử nghiệm';
  const secretState=v.secretConfigured?'✓ Đã mã hóa':'Chưa nhập khóa';
  if(chId==='cod'){
   return snapshotItem('Hạn mức tối đa:',Number(v.maxAmountVnd||50000000).toLocaleString('vi-VN')+'₫')
    +snapshotItem('Phí vận chuyển:','Theo bảng giá tỉnh/thành')
    +snapshotItem('Xác nhận đơn:','Quy trình tiêu chuẩn');
  }
  if(chId==='bank_transfer'){
   return snapshotItem('Ngân hàng:',esc(v.bankName||'Chưa thiết lập'))
    +snapshotItem('Số tài khoản:',esc(v.accountNumber||'Chưa thiết lập'))
    +snapshotItem('Chủ tài khoản:',esc(v.accountHolder||'Chưa thiết lập'))
    +snapshotItem('Cú pháp:','<code>'+esc(v.transferSyntax||'GAERU {MA_DON}')+'</code>');
  }
  if(chId==='vnpay'){
   return snapshotItem('Mã website (TMN):','<code>'+esc(v.tmnCode||'Chưa thiết lập')+'</code>')
    +snapshotItem('Môi trường:',environment)
    +snapshotItem('Khóa Hash Secret:',secretState);
  }
  if(chId==='9pay'){
   return snapshotItem('Merchant Key:','<code>'+(v.merchantKey?esc(v.merchantKey.slice(0,8)+'••••'):'Chưa thiết lập')+'</code>')
    +snapshotItem('Môi trường:',environment)
    +snapshotItem('Khóa bí mật:',secretState);
  }
  if(chId==='momo'){
   return snapshotItem('Partner Code:','<code>'+esc(v.partnerCode||'Chưa thiết lập')+'</code>')
    +snapshotItem('Môi trường:',environment)
    +snapshotItem('Secret Key:',secretState);
  }
  return snapshotItem('App ID:','<code>'+esc(v.appId||'Chưa thiết lập')+'</code>')
   +snapshotItem('Môi trường:',environment)
   +snapshotItem('Key 1 &amp; Key 2:',secretState);
 }

 function paymentIntegrationBoxHtml(chId,callbacks){
  if(chId==='cod')return '<div class="payment-integration-box">Thu tiền mặt khi giao hàng. Kiểm tra cấu hình đối chiếu hạn mức COD và bảng phí vận chuyển; không xác thực kết nối với hãng vận chuyển.</div>';
  if(chId==='bank_transfer')return '<div class="payment-integration-box">Cần đối chiếu thủ công tiền vào tài khoản trước khi xác nhận thanh toán. Kiểm tra cấu hình chỉ kiểm tra định dạng, không xác minh chủ tài khoản.</div>';
  const urls={
   vnpay:['VNPAY URLs:','IPN URL',callbacks.vnpayReturn,callbacks.vnpayIpn],
   '9pay':['9Pay URLs:','IPN URL',callbacks.ninepayReturn,callbacks.ninepayIpn],
   momo:['MoMo URLs:','IPN URL',callbacks.momoReturn,callbacks.momoIpn],
   zalopay:['ZaloPay URLs:','Callback IPN URL',callbacks.zalopayReturn,callbacks.zalopayIpn]
  }[chId]||['ZaloPay URLs:','Callback IPN URL',callbacks.zalopayReturn,callbacks.zalopayIpn];
  const [heading,ipnLabel,returnUrl,ipnUrl]=urls;
  return '<div class="payment-integration-box"><strong>'+heading+'</strong><br>Return URL: <code>'+esc(returnUrl||'')+'</code><br>'+ipnLabel+': <code>'+esc(ipnUrl||'')+'</code></div>';
 }

 function paymentCardHtml(chId,channels,callbacks,data){
  const configId=paymentMap[chId];
  const channel=channels.find(c=>c.id===chId)||{id:chId,configId,verified:false,enabled:chId==='cod',version:data.records[configId]?.version||0};
  const record=data.records[configId]||{version:0,data:{}};
  const v=record.data||{};
  const meta=channelMeta[chId]||{title:titles[configId],sub:'',icon:''};

  const envPill=v.environment?(v.environment==='production'?'<span class="payment-badge badge-prod">Chính thức</span>':'<span class="payment-badge badge-sandbox">Thử nghiệm</span>'):'';
  const statusPill=channel.enabled?'<span class="payment-badge badge-enabled">● Đang bật</span>':'<span class="payment-badge badge-disabled">○ Đang tắt</span>';
  const verifyPill=paymentVerificationBadge(channel);
  const enableBlocked=!channel.enabled&&(chId==='9pay'||channel.canEnable===false||channel.supported===false);
  const readinessHtml=channel.unsupportedReason
   ?'<p class="help-text">'+esc(channel.unsupportedReason)+'</p>'
   :channel.enabled&&channel.checkoutReady===false?'<p class="help-text">Kênh đã bật nhưng chưa sẵn sàng nhận thanh toán.</p>':'';

  return '<article class="payment-card configuration-panel '+(channel.enabled?'card-enabled':'')+'" id="config-panel-'+configId+'" data-channel-id="'+chId+'">'
   +'<div class="payment-card-header"><div class="payment-card-icon">'+meta.icon+'</div><div class="payment-card-header-main"><h3 class="payment-card-title">'+meta.title+'</h3><p class="payment-card-sub">'+meta.sub+'</p><div class="payment-card-badges">'+statusPill+verifyPill+envPill+'</div></div></div>'
   +'<div class="payment-card-body">'+paymentSnapshotHtml(chId,v)+readinessHtml+'</div>'
   +'<div class="payment-card-actions">'
   +'<button type="button" class="payment-action-btn payment-btn-setup" data-open-config-popup="'+configId+'" data-toggle-drawer="'+configId+'">⚙ Cấu hình &amp; Khóa</button>'
   +'<button type="button" class="payment-action-btn '+(channel.enabled?'payment-btn-disable':'payment-btn-enable')+'" data-payment-enable="'+chId+'" data-enabled="'+(!channel.enabled)+'" '+(enableBlocked?'disabled':'')+'>'+(channel.enabled?'Tắt kênh':'Bật kênh')+'</button>'
   +'<button type="button" class="payment-action-btn payment-btn-test" data-payment-test="'+chId+'">Kiểm tra kết nối</button>'
   +'<p role="status" class="payment-card-status" data-payment-result></p></div>'
   +'<details class="payment-card-drawer" id="drawer-'+configId+'" style="display:none"><summary class="payment-drawer-summary"><span>⚙ Chi tiết cấu hình, Khóa bảo mật &amp; Webhook</span></summary>'+paymentIntegrationBoxHtml(chId,callbacks)+form(configId)+'</details>'
   +'</article>';
 }

 const RECONCILE_FORM_HTML='<details class="configuration-panel" id="config-panel-payment-reconcile"><summary>Xác nhận thanh toán sau đối chiếu</summary>'
  +'<p class="help-text">Chỉ xác nhận tại đây sau khi đã đối chiếu tiền thực nhận và chứng từ của đúng đơn hàng. Thao tác này ghi nhận thanh toán thủ công; không truy vấn số dư ngân hàng và không chuyển tiền.</p>'
  +'<form class="configuration-form" data-payment-reconcile-form><div class="form-grid">'
  +'<label>Kênh thanh toán trước<select name="provider"><option value="bank_transfer">Chuyển khoản ngân hàng</option><option value="momo">Ví điện tử MoMo</option><option value="zalopay">Ví điện tử ZaloPay</option><option value="vnpay">Cổng VNPAY</option><option value="9pay">9Pay (đơn lịch sử)</option></select></label>'
  +'<label>Mã đơn / Nội dung giao dịch<input name="orderNumber" required maxlength="120" placeholder="VD: GAERU GR-20261027-ABCDE12345"></label>'
  +'<label>Số tiền giao dịch (₫)<input name="amountVnd" type="number" required min="1" max="2000000000" placeholder="Nhập đúng tổng tiền đơn"></label>'
  +'<label>Mã giao dịch tham chiếu<input name="providerTransactionId" maxlength="120" placeholder="Mã GD ngân hàng / ví (tùy chọn)"></label>'
  +'</div><div class="configuration-reauth"><p>Xác nhận bằng mật khẩu hiện tại của chủ doanh nghiệp.</p><div class="form-grid">'
  +'<label>Mật khẩu hiện tại<input name="password" type="password" autocomplete="current-password" required maxlength="200"></label>'
  +'<label>Mã xác thực / mã dự phòng<input name="factorCode" autocomplete="one-time-code" maxlength="32"></label>'
  +'</div></div><div class="configuration-actions"><button type="submit" class="primary-button">Xác nhận đã đối chiếu và nhận tiền</button><p role="status" data-reconcile-result></p></div></form></details>';

 async function mountPayments(){
  const root=document.querySelector('#payment-configuration');
  if(!root)return;
  if(!owner()){root.textContent='Chỉ chủ doanh nghiệp được thiết lập và kiểm tra kết nối các kênh thanh toán.';return;}
  const data=await read();
  const info=await admin.request('/api/gaeru_ceo/owner/payments');
  const callbacks=info.callbacks||data.callbacks||{};
  const channels=info.channels||[];
  const activeCount=channels.filter(c=>c.enabled).length;
  const verifiedCount=channels.filter(authenticatedPaymentProof).length;

  const introHtml='<div class="payment-hub-intro"><div><p><strong>Quản lý thanh toán GAERU:</strong> Lưu cấu hình và xem bằng chứng xác thực của từng kênh. Chỉ phương thức được bật và sẵn sàng mới xuất hiện khi khách thanh toán.</p><p style="margin-top:6px;font-size:12px;color:#475569;">Đơn thanh toán qua cổng được cập nhật khi nhận phản hồi hợp lệ. Chuyển khoản ngân hàng cần đối chiếu thủ công trước khi xác nhận.</p></div>'
   +'<div class="payment-hub-stats"><span class="payment-stat-pill">● Đang bật: <strong>'+activeCount+'/6</strong></span><span class="payment-stat-pill">Đã có bằng chứng xác thực: <strong>'+verifiedCount+'</strong></span></div></div>';

  const cardsHtml=Object.keys(paymentMap).map(chId=>paymentCardHtml(chId,channels,callbacks,data)).join('');
  root.innerHTML=introHtml+'<div class="payment-channel-grid">'+cardsHtml+'</div>'+RECONCILE_FORM_HTML;
 }

 // Bật/tắt hoặc kiểm tra kết nối một kênh (vận chuyển hoặc thanh toán) bằng thông tin xác thực mới nhập.
 async function runChannelAction({button,details,form,status,testing,path,version,resultSelector,remount,successState}){
  button.disabled=true;
  try{
   const pwd=form.elements.password.value;
   const factorCode=form?.elements?.factorCode?form.elements.factorCode.value:'';
   const body={version,...(testing?{}:{enabled:button.dataset.enabled==='true'}),password:pwd,factorCode:factorCode,factorChallengeId:form?.dataset?.challenge};
   const result=await admin.request(path+(testing?'/test':'/availability'),{method:testing?'POST':'PATCH',body:JSON.stringify(body)});
   admin.showGlobal(result.message);
   if(status){
    const state=successState(result);
    status.textContent=(state.verified?'✓ ':'')+result.message;
    setModalStatusClass(status,state.className);
   }
   await remount();
   const reopened=document.getElementById(details.id);
   if(reopened){
    const msg=reopened.querySelector(resultSelector);
    if(msg)msg.textContent=result.message;
   }
  }catch(error){
   if(status){
    status.textContent=error.message;
    setModalStatusClass(status,'is-error');
   }
   clearCredentials(form);
  }finally{
   clearCredentials(form);
   button.disabled=false;
  }
 }

 document.addEventListener('click',async event=>{
  const button=event.target.closest('[data-shipping-test],[data-shipping-enable]');
  if(!button)return;
  const details=button.closest('[id^="config-panel-"]')||button.closest('details')||button.closest('.config-modal-dialog')||button.closest('article');
  if(!details)return;
  const form=details.querySelector('form');
  const id=button.dataset.shippingTest||button.dataset.shippingEnable;
  const status=details.querySelector('[data-shipping-result]')||details.querySelector('[data-modal-status]')||details.querySelector('[role=status]');
  if(!form||!form.elements||!form.elements.password||!form.elements.password.value){
   openConfigModal('shipping_'+id,button);
   if(status)status.textContent='Vui lòng nhập mật khẩu chủ doanh nghiệp để xác thực.';
   return;
  }
  const testing=!!button.dataset.shippingTest;
  await runChannelAction({
   button,details,form,status,testing,
   path:'/api/gaeru_ceo/owner/shipping/'+id,
   version:Number(form?.dataset?.version||ctx.getData()?.records?.['shipping_'+id]?.version||0),
   resultSelector:'[data-shipping-result]',
   remount:mountShipping,
   successState:()=>({verified:testing,className:'is-success'})
  });
 });

 document.addEventListener('click',async event=>{
  const button=event.target.closest('[data-payment-test],[data-payment-enable]');
  if(!button)return;
  const details=button.closest('[id^="config-panel-"]')||button.closest('.configuration-panel')||button.closest('details')||button.closest('.config-modal-dialog');
  if(!details)return;
  const form=details.querySelector('form');
  const id=button.dataset.paymentTest||button.dataset.paymentEnable;
  const status=details.querySelector('[data-payment-result]')||details.querySelector('[data-modal-status]')||details.querySelector('[role=status]');
  if(!form||!form.elements||!form.elements.password||!form.elements.password.value){
   openConfigModal(paymentMap[id]||id,button);
   if(status)status.textContent='Vui lòng nhập mật khẩu chủ doanh nghiệp để xác thực.';
   return;
  }
  const testing=!!button.dataset.paymentTest;
  await runChannelAction({
   button,details,form,status,testing,
   path:'/api/gaeru_ceo/owner/payments/'+id,
   version:Number(form?.dataset?.version||ctx.getData()?.records?.[paymentMap[id]||id]?.version||0),
   resultSelector:'[data-payment-result]',
   remount:mountPayments,
   successState:result=>{
    const verified=testing&&authenticatedPaymentProof({...result,id});
    return {verified,className:testing&&!verified?'is-notice':'is-success'};
   }
  });
 });

 document.addEventListener('click',async event=>{
  const btn=event.target.closest('[data-copy]');
  if(!btn)return;
  const text=btn.dataset.copy;
  if(!text)return;
  try{
   if(navigator.clipboard&&typeof navigator.clipboard.writeText==='function'){
    await navigator.clipboard.writeText(text);
   }else{
    throw Error('fallback');
   }
  }catch{
   const t=document.createElement('textarea');
   t.value=text;
   t.style.position='fixed';
   t.style.opacity='0';
   document.body.appendChild(t);
   t.select();
   document.execCommand('copy');
   t.remove();
  }
  const old=btn.textContent;
  btn.textContent='✓ Đã chép';
  btn.classList.add('copied');
  setTimeout(()=>{
   btn.textContent=old;
   btn.classList.remove('copied');
  },2000);
 });

 document.addEventListener('submit',async e=>{
  const rf=e.target.closest('[data-payment-reconcile-form]');
  if(!rf)return;
  e.preventDefault();
  const btn=rf.querySelector('[type=submit]'),st=rf.querySelector('[data-reconcile-result]');
  btn.disabled=true;
  try{
   const res=await admin.request('/api/gaeru_ceo/owner/payments/reconcile',{
    method:'POST',
    body:JSON.stringify({
     provider:rf.elements.provider.value,
     orderNumber:rf.elements.orderNumber.value.trim(),
     amountVnd:Number(rf.elements.amountVnd.value),
     providerTransactionId:rf.elements.providerTransactionId.value.trim()||undefined,
     password:rf.elements.password.value,
     factorCode:rf.elements.factorCode.value
    })
   });
   st.textContent=res.message;
   rf.elements.password.value='';
   rf.elements.factorCode.value='';
   admin.showGlobal(res.message);
  }catch(err){
   st.textContent=err.message;
   rf.elements.password.value='';
   rf.elements.factorCode.value='';
  }finally{
   btn.disabled=false;
  }
 });

 return {mountOAuth,mountShipping,mountPayments};
}

window.GAERUConfigurationChannels=Object.freeze({
 titles,
 fields,
 fieldPlaceholders,
 configModalMeta,
 paymentMap,
 paymentIds,
 shippingConfigIds:SHIPPING_CONFIG_IDS,
 gatewayConfigIds:GATEWAY_CONFIG_IDS,
 offlinePaymentConfigIds:OFFLINE_PAYMENT_CONFIG_IDS,
 authenticatedPaymentProof,
 paymentVerificationBadge,
 renderWebhookBox,
 readChannelToggles,
 normalizeChannelValues,
 validateChannelValues,
 createChannelsController
});
})();
