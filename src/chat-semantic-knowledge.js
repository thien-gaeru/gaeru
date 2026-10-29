'use strict';

const express = require('express');

const INITIAL_KNOWLEDGE = [
  {
    category: 'specs',
    product_slug: 'k9',
    title: 'Thông số và hướng dẫn kết nối Micro GAERU K9',
    content: 'Micro cài áo GAERU K9 là dòng mic thu âm không dây 2.4GHz độ trễ siêu thấp (< 15ms). Có 2 phân loại jack cắm: Type-C (dành cho Android và iPhone 15/16) và Lightning (dành cho iPhone 14 trở về trước). Khoảng cách truyền tín hiệu tối đa 20 mét không vật cản. Pin dùng liên tục 6-8 tiếng. Hỗ trợ lọc tiếng ồn thông minh một chạm (nút bấm bên thân mic).',
    keywords: ['k9', 'micro', 'thu am', 'cai ao', 'type-c', 'lightning', 'iphone', 'android', 'loc on']
  },
  {
    category: 'specs',
    product_slug: 'p01',
    title: 'Hướng dẫn sử dụng Gimbal AI bám mặt GAERU P01',
    content: 'Gimbal GAERU P01 tích hợp ống kính nhận diện khuôn mặt và cơ thể thông minh AI. Không cần cài đặt ứng dụng (No App Required), cắm là chạy. Xoay 360 độ tự động theo cử động người dùng. Có thể điều khiển bằng cử chỉ tay: giơ bàn tay hình chữ V hoặc xòe tay để bật/tắt bám theo. Tương thích với tất cả điện thoại kích thước từ 4.5 đến 7.0 inch.',
    keywords: ['p01', 'gimbal', 'chong rung', 'theo nguoi', 'ai', 'livestream', 'tiktok', '360 do']
  },
  {
    category: 'specs',
    product_slug: 'g1-ultra',
    title: 'Micro không dây chuyên nghiệp GAERU G1 ULTRA',
    content: 'GAERU G1 ULTRA là bộ mic kép (2 bộ phát TX + 1 bộ thu RX) chuyên nghiệp cho quay phỏng vấn, vlog, podcast. Tích hợp hộp sạc thông minh với thời lượng tổng cộng lên tới 30 tiếng. Màn hình OLED hiển thị mức âm lượng, tình trạng pin, chống hú và lọc ồn DSP 3 cấp độ. Cắm được cả điện thoại, máy ảnh DSLR và máy tính qua cổng Type-C / 3.5mm TRS.',
    keywords: ['g1', 'g1 ultra', 'mic kep', 'hop sac', 'chuyen nghiep', 'may anh', 'oled', 'dsp', 'phong van']
  },
  {
    category: 'policy',
    product_slug: null,
    title: 'Chính sách bảo hành điện tử và đổi trả 1-1 GAERU',
    content: 'Tất cả sản phẩm GAERU chính hãng được bảo hành điện tử 12 tháng tại Việt Nam. Khách hàng được đổi mới 1-1 trong 30 ngày đầu tiên nếu phát sinh lỗi từ nhà sản xuất. Khách có thể kích hoạt hoặc tra cứu bảo hành trực tuyến tại trang dang-ky-bao-hanh bằng số điện thoại hoặc mã đơn hàng.',
    keywords: ['bao hanh', 'doi tra', 'chinh sach', '12 thang', '1 doi 1', 'kich hoat']
  },
  {
    category: 'compatibility',
    product_slug: null,
    title: 'Tương thích kết nối Micro GAERU với iPhone, iPad, MacBook (Type-C & Lightning)',
    content: 'iPhone 15, 15 Plus, 15 Pro, 15 Pro Max và toàn bộ iPhone 16 series dùng cổng Type-C: Cắm đầu thu Type-C trực tiếp vào đáy máy nhận mic ngay không cần đầu chuyển. Dòng iPhone 14 trở xuống (14, 13, 12, 11, X) sử dụng cổng Lightning, chọn phân loại chân Lightning hoặc dùng cáp chuyển OTG chuẩn Apple. iPad Type-C và máy tính MacBook cắm đầu thu Type-C tự nhận làm microphone mặc định.',
    keywords: ['iphone', 'apple', 'ios', 'lightning', 'type-c', 'ipad', 'macbook', 'dau chuyen']
  },
  {
    category: 'compatibility',
    product_slug: null,
    title: 'Hướng dẫn kích hoạt kết nối OTG trên điện thoại Android (Oppo, Realme, Vivo, Xiaomi, Samsung)',
    content: 'Samsung Galaxy và Google Pixel cắm đầu thu Type-C tự động nhận diện mic ngay. Với Oppo, Realme, Vivo, OnePlus: cổng Type-C có thể bị khóa OTG tiết kiệm pin, người dùng cần vào Cài đặt (Settings) -> tìm "OTG" -> Bật "Kết nối OTG" trước khi cắm đầu thu. Xiaomi, Redmi, POCO đa phần tự nhận; nếu camera mặc định chưa nhận tiếng, vào Cài đặt Camera -> Bật nguồn âm thanh micro ngoài.',
    keywords: ['android', 'samsung', 'oppo', 'xiaomi', 'redmi', 'vivo', 'realme', 'otg', 'chua nhan', 'khong sang den']
  },
  {
    category: 'compatibility',
    product_slug: null,
    title: 'Tương thích ứng dụng quay video, phát trực tiếp và họp trực tuyến (TikTok, CapCut, Open Camera, Zoom)',
    content: 'Micro GAERU tương thích 100% với các ứng dụng phổ biến: TikTok, CapCut, Facebook Live, YouTube, Shopee Live, Instagram Reels, Zoom, Google Meet. Nếu camera mặc định của một số máy Android cũ không thu tiếng từ mic rời, người dùng có thể quay trực tiếp trong app TikTok/CapCut hoặc tải ứng dụng miễn phí "Open Camera" (Vào Cài đặt video -> Cài đặt âm thanh -> Nguồn âm thanh -> Chọn "Microphone ngoài nếu có").',
    keywords: ['camera', 'quay video', 'tiktok', 'capcut', 'livestream', 'facebook', 'youtube', 'zoom', 'open camera', 'app']
  },
  {
    category: 'tech',
    product_slug: null,
    title: 'Công nghệ lọc tiếng ồn thông minh Smart DSP và sóng không dây 2.4GHz',
    content: 'Công nghệ lọc tiếng ồn thông minh Smart DSP tự động tách giọng nói khỏi tạp âm xung quanh (tiếng gió, còi xe, tiếng quạt, tiếng ồn quán cafe). Sóng không dây 2.4GHz kỹ thuật số cho kết nối ổn định, độ trễ siêu thấp dưới 20ms, âm thanh không bị lệch hình khi quay video hay phát trực tiếp. Phạm vi hoạt động hiệu quả lên đến 15-25m trong môi trường mở.',
    keywords: ['loc am', 'loc tieng on', 'on', 'gio', 'tap am', 'dsp', 'khoang cach', 'pin', 'song', '2.4ghz']
  },
  {
    category: 'compatibility',
    product_slug: null,
    title: 'Sử dụng Micro không dây GAERU trên Máy tính, Laptop Windows và Mac (OBS, CapCut PC)',
    content: 'Sử dụng trên Máy tính / Laptop (Windows 10/11 & Mac): Cắm đầu thu Type-C (hoặc dùng đầu chuyển USB-A sang Type-C nếu máy không có cổng C). Vào Settings -> Sound -> Chọn Input / Microphone là Wireless Microphone. Hoạt động mượt mà trên OBS Studio, Audacity, Premiere Pro, Camtasia, CapCut PC.',
    keywords: ['may tinh', 'laptop', 'pc', 'windows', 'mac', 'obs', 'capcut pc', 'thu am']
  }
];

