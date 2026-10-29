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
  seedInitialKnowledge,
  searchKnowledge,
  createKnowledgeAdminRouter
};
