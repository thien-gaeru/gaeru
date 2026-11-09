'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  sanitizePii,
  extractTriggers,
  synthesizeTopic,
  learnFromInteraction,
  learnFromStaffResponse,
  matchLearnedKnowledge,
  getLearnedKnowledgeStats,
  scanAndHarvestPastChats,
  invalidateCache
} = require('../src/ai-self-learning');
const { generateGaeruAiResponse } = require('../src/gaeru-ai-customer');

test('PII Sanitizer completely removes phone numbers, emails, orders and account numbers', () => {
  const dirty = 'Khách Nguyễn Văn A số 0912345678, email khach@gmail.com, mã đơn gae-987123-abc, stk 19033456789012 hỏi mic K9';
  const clean = sanitizePii(dirty);

  assert.ok(!clean.includes('0912345678'), 'Phải ẩn số điện thoại');
  assert.ok(clean.includes('[SĐT_ĐÃ_ẨN]'), 'Phải gắn nhãn ẩn số điện thoại');
  assert.ok(!clean.includes('khach@gmail.com'), 'Phải ẩn email');
  assert.ok(clean.includes('[EMAIL_ĐÃ_ẨN]'), 'Phải gắn nhãn ẩn email');
  assert.ok(!clean.includes('gae-987123-abc'), 'Phải ẩn mã đơn hàng');
  assert.ok(clean.includes('[MÃ_ĐƠN_HÀNG]'), 'Phải gắn nhãn ẩn mã đơn');
  assert.ok(!clean.includes('19033456789012'), 'Phải ẩn số tài khoản');
  assert.ok(clean.includes('[SỐ_TÀI_KHOẢN_ĐÃ_ẨN]'), 'Phải gắn nhãn ẩn số tài khoản');
});

test('Trigger extractor identifies device, connector, app and technical keywords', () => {
  const text = 'Mic GAERU P01 cắm vào iPhone 15 cổng Type-C quay video trên app TikTok có cần bật OTG không?';
  const triggers = extractTriggers(text);

  assert.ok(triggers.includes('p01') || triggers.includes('gaeru p01'));
  assert.ok(triggers.includes('iphone 15') || triggers.includes('iphone'));
  assert.ok(triggers.includes('type-c') || triggers.includes('type c'));
  assert.ok(triggers.includes('tiktok'));
  assert.ok(triggers.includes('otg') || triggers.includes('quay video'));
});

