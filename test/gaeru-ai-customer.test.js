'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { answerCustomerChat, generateGaeruAiResponse, lookupOrderInfo } = require('../src/gaeru-ai-customer');

test('GAERU AI Customer Assistant Test Suite', async (t) => {
  await t.test('1. GAERU AI tư vấn sản phẩm GAERU P01 chi tiết và chính xác', async () => {
    const res = await generateGaeruAiResponse({
      question: 'Tư vấn giúp mình micro GAERU P01 với',
      catalog: [{ name: 'GAERU P01', slug: 'gaeru-p01', variants: [{ priceVnd: 1250000 }] }]
    });

    assert.equal(res.handoff, false);
    assert.ok(res.answer.includes('GAERU P01'));
    assert.ok(res.answer.includes('Khử ồn chủ động'));
    assert.ok(res.answer.includes('1.250.000 ₫'));
  });

  await t.test('2. GAERU AI hướng dẫn tương thích iPhone 15/16 Type-C vs iPhone cũ Lightning', async () => {
    const res = await generateGaeruAiResponse({
      question: 'Micro này có dùng được cho iPhone 15 Pro Max không?'
    });

    assert.equal(res.handoff, false);
    assert.ok(res.answer.includes('iPhone 15'));
    assert.ok(res.answer.includes('Type-C'));
    assert.ok(res.answer.includes('Lightning'));
  });

  await t.test('3. GAERU AI hướng dẫn bật OTG cho điện thoại Android (OPPO/Realme/Vivo)', async () => {
    const res = await generateGaeruAiResponse({
      question: 'Điện thoại OPPO cắm mic vào không thấy sáng đèn'
    });

    assert.equal(res.handoff, false);
    assert.ok(res.answer.includes('OTG'));
    assert.ok(res.answer.includes('Cài đặt'));
    assert.ok(res.answer.includes('OPPO'));
  });

  await t.test('4. GAERU AI giải đáp chính sách GAERU Xu tuân thủ Nghị định 81 & 52', async () => {
    const res = await generateGaeruAiResponse({
      question: 'GAERU Xu là gì và được giảm tối đa bao nhiêu?'
    });

    assert.equal(res.handoff, false);
    assert.ok(res.answer.includes('GAERU Xu'));
    assert.ok(res.answer.includes('50%'));
    assert.ok(res.answer.includes('81/2018/NĐ-CP'));
    assert.ok(res.answer.includes('1 GAERU Xu = 1 VNĐ'));
  });

  await t.test('5. GAERU AI giải đáp chính sách Bảo hành 12 tháng 1 đổi 1 và Freeship', async () => {
    const resWarranty = await generateGaeruAiResponse({ question: 'Chính sách bảo hành như thế nào?' });
    assert.equal(resWarranty.handoff, false);
    assert.ok(resWarranty.answer.includes('12 tháng'));
    assert.ok(resWarranty.answer.includes('1 đổi 1'));

    const resShip = await generateGaeruAiResponse({ question: 'Phí ship và thời gian giao hàng thế nào?' });
    assert.equal(resShip.handoff, false);
    assert.ok(resShip.answer.includes('Freeship'));
    assert.ok(resShip.answer.includes('500.000 ₫'));
    assert.ok(resShip.answer.includes('đồng kiểm'));
  });

  await t.test('6. GAERU AI tự động chuyển giao (handoff: true) khi khách yêu cầu gặp người thật', async () => {
    const res = await generateGaeruAiResponse({ question: 'Tôi muốn gặp nhân viên tư vấn' });
    assert.equal(res.handoff, true);
    assert.ok(res.answer.includes('082 919 1080'));
    assert.ok(res.answer.includes('chuyên viên'));
  });

  await t.test('7. GAERU AI tra cứu đơn hàng trực tiếp từ database khi khách cung cấp mã đơn', async () => {
    const mockPool = {
      async query(sql, params) {
        if (sql.includes('FROM orders')) {
          return {
            rows: [{
              order_number: 'GAE-20261109-001',
              customer_name: 'Nguyễn Văn A',
              phone: '0988123456',
              address: '123 Đường Cầu Giấy',
              city: 'Hà Nội',
              status: 'shipped',
              payment_method: 'cod',
              payment_status: 'pending',
              total_vnd: 1250000,
              created_at: new Date()
            }]
          };
        }
        if (sql.includes('FROM shipping_fulfillments')) {
          return {
            rows: [{
              carrier_name: 'Viettel Post',
              tracking_number: 'VTP99887766',
              status: 'Đang vận chuyển'
            }]
          };
        }
        return { rows: [] };
      }
    };

    const res = await generateGaeruAiResponse({
      pool: mockPool,
      question: 'Kiểm tra giúp mình đơn hàng GAE-20261109-001 với'
    });

    assert.equal(res.handoff, false);
    assert.ok(res.answer.includes('GAE-20261109-001'));
    assert.ok(res.answer.includes('Nguyễn Văn A'));
    assert.ok(res.answer.includes('Đang vận chuyển giao cho khách'));
    assert.ok(res.answer.includes('VTP99887766'));
  });

  await t.test('8. answerCustomerChat hoạt động độc lập không cần API key ngoài', async () => {
    const res = await answerCustomerChat({
      pool: { async query() { return { rows: [] }; } },
      config: {},
      question: 'Xin chào, tư vấn giúp mình thiết bị livestream',
      settings: { enabled: false, apiKey: '' }
    });

    assert.equal(res.handoff, false);
    assert.ok(res.answer.length > 50);
    assert.ok(res.answer.includes('GAERU AI'));
  });
});
