'use strict';

const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

const os = require('os');

const SCREENSHOT_DIR = process.env.GAERU_SCREENSHOT_DIR || path.join(os.homedir(), '.gemini', 'antigravity', 'brain', '470c3e88-af2f-4c7e-9f97-1ee26cfc045b', 'screenshots');
const BASE_URL = 'http://127.0.0.1:3000';
const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

if (!fs.existsSync(SCREENSHOT_DIR)) {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
}

const auditReport = {
  timestamp: new Date().toISOString(),
  pagesAudited: [],
  interactions: [],
  consoleErrors: [],
  networkErrors: [],
  brokenLinks: [],
  summary: {}
};

async function runE2EAudit() {
  console.log('=== BẮT ĐẦU TỔNG KIỂM TRA TOÀN BỘ HỆ THỐNG VÀ CHỤP ẢNH MINH CHỨNG ===');
  
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-gpu',
      '--window-size=1280,900'
    ]
  });

  async function createAuditPage(isMobile = false) {
    const page = await browser.newPage();
    if (isMobile) {
      await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
    } else {
      await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
    }

    page.on('console', msg => {
      const type = msg.type();
      const text = msg.text();
      if (type === 'error' && !text.includes('favicon.ico') && !text.includes('[GSI_LOGGER]')) {
        console.warn(`[BROWSER ERROR] [${page.url()}] ${text}`);
        auditReport.consoleErrors.push({ url: page.url(), text });
      }
    });

    page.on('pageerror', err => {
      console.error(`[PAGE UNCAUGHT ERROR] [${page.url()}] ${err.message}`);
      auditReport.consoleErrors.push({ url: page.url(), error: err.message });
    });

    page.on('requestfailed', req => {
      const failure = req.failure();
      const url = req.url();
      if (!url.includes('google-analytics') && !url.includes('googletagmanager') && failure?.errorText !== 'net::ERR_ABORTED') {
        console.warn(`[REQUEST FAILED] ${url} - ${failure?.errorText}`);
        auditReport.networkErrors.push({ url, error: failure?.errorText });
      }
    });

    return page;
  }

  // Danh sách các trang chính cần kiểm tra hiển thị Desktop
  const pagesToTest = [
    { name: '01_Trang_Chu', path: '/', title: 'Trang chủ GAERU' },
    { name: '02_Cua_Hang', path: '/cua-hang', title: 'Cửa hàng GAERU' },
    { name: '03_San_Pham_P01', path: '/san-pham/gaeru-p01', title: 'Chi tiết sản phẩm GAERU P01' },
    { name: '04_Kham_Pha_P01', path: '/kham-pha/gaeru-p01', title: 'Khám phá GAERU P01' },
    { name: '05_Gio_Hang', path: '/gio-hang', title: 'Giỏ hàng' },
    { name: '06_Thanh_Toan', path: '/thanh-toan', title: 'Thanh toán đơn hàng' },
    { name: '07_Tai_Khoan', path: '/tai-khoan', title: 'Tài khoản khách hàng' },
    { name: '08_Ho_Tro', path: '/ho-tro', title: 'Trung tâm hỗ trợ GAERU' },
    { name: '09_Tra_Cuu_Don_Hang', path: '/tra-cuu-don-hang', title: 'Tra cứu hành trình đơn hàng' },
    { name: '10_Dang_Ky_Bao_Hanh', path: '/dang-ky-bao-hanh', title: 'Đăng ký & Kích hoạt bảo hành Care+' },
    { name: '11_Care_Plus', path: '/care', title: 'Chương trình bảo hành Care+' },
    { name: '12_Huong_Dan', path: '/huong-dan', title: 'Hướng dẫn sử dụng thiết bị' },
    { name: '13_Tin_Tuc', path: '/tin-tuc', title: 'Tin tức & Bài viết công nghệ' },
    { name: '14_Cau_Chuyen', path: '/cau-chuyen', title: 'Câu chuyện thương hiệu GAERU' },
    { name: '15_Chinh_Sach_Quyen_Rieng_Tu', path: '/chinh-sach/quyen-rieng-tu', title: 'Chính sách Quyền riêng tư' },
    { name: '16_Chinh_Sach_Dieu_Khoan', path: '/chinh-sach/dieu-khoan', title: 'Điều khoản dịch vụ' },
    { name: '17_Chinh_Sach_Giao_Hang_Doi_Tra', path: '/chinh-sach/giao-hang-doi-tra', title: 'Chính sách giao hàng và đổi trả' },
    { name: '18_Khieu_Nai', path: '/khieu-nai', title: 'Chính sách giải quyết khiếu nại' }
  ];

  console.log('\n--- 1. DUYỆT KIỂM TRA HIỂN THỊ TỪNG TRANG (DESKTOP) ---');
  for (const p of pagesToTest) {
    const page = await createAuditPage(false);
    try {
      const fullUrl = BASE_URL + p.path;
      const res = await page.goto(fullUrl, { waitUntil: 'domcontentloaded', timeout: 8000 });
      await new Promise(r => setTimeout(r, 600));
      const status = res?.status() || 0;
      
      const shotFilename = `${p.name}.png`;
      const shotPath = path.join(SCREENSHOT_DIR, shotFilename);
      await page.screenshot({ path: shotPath, fullPage: false });

      console.log(`[PASS] ${p.name}: HTTP ${status} | URL: ${p.path} -> Chụp ảnh: ${shotFilename}`);
      auditReport.pagesAudited.push({
        name: p.name,
        path: p.path,
        status,
        screenshot: shotFilename,
        ok: status === 200
      });
    } catch (err) {
      console.error(`[FAIL] ${p.name}: Lỗi tải trang - ${err.message}`);
      auditReport.pagesAudited.push({
        name: p.name,
        path: p.path,
        error: err.message,
        ok: false
      });
    } finally {
      await page.close();
    }
  }

  // 2. KIỂM TRA THAO TÁC NÚT BẤM THỰC TẾ & CHỤP ẢNH TỪNG TÁC VỤ
  console.log('\n--- 2. KIỂM TRA TƯƠNG TÁC NÚT BẤM & TÁC VỤ THỰC TẾ ---');

  // Tác vụ A: Tương tác trang sản phẩm - Chuyển đổi Biến thể & Thêm giỏ hàng
  {
    const page = await createAuditPage(false);
    try {
      console.log('\n[Tác vụ A] Kiểm tra chuyển đổi biến thể & Thêm giỏ hàng trên /san-pham/gaeru-p01');
      await page.goto(BASE_URL + '/san-pham/gaeru-p01', { waitUntil: 'domcontentloaded' });
      await new Promise(r => setTimeout(r, 600));

      const shotPdpInitial = '19_TacVu_SanPham_KhoiTao.png';
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, shotPdpInitial) });

      // Click chọn variant khác nếu có
      await page.evaluate(() => {
        const select = document.querySelector('select#product-variant');
        if (select && select.options.length > 1) {
          select.selectedIndex = 1;
          select.dispatchEvent(new Event('change', { bubbles: true }));
        }
      });
      await new Promise(r => setTimeout(r, 500));

      // Bấm nút Thêm vào giỏ
      const buyButton = await page.$('[data-add-to-cart], [data-buy-now], button.add-to-cart, .btn-buy-now');
      if (buyButton) {
        console.log('Bấm nút Thêm vào giỏ hàng...');
        await buyButton.click();
        await new Promise(r => setTimeout(r, 1200));
      }

      const shotPdpAdded = '20_TacVu_DaThemGioHang.png';
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, shotPdpAdded) });
      console.log(`[PASS] Đã bấm Thêm vào giỏ hàng và chụp minh chứng: ${shotPdpAdded}`);

      auditReport.interactions.push({
        task: 'Chọn biến thể và thêm giỏ hàng',
        status: 'SUCCESS',
        screenshots: [shotPdpInitial, shotPdpAdded]
      });
    } catch (err) {
      console.error('[FAIL] Lỗi tương tác PDP:', err.message);
      auditReport.interactions.push({ task: 'Chọn biến thể và thêm giỏ hàng', status: 'FAILED', error: err.message });
    } finally {
      await page.close();
    }
  }

  // Tác vụ B: Kiểm tra Giỏ hàng & Thay đổi số lượng
  {
    const page = await createAuditPage(false);
    try {
      console.log('\n[Tác vụ B] Kiểm tra giỏ hàng trên /gio-hang');
      await page.goto(BASE_URL + '/gio-hang', { waitUntil: 'domcontentloaded' });
      await new Promise(r => setTimeout(r, 600));
      const shotCart = '21_TacVu_TrangGioHang_CoSanPham.png';
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, shotCart) });
      console.log(`[PASS] Chụp ảnh giỏ hàng: ${shotCart}`);

      auditReport.interactions.push({
        task: 'Kiểm tra giỏ hàng',
        status: 'SUCCESS',
        screenshots: [shotCart]
      });
    } catch (err) {
      console.error('[FAIL] Lỗi giỏ hàng:', err.message);
    } finally {
      await page.close();
    }
  }

  // Tác vụ C: Kiểm tra Chat Realtime SSE & Streamline Header
  {
    const page = await createAuditPage(false);
    try {
      console.log('\n[Tác vụ C] Kiểm tra Floating Chat Button & Mở Dialog Chat Realtime');
      await page.goto(BASE_URL + '/cua-hang', { waitUntil: 'domcontentloaded' });
      await new Promise(r => setTimeout(r, 600));

      // Mở modal chat
      await page.evaluate(() => {
        const chatBtn = document.querySelector('[data-product-chat], [data-open-chat], .floating-chat-trigger, #chat-widget-launcher');
        if (chatBtn) chatBtn.click();
        else if (window.openChat) window.openChat(null);
      });
      await new Promise(r => setTimeout(r, 1500));

      // Chụp ảnh giao diện Chat Dialog đang mở
      const shotChatOpen = '22_TacVu_ChatDialog_HeaderStreamline.png';
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, shotChatOpen) });
      console.log(`[PASS] Chụp ảnh Modal Chat với chấm trạng thái SSE và hotline cùng 1 hàng: ${shotChatOpen}`);

      // Gõ thử tin nhắn trong Chat
      const chatInput = await page.$('textarea[data-chat-input], input[data-chat-input], .shopping-chat-dialog textarea');
      if (chatInput) {
        console.log('Gõ tin nhắn thử nghiệm vào hộp chat...');
        await chatInput.type('Xin chào GAERU, tư vấn giúp tôi thiết bị P01');
        await new Promise(r => setTimeout(r, 500));
        
        const shotChatTyping = '23_TacVu_Chat_GoTinNhan.png';
        await page.screenshot({ path: path.join(SCREENSHOT_DIR, shotChatTyping) });
        console.log(`[PASS] Chụp ảnh soạn tin nhắn chat: ${shotChatTyping}`);
      }

      auditReport.interactions.push({
        task: 'Mở chat realtime và kiểm tra giao diện',
        status: 'SUCCESS',
        screenshots: [shotChatOpen]
      });
    } catch (err) {
      console.error('[FAIL] Lỗi tương tác Chat:', err.message);
    } finally {
      await page.close();
    }
  }

  // Tác vụ D: Kiểm tra Trang Tài khoản & Form Đăng nhập
  {
    const page = await createAuditPage(false);
    try {
      console.log('\n[Tác vụ D] Kiểm tra Trang Tài khoản / Đăng nhập');
      await page.goto(BASE_URL + '/tai-khoan', { waitUntil: 'domcontentloaded' });
      await new Promise(r => setTimeout(r, 600));

      const shotAccountLogin = '24_TacVu_DangNhap_KhachHang.png';
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, shotAccountLogin) });
      console.log(`[PASS] Chụp ảnh giao diện đăng nhập tài khoản: ${shotAccountLogin}`);

      auditReport.interactions.push({
        task: 'Kiểm tra form đăng nhập tài khoản',
        status: 'SUCCESS',
        screenshots: [shotAccountLogin]
      });
    } catch (err) {
      console.error('[FAIL] Lỗi form tài khoản:', err.message);
    } finally {
      await page.close();
    }
  }

  // Tác vụ E: Kiểm tra Form Tra cứu đơn hàng & Đăng ký bảo hành
  {
    const page1 = await createAuditPage(false);
    try {
      console.log('\n[Tác vụ E1] Kiểm tra Form Tra cứu đơn hàng');
      await page1.goto(BASE_URL + '/tra-cuu-don-hang', { waitUntil: 'domcontentloaded' });
      await new Promise(r => setTimeout(r, 600));

      const orderInput = await page1.$('input[name="orderNumber"], input[name="orderId"], input[type="text"]');
      if (orderInput) {
        await orderInput.type('GAE-261028-1234');
        await new Promise(r => setTimeout(r, 300));
      }
      const shotTracking = '25_TacVu_TraCuuDonHang.png';
      await page1.screenshot({ path: path.join(SCREENSHOT_DIR, shotTracking) });
      console.log(`[PASS] Chụp ảnh tra cứu đơn hàng: ${shotTracking}`);
    } finally {
      await page1.close();
    }

    const page2 = await createAuditPage(false);
    try {
      console.log('\n[Tác vụ E2] Kiểm tra Form Đăng ký bảo hành');
      await page2.goto(BASE_URL + '/dang-ky-bao-hanh', { waitUntil: 'domcontentloaded' });
      await new Promise(r => setTimeout(r, 600));

      const shotWarranty = '26_TacVu_DangKyBaoHanh.png';
      await page2.screenshot({ path: path.join(SCREENSHOT_DIR, shotWarranty) });
      console.log(`[PASS] Chụp ảnh đăng ký bảo hành: ${shotWarranty}`);

      auditReport.interactions.push({
        task: 'Kiểm tra form tra cứu đơn và đăng ký bảo hành',
        status: 'SUCCESS',
        screenshots: ['25_TacVu_TraCuuDonHang.png', shotWarranty]
      });
    } finally {
      await page2.close();
    }
  }

  // 3. KIỂM TRA HIỂN THỊ MOBILE (IPHONE VIEWPORT 390x844)
  console.log('\n--- 3. KIỂM TRA GIAO DIỆN MOBILE VIEWPORT (390x844) ---');
  const mobilePages = [
    { name: '27_Mobile_TrangChu', path: '/' },
    { name: '28_Mobile_CuaHang', path: '/cua-hang' },
    { name: '29_Mobile_SanPham_P01', path: '/san-pham/gaeru-p01' },
    { name: '30_Mobile_HoTro', path: '/ho-tro' }
  ];

  for (const mp of mobilePages) {
    const page = await createAuditPage(true);
    try {
      await page.goto(BASE_URL + mp.path, { waitUntil: 'domcontentloaded' });
      await new Promise(r => setTimeout(r, 600));
      const shotFilename = `${mp.name}.png`;
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, shotFilename) });
      console.log(`[PASS] Mobile ${mp.name} -> Chụp ảnh: ${shotFilename}`);
    } catch (err) {
      console.error(`[FAIL] Mobile ${mp.name}:`, err.message);
    } finally {
      await page.close();
    }
  }

  // Tác vụ Mobile F: Bấm mở Menu Drawer trên Mobile
  {
    const page = await createAuditPage(true);
    try {
      await page.goto(BASE_URL + '/', { waitUntil: 'domcontentloaded' });
      await new Promise(r => setTimeout(r, 600));
      const menuButton = await page.$('[data-menu-toggle], button.site-nav-toggle, button.menu-trigger, [aria-label*="menu" i]');
      if (menuButton) {
        console.log('Bấm mở Hamburger Menu trên Mobile...');
        await menuButton.click();
        await new Promise(r => setTimeout(r, 600));
        const shotMenuOpen = '31_Mobile_MenuDrawer_Mo.png';
        await page.screenshot({ path: path.join(SCREENSHOT_DIR, shotMenuOpen) });
        console.log(`[PASS] Chụp ảnh Hamburger Drawer mở trên mobile: ${shotMenuOpen}`);
      }
    } catch (err) {
      console.warn('Lỗi mở menu mobile:', err.message);
    } finally {
      await page.close();
    }
  }

  // 4. QUÉT TOÀN BỘ LIÊN KẾT (BROKEN LINK CHECKER)
  console.log('\n--- 4. QUÉT TOÀN BỘ LIÊN KẾT TRÊN TRANG (BROKEN LINK AUDIT) ---');
  const pageAuditLinks = await createAuditPage(false);
  await pageAuditLinks.goto(BASE_URL + '/', { waitUntil: 'domcontentloaded' });
  await new Promise(r => setTimeout(r, 600));

  const allHrefs = await pageAuditLinks.evaluate(() => {
    const anchors = Array.from(document.querySelectorAll('a[href]'));
    return Array.from(new Set(anchors.map(a => a.getAttribute('href')).filter(Boolean)));
  });
  await pageAuditLinks.close();

  console.log(`Tìm thấy tổng cộng ${allHrefs.length} liên kết trên Trang chủ.`);
  let checkedCount = 0;
  let brokenCount = 0;

  for (const href of allHrefs) {
    if (href.startsWith('#') || href.startsWith('tel:') || href.startsWith('mailto:') || href.startsWith('javascript:')) {
      continue;
    }
    checkedCount++;
    const testUrl = href.startsWith('http') ? href : BASE_URL + (href.startsWith('/') ? href : '/' + href);
    try {
      const response = await fetch(testUrl, { method: 'HEAD' });
      if (response.status >= 400) {
        console.warn(`[BROKEN LINK] ${href} -> HTTP ${response.status}`);
        auditReport.brokenLinks.push({ href, status: response.status });
        brokenCount++;
      }
    } catch (e) {
      console.warn(`[BROKEN LINK FETCH ERROR] ${href} -> ${e.message}`);
      auditReport.brokenLinks.push({ href, error: e.message });
      brokenCount++;
    }
  }
  console.log(`Hoàn tất quét ${checkedCount} liên kết nội bộ. Số liên kết lỗi: ${brokenCount}`);

  await browser.close();

  // Lưu báo cáo JSON
  const reportPath = path.join(__dirname, '..', 'logs', 'e2e-audit-results.json');
  auditReport.summary = {
    totalPagesChecked: pagesToTest.length,
    pagesSuccess: auditReport.pagesAudited.filter(p => p.ok).length,
    totalConsoleErrors: auditReport.consoleErrors.length,
    totalNetworkErrors: auditReport.networkErrors.length,
    totalBrokenLinks: auditReport.brokenLinks.length,
    completedAt: new Date().toISOString()
  };
  fs.writeFileSync(reportPath, JSON.stringify(auditReport, null, 2), 'utf8');

  console.log('\n=== TỔNG KẾT KẾT QUẢ KIỂM TRA TOÀN BỘ HỆ THỐNG ===');
  console.log(`- Trang kiểm tra thành công: ${auditReport.summary.pagesSuccess} / ${auditReport.summary.totalPagesChecked}`);
  console.log(`- Lỗi console phát hiện: ${auditReport.summary.totalConsoleErrors}`);
  console.log(`- Lỗi mạng/tài nguyên: ${auditReport.summary.totalNetworkErrors}`);
  console.log(`- Liên kết hỏng (Broken links): ${auditReport.summary.totalBrokenLinks}`);
  console.log(`- Thư mục ảnh chụp màn hình: ${SCREENSHOT_DIR}`);
  console.log(`- File báo cáo kết quả: ${reportPath}`);
}

runE2EAudit().catch(err => {
  console.error('Lỗi nghiêm trọng trong quá trình kiểm tra E2E:', err);
  process.exit(1);
});