test('Self-learning engine stores new knowledge and reinforces recurring questions', async () => {
  invalidateCache();
  const mockRows = [];
  const mockPool = {
    query: async (sql, params = []) => {
      if (sql.includes('WHERE triggers &&')) {
        // Tìm kiếm trigger trùng khớp
        const trigs = params[0] || [];
        const found = mockRows.filter(r => (r.triggers || []).some(t => trigs.includes(t)));
        return { rows: found };
      }
      if (sql.includes('INSERT INTO ai_learned_knowledge')) {
        const row = {
          id: params[0],
          source_type: params[1],
          topic: params[2],
          triggers: params[3],
          learned_facts: params[4],
          sample_question: params[5],
          sample_answer: params[6],
          confidence_score: params[7],
          occurrence_count: 1,
          status: params[8]
        };
        mockRows.push(row);
        return { rows: [row] };
      }
      if (sql.includes('UPDATE ai_learned_knowledge')) {
        const target = mockRows.find(r => r.id === params[5]);
        if (target) {
          target.occurrence_count = params[0];
          target.confidence_score = params[1];
          target.triggers = params[2];
          target.sample_question = params[3];
          target.sample_answer = params[4];
        }
        return { rows: [target] };
      }
      if (sql.includes('WHERE status = \'active\'')) {
        return { rows: mockRows.filter(r => r.status === 'active') };
      }
      if (sql.includes('COUNT(*)::int AS total')) {
        return {
          rows: [{
            total: mockRows.length,
            active_count: mockRows.filter(r => r.status === 'active').length,
            pending_count: mockRows.filter(r => r.status === 'pending_review').length,
            total_interactions: mockRows.reduce((sum, r) => sum + (r.occurrence_count || 1), 0),
            avg_confidence: 0.9
          }]
        };
      }
      return { rows: [] };
    }
  };

  // 1. Học lần đầu từ tương tác mới
  const res1 = await learnFromInteraction(mockPool, {
    sourceType: 'customer_chat',
    question: 'Micro GAERU P01 có cắm được cho máy ảnh Sony ZV-E10 không shop?',
    answer: 'Dạ GAERU P01 cắm tốt cho máy ảnh Sony ZV-E10, bạn dùng dây chuyển 3.5mm TRS sang TRRS đi kèm trong hộp nhé.',
    confidence: 0.88
  });

  assert.ok(res1);
  assert.equal(res1.action, 'created');
  assert.equal(mockRows.length, 1);
  assert.equal(mockRows[0].status, 'active');

  // 2. Tự động truy hồi tri thức vừa học
  const matched = await matchLearnedKnowledge(mockPool, 'Em muốn dùng mic P01 cho máy ảnh Sony ZV-E10');
  assert.ok(matched, 'Phải tìm thấy tri thức vừa học');
  assert.ok(matched.entry.learned_facts.includes('Sony ZV-E10'));

  // 3. Học lần thứ hai từ câu hỏi tương tự -> Tự động củng cố (Reinforce)
  const res2 = await learnFromInteraction(mockPool, {
    sourceType: 'staff_guidance',
    question: 'Cắm mic GAERU P01 vào máy ảnh Sony như thế nào?',
    answer: 'Bạn dùng jack 3.5mm cắm vào cổng mic màu đỏ trên thân máy ảnh Sony ZV-E10 nhé.',
    confidence: 0.95
  });

  assert.ok(res2);
  assert.equal(res2.action, 'reinforced');
  assert.equal(mockRows[0].occurrence_count, 2, 'Số lần xuất hiện phải tăng lên 2');
  assert.ok(mockRows[0].confidence_score > 0.88, 'Độ tin cậy phải được nâng cao');

  // 4. Kiểm tra thống kê
  const stats = await getLearnedKnowledgeStats(mockPool);
  assert.equal(stats.counts.total, 1);
  assert.equal(stats.counts.active_count, 1);
  assert.equal(stats.counts.total_interactions, 2);
});

test('Customer assistant uses learned knowledge to answer novel technical inquiries', async () => {
  invalidateCache();
  const mockKnowledge = [{
    id: 'k-101',
    topic: 'Tương thích GAERU M3 với OBS Studio',
    triggers: ['m3', 'obs', 'obs studio', 'may tinh', 'laptop'],
    learned_facts: 'Micro GAERU M3 kết nối Plug & Play với OBS Studio qua cổng Type-C. Trong Audio Settings của OBS, chọn Mic/Auxiliary Audio là "GAERU M3 Audio".',
    sample_answer: 'Dạ bạn cắm Type-C và chọn GAERU M3 Audio trong OBS nhé.',
    confidence_score: 0.95,
    occurrence_count: 5,
    status: 'active'
  }];

  const mockPool = {
    query: async (sql) => {
      if (sql.includes('WHERE status = \'active\'')) {
        return { rows: mockKnowledge };
      }
      return { rows: [] };
    }
  };

  const reply = await generateGaeruAiResponse({
    pool: mockPool,
    thread: { id: 'thread-test' },
    question: 'Hướng dẫn cài micro GAERU M3 vào phần mềm OBS trên laptop để livestream'
  });

  assert.ok(reply);
  assert.equal(reply.handoff, false);
  assert.ok(reply.answer.includes('OBS Studio'));
  assert.ok(reply.answer.includes('GAERU M3'));
  assert.ok(reply.learnedKnowledge);
  assert.equal(reply.learnedKnowledge.id, 'k-101');
});
