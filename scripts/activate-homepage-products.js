const BASE_URL = process.env.BASE_URL || `http://127.0.0.1:${process.env.PORT || 3000}`;
const isApply = process.argv.includes('--apply');
const isPlan = process.argv.includes('--plan') || (!isApply && !process.env.GAERU_ADMIN_USER);

// GAERU OPS-03: Enforce HTTPS for remote URLs to prevent unencrypted credential transit
try {
  const parsedBase = new URL(BASE_URL);
  if (parsedBase.protocol !== 'https:' && !['127.0.0.1', 'localhost', '::1'].includes(parsedBase.hostname)) {
    if (isApply) {
      throw new Error('BASE_URL bắt buộc phải dùng giao thức HTTPS khi không chạy trên localhost để bảo mật thông tin quản trị.');
    } else {
      console.warn('⚠️ CẢNH BÁO: BASE_URL đang dùng HTTP (' + BASE_URL + '). Khi áp dụng --apply trên máy chủ từ xa, bắt buộc phải dùng HTTPS.');
    }
  }
} catch (e) {
  if (isApply) throw e;
}

async function activateProducts() {
  console.log('--- KÍCH HOẠT SẢN PHẨM MỞ BÁN TRÊN TRANG CHỦ GAERU ---');
  if (isPlan || !isApply) {
    console.log('ℹ CHẾ ĐỘ PLAN / DRY-RUN: Script đang chạy ở chế độ xem trước an toàn. Không có dữ liệu nào được ghi.');
    console.log('  Để áp dụng thay đổi, chạy lệnh với cờ: node scripts/activate-homepage-products.js --apply\n');
  }

  const username = process.env.GAERU_ADMIN_USER;
  const password = process.env.GAERU_ADMIN_PASSWORD;

  if (isPlan || !username || !password) {
    if (!username || !password) {
      console.log('ℹ Không phát hiện credentials quản trị (GAERU_ADMIN_USER / GAERU_ADMIN_PASSWORD).');
      if (isApply) {
        throw new Error('Thiếu thông tin đăng nhập quản trị (GAERU_ADMIN_USER, GAERU_ADMIN_PASSWORD) để thực hiện --apply.');
      }
    }
    console.log('[Plan] Kiểm tra API Public Storefront...');
    try {
      const rPublic = await fetch(`${BASE_URL}/api/products`);
      const pubData = await rPublic.json();
      const publicList = pubData.products || [];
      console.log(`  -> Số sản phẩm đang mở bán trên Trang Chủ: ${publicList.length}`);
      publicList.forEach((p, idx) => {
        console.log(`     ${idx + 1}. [${p.slug}] - ${p.name}`);
      });
    } catch (_) {
      console.log('  -> Không thể kết nối tới server storefront (chưa khởi động hoặc khác cổng).');
    }
    console.log('\n[Plan] Kế hoạch các sản phẩm mục tiêu (Target Products):');
    console.log('  1. GAERU K9 (gaeru-k9) - 3 biến thể');
    console.log('  2. GAERU M3 (gaeru-m3) - 4 biến thể (chuẩn hóa theo Zod variant schema)');
    console.log('  3. GAERU P01 (gaeru-p01) - 2 biến thể');
    console.log('  4. GAERU G1 ULTRA (gaeru-g1-ultra) - 2 biến thể');
    return;
  }

  // 1. Đăng nhập quản trị viên
  console.log('1. Đăng nhập quyền Chủ doanh nghiệp (Owner)...');
  const rCsrf = await fetch(`${BASE_URL}/api/csrf`);
  const { csrfToken } = await rCsrf.json();
  const initialCookie = rCsrf.headers.get('set-cookie');

  const rLogin = await fetch(`${BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken, 'Cookie': initialCookie },
    body: JSON.stringify({ username, password })
  });
  if (rLogin.status !== 200) {
    throw new Error('Đăng nhập thất bại: HTTP ' + rLogin.status);
  }
  const loginData = await rLogin.json();
  const loginCookie = rLogin.headers.get('set-cookie') || initialCookie;
  const activeCsrfToken = loginData.csrfToken || csrfToken;
  console.log('  -> Đăng nhập thành công! CSRF mới nhận diện.');

  // Helper gửi request admin có CSRF và cookie
  async function adminReq(url, method = 'GET', body = null) {
    const opts = {
      method,
      headers: {
        'Cookie': loginCookie,
        'X-CSRF-Token': activeCsrfToken
      }
    };
    if (body) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(`${BASE_URL}` + url, opts);
    const data = await res.json().catch(() => null);
    return { status: res.status, data };
  }

  // 2. Lấy danh sách sản phẩm hiện có trong admin
  console.log('\n2. Kiểm tra danh mục sản phẩm trong hệ thống...');
  const { data: catData } = await adminReq('/api/gaeru_ceo/products?scope=catalog');
  const existingProducts = catData.products || [];
  console.log(`  -> Tìm thấy ${existingProducts.length} sản phẩm trong kho dữ liệu:`, existingProducts.map(p => ({ slug: p.slug, active: p.active })));

  // Định nghĩa thông tin chuẩn 3 sản phẩm cần kích hoạt
  const targetProducts = [
    {
      slug: 'gaeru-k9',
      product: {
        name: 'GAERU K9 Micro Thu Âm Cài Áo',
        slug: 'gaeru-k9',
        category: 'audio',
        descriptor: 'Âm thanh cho mọi câu chuyện',
        cardTitle: 'GAERU K9',
        cardSummary: 'Ghi lại giọng nói trong trẻo, tự nhiên — để ý tưởng của bạn luôn được lắng nghe.',
        description: 'Ghi lại giọng nói trong trẻo, tự nhiên — để ý tưởng của bạn luôn được lắng nghe. Micro cài áo nhỏ gọn, giảm ồn AI thông minh, kết nối không dây ổn định cho điện thoại và máy ảnh.',
        imageUrl: '/assets/products/k9.webp',
        imageAlt: 'Micro cài áo không dây GAERU K9',
        active: true,
        sortOrder: 10,
        shopeeUrl: 'https://shopee.vn/gaeru-k9-chinh-hang',
        tiktokShopUrl: 'https://vn.tiktok.com/@gaerustore/live'
      },
      gallery: ['/assets/products/k9.webp'],
      groups: [{ name: 'Phiên bản', values: ['Bản 1 Mic Type-C', 'Bản 1 Mic Lightning', 'Bản 2 Mic (Dual)'] }],
      variants: [
        {
          sku: 'K9-TYPEC',
          name: 'Bản 1 Mic Cổng Type-C',
          options: { 'Phiên bản': 'Bản 1 Mic Type-C' },
          priceVnd: 290000,
          stockQuantity: 50,
          active: true,
          imageUrl: '/assets/products/k9.webp'
        },
        {
          sku: 'K9-LIGHTNING',
          name: 'Bản 1 Mic Cổng Lightning (iPhone)',
          options: { 'Phiên bản': 'Bản 1 Mic Lightning' },
          priceVnd: 290000,
          stockQuantity: 45,
          active: true,
          imageUrl: '/assets/products/k9.webp'
        },
        {
          sku: 'K9-DUAL',
          name: 'Bản 2 Mic Thu Âm Đôi',
          options: { 'Phiên bản': 'Bản 2 Mic (Dual)' },
          priceVnd: 450000,
          stockQuantity: 30,
          active: true,
          imageUrl: '/assets/products/k9.webp'
        }
      ]
    },
    {
      slug: 'gaeru-m3',
      product: {
        name: 'GAERU M3 Micro Thu Âm Không Dây',
        slug: 'gaeru-m3',
        category: 'audio',
        descriptor: 'MIC KHÔNG DÂY CÀI ÁO CÓ HỘP SẠC CAO CẤP',
        cardTitle: 'GAERU M3',
        cardSummary: 'Micro thu âm cài áo không dây kèm hộp sạc cao cấp, màn hình kỹ thuật số hiển thị pin, lọc ồn thông minh cho điện thoại và máy ảnh.',
        description: 'Micro thu âm cài áo không dây kèm hộp sạc cao cấp, màn hình kỹ thuật số hiển thị pin, lọc ồn thông minh cho điện thoại và máy ảnh. Tương thích Type-C, Lightning, USB và Micro USB.',
        imageUrl: '/assets/products/m3-home-cutout.webp',
        imageAlt: 'Bộ micro không dây GAERU M3 cùng hộp sạc',
        active: true,
        sortOrder: 20,
        shopeeUrl: 'https://shopee.vn/gaeru-m3-chinh-hang',
        tiktokShopUrl: 'https://vn.tiktok.com/@gaerustore/live'
      },
      gallery: ['/assets/products/m3-home-cutout.webp'],
      groups: [{ name: 'Cổng kết nối', values: ['Type C', 'Type C + đầu chuyển Lightning', 'Type C + chuyển USB', 'Type C + chuyển Micro usb'] }],
      variants: [
        {
          sku: 'M3-TYPEC',
          name: 'Bản Type C',
          options: { 'Cổng kết nối': 'Type C' },
          priceVnd: 840000,
          stockQuantity: 50,
          active: true,
          imageUrl: '/assets/products/m3-home-cutout.webp'
        },
        {
          sku: 'M3-LIGHTNING',
          name: 'Bản Type C + đầu chuyển Lightning',
          options: { 'Cổng kết nối': 'Type C + đầu chuyển Lightning' },
          priceVnd: 840000,
          stockQuantity: 50,
          active: true,
          imageUrl: '/assets/products/m3-home-cutout.webp'
        },
        {
          sku: 'M3-USB',
          name: 'Bản Type C + chuyển USB',
          options: { 'Cổng kết nối': 'Type C + chuyển USB' },
          priceVnd: 840000,
          stockQuantity: 40,
          active: true,
          imageUrl: '/assets/products/m3-home-cutout.webp'
        },
        {
          sku: 'M3-MICROUSB',
          name: 'Bản Type C + chuyển Micro usb',
          options: { 'Cổng kết nối': 'Type C + chuyển Micro usb' },
          priceVnd: 840000,
          stockQuantity: 30,
          active: true,
          imageUrl: '/assets/products/m3-home-cutout.webp'
        }
      ]
    },
    {
      slug: 'gaeru-p01',
      product: {
        name: 'GAERU P01 Gimbal Xoay Theo Dõi AI',
        slug: 'gaeru-p01',
        category: 'video',
        descriptor: 'Bạn sáng tạo. P01 theo khung hình.',
        cardTitle: 'GAERU P01',
        cardSummary: 'Giá đỡ điện thoại tự động theo dõi, giúp bạn chủ động ghi hình khi quay một mình.',
        description: 'Bạn sáng tạo. P01 theo khung hình. Giá đỡ điện thoại tự động theo dõi khuôn mặt và cử chỉ 360 độ, giúp bạn chủ động ghi hình khi quay một mình. Chọn bản để bàn hoặc bộ kèm chân 2m1 phù hợp không gian.',
        imageUrl: '/assets/products/p01.webp',
        imageAlt: 'Gimbal xoay theo dõi tự động GAERU P01',
        active: true,
        sortOrder: 30,
        shopeeUrl: 'https://shopee.vn/gaeru-p01-chinh-hang',
        tiktokShopUrl: 'https://vn.tiktok.com/@gaerustore/live'
      },
      gallery: ['/assets/products/p01.webp'],
      groups: [{ name: 'Cấu hình', values: ['Bản để bàn tiêu chuẩn', 'Bộ kèm chân tripod 2m1'] }],
      variants: [
        {
          sku: 'P01-DESK',
          name: 'Bản Để Bàn Tiêu Chuẩn',
          options: { 'Cấu hình': 'Bản để bàn tiêu chuẩn' },
          priceVnd: 390000,
          stockQuantity: 40,
          active: true,
          imageUrl: '/assets/products/p01.webp'
        },
        {
          sku: 'P01-TRIPOD',
          name: 'Bộ Kèm Chân Đứng Tripod 2m1',
          options: { 'Cấu hình': 'Bộ kèm chân tripod 2m1' },
          priceVnd: 550000,
          stockQuantity: 25,
          active: true,
          imageUrl: '/assets/products/p01.webp'
        }
      ]
    },
    {
      slug: 'gaeru-g1-ultra',
      product: {
        name: 'GAERU G1 ULTRA Mic Không Dây Đa Thiết Bị',
        slug: 'gaeru-g1-ultra',
        category: 'audio',
        descriptor: 'Thêm kết nối. Mở rộng cách sáng tạo.',
        cardTitle: 'GAERU G1 ULTRA',
        cardSummary: 'Bộ micro không dây kết nối đa thiết bị, hỗ trợ nhạc nền qua Bluetooth.',
        description: 'Bộ micro không dây kết nối đa thiết bị, hỗ trợ nhạc nền qua Bluetooth. Chọn kết nối phù hợp để ghi lại giọng nói theo cách của bạn. Hai micro cài áo, đầu thu và hộp sạc gọn gàng giúp bạn chuẩn bị cho cuộc trò chuyện trước máy quay.',
        imageUrl: '/assets/products/g1-ultra-874bf1d3db77.webp',
        imageAlt: 'Bộ micro GAERU G1 ULTRA và hộp sạc',
        active: true,
        sortOrder: 40,
        shopeeUrl: 'https://shopee.vn/gaeru-g1-ultra-chinh-hang',
        tiktokShopUrl: 'https://vn.tiktok.com/@gaerustore/live'
      },
      gallery: ['/assets/products/g1-ultra-874bf1d3db77.webp'],
      groups: [{ name: 'Gói sản phẩm', values: ['Bộ 2 Mic Tiêu Chuẩn', 'Bộ Pro Kèm Hộp Sạc Đa Năng'] }],
      variants: [
        {
          sku: 'G1-ULTRA-SET',
          name: 'Bộ 2 Mic Tiêu Chuẩn',
          options: { 'Gói sản phẩm': 'Bộ 2 Mic Tiêu Chuẩn' },
          priceVnd: 1290000,
          stockQuantity: 25,
          active: true,
          imageUrl: '/assets/products/g1-ultra-874bf1d3db77.webp'
        },
        {
          sku: 'G1-ULTRA-PRO',
          name: 'Bộ Pro Kèm Hộp Sạc Đa Năng',
          options: { 'Gói sản phẩm': 'Bộ Pro Kèm Hộp Sạc Đa Năng' },
          priceVnd: 1690000,
          stockQuantity: 18,
          active: true,
          imageUrl: '/assets/products/g1-ultra-874bf1d3db77.webp'
        }
      ]
    }
  ];

  for (const t of targetProducts) {
    const existing = existingProducts.find(p => p.slug === t.slug || p.slug === t.slug.replace(/^gaeru-/, ''));
    if (!isApply) {
      console.log(`[Dry-Run] Kế hoạch đồng bộ [${t.slug}]: ${existing ? `Cập nhật (ID: ${existing.id})` : 'Tạo mới'}`);
      continue;
    }
    if (existing) {
      console.log(`\nCập nhật và kích hoạt sản phẩm có sẵn: [${t.slug}] (ID: ${existing.id})...`);
      const { data: currentData } = await adminReq(`/api/gaeru_ceo/product-workspace/${existing.id}`);
      if (!currentData) {
        console.error(`  -> Không lấy được chi tiết hiện tại của [${t.slug}]`);
        continue;
      }
      // Khớp biến thể để bảo tồn id, version, giá và tồn kho thực tế nếu có
      const existingVariants = currentData.variants || [];
      const mergedVariants = t.variants.map(tv => {
        const match = existingVariants.find(ev => ev.sku === tv.sku);
        if (match) {
          return {
            ...tv,
            id: match.id,
            version: match.version,
            priceVnd: match.priceVnd ?? tv.priceVnd,
            stockQuantity: match.stockQuantity ?? tv.stockQuantity,
            active: true
          };
        }
        return tv;
      });
      // Nếu có biến thể cũ không nằm trong target, giữ nguyên chúng
      for (const ev of existingVariants) {
        if (!mergedVariants.some(mv => mv.id === ev.id)) {
          mergedVariants.push(ev);
        }
      }
      const payload = {
        id: existing.id,
        version: currentData.version,
        product: { ...currentData.product, ...t.product, active: true },
        gallery: t.gallery && t.gallery.length ? t.gallery : (currentData.gallery || []),
        groups: t.groups || currentData.groups || [],
        variants: mergedVariants,
        descriptionMedia: currentData.descriptionMedia || []
      };
      const res = await adminReq('/api/gaeru_ceo/product-workspace', 'POST', payload);
      if (res.status === 200 || res.status === 201) {
        console.log(`  -> Thành công: Đã cập nhật và mở bán [${t.slug}]!`);
      } else {
        console.error(`  -> Lỗi khi cập nhật [${t.slug}]:`, res.status, res.data);
      }
    } else {
      console.log(`\nTạo mới và kích hoạt sản phẩm: [${t.slug}]...`);
      const payload = {
        product: { ...t.product, active: true },
        gallery: t.gallery,
        groups: t.groups,
        variants: t.variants,
        descriptionMedia: []
      };
      const res = await adminReq('/api/gaeru_ceo/product-workspace', 'POST', payload);
      if (res.status === 200 || res.status === 201) {
        console.log(`  -> Thành công: Đã tạo mới và mở bán [${t.slug}]!`);
      } else {
        console.error(`  -> Lỗi khi tạo mới [${t.slug}]:`, res.status, res.data);
      }
    }
  }

  // 4. Kiểm tra lại kết quả API Public Storefront
  console.log('\n4. Kiểm tra API Public Storefront (/api/products)...');
  const rPublic = await fetch(`${BASE_URL}/api/products`);
  const pubData = await rPublic.json();
  const publicList = pubData.products || [];
  console.log(`  -> Tổng số sản phẩm đang mở bán trên Trang Chủ: ${publicList.length}`);
  publicList.forEach((p, idx) => {
    const minPrice = p.variants?.length ? Math.min(...p.variants.map(v => v.priceVnd)) : 0;
    const maxPrice = p.variants?.length ? Math.max(...p.variants.map(v => v.priceVnd)) : 0;
    console.log(`     ${idx + 1}. [${p.slug}] - ${p.name} | Danh mục: ${p.category} | Biến thể: ${p.variants?.length} | Giá: ${new Intl.NumberFormat('vi-VN').format(minPrice)}đ - ${new Intl.NumberFormat('vi-VN').format(maxPrice)}đ`);
  });

  console.log('\n--- HOÀN TẤT KÍCH HOẠT SẢN PHẨM ---');
}

activateProducts().catch(e => {
  console.error('Lỗi khi kích hoạt sản phẩm:', e);
  process.exit(1);
});
