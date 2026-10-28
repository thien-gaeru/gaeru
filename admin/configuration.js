(()=>{
const admin=window.GAERUAdmin;
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let data=null;
let configModalTrigger=null;
let configModalPreviousOverflow='';

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
 chat_ai:'Chat AI · GPT, Gemini, Claude',
 operations:'Vận hành cửa hàng',
 profile:'Hồ sơ chủ doanh nghiệp',
 security:'Bảo mật hệ thống',
 misa:'MISA eShop',
 shopee:'Shopee',
 tiktok:'TikTok Shop',
 oauth:'Đăng nhập Google & Apple (OAuth)'
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
 payment_zalopay:{appId:'App ID (dãy số do ZaloPay cấp, VD: 2554)'},
 misa:{appId:'App ID Open API do MISA cấp',storeId:'Store ID mã định danh cửa hàng MISA',taxCode:'Mã số thuế doanh nghiệp (VD: 0101243150)',templateCode:'Ký hiệu mẫu hóa đơn (VD: 1/001)',series:'Ký hiệu hóa đơn (VD: C26TGA)'}
};

const fields={
 chat_ai:[],
 operations:[],
 profile:[['fullName','Họ và tên'],['company','Tên doanh nghiệp'],['position','Chức danh'],['taxCode','Mã số thuế'],['address','Địa chỉ doanh nghiệp']],
 security:[['idleMinutes','Tự đăng xuất khi không hoạt động (phút)','number'],['absoluteHours','Thời hạn tối đa mỗi phiên (giờ)','number']],
 payment_cod:[['maxAmountVnd','Hạn mức tối đa đơn COD (₫)','number'],['instructions','Hướng dẫn thanh toán khi nhận hàng']],
 payment_bank_transfer:[['bankName','Tên ngân hàng thụ hưởng'],['accountNumber','Số tài khoản'],['accountHolder','Chủ tài khoản'],['branch','Chi nhánh (không bắt buộc)'],['transferSyntax','Cú pháp nội dung chuyển khoản']],
 vnpay:[['tmnCode','Mã website / TmnCode'],['hashSecret','Hash secret','password']],
 payment_9pay:[['merchantKey','Merchant Key'],['secretKey','Secret Key','password'],['checksumKey','Checksum Key','password']],
 payment_momo:[['partnerCode','Partner Code'],['accessKey','Access Key'],['secretKey','Secret Key','password']],
 payment_zalopay:[['appId','App ID'],['key1','Key 1 (Khóa tạo đơn)','password'],['key2','Key 2 (Khóa đối soát callback)','password']],
 misa:[['appId','Mã ứng dụng / App ID Open API'],['storeId','Mã cửa hàng Store ID'],['secret','Khóa bảo mật Open API Secret','password'],['taxCode','Mã số thuế doanh nghiệp xuất HĐ'],['templateCode','Ký hiệu mẫu số hóa đơn (VD: 1/001)'],['series','Ký hiệu hóa đơn (VD: C26TGA)']],
 shopee:[['partnerId','Partner ID'],['shopId','Shop ID'],['secret','Partner key','password']],
 tiktok:[['appKey','App key'],['shopId','Mã cửa hàng'],['secret','App secret','password']],
 oauth:[['googleClientId','Google Client ID (từ Google Cloud Console)'],['appleClientId','Apple Service ID (từ Apple Developer Program)']]
};

for(const id of ['shipping_ghn','shipping_ghtk','shipping_viettel','shipping_jt','shipping_spx']){
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
 chat_ai:{title:'Cấu hình & Khóa · Chat AI (GPT, Gemini, Claude)',sub:'Model AI, API Keys và kích hoạt trợ lý tư vấn bán hàng',icon:'<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#8b5cf6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a2 2 0 0 1 2 2v2a2 2 0 0 1-2 2 2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z"></path><rect x="4" y="8" width="16" height="12" rx="2"></rect><path d="M9 13v2M15 13v2"></path></svg>'},
 oauth:{title:'Cấu hình & Khóa · Đăng nhập Google & Apple',sub:'Google Client ID và Apple Service ID cho phép khách đăng nhập nhanh',icon:'<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#2563eb" stroke-width="2"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M22 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path></svg>'},
 operations:{title:'Cấu hình · Vận hành & Tiếp nhận đơn',sub:'Bật / tắt tiếp nhận đơn đặt hàng trực tuyến trên hệ thống GAERU',icon:'<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#0ea5e9" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>'},
 security:{title:'Cấu hình · Chính sách phiên & Bảo mật',sub:'Thời hạn phiên làm việc và bảo vệ tài khoản quản trị',icon:'<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#6366f1" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>'},
 misa:{title:'Cấu hình & Khóa · MISA eShop',sub:'Kết nối hóa đơn điện tử & phần mềm bán hàng MISA eShop (meInvoice)',icon:'<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#2563eb" stroke-width="2"><path d="M4 4h16v16H4z"></path></svg>'},
 shopee:{title:'Cấu hình & Khóa · Sàn TMĐT Shopee',sub:'Partner ID, Shop ID và Partner Key liên kết Shopee Open Platform',icon:'<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#ee4d2d" stroke-width="2"><path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"></path><line x1="3" y1="6" x2="21" y2="6"></line><path d="M16 10a4 4 0 0 1-8 0"></path></svg>'},
 tiktok:{title:'Cấu hình & Khóa · Sàn TMĐT TikTok Shop',sub:'App Key, Shop ID và App Secret TikTok Shop Partner Center',icon:'<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#000000" stroke-width="2"><path d="M9 12a4 4 0 1 0 4 4V4a5 5 0 0 0 5 5"></path></svg>'}
};

function renderWebhookBox(configId){
 const callbacks=data?.callbacks||{};
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
 return '<div class="config-url-list">'+(note?'<p style="margin:0 0 8px;font-size:12px;color:#475569;line-height:1.4;">'+esc(note)+'</p>':'')+rows.map(r=>'<div class="config-url-row"><span class="config-url-label">'+esc(r.label)+':</span><code class="config-url-code">'+esc(r.url)+'</code><button type="button" class="config-copy-btn" data-copy="'+esc(r.url)+'">Sao chép</button></div>').join('')+'</div>';
}

function openConfigModal(configId,actionButton){
 if(typeof document==='undefined'||typeof document.createElement!=='function')return;
 let backdrop=document.getElementById('config-popup-modal');
 if(!backdrop){
  backdrop=document.createElement('div');
  backdrop.id='config-popup-modal';
  backdrop.className='config-modal-backdrop';
  backdrop.hidden=true;
  document.body.appendChild(backdrop);
 }
 const meta=configModalMeta[configId]||{title:titles[configId]||'Cấu hình hệ thống',sub:'Thiết lập tham số và khóa bảo mật',icon:'<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#2563eb" stroke-width="2"><circle cx="12" cy="12" r="3"></circle></svg>'};
 const webhookHtml=renderWebhookBox(configId);
 const formHtml=form(configId);
 if(backdrop.hidden){
  configModalTrigger=document.activeElement;
  configModalPreviousOverflow=document.body.style.overflow||'';
 }
 backdrop.innerHTML='<div class="config-modal-dialog" role="dialog" aria-modal="true" aria-labelledby="modal-title-'+configId+'"><header class="config-modal-header"><div class="config-modal-icon">'+meta.icon+'</div><div class="config-modal-header-text"><h3 class="config-modal-title" id="modal-title-'+configId+'">'+esc(meta.title)+'</h3><p class="config-modal-sub">'+esc(meta.sub)+'</p></div><button type="button" class="config-modal-close" data-close-config-modal aria-label="Đóng">×</button></header><div class="config-modal-body">'+webhookHtml+formHtml+'<div class="config-modal-status" data-modal-status></div></div></div>';
 if(actionButton?.matches('[data-shipping-enable],[data-payment-enable]')){
  const confirmButton=actionButton.cloneNode(true);
  confirmButton.textContent='Xác nhận '+actionButton.textContent.toLocaleLowerCase('vi-VN');
  backdrop.querySelector('.configuration-actions').prepend(confirmButton);
 }
 backdrop.hidden=false;
 if(typeof document.body!=='undefined'&&document.body.style){
  document.body.style.overflow='hidden';
 }
 const firstInput=backdrop.querySelector('input:not([type=hidden]):not([type=password]), select');
 if(firstInput&&typeof firstInput.focus==='function'){
  setTimeout(()=>{if(!backdrop.hidden&&firstInput.isConnected)try{firstInput.focus();}catch(e){}},50);
 }
}

function closeConfigModal(){
 const backdrop=document.getElementById('config-popup-modal');
 if(!backdrop||backdrop.hidden)return;
 if(backdrop){
  backdrop.hidden=true;
  backdrop.innerHTML='';
 }
 if(typeof document.body!=='undefined'&&document.body.style){
  document.body.style.overflow=configModalPreviousOverflow;
 }
 if(configModalTrigger?.isConnected&&typeof configModalTrigger.focus==='function')configModalTrigger.focus();
 configModalTrigger=null;
}

async function mountShipping(){
 const root=document.querySelector('#shipping-configuration');
 if(!root)return;
 if(!owner()){root.textContent='Chỉ chủ doanh nghiệp được thiết lập khóa kết nối vận chuyển.';return;}
 await read();
 const info=await admin.request('/api/gaeru_ceo/owner/shipping');
 const carriers=info.carriers||[];
 const activeCount=carriers.filter(c=>c.enabled).length;
 const verifiedCount=carriers.filter(c=>c.verified).length;

 const introHtml='<div class="payment-hub-intro"><div><p><strong>Quản lý kết nối vận chuyển:</strong> Thiết lập tài khoản API, mã hóa Token kết nối của các đơn vị vận chuyển hàng đầu tại Việt Nam. Bật đơn vị vận chuyển đã xác minh để người mua tự do lựa chọn khi đặt hàng.</p><p style="margin-top:6px;font-size:12px;color:#059669;">✓ Phí giao hàng áp dụng linh hoạt theo cấu hình bảng giá tỉnh/thành phố GAERU.</p></div><div class="payment-hub-stats"><span class="payment-stat-pill">● Đang bật: <strong>'+activeCount+'/5</strong></span><span class="payment-stat-pill">🛡️ Đã xác minh: <strong>'+verifiedCount+'/5</strong></span></div></div>';

 const cardsHtml=['shipping_ghn','shipping_ghtk','shipping_viettel','shipping_jt','shipping_spx'].map(configId=>{
  const meta=shippingMeta[configId];
  const carrier=carriers.find(c=>c.id===meta.id)||{id:meta.id,verified:false,enabled:false,supported:true};
  const record=data?.records?.[configId]||{version:0,data:{}};
  const v=record.data||{};

  const statusPill=carrier.enabled?'<span class="payment-badge badge-enabled">● Đang bật</span>':'<span class="payment-badge badge-disabled">○ Đang tắt</span>';
  const verifyPill=carrier.verified?'<span class="payment-badge badge-verified">✓ Đã xác minh</span>':record.version?'<span class="payment-badge badge-pending">⏳ Chưa xác minh</span>':'<span class="payment-badge badge-unconfigured">Chưa cấu hình</span>';

  const snapshotHtml='<div class="payment-snapshot-item"><span class="payment-snapshot-label">'+(meta.id==='ghn'?'Shop ID:':'Mã tài khoản / KH:')+'</span><span class="payment-snapshot-val"><code>'+esc(v.accountId||'Chưa thiết lập')+'</code></span></div><div class="payment-snapshot-item"><span class="payment-snapshot-label">Người gửi:</span><span class="payment-snapshot-val">'+esc(v.pickupName||'Chưa thiết lập')+'</span></div><div class="payment-snapshot-item"><span class="payment-snapshot-label">Kho lấy hàng:</span><span class="payment-snapshot-val">'+esc(v.pickupAddress||'Chưa thiết lập')+'</span></div><div class="payment-snapshot-item"><span class="payment-snapshot-label">Khóa kết nối:</span><span class="payment-snapshot-val">'+(v.secretConfigured?'✓ Đã mã hóa':'Chưa nhập khóa')+'</span></div>';

  return '<article class="payment-card configuration-panel '+(carrier.enabled?'card-enabled':'')+'" id="config-panel-'+configId+'" data-carrier-id="'+meta.id+'"><div class="payment-card-header"><div class="payment-card-icon">'+meta.icon+'</div><div class="payment-card-header-main"><h3 class="payment-card-title">'+esc(meta.name)+'</h3><p class="payment-card-sub">'+esc(meta.sub)+'</p><div class="payment-card-badges">'+statusPill+verifyPill+'</div></div></div><div class="payment-card-body">'+snapshotHtml+'</div><div class="payment-card-actions"><button type="button" class="payment-action-btn payment-btn-setup" data-open-config-popup="'+configId+'">⚙ Cấu hình &amp; Khóa API</button>'+(carrier.supported?'<button type="button" class="payment-action-btn '+(carrier.enabled?'payment-btn-disable':'payment-btn-enable')+'" data-shipping-enable="'+carrier.id+'" data-enabled="'+(!carrier.enabled)+'">'+(carrier.enabled?'Tắt hãng':'Bật hãng')+'</button><button type="button" class="payment-action-btn payment-btn-test" data-shipping-test="'+carrier.id+'">Kiểm tra kết nối</button>':'<p>Chưa hoàn tất tích hợp API.</p>')+'<p role="status" class="payment-card-status" data-shipping-result></p></div><details class="payment-card-drawer" id="drawer-'+configId+'" style="display:none"><summary class="payment-drawer-summary"><span>⚙ Chi tiết cấu hình</span></summary>'+form(configId)+'</details></article>';
 }).join('');

 root.innerHTML=introHtml+'<div class="payment-channel-grid shipping-channel-grid">'+cardsHtml+'</div>';
}

async function mountPayments(){
 const root=document.querySelector('#payment-configuration');
 if(!root)return;
 if(!owner()){root.textContent='Chỉ chủ doanh nghiệp được thiết lập và kiểm tra kết nối các kênh thanh toán.';return;}
 await read();
 const info=await admin.request('/api/gaeru_ceo/owner/payments');
 const callbacks=info.callbacks||data.callbacks||{};
 const channels=info.channels||[];
 const activeCount=channels.filter(c=>c.enabled).length;
 const verifiedCount=channels.filter(authenticatedPaymentProof).length;

 const introHtml='<div class="payment-hub-intro"><div><p><strong>Quản lý thanh toán GAERU:</strong> Lưu cấu hình và xem bằng chứng xác thực của từng kênh. Chỉ phương thức được bật và sẵn sàng mới xuất hiện khi khách thanh toán.</p><p style="margin-top:6px;font-size:12px;color:#475569;">Đơn thanh toán qua cổng được cập nhật khi nhận phản hồi hợp lệ. Chuyển khoản ngân hàng cần đối chiếu thủ công trước khi xác nhận.</p></div><div class="payment-hub-stats"><span class="payment-stat-pill">● Đang bật: <strong>'+activeCount+'/6</strong></span><span class="payment-stat-pill">Đã có bằng chứng xác thực: <strong>'+verifiedCount+'</strong></span></div></div>';

 const cardsHtml=['cod','bank_transfer','vnpay','9pay','momo','zalopay'].map(chId=>{
  const configId=paymentMap[chId];
  const channel=channels.find(c=>c.id===chId)||{id:chId,configId,verified:false,enabled:chId==='cod',version:data.records[configId]?.version||0};
  const record=data.records[configId]||{version:0,data:{}};
  const v=record.data||{};
  const meta=channelMeta[chId]||{title:titles[configId],sub:'',icon:''};
  
  let snapshotHtml='';
  if(chId==='cod'){
   snapshotHtml='<div class="payment-snapshot-item"><span class="payment-snapshot-label">Hạn mức tối đa:</span><span class="payment-snapshot-val">'+Number(v.maxAmountVnd||50000000).toLocaleString('vi-VN')+'₫</span></div><div class="payment-snapshot-item"><span class="payment-snapshot-label">Phí vận chuyển:</span><span class="payment-snapshot-val">Theo bảng giá tỉnh/thành</span></div><div class="payment-snapshot-item"><span class="payment-snapshot-label">Xác nhận đơn:</span><span class="payment-snapshot-val">Quy trình tiêu chuẩn</span></div>';
  }else if(chId==='bank_transfer'){
   snapshotHtml='<div class="payment-snapshot-item"><span class="payment-snapshot-label">Ngân hàng:</span><span class="payment-snapshot-val">'+esc(v.bankName||'Chưa thiết lập')+'</span></div><div class="payment-snapshot-item"><span class="payment-snapshot-label">Số tài khoản:</span><span class="payment-snapshot-val">'+esc(v.accountNumber||'Chưa thiết lập')+'</span></div><div class="payment-snapshot-item"><span class="payment-snapshot-label">Chủ tài khoản:</span><span class="payment-snapshot-val">'+esc(v.accountHolder||'Chưa thiết lập')+'</span></div><div class="payment-snapshot-item"><span class="payment-snapshot-label">Cú pháp:</span><span class="payment-snapshot-val"><code>'+esc(v.transferSyntax||'GAERU {MA_DON}')+'</code></span></div>';
  }else if(chId==='vnpay'){
   snapshotHtml='<div class="payment-snapshot-item"><span class="payment-snapshot-label">Mã website (TMN):</span><span class="payment-snapshot-val"><code>'+esc(v.tmnCode||'Chưa thiết lập')+'</code></span></div><div class="payment-snapshot-item"><span class="payment-snapshot-label">Môi trường:</span><span class="payment-snapshot-val">'+(v.environment==='production'?'Chính thức':'Thử nghiệm')+'</span></div><div class="payment-snapshot-item"><span class="payment-snapshot-label">Khóa Hash Secret:</span><span class="payment-snapshot-val">'+(v.secretConfigured?'✓ Đã mã hóa':'Chưa nhập khóa')+'</span></div>';
  }else if(chId==='9pay'){
   snapshotHtml='<div class="payment-snapshot-item"><span class="payment-snapshot-label">Merchant Key:</span><span class="payment-snapshot-val"><code>'+(v.merchantKey?esc(v.merchantKey.slice(0,8)+'••••'):'Chưa thiết lập')+'</code></span></div><div class="payment-snapshot-item"><span class="payment-snapshot-label">Môi trường:</span><span class="payment-snapshot-val">'+(v.environment==='production'?'Chính thức':'Thử nghiệm')+'</span></div><div class="payment-snapshot-item"><span class="payment-snapshot-label">Khóa bí mật:</span><span class="payment-snapshot-val">'+(v.secretConfigured?'✓ Đã mã hóa':'Chưa nhập khóa')+'</span></div>';
  }else if(chId==='momo'){
   snapshotHtml='<div class="payment-snapshot-item"><span class="payment-snapshot-label">Partner Code:</span><span class="payment-snapshot-val"><code>'+esc(v.partnerCode||'Chưa thiết lập')+'</code></span></div><div class="payment-snapshot-item"><span class="payment-snapshot-label">Môi trường:</span><span class="payment-snapshot-val">'+(v.environment==='production'?'Chính thức':'Thử nghiệm')+'</span></div><div class="payment-snapshot-item"><span class="payment-snapshot-label">Secret Key:</span><span class="payment-snapshot-val">'+(v.secretConfigured?'✓ Đã mã hóa':'Chưa nhập khóa')+'</span></div>';
  }else{
   snapshotHtml='<div class="payment-snapshot-item"><span class="payment-snapshot-label">App ID:</span><span class="payment-snapshot-val"><code>'+esc(v.appId||'Chưa thiết lập')+'</code></span></div><div class="payment-snapshot-item"><span class="payment-snapshot-label">Môi trường:</span><span class="payment-snapshot-val">'+(v.environment==='production'?'Chính thức':'Thử nghiệm')+'</span></div><div class="payment-snapshot-item"><span class="payment-snapshot-label">Key 1 &amp; Key 2:</span><span class="payment-snapshot-val">'+(v.secretConfigured?'✓ Đã mã hóa':'Chưa nhập khóa')+'</span></div>';
  }

  let webhookBox='';
  if(chId==='cod'){
   webhookBox='<div class="payment-integration-box">Thu tiền mặt khi giao hàng. Kiểm tra cấu hình đối chiếu hạn mức COD và bảng phí vận chuyển; không xác thực kết nối với hãng vận chuyển.</div>';
  }else if(chId==='bank_transfer'){
   webhookBox='<div class="payment-integration-box">Cần đối chiếu thủ công tiền vào tài khoản trước khi xác nhận thanh toán. Kiểm tra cấu hình chỉ kiểm tra định dạng, không xác minh chủ tài khoản.</div>';
  }else if(chId==='vnpay'){
   webhookBox='<div class="payment-integration-box"><strong>VNPAY URLs:</strong><br>Return URL: <code>'+esc(callbacks.vnpayReturn||'')+'</code><br>IPN URL: <code>'+esc(callbacks.vnpayIpn||'')+'</code></div>';
  }else if(chId==='9pay'){
   webhookBox='<div class="payment-integration-box"><strong>9Pay URLs:</strong><br>Return URL: <code>'+esc(callbacks.ninepayReturn||'')+'</code><br>IPN URL: <code>'+esc(callbacks.ninepayIpn||'')+'</code></div>';
  }else if(chId==='momo'){
   webhookBox='<div class="payment-integration-box"><strong>MoMo URLs:</strong><br>Return URL: <code>'+esc(callbacks.momoReturn||'')+'</code><br>IPN URL: <code>'+esc(callbacks.momoIpn||'')+'</code></div>';
  }else{
   webhookBox='<div class="payment-integration-box"><strong>ZaloPay URLs:</strong><br>Return URL: <code>'+esc(callbacks.zalopayReturn||'')+'</code><br>Callback IPN URL: <code>'+esc(callbacks.zalopayIpn||'')+'</code></div>';
  }

  const envPill=v.environment?(v.environment==='production'?'<span class="payment-badge badge-prod">Chính thức</span>':'<span class="payment-badge badge-sandbox">Thử nghiệm</span>'):'';
  const statusPill=channel.enabled?'<span class="payment-badge badge-enabled">● Đang bật</span>':'<span class="payment-badge badge-disabled">○ Đang tắt</span>';
  const verifyPill=paymentVerificationBadge(channel);
  const enableBlocked=!channel.enabled&&(chId==='9pay'||channel.canEnable===false||channel.supported===false);
  const readinessHtml=channel.unsupportedReason?'<p class="help-text">'+esc(channel.unsupportedReason)+'</p>':channel.enabled&&channel.checkoutReady===false?'<p class="help-text">Kênh đã bật nhưng chưa sẵn sàng nhận thanh toán.</p>':'';

  return '<article class="payment-card configuration-panel '+(channel.enabled?'card-enabled':'')+'" id="config-panel-'+configId+'" data-channel-id="'+chId+'"><div class="payment-card-header"><div class="payment-card-icon">'+meta.icon+'</div><div class="payment-card-header-main"><h3 class="payment-card-title">'+meta.title+'</h3><p class="payment-card-sub">'+meta.sub+'</p><div class="payment-card-badges">'+statusPill+verifyPill+envPill+'</div></div></div><div class="payment-card-body">'+snapshotHtml+readinessHtml+'</div><div class="payment-card-actions"><button type="button" class="payment-action-btn payment-btn-setup" data-open-config-popup="'+configId+'" data-toggle-drawer="'+configId+'">⚙ Cấu hình &amp; Khóa</button><button type="button" class="payment-action-btn '+(channel.enabled?'payment-btn-disable':'payment-btn-enable')+'" data-payment-enable="'+chId+'" data-enabled="'+(!channel.enabled)+'" '+(enableBlocked?'disabled':'')+'>'+(channel.enabled?'Tắt kênh':'Bật kênh')+'</button><button type="button" class="payment-action-btn payment-btn-test" data-payment-test="'+chId+'">Kiểm tra kết nối</button><p role="status" class="payment-card-status" data-payment-result></p></div><details class="payment-card-drawer" id="drawer-'+configId+'" style="display:none"><summary class="payment-drawer-summary"><span>⚙ Chi tiết cấu hình, Khóa bảo mật &amp; Webhook</span></summary>'+webhookBox+form(configId)+'</details></article>';
 }).join('');

 const reconcileHtml='<details class="configuration-panel" id="config-panel-payment-reconcile"><summary>Xác nhận thanh toán sau đối chiếu</summary><p class="help-text">Chỉ xác nhận tại đây sau khi đã đối chiếu tiền thực nhận và chứng từ của đúng đơn hàng. Thao tác này ghi nhận thanh toán thủ công; không truy vấn số dư ngân hàng và không chuyển tiền.</p><form class="configuration-form" data-payment-reconcile-form><div class="form-grid"><label>Kênh thanh toán trước<select name="provider"><option value="bank_transfer">Chuyển khoản ngân hàng</option><option value="momo">Ví điện tử MoMo</option><option value="zalopay">Ví điện tử ZaloPay</option><option value="vnpay">Cổng VNPAY</option><option value="9pay">9Pay (đơn lịch sử)</option></select></label><label>Mã đơn / Nội dung giao dịch<input name="orderNumber" required maxlength="120" placeholder="VD: GAERU GR-20261027-ABCDE12345"></label><label>Số tiền giao dịch (₫)<input name="amountVnd" type="number" required min="1" max="2000000000" placeholder="Nhập đúng tổng tiền đơn"></label><label>Mã giao dịch tham chiếu<input name="providerTransactionId" maxlength="120" placeholder="Mã GD ngân hàng / ví (tùy chọn)"></label></div><div class="configuration-reauth"><p>Xác nhận bằng mật khẩu hiện tại của chủ doanh nghiệp.</p><div class="form-grid"><label>Mật khẩu hiện tại<input name="password" type="password" autocomplete="current-password" required maxlength="200"></label><label>Mã xác thực / mã dự phòng<input name="factorCode" autocomplete="one-time-code" maxlength="32"></label></div></div><div class="configuration-actions"><button type="submit" class="primary-button">Xác nhận đã đối chiếu và nhận tiền</button><p role="status" data-reconcile-result></p></div></form></details>';

 root.innerHTML=introHtml+'<div class="payment-channel-grid">'+cardsHtml+'</div>'+reconcileHtml;
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
 button.disabled=true;
 try{
  const testing=!!button.dataset.shippingTest;
  const pwd=form.elements.password.value;
  const factorCode=form?.elements?.factorCode?form.elements.factorCode.value:'';
  const version=Number(form?.dataset?.version||data?.records?.['shipping_'+id]?.version||0);
  const result=await admin.request('/api/gaeru_ceo/owner/shipping/'+id+(testing?'/test':'/availability'),{method:testing?'POST':'PATCH',body:JSON.stringify({version,...(testing?{}:{enabled:button.dataset.enabled==='true'}),password:pwd,factorCode:factorCode,factorChallengeId:form?.dataset?.challenge})});
  admin.showGlobal(result.message);
  if(status){
   status.textContent=(testing?'✓ ':'')+result.message;
   if(status.classList&&status.classList.contains('config-modal-status')){
    status.className='config-modal-status is-visible is-success';
   }
  }
  await mountShipping();
  const reopened=document.getElementById(details.id);
  if(reopened){
   const msg=reopened.querySelector('[data-shipping-result]');
   if(msg)msg.textContent=result.message;
  }
 }catch(error){
  if(status){
   status.textContent=error.message;
   if(status.classList&&status.classList.contains('config-modal-status')){
    status.className='config-modal-status is-visible is-error';
   }
  }
  if(form&&form.elements&&form.elements.password)form.elements.password.value='';
  if(form&&form.elements&&form.elements.factorCode)form.elements.factorCode.value='';
  if(form)delete form.dataset.challenge;
 }finally{
  if(form&&form.elements&&form.elements.password)form.elements.password.value='';
  if(form&&form.elements&&form.elements.factorCode)form.elements.factorCode.value='';
  if(form)delete form.dataset.challenge;
  button.disabled=false;
 }
});

