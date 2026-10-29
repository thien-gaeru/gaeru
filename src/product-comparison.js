'use strict';
const { Router } = require('express');

const PRODUCT_TECH_SPECS = {
  k9: {
    category: 'Micro Thu Âm',
    type: 'Không dây cài áo (Wireless Lavalier)',
    weight: '16g (Mỗi micro)',
    batteryLife: '6 - 8 giờ liên tục',
    connectionRange: '20m (Môi trường thoáng)',
    noiseReduction: 'AI DSP Smart Denoise 3 cấp độ',
    latency: '< 15ms (Thời gian thực)',
    compatibility: 'iOS (Lightning/Type-C), Android, PC',
    appRequired: false,
    warranty: '12 tháng 1 đổi 1 chính hãng',
    boxContents: '1x Đầu thu, 1x/2x Micro phát, Cáp sạc, HDSD tiếng Việt'
  },
  'g1-ultra': {
    category: 'Gimbal Chống Rung',
    type: 'Gimbal 3 trục (3-Axis Handheld Stabilizer)',
    weight: '395g',
    batteryLife: '10 - 12 giờ',
    connectionRange: 'Bluetooth 5.2 (10m)',
    noiseReduction: 'N/A',
    latency: 'N/A',
    maxPayload: '290g (Cân mọi dòng iPhone Pro Max)',
    compatibility: 'iOS, Android 8.0 trở lên',
    appRequired: true,
    warranty: '12 tháng 1 đổi 1 chính hãng',
    boxContents: '1x Gimbal G1 Ultra, 1x Chân tripod mini, Cáp sạc Type-C, Túi nhung đựng máy'
  },
  m3: {
    category: 'Chân Đế Tripod',
    type: 'Tripod để bàn mini & ngàm xoay 360',
    weight: '145g',
    batteryLife: 'Không dùng pin',
    connectionRange: 'N/A',
    noiseReduction: 'N/A',
    latency: 'N/A',
    maxPayload: '1.5kg',
    compatibility: 'Điện thoại, Máy ảnh mini, Đèn livestream',
    appRequired: false,
    warranty: '12 tháng 1 đổi 1',
    boxContents: '1x Chân Tripod M3 kim loại, 1x Ngàm kẹp cao su chống xước'
  },
  p01: {
    category: 'Gimbal & Gậy Tự Sướng',
    type: 'Gimbal 1 trục xoay 360 độ tự động Face Tracking',
    weight: '220g',
    batteryLife: '4 - 6 giờ',
    connectionRange: 'Camera AI tích hợp nhận diện cử chỉ',
    noiseReduction: 'N/A',
    latency: '< 20ms',
    maxPayload: '300g',
    compatibility: 'Mọi dòng điện thoại thông minh',
    appRequired: false,
    warranty: '12 tháng 1 đổi 1',
    boxContents: '1x Thân máy P01 AI, 1x Đế tròn, Cáp sạc, Hướng dẫn cử chỉ'
  }
};

const DEFAULT_SPECS = {
  category: 'Phụ kiện Creator',
  type: 'Thiết bị sáng tạo nội dung GAERU',
  weight: 'Tiêu chuẩn',
  batteryLife: 'Theo model',
  connectionRange: 'Chuẩn công nghiệp',
  noiseReduction: 'Tùy dòng sản phẩm',
  compatibility: 'Đa nền tảng',
  warranty: '12 tháng 1 đổi 1 chính hãng'
};

async function getComparisonData(pool, slugs = []) {
  const cleanSlugs = (Array.isArray(slugs) ? slugs : String(slugs).split(','))
    .map(s => s.trim().toLowerCase())
    .filter(Boolean)
    .slice(0, 4);

  if (!cleanSlugs.length) {
    return { error: 'Vui lòng cung cấp ít nhất 1 mã sản phẩm để so sánh.' };
  }

  const { rows } = await pool.query(
    `SELECT p.id, p.slug, p.name, p.image_url AS "imageUrl",
            COALESCE(
              (SELECT min(v.price_vnd) FROM product_variants v WHERE v.product_id = p.id AND v.active = true),
              0
            ) AS "priceVnd"
     FROM products p
     WHERE p.slug = ANY($1::text[]) AND p.active = true`,
    [cleanSlugs]
  );

  const products = cleanSlugs.map(slug => {
    const dbRow = rows.find(r => r.slug === slug);
    const specs = PRODUCT_TECH_SPECS[slug] || DEFAULT_SPECS;
    return {
      slug,
      name: dbRow?.name || slug.toUpperCase(),
      imageUrl: dbRow?.imageUrl || `/assets/${slug}.webp`,
      priceVnd: Number(dbRow?.priceVnd) || 0,
      specs
    };
  });

  // Calculate Best Value (lowest price with high utility) and Pro Pick (most features/highest price)
  let bestValueSlug = null;
  let proPickSlug = null;
  if (products.length > 1) {
    const sortedByPrice = [...products].sort((a, b) => a.priceVnd - b.priceVnd);
    bestValueSlug = sortedByPrice[0]?.slug;
    proPickSlug = sortedByPrice[sortedByPrice.length - 1]?.slug;
  }

  // Define specs keys to compare
  const specFields = [
    { key: 'category', label: 'Phân loại thiết bị' },
    { key: 'type', label: 'Công nghệ & Thiết kế' },
    { key: 'weight', label: 'Trọng lượng' },
    { key: 'batteryLife', label: 'Thời lượng pin' },
    { key: 'connectionRange', label: 'Khoảng cách kết nối' },
    { key: 'noiseReduction', label: 'Khả năng lọc ồn' },
    { key: 'maxPayload', label: 'Tải trọng tối đa' },
    { key: 'compatibility', label: 'Khả năng tương thích' },
    { key: 'appRequired', label: 'Yêu cầu cài đặt ứng dụng', format: v => (v === false ? 'Không (Cắm là chạy ngay)' : v === true ? 'Có ứng dụng riêng' : 'N/A') },
    { key: 'warranty', label: 'Chính sách bảo hành' },
    { key: 'boxContents', label: 'Phụ kiện trong hộp' }
  ];

  return {
    products,
    specFields,
    recommendations: {
      bestValue: bestValueSlug,
      proPick: proPickSlug
    }
  };
}

function createComparisonRouter(pool) {
  const router = Router();

  router.get('/products/compare', async (req, res, next) => {
    try {
      const slugs = req.query.slugs;
      if (!slugs) {
        return res.status(400).json({ error: 'Cần ít nhất một slug sản phẩm (ví dụ ?slugs=k9,g1-ultra)' });
      }
      const data = await getComparisonData(pool, slugs);
      res.json(data);
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = {
  PRODUCT_TECH_SPECS,
  getComparisonData,
  createComparisonRouter
};
