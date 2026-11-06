const PORT = 3000;

async function activateProducts() {
  console.log('--- KÍCH HOẠT SẢN PHẨM MỞ BÁN TRÊN TRANG CHỦ GAERU ---');

  // 1. Đăng nhập quản trị viên
  console.log('1. Đăng nhập quyền Chủ doanh nghiệp (Owner)...');
  const rCsrf = await fetch(`http://127.0.0.1:${PORT}/api/csrf`);
  const { csrfToken } = await rCsrf.json();
  const initialCookie = rCsrf.headers.get('set-cookie');

  const rLogin = await fetch(`http://127.0.0.1:${PORT}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken, 'Cookie': initialCookie },
    body: JSON.stringify({ username: 'gaeru', password: 'GaeruSecret2026!' })
  });
  if (rLogin.status !== 200) {
    throw new Error('Đăng nhập thất bại: ' + rLogin.status);
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
    const res = await fetch(`http://127.0.0.1:${PORT}` + url, opts);
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
    const existing = existingProducts.find(p => p.slug === t.slug);
    if (existing) {
      console.log(`\nCập nhật và kích hoạt sản phẩm có sẵn: [${t.slug}] (ID: ${existing.id})...`);
      const { data: currentData } = await adminReq(`/api/gaeru_ceo/product-workspace/${existing.id}`);
      const payload = {
        id: existing.id,
        version: currentData.version,
        product: t.product,
        gallery: t.gallery,
        groups: t.groups,
        variants: t.variants,
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
        product: t.product,
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
  const rPublic = await fetch(`http://127.0.0.1:${PORT}/api/products`);
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