document.addEventListener('click',event=>{
 const toggle=event.target.closest('[data-open-config-popup],[data-toggle-drawer]');
 if(!toggle)return;
 const configId=toggle.dataset.openConfigPopup||toggle.dataset.toggleDrawer;
 if(!configId)return;
 openConfigModal(configId);
});

document.addEventListener('click',event=>{
 if(event.target.closest('[data-close-config-modal]')){
  closeConfigModal();
  return;
 }
 const backdrop=document.getElementById('config-popup-modal');
 if(backdrop&&!backdrop.hidden&&event.target===backdrop){
  closeConfigModal();
 }
});

document.addEventListener('keydown',event=>{
 const backdrop=document.getElementById('config-popup-modal');
 if(!backdrop||backdrop.hidden)return;
 if(event.key==='Escape'){
  event.preventDefault();
  closeConfigModal();
  return;
 }
 if(event.key==='Tab'){
  const controls=[...backdrop.querySelectorAll('a[href],button:not([disabled]),input:not([disabled]):not([type=hidden]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])')].filter(el=>!el.closest('[hidden]'));
  const first=controls[0],last=controls.at(-1),active=document.activeElement;
  if(first&&(!backdrop.contains(active)||(event.shiftKey?active===first:active===last))){
   event.preventDefault();
   (event.shiftKey?last:first).focus();
  }
 }
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

document.addEventListener('click',async event=>{
 const button=event.target.closest('[data-payment-test],[data-payment-enable]');
 if(!button)return;
 const details=button.closest('[id^="config-panel-"]')||button.closest('.configuration-panel')||button.closest('details')||button.closest('.config-modal-dialog');
 if(!details)return;
 const form=details.querySelector('form');
 const id=button.dataset.paymentTest||button.dataset.paymentEnable;
 const status=details.querySelector('[data-payment-result]')||details.querySelector('[data-modal-status]')||details.querySelector('[role=status]');
 if(!form||!form.elements||!form.elements.password||!form.elements.password.value){
   const configId=paymentMap[id]||id;
   openConfigModal(configId,button);
   if(status)status.textContent='Vui lòng nhập mật khẩu chủ doanh nghiệp để xác thực.';
   return;
 }
 button.disabled=true;
 try{
  const testing=!!button.dataset.paymentTest;
  const pwd=form.elements.password.value;
  const factorCode=form?.elements?.factorCode?form.elements.factorCode.value:'';
  const version=Number(form?.dataset?.version||data?.records?.[paymentMap[id]||id]?.version||0);
  const result=await admin.request('/api/gaeru_ceo/owner/payments/'+id+(testing?'/test':'/availability'),{method:testing?'POST':'PATCH',body:JSON.stringify({version,...(testing?{}:{enabled:button.dataset.enabled==='true'}),password:pwd,factorCode:factorCode,factorChallengeId:form?.dataset?.challenge})});
  admin.showGlobal(result.message);
  if(status){
   const verified=testing&&authenticatedPaymentProof({...result,id});
   status.textContent=(verified?'✓ ':'')+result.message;
   if(status.classList&&status.classList.contains('config-modal-status')){
    status.className='config-modal-status is-visible '+(testing&&!verified?'is-notice':'is-success');
   }
  }
  await mountPayments();
  const reopened=document.getElementById(details.id);
  if(reopened){
   const msg=reopened.querySelector('[data-payment-result]');
   if(msg)msg.textContent=result.message;
  }
 }catch(error){
  if(status){
   status.textContent=error.message;
   if(status.classList&&status.classList.contains('config-modal-status')){
    status.className='config-modal-status is-visible is-error';
   }
  }
  if(form&&form.elements&&form.elements.password)form.elements.password.value='';
  if(form&&form.elements&&form.elements.factorCode)form.elements.factorCode.value='';
  if(form)delete form.dataset.challenge;
 }finally{
  if(form&&form.elements&&form.elements.password)form.elements.password.value='';
  if(form&&form.elements&&form.elements.factorCode)form.elements.factorCode.value='';
  if(form)delete form.dataset.challenge;
  button.disabled=false;
 }
});

function owner(){return admin.user?.role==='owner'&&admin.user?.source==='bootstrap';}
async function read(){data=await admin.request('/api/gaeru_ceo/owner/configuration');return data;}

function chatAIFields(v){
 return '<label>AI đang sử dụng<select name="provider">'+[['openai','OpenAI / GPT'],['gemini','Google Gemini'],['claude','Anthropic Claude']].map(([id,label])=>'<option value="'+id+'" '+(v.provider===id?'selected':'')+'>'+label+'</option>').join('')+'</select></label><label><input type="checkbox" name="aiEnabled" '+(v.enabled?'checked':'')+'> Bật Chat AI</label>'+[['openai','OpenAI / GPT'],['gemini','Gemini'],['claude','Claude']].map(([id,label])=>'<label>Model '+label+'<input name="'+id+'Model" value="'+esc(v.profiles?.[id]?.model)+'" maxlength="120" pattern="[a-zA-Z0-9._-]*" placeholder="ID model trong tài khoản nhà cung cấp"></label><label>API key '+label+'<input name="'+id+'Key" type="password" autocomplete="new-password" maxlength="2000" placeholder="'+(v.profiles?.[id]?.secretConfigured?'Đã lưu · để trống để giữ khóa':'Nhập khóa API riêng')+'"></label>').join('');
}

function form(id){
 const record=data?.records?.[id]||{version:0,data:{}},v=record.data||{};
 const values=id==='security'?{idleMinutes:30,absoluteHours:8,...v}:id==='payment_cod'?{maxAmountVnd:50000000,instructions:'Thanh toán tiền mặt trực tiếp cho bưu tá khi nhận hàng.',enabled:true,...v}:id==='payment_bank_transfer'?{transferSyntax:'GAERU {MA_DON}',enabled:false,...v}:id==='misa'?{templateCode:'1/001',series:'C26TGA',environment:'sandbox',autoIssue:true,enabled:false,...v}:v;
 
 const testBtnHtml=id==='chat_ai'
  ?'<button type="button" class="secondary-button" data-chat-ai-test>Kiểm tra chat AI đã lưu</button>'
  :id==='misa'?'<button type="button" class="secondary-button" data-misa-test>Kiểm tra kết nối MISA eShop</button>':id.startsWith('shipping_')
  ?'<button type="button" class="secondary-button" data-shipping-test="'+id.slice(9)+'">Kiểm tra kết nối đã lưu</button>'
  :paymentIds.has(id)&&id!=='payments'
  ?'<button type="button" class="secondary-button" data-payment-test="'+(id==='vnpay'?'vnpay':id.slice(8))+'">Kiểm tra kết nối đã lưu</button>'
  :'';

 const markup='<form class="configuration-form" data-config-form="'+id+'" data-version="'+record.version+'"><div class="form-grid">'+(id==='chat_ai'?chatAIFields(v):'')+fields[id].map(([name,label,type])=>'<label>'+label+'<input name="'+name+'" type="'+(type||'text')+'" maxlength="'+(type==='password'?2000:500)+'" '+(type==='password'?'autocomplete="new-password" placeholder="'+(v.secretConfigured?'Đã lưu · để trống để giữ khóa':'Nhập khóa bí mật')+'"':'value="'+esc(values[name])+'"'+(fieldPlaceholders[id]?.[name]?' placeholder="'+esc(fieldPlaceholders[id][name])+'"':''))+(id==='security'?(name==='idleMinutes'?' min="5" max="60"':' min="1" max="8"'):id==='payment_cod'&&name==='maxAmountVnd'?' min="100000" max="2000000000"':'')+'></label>').join('')+(id==='operations'?'<label class="operation-switch"><input type="checkbox" name="ordersEnabled" '+(values.ordersEnabled?'checked':'')+'> Tiếp nhận đơn đặt hàng trực tuyến</label>':'')+(['vnpay','payment_9pay','payment_momo','payment_zalopay'].includes(id)?'<label>Môi trường<select name="environment"><option value="sandbox">Thử nghiệm</option><option value="production" '+(v.environment==='production'?'selected':'')+'>Chính thức</option></select></label><label><input type="checkbox" name="enabled" '+(v.enabled?'checked':'')+'> Cho phép sử dụng '+titles[id]+'</label>':'')+(['payment_cod','payment_bank_transfer'].includes(id)?'<label><input type="checkbox" name="enabled" '+(values.enabled?'checked':'')+'> Cho phép sử dụng '+titles[id]+'</label>':'')+(id==='misa'?'<label>Môi trường kết nối<select name="environment"><option value="sandbox" '+(values.environment!=='production'?'selected':'')+'>Thử nghiệm (Sandbox)</option><option value="production" '+(values.environment==='production'?'selected':'')+'>Chính thức (Production)</option></select></label><label class="operation-switch"><input type="checkbox" name="autoIssue" '+(values.autoIssue?'checked':'')+'> Tự động xuất hóa đơn khi đơn hoàn thành & đã thanh toán</label><label class="operation-switch"><input type="checkbox" name="enabled" '+(values.enabled?'checked':'')+'> Kích hoạt kết nối hóa đơn điện tử MISA eShop</label>':'')+'</div>'+(id!=='profile'?'<div class="configuration-reauth"><p>Xác nhận bằng mật khẩu và mã xác thực hiện tại của chủ doanh nghiệp.</p><div class="form-grid"><label>Mật khẩu hiện tại<input name="password" type="password" autocomplete="current-password" required maxlength="200"></label><label>Mã xác thực / mã dự phòng<input name="factorCode" autocomplete="one-time-code" maxlength="32"></label></div><button type="button" data-config-email>Gửi mã qua email</button></div>':'<p class="help-text">Thông tin hồ sơ không thay đổi tên đăng nhập hoặc liên hệ khôi phục đã xác minh.</p>')+'<div class="configuration-actions">'+testBtnHtml+'<button type="submit" class="primary-button">Lưu '+esc(id==='chat_ai'?'Chat AI':titles[id].toLowerCase())+'</button><p role="status" aria-live="polite"></p></div></form>';
 return id==='payment_9pay'?markup.replace(/<input type="checkbox" name="enabled"[^>]*>/,'<input type="checkbox" name="enabled" disabled>')+'<p class="help-text">9Pay chưa hỗ trợ nhận thanh toán. Có thể lưu thông tin cấu hình để đối chiếu.</p>':markup;
}

async function mountProfile(root){
 if(!owner()||!root?.isConnected)return;
 await read();
 if(!root.isConnected)return;
 root.innerHTML='<details class="configuration-panel owner-profile-panel"><summary><span>Hồ sơ chủ doanh nghiệp</span><small>Mở để xem hoặc chỉnh sửa</small></summary><div>'+form('profile')+'</div></details>';
}

async function load(){
 if(!owner())return;
 await read();
 const root=document.querySelector('#system-configuration');
 if(!root)return;
 const services=data.services;
 root.innerHTML='<header class="section-heading"><div><p class="eyebrow">Cấu hình riêng của chủ doanh nghiệp</p><h2>Kết nối, AI và bảo mật</h2></div><button type="button" class="secondary-button" data-config-open="payments">Mở Quản lý thanh toán ↗</button></header><p class="help-text">Khóa bí mật được mã hóa khi lưu, không trả lại trình duyệt. Thay đổi quan trọng cần mật khẩu và xác thực hai yếu tố. Các kênh thanh toán (COD, Chuyển khoản, VNPAY, 9Pay) được quản lý tập trung tại mục Quản lý thanh toán.</p><section class="configuration-panel"><h3>Lưu trữ ảnh và tài liệu</h3><button type="button" data-media-storage-probe>Kiểm tra lưu trữ ngay</button><p role="status" data-media-storage-probe-result></p><p>Nơi lưu tệp mới: '+(services.mediaStorage?.provider==='hostinger'?'Hostinger':'Thư mục cục bộ chưa cấu hình')+'</p><p role="status">'+esc(services.mediaStorage?.message||'Chưa kiểm tra')+'</p><p class="help-text">Ảnh và tài liệu được đọc từ thư mục lưu trữ cục bộ. Cơ sở dữ liệu giữ thông tin và tham chiếu tệp.</p><p role="status">Kiểm tra tệp cục bộ: '+esc(services.mediaAudit?.message||'Chưa kiểm tra')+'</p></section>'+['chat_ai','oauth','misa','shopee','tiktok','security'].map(id=>'<details class="configuration-panel" id="config-panel-'+id+'"><summary><span>'+titles[id]+'</span><small>'+(id==='chat_ai'?(data.records.chat_ai.data.enabled?'Đã bật · kiểm tra model trước khi sử dụng':'Chưa bật'):id==='oauth'?(data.records.oauth?.data?.googleClientId||data.records.oauth?.data?.appleClientId?'Đã lưu Client ID · Sẵn sàng':'Chưa cấu hình'):id==='misa'?(data.records.misa?.data?.enabled?(data.records.misa?.data?.autoIssue?'Đã bật · Tự động xuất hóa đơn':'Đã bật · Xuất thủ công'):'Chưa kích hoạt'):id==='security'?'Chính sách phiên quản trị':data.records[id]?.version?'Đã lưu ứng dụng · chưa cấp quyền đồng bộ':'Chưa cấu hình')+'</small></summary><div>'+ (id==='oauth'?'<p class="help-text">Nhập Google Client ID và Apple Service ID để kích hoạt đăng nhập một chạm. Hướng dẫn lấy mã: <br>• <strong>Google:</strong> Truy cập Google Cloud Console ➔ APIs & Services ➔ Credentials ➔ OAuth Client ID (Web Application) ➔ thêm redirect URI: <code>https://gaeru.com/account.html</code> (hoặc <code>http://localhost:3000/account.html</code>).<br>• <strong>Apple:</strong> Truy cập Apple Developer ➔ Certificates, Identifiers & Profiles ➔ Services IDs (VD: <code>com.gaeru.web.signin</code>).</p>':id==='chat_ai'?'<p class="help-text">Chọn AI, nhập ID model và khóa tương ứng rồi lưu. Có thể giữ khóa riêng cho cả ba nhà cung cấp. Kiểm tra chat AI gửi một câu thử, có thể tính phí API theo tài khoản của bạn. Chỉ câu hỏi, tin nhắn gần đây và dữ liệu sản phẩm được gửi cho AI; tệp đính kèm dành cho nhân viên.</p>':id==='security'?'<p class="help-text">Turnstile: '+(services.turnstileConfigured?'Đã cấu hình':'Chưa cấu hình')+' · Email: '+(services.smtpConfigured?'Đã cấu hình':'Chưa cấu hình')+'. Khóa CAPTCHA và khóa mã hóa được quản lý trên máy chủ.</p>':'<p class="help-text">Lưu hồ sơ ứng dụng trước. Chưa thực hiện OAuth, gọi API hay đồng bộ đơn và tồn kho. Cần quyền và thông tin ứng dụng được nhà cung cấp phê duyệt.</p>')+'<div style="margin-bottom:12px;"><button type="button" class="secondary-button" data-open-config-popup="'+id+'">⚙ Mở cửa sổ cấu hình trực quan</button></div>'+form(id)+'</div></details>').join('');
}

document.addEventListener('click',async e=>{
 const button=e.target.closest('[data-config-email]');
 if(!button)return;
 const f=button.closest('form'),status=f.querySelector('[role=status]');
 try{
  if(!f.elements.password.value)throw Error('Nhập mật khẩu hiện tại trước.');
  const r=await window.GAERUSecurity.api('/authorize',{password:f.elements.password.value});
  f.dataset.challenge=r.challengeId;
  status.textContent=r.message;
 }catch(error){
  status.textContent=error.message;
 }
});

document.addEventListener('submit',async e=>{
 const rf=e.target.closest('[data-payment-reconcile-form]');
 if(rf){
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
  return;
 }

 const f=e.target.closest('[data-config-form]');
 if(!f)return;
 e.preventDefault();
 const id=f.dataset.configForm;
 const status=f.querySelector('[role=status]');
 const modal=typeof f.closest==='function'?f.closest('.config-modal-dialog'):null;
 const modalStatus=modal?.querySelector('[data-modal-status]');
 const button=f.querySelector('[type=submit]');
 if(button)button.disabled=true;

 function showMsg(msg,isError){
  if(modalStatus){
   modalStatus.textContent=(isError?'❌ ':'✅ ')+msg;
   modalStatus.className='config-modal-status is-visible '+(isError?'is-error':'is-success');
  }
  if(status){
   status.textContent=msg;
   if(status.style)status.style.color=isError?'#dc2626':'#16a34a';
  }
 }

 try{
  const values={};
  for(const [name,,type]of fields[id]){
   const el=f.elements[name];
   if(!el)continue;
   const value=el.value;
   if(type==='password'&&!value)continue;
   values[name]=type==='number'?Number(value):value;
  }
  if(id==='chat_ai'){
   values.enabled=f.elements.aiEnabled?f.elements.aiEnabled.checked:false;
   values.provider=f.elements.provider?f.elements.provider.value:'openai';
   values.profiles=Object.fromEntries(['openai','gemini','claude'].map(provider=>[
    provider,
    {
     model:f.elements[provider+'Model']?f.elements[provider+'Model'].value.trim():'',
     ...(f.elements[provider+'Key']&&f.elements[provider+'Key'].value.trim()?{apiKey:f.elements[provider+'Key'].value.trim()}:{})
    }
   ]));
  }
  if(id==='operations'){
   values.ordersEnabled=f.elements.ordersEnabled?f.elements.ordersEnabled.checked:false;
  }
  if(['vnpay','payment_9pay','payment_momo','payment_zalopay'].includes(id)){
   if(f.elements.environment)values.environment=f.elements.environment.value;
   if(f.elements.enabled)values.enabled=f.elements.enabled.checked;
  }
  if(['payment_cod','payment_bank_transfer'].includes(id)){
   if(f.elements.enabled)values.enabled=f.elements.enabled.checked;
  }

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

  const record=data?.records?.[id]||{version:0,data:{}};
  const curVersion=Number(f.dataset.version||record.version||0);

   if(id!=='profile'&&!f.elements.password?.value){
   if(f.elements.password&&typeof f.elements.password.focus==='function')f.elements.password.focus();
   showMsg('Vui lòng nhập mật khẩu hiện tại của chủ doanh nghiệp để xác thực.',true);
   if(button)button.disabled=false;
   return;
  }

  if(id==='vnpay'){
   if(!values.tmnCode||!/^[a-zA-Z0-9]{8}$/.test(values.tmnCode)){
    if(f.elements.tmnCode&&typeof f.elements.tmnCode.focus==='function')f.elements.tmnCode.focus();
    showMsg('Mã website VNPAY (TmnCode) cần đúng 8 ký tự chữ hoặc số (VD: GAERUVN1).',true);
    if(button)button.disabled=false;
    return;
   }
   if(!curVersion&&!values.hashSecret){
    if(f.elements.hashSecret&&typeof f.elements.hashSecret.focus==='function')f.elements.hashSecret.focus();
    showMsg('Vui lòng nhập khóa bí mật (Hash Secret) cho lần cấu hình đầu tiên.',true);
    if(button)button.disabled=false;
    return;
   }
  }
  if(id==='payment_9pay'){
   if(!curVersion&&(!values.secretKey||!values.checksumKey)){
    showMsg('Vui lòng nhập Secret Key và Checksum Key cho lần cấu hình đầu tiên.',true);
    if(button)button.disabled=false;
    return;
   }
  }
  if(id==='payment_momo'){
   if(!curVersion&&!values.secretKey){
    showMsg('Vui lòng nhập Secret Key MoMo cho lần cấu hình đầu tiên.',true);
    if(button)button.disabled=false;
    return;
   }
  }
  if(id==='payment_zalopay'){
   if(!curVersion&&(!values.key1||!values.key2)){
    showMsg('Vui lòng nhập Key 1 và Key 2 ZaloPay cho lần cấu hình đầu tiên.',true);
    if(button)button.disabled=false;
    return;
   }
  }
  if(id==='payment_bank_transfer'){
   if(values.accountNumber&&values.accountNumber.length<6){
    showMsg('Số tài khoản ngân hàng từ 6 đến 30 ký tự số/chữ.',true);
    if(button)button.disabled=false;
    return;
   }
  }
  if(id==='payment_cod'){
   const max=Number(values.maxAmountVnd);
   if(isNaN(max)||max<100000||max>2000000000){
    showMsg('Hạn mức tối đa đơn COD hợp lệ từ 100.000₫ đến 2.000.000.000₫.',true);
    if(button)button.disabled=false;
    return;
   }
  }

  const result=await admin.request('/api/gaeru_ceo/owner/configuration/'+id,{
   method:'PUT',
   body:JSON.stringify({
    data:values,
    version:curVersion,
     password:f.elements.password?.value,
    factorCode:f.elements.factorCode?.value,
    factorChallengeId:f.dataset.challenge
   })
  });

  f.dataset.version=result.version;
  if(data?.records)data.records[id]=result;
  showMsg(result.message,false);

  for(const input of f.querySelectorAll('input[type=password],[name=factorCode]'))input.value='';
  delete f.dataset.challenge;

  if(id==='operations'){
   await window.GAERUOwner?.load();
   admin.showGlobal(result.message);
  }else if(id.startsWith('shipping_')){
   await mountShipping();
   admin.showGlobal(result.message);
  }else if(paymentIds.has(id)){
   await mountPayments();
   const panel=document.getElementById('config-panel-'+id);
   if(panel){
    const drawer=panel.querySelector('.payment-card-drawer')||panel;
    if('open' in drawer)drawer.open=true;
    const msg=panel.querySelector('[data-payment-result]')||panel.querySelector('[role=status]');
    if(msg)msg.textContent=result.message;
   }
   admin.showGlobal(result.message);
  }else if(id!=='profile'){
   await load();
   if(id==='chat_ai'){
    const panel=document.getElementById('config-panel-chat_ai');
    if(panel){
     panel.open=true;
     const panelStatus=panel.querySelector('[role=status]');
     if(panelStatus)panelStatus.textContent=result.message+' Nhập lại mật khẩu và mã xác thực mới để kiểm tra kết nối.';
    }
   }
   admin.showGlobal(result.message);
  }else{
   await window.GAERUOwner?.load();
   admin.showGlobal(result.message);
  }
 }catch(error){
  showMsg(error.message,true);
  if(error.status===401||error.status===403){
   if(f.elements.password)f.elements.password.value='';
  }
 }finally{
  if(button)button.disabled=false;
 }
});

function savedAISelection(form){
 const record=data.records.chat_ai,v=record.data,provider=form.elements.provider.value,model=form.elements[provider+'Model'].value.trim();
 if(!record.version||provider!==v.provider||model!==(v.profiles?.[provider]?.model||'')||form.elements.aiEnabled.checked!==Boolean(v.enabled)||form.elements[provider+'Key'].value.trim())throw Error('Có cấu hình AI chưa lưu. Bấm Lưu Chat AI trước, rồi nhập lại thông tin xác thực để kiểm tra.');
 return {provider,model};
}

function probeFailure(error){
 const d=error.diagnostic;
 if(!d)return error.message;
 const names={openai:'OpenAI / GPT',gemini:'Google Gemini',claude:'Anthropic Claude'};
 return (names[d.provider]||'AI')+' · '+d.model+': '+error.message+'\nMã chẩn đoán: '+d.code+(d.upstreamStatus?' · HTTP '+d.upstreamStatus:'')+(d.requestId?' · Mã hỗ trợ: '+d.requestId:'');
}

document.addEventListener('click',async event=>{
 const button=event.target.closest('[data-chat-ai-test]');
 if(!button||button.disabled)return;
 const f=button.closest('form'),status=f.querySelector('[role=status]'),modal=typeof button.closest==='function'?button.closest('.config-modal-dialog'):null,modalStatus=modal?.querySelector('[data-modal-status]');
 try{
  const selected=savedAISelection(f);
  if(!f.elements.password.value){
   f.elements.password.focus();
   throw Error('Nhập lại mật khẩu hiện tại trước khi kiểm tra. Nếu đã bật xác thực hai yếu tố, dùng mã mới chưa sử dụng.');
  }
  const pwd=f.elements.password.value;
  button.disabled=true;
  const testingMsg='Đang kiểm tra '+selected.provider+' · '+selected.model+' đã lưu…';
  if(status)status.textContent=testingMsg;
  if(modalStatus){modalStatus.textContent='⏳ '+testingMsg;modalStatus.className='config-modal-status is-visible';}
  const result=await admin.request('/api/gaeru_ceo/owner/configuration/chat_ai/test',{
   method:'POST',
   body:JSON.stringify({
    version:Number(f.dataset.version),
    expectedProvider:selected.provider,
    expectedModel:selected.model,
    password:pwd,
    factorCode:f.elements.factorCode.value,
    factorChallengeId:f.dataset.challenge
   })
  });
  const succMsg=result.message+' '+result.provider+' · '+result.model;
  if(status)status.textContent=succMsg;
  if(modalStatus){modalStatus.textContent='✅ '+succMsg;modalStatus.className='config-modal-status is-visible is-success';}
  for(const input of f.querySelectorAll('input[type=password],[name=factorCode]'))input.value='';
  delete f.dataset.challenge;
 }catch(error){
  const failMsg=probeFailure(error)+(error.stage==='provider'?' Nhập lại thông tin xác thực mới nếu cần kiểm tra lại.':'');
  if(status)status.textContent=failMsg;
  if(modalStatus){modalStatus.textContent='❌ '+failMsg;modalStatus.className='config-modal-status is-visible is-error';}
  if(error.stage==='provider'){
   for(const input of f.querySelectorAll('input[type=password],[name=factorCode]'))input.value='';
   delete f.dataset.challenge;
  }
 }finally{
  button.disabled=false;
 }
});

document.addEventListener('click',async event=>{
 const button=event.target.closest('[data-misa-test]');
 if(!button)return;
 const f=button.closest('form'),status=f.querySelector('[role=status]');
 const modalStatus=f.closest('.config-modal-body')?.querySelector('[data-modal-status]');
 try{
  if(!f.elements.password?.value){
   throw Error('Nhập lại mật khẩu hiện tại trước khi kiểm tra. Nếu đã bật xác thực hai yếu tố, dùng mã mới chưa sử dụng.');
  }
  const pwd=f.elements.password.value;
  button.disabled=true;
  const testingMsg='Đang kiểm tra kết nối MISA eShop…';
  if(status)status.textContent=testingMsg;
  if(modalStatus){modalStatus.textContent='⏳ '+testingMsg;modalStatus.className='config-modal-status is-visible';}
  const result=await admin.request('/api/gaeru_ceo/owner/configuration/misa/test',{
   method:'POST',
   body:JSON.stringify({
    version:Number(f.dataset.version),
    password:pwd,
    factorCode:f.elements.factorCode.value,
    factorChallengeId:f.dataset.challenge
   })
  });
  const succMsg=(result.message||'Kết nối thành công.')+' ('+(result.environment==='production'?'Chính thức':'Thử nghiệm')+' · Cửa hàng: '+result.storeId+')';
  if(status)status.textContent=succMsg;
  if(modalStatus){modalStatus.textContent='✅ '+succMsg;modalStatus.className='config-modal-status is-visible is-success';}
  for(const input of f.querySelectorAll('input[type=password],[name=factorCode]'))input.value='';
  delete f.dataset.challenge;
 }catch(error){
  const failMsg=error.message||'Kiểm tra kết nối MISA eShop thất bại.';
  if(status)status.textContent=failMsg;
  if(modalStatus){modalStatus.textContent='❌ '+failMsg;modalStatus.className='config-modal-status is-visible is-error';}
  if(error.stage==='provider'){
   for(const input of f.querySelectorAll('input[type=password],[name=factorCode]'))input.value='';
   delete f.dataset.challenge;
  }
 }finally{
  button.disabled=false;
 }
});

async function mountOperations(root){
 if(!owner()||!root?.isConnected)return;
 await read();
 if(!root.isConnected)return;
 root.innerHTML='<h3>Điều khiển vận hành</h3><p class="help-text">Chọn trạng thái, sau đó xác nhận để lưu.</p>'+form('operations')+'<div class="configuration-service-links"><button type="button" data-config-open="payments">Quản lý kênh thanh toán</button><button type="button" data-config-open="security">Chính sách phiên</button><button type="button" data-owner-security>Tài khoản &amp; xác thực</button></div>';
 const f=root.querySelector('form'),panel=document.createElement('details');
 panel.className='owner-operation-confirm';
 panel.innerHTML='<summary>Xác nhận và lưu thay đổi</summary>';
 f.append(panel);
 panel.append(f.querySelector('.configuration-reauth'),f.querySelector('.configuration-actions'));
 f.addEventListener('invalid',()=>{panel.open=true;},true);
}

document.addEventListener('change',event=>{
 const input=event.target;
 if(input.name!=='ordersEnabled')return;
 const f=input.closest('[data-config-form="operations"]');
 if(!f)return;
 const panel=f.querySelector('.owner-operation-confirm');
 if(panel){
  panel.open=true;
  panel.querySelector('summary').textContent=input.checked?'Xác nhận bật nhận đơn':'Xác nhận tạm dừng nhận đơn';
 }
});

document.addEventListener('click',async event=>{
 const button=event.target.closest('[data-config-open]');
 if(!button)return;
 const target=button.dataset.configOpen;
 await admin.activateView(paymentIds.has(target)?'payments':'settings');
 const panelId=target==='payments'?'config-panel-vnpay':'config-panel-'+target;
 const panel=document.getElementById(panelId);
 if(panel){
  panel.open=true;
  panel.scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth',block:'start'});
  panel.querySelector('input')?.focus({preventScroll:true});
 }
});

document.addEventListener('click',async e=>{
 const button=e.target.closest('[data-media-storage-probe]');
 if(!button)return;
 const status=button.parentElement.querySelector('[data-media-storage-probe-result]');
 button.disabled=true;
 status.textContent='Đang thử ghi, đọc lại và xóa tệp kiểm tra…';
 try{
  const r=await admin.request('/api/gaeru_ceo/owner/media-storage/probe',{method:'POST',body:'{}'});
  status.textContent=[
   r.message,
   r.errorCode,
   r.operation,
   r.configuredPath?'MEDIA_ROOT: '+r.configuredPath:'',
   r.errorPath?'Đường dẫn lỗi: '+r.errorPath:'',
   r.inventory?'Thư mục thực: '+r.inventory.realPath+' · '+r.inventory.files+' tệp · '+r.inventory.bytes+' byte':'',
   ...(r.inventory?.directories||[]).map(d=>d.name+': '+d.files+' tệp')
  ].filter(Boolean).join(' · ');
 }catch(error){
  status.textContent=error.message;
 }finally{
  button.disabled=false;
 }
});

window.GAERUConfiguration={load,mountProfile,mountOperations,mountShipping,mountPayments,openConfigModal,closeConfigModal};
})();
