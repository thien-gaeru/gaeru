(function(root){
  const views={
    overview:['Tổng quan','Không gian vận hành','Các chỉ số và công việc cần xử lý của cửa hàng.','M3 3h6v6H3z M13 3h6v6h-6z M3 13h6v6H3z M13 13h6v6h-6z'],
    notifications:['Thông báo','Không gian vận hành','Theo dõi cảnh báo và mở đúng hồ sơ cần xử lý.','M5 15V9a6 6 0 0 1 12 0v6l2 2H3z M9 20h4'],
    security:['Cài đặt bảo mật tài khoản','Tài khoản','Mật khẩu, liên hệ khôi phục và xác thực hai yếu tố.','M11 2l8 3v6c0 5-8 9-8 9S3 16 3 11V5z M7 11l3 3 5-6'],
    owner:['Quản trị tối cao','Tài khoản','Trạng thái bảo vệ và quyền kiểm soát của chủ doanh nghiệp.','M11 2l8 3v6c0 5-8 9-8 9S3 16 3 11V5z M8 11h6 M11 8v6'],
    orders:['Đơn hàng','Bán hàng','Tìm kiếm, kiểm tra thanh toán và xử lý theo trạng thái đơn.','M5 3h12v17H5z M8 7h6 M8 11h6 M8 15h4'],
    care:['GAERU CARE+','Bán hàng','Tiếp nhận yêu cầu và trao đổi trực tiếp trong từng hội thoại.','M3 4h16v12H9l-6 4z M7 8h8 M7 12h5'],
    warranty:['Bảo hành sản phẩm','Bán hàng','Hồ sơ theo mã đơn; tự động cho website, đối chiếu đơn bên ngoài.','M11 2l8 3v6c0 5-8 9-8 9S3 16 3 11V5z M7 11l3 3 5-6'],
    customers:['Khách hàng','Bán hàng','Thông tin liên hệ, đơn hàng và các yêu cầu tài khoản.','M7 7a4 4 0 1 0 8 0a4 4 0 1 0-8 0 M3 20v-2a8 6 0 0 1 16 0v2'],
    news:['Tin tức','Nội dung & sản phẩm','Soạn bài, kiểm tra bản nháp và quản lý nội dung xuất bản.','M3 3h16v17H3z M6 7h10 M6 11h4v5H6z M13 11h3 M13 15h3'],
    products:['Sản phẩm','Nội dung & sản phẩm','Danh mục, biến thể, giá bán và trạng thái hiển thị.','M11 2l9 5v10l-9 5-9-5V7z M2 7l9 5 9-5 M11 12v10'],
    inventory:['Tồn kho & điều chuyển','Kho & mua hàng','Theo dõi tồn thực tế và lịch sử nghiệp vụ kho.','M3 5h16v15H3z M3 10h16 M8 5V2 M14 5V2 M7 14h8'],
    warehouses:['Kho hàng','Kho & mua hàng','Danh sách kho và thông tin phục vụ nhập, xuất, điều chuyển.','M2 9l9-7 9 7v12H2z M7 21V11h8v10'],
    suppliers:['Nhà cung cấp','Kho & mua hàng','Thông tin đối tác và liên kết đến nghiệp vụ mua hàng.','M3 21V6h9v15 M12 10h7v11 M6 10h3 M6 14h3 M15 14h1'],
    purchases:['Đơn mua & nhập hàng','Kho & mua hàng','Đối chiếu đơn mua, duyệt và ghi nhận từng lần nhập.','M5 3h12v17H5z M8 7h6 M8 11h6 M8 15h4'],
    finance:['Công nợ & thanh toán','Tài chính','Theo dõi số dư và ghi nhận thu, chi có chứng từ.','M2 5h18v14H2z M2 9h18 M6 15h4'],
    payroll:['Tính lương','Tài chính','Kiểm tra chứng từ lương trước khi duyệt và ghi nhận chi.','M4 3h14v18H4z M7 7h8 M7 11h2 M13 11h2 M7 15h2 M13 15h2'],
    tax:['Đối chiếu thuế','Tài chính','Đối chiếu số liệu theo kỳ và giữ lịch sử chứng từ.','M5 3h12v17H5z M8 7h6 M8 11h6 M8 15h4'],
    invoice:['Hóa đơn điện tử','Tài chính','Chuẩn bị dữ liệu hóa đơn và theo dõi trạng thái chứng từ.','M5 2h12v20l-3-2-3 2-3-2-3 2z M8 7h6 M8 11h6'],
    marketplace:['Sàn TMĐT & lợi nhuận','Tài chính','Đối soát theo kênh và theo dõi các chi phí chưa đầy đủ.','M3 20V8 M9 20V3 M15 20v-9 M21 20H1'],
    reports:['Báo cáo kinh doanh','Tài chính','Đọc số liệu theo kỳ và nhận diện phần dữ liệu còn thiếu.','M3 20V8 M9 20V3 M15 20v-9 M21 20H1'],
    staff:['Nhân viên & quyền','Tổ chức','Tài khoản nhân viên, vai trò và trạng thái truy cập.','M7 7a4 4 0 1 0 8 0a4 4 0 1 0-8 0 M3 20v-2a8 6 0 0 1 16 0v2'],
    departments:['Phòng ban','Tổ chức','Sắp xếp nhóm làm việc và thông tin tổ chức.','M8 2h6v5H8z M3 16h6v5H3z M15 16h6v5h-6z M11 7v5 M6 16v-4h12v4'],
    audit:['Nhật ký hoạt động','Tổ chức','Tra cứu lịch sử nghiệp vụ theo quyền được cấp.','M11 2a9 9 0 1 0 9 9 M11 5v6l4 3 M15 2h5v5'],
    settings:['Cài đặt cửa hàng','Vận hành','Thông tin cửa hàng, phí giao hàng và cấu hình nghiệp vụ.','M3 6h16 M3 16h16 M7 3v6 M15 13v6']
  };
  const roles={owner:'Chủ doanh nghiệp',admin:'Quản trị viên',manager:'Quản lý',sales:'Kinh doanh',warehouse:'Nhân viên kho',accountant:'Kế toán',viewer:'Chỉ xem'};
  const api={views,roleName:value=>roles[value]||value,title:view=>views[view]?.[0],description:view=>views[view]?.[2]};
  if(typeof module!=='undefined')module.exports=api;
  if(!root.document)return;
  root.GAERUAdminUI=api;
  const document=root.document,nav=document.querySelector('#admin-navigation');
  if(!nav)return;
  for(const button of nav.querySelectorAll('[data-view]')){
    const info=views[button.dataset.view];if(!info)continue;
    const icon=document.createElementNS('http://www.w3.org/2000/svg','svg');
    for(const [key,value]of Object.entries({viewBox:'0 0 24 24',fill:'none',stroke:'currentColor','stroke-width':'1.5','stroke-linecap':'round','stroke-linejoin':'round','aria-hidden':'true'}))icon.setAttribute(key,value);
    const path=document.createElementNS('http://www.w3.org/2000/svg','path');path.setAttribute('d',info[3]);icon.append(path);
    const label=document.createElement('span');label.className='admin-nav-label';
    while(button.firstChild)label.append(button.firstChild);button.append(icon,label);
  }
  const search=document.createElement('label');search.className='admin-nav-search';
  search.innerHTML='<span>Tìm mục quản trị</span><input type="search" placeholder="Tìm mục…" autocomplete="off" aria-controls="admin-navigation"><small>⌘ / Ctrl K</small>';
  nav.before(search);const input=search.querySelector('input');
  function filter(){const q=input.value.normalize('NFD').replace(/\p{Diacritic}/gu,'').replace(/đ/g,'d').toLowerCase().trim();for(const button of nav.querySelectorAll('[data-view]')){const hay=button.textContent.normalize('NFD').replace(/\p{Diacritic}/gu,'').replace(/đ/g,'d').toLowerCase();button.toggleAttribute('data-search-hidden',Boolean(q&&!hay.includes(q)));}for(const group of nav.querySelectorAll('.nav-group'))group.toggleAttribute('data-search-empty',![...group.querySelectorAll('[data-view]')].some(b=>!b.hidden&&!b.hasAttribute('data-search-hidden')));}
  input.addEventListener('input',filter);document.addEventListener('gaeru:admin-ready',()=>queueMicrotask(filter));
  document.addEventListener('keydown',event=>{if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='k'){if(document.querySelector('#admin-app').hidden)return;event.preventDefault();document.querySelector('.sidebar').classList.add('navigation-open');document.querySelector('.sidebar-toggle').setAttribute('aria-expanded','true');input.focus();}if(event.key==='Escape'&&document.activeElement===input){input.value='';filter();}});
  let heartbeatAt=Date.now(),running=false;
  function activity(event){if(!event.isTrusted||!root.GAERUAdmin?.user||running||Date.now()-heartbeatAt<60000)return;running=true;heartbeatAt=Date.now();root.GAERUAdmin.request('/api/auth/activity',{method:'POST',gaeruBackground:true}).catch(()=>{}).finally(()=>running=false);}
  document.addEventListener('keydown',activity);document.addEventListener('click',activity);
  root.addEventListener('pageshow',event=>{if(event.persisted)root.location.reload();});
})(typeof window==='undefined'?globalThis:window);