async function seedInitialKnowledge(pool) {
  for (const doc of INITIAL_KNOWLEDGE) {
    const existing = await pool.query(
      `SELECT id FROM chat_knowledge_documents WHERE title = $1`,
      [doc.title]
    );
    if (!existing.rows.length) {
      await pool.query(
        `INSERT INTO chat_knowledge_documents (category, product_slug, title, content, keywords, active)
         VALUES ($1, $2, $3, $4, $5, true)`,
        [doc.category, doc.product_slug, doc.title, doc.content, doc.keywords]
      );
    }
  }
}

async function searchKnowledge(pool, queryText, { limit = 3, productSlug = null } = {}) {
  const q = String(queryText || '').toLowerCase().trim();
  if (!q) return [];

  const tokens = q.split(/\s+/).filter(t => t.length > 1);
  if (!tokens.length) return [];

  const params = [];
  let filter = '';
  if (productSlug) {
    params.push(productSlug);
    filter = ' AND (product_slug = $1 OR product_slug IS NULL)';
  }

  const result = await pool.query(
    `SELECT id, category, product_slug AS "productSlug", title, content, keywords
     FROM chat_knowledge_documents
     WHERE active = true ${filter}
     ORDER BY created_at DESC
     LIMIT 50`,
    params
  );

  // Hybrid rank by keyword match and term presence
  const scored = result.rows.map(doc => {
    let score = 0;
    const lowerContent = (doc.title + ' ' + doc.content).toLowerCase();
    const docKeywords = (doc.keywords || []).map(k => String(k).toLowerCase());

    for (const token of tokens) {
      if (docKeywords.includes(token)) score += 3;
      if (lowerContent.includes(token)) score += 1;
    }
    return { ...doc, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.filter(s => s.score > 0).slice(0, limit);
}

function createKnowledgeAdminRouter(pool) {
  const router = express.Router();

  router.get('/knowledge', async (req, res, next) => {
    try {
      const result = await pool.query(`
        SELECT id, category, product_slug AS "productSlug", title, content, keywords, active, updated_at AS "updatedAt"
        FROM chat_knowledge_documents
        ORDER BY updated_at DESC
      `);
      res.json({ documents: result.rows });
    } catch (err) {
      next(err);
    }
  });

  router.post('/knowledge', express.json(), async (req, res, next) => {
    try {
      const { category = 'general', productSlug = null, title, content, keywords = [] } = req.body || {};
      if (!title || !content) return res.status(400).json({ error: 'Tiêu đề và nội dung là bắt buộc.' });

      const result = await pool.query(
        `INSERT INTO chat_knowledge_documents (category, product_slug, title, content, keywords, active)
         VALUES ($1, $2, $3, $4, $5, true)
         RETURNING *`,
        [category, productSlug || null, title, content, Array.isArray(keywords) ? keywords : []]
      );
      res.status(201).json({ ok: true, document: result.rows[0] });
    } catch (err) {
      next(err);
    }
  });

  router.delete('/knowledge/:id', async (req, res, next) => {
    try {
      await pool.query(`DELETE FROM chat_knowledge_documents WHERE id = $1`, [req.params.id]);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = {
  INITIAL_KNOWLEDGE,
  seedInitialKnowledge,
  searchKnowledge,
  createKnowledgeAdminRouter
};
