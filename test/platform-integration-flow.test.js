'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { addLoyaltyPoints, getLoyaltyProfile } = require('../src/loyalty-api');
const { registerPartner, attributeOrderCommission } = require('../src/affiliate-system');
const { submitRmaTicket, lookupRmaTicket, updateRmaStatus } = require('../src/rma-workflow');
const { calculateInstallments, createBnplTransaction } = require('../src/bnpl-payment');
const { logCapiEvent } = require('../src/server-capi');
const { getUpgradesSettings, saveUpgradesSettings } = require('../src/upgrades-settings');

// In-Memory Database Mock for end-to-end integration testing
function createMockPool() {
  const tables = {
    customer_loyalty: new Map(),
    loyalty_transactions: [],
    affiliate_partners: new Map(),
    affiliate_commissions: [],
    rma_tickets: new Map(),
    bnpl_transactions: new Map(),
    server_capi_logs: [],
    store_settings: new Map()
  };

  const poolInstance = {
    tables,
    async query(sql, params = []) {
      const s = sql.trim();

      // 1. customer_loyalty queries
      if (s.includes('FROM customer_loyalty')) {
        const id = params[0];
        const row = tables.customer_loyalty.get(id);
        return { rows: row ? [row] : [] };
      }
      if (s.includes('INSERT INTO customer_loyalty')) {
        const row = {
          points: 0,
          lifetimePoints: 0,
          tier: 'standard',
          updatedAt: new Date().toISOString()
        };
        tables.customer_loyalty.set(params[0], row);
        return { rows: [row] };
      }
      if (s.includes('UPDATE customer_loyalty')) {
        const id = params[3];
        const row = tables.customer_loyalty.get(id) || {};
        row.points = params[0];
        row.lifetimePoints = params[1];
        row.tier = params[2];
        row.updatedAt = new Date().toISOString();
        tables.customer_loyalty.set(id, row);
        return { rows: [row] };
      }
      if (s.includes('FROM loyalty_transactions')) {
        const id = params[0];
        const rows = tables.loyalty_transactions.filter(t => t.customer_id === id);
        return { rows };
      }
      if (s.includes('INSERT INTO loyalty_transactions')) {
        tables.loyalty_transactions.push({
          customer_id: params[0],
          order_id: params[1],
          pointsChange: params[2],
          balanceAfter: params[3],
          reason: params[4],
          createdAt: new Date().toISOString()
        });
        return { rows: [] };
      }

      // 2. affiliate_partners queries
      if (s.includes('INSERT INTO affiliate_partners')) {
        const p = {
          id: 'aff-' + Math.random().toString(36).slice(2),
          partnerCode: params[0],
          name: params[1],
          email: params[2],
          phone: params[3],
          commissionPercent: params[4],
          status: 'active',
          totalEarningsVnd: 0,
          totalOrders: 0
        };
        tables.affiliate_partners.set(params[0], p);
        return { rows: [p] };
      }
      if (s.includes('FROM affiliate_partners')) {
        const code = params[0];
        const p = tables.affiliate_partners.get(code);
        return { rows: p ? [p] : [] };
      }
      if (s.includes('INSERT INTO affiliate_commissions')) {
        const comm = {
          id: 'comm-' + Math.random().toString(36).slice(2),
          partnerCode: params[0],
          orderId: params[1],
          orderCode: params[2],
          orderTotalVnd: params[3],
          commissionVnd: params[4],
          status: 'pending'
        };
        tables.affiliate_commissions.push(comm);
        return { rows: [comm] };
      }
      if (s.includes('UPDATE affiliate_partners')) {
        const code = params[1];
        const p = tables.affiliate_partners.get(code);
        if (p) {
          p.totalEarningsVnd += params[0];
          p.totalOrders += 1;
        }
        return { rows: p ? [p] : [] };
      }

      // 3. rma_tickets queries
      if (s.includes('INSERT INTO rma_tickets')) {
        const id = 'rma-uuid-' + Math.random().toString(36).slice(2);
        const ticket = {
          id,
          ticket_code: params[0],
          ticketCode: params[0],
          customer_name: params[4],
          customer_phone: params[5],
          product_name: params[6],
          issue_type: params[8],
          fault_description: params[9],
          status: 'pending',
          created_at: new Date().toISOString()
        };
        tables.rma_tickets.set(id, ticket);
        return { rows: [ticket] };
      }
      if (s.includes('FROM rma_tickets')) {
        const q = params[0];
        const matches = [...tables.rma_tickets.values()].filter(t =>
          !q || t.customer_phone === q || t.ticket_code === q || t.id === q
        );
        return { rows: matches };
      }
      if (s.includes('UPDATE rma_tickets')) {
        const id = params[4];
        const ticket = tables.rma_tickets.get(id);
        if (ticket) {
          ticket.status = params[0];
          ticket.resolution_type = params[1];
          ticket.tracking_code_outbound = params[2];
          ticket.technician_notes = params[3];
          ticket.admin_notes = params[3];
        }
        return { rows: ticket ? [ticket] : [] };
      }

      // 3. bnpl_transactions queries
      if (s.includes('INSERT INTO bnpl_transactions')) {
        const id = 'bnpl-' + Math.random().toString(36).slice(2);
        const tx = {
          id,
          order_id: params[0],
          order_number: params[1],
          provider: params[2],
          transaction_id: params[3],
          amount_vnd: params[4],
          installments_count: params[5],
          installment_amount_vnd: params[6],
          status: 'pending'
        };
        tables.bnpl_transactions.set(id, tx);
        return { rows: [tx] };
      }

      // 4. server_capi_logs queries
      if (s.includes('INSERT INTO server_capi_logs')) {
        tables.server_capi_logs.push({
          eventId: params[0],
          eventName: params[1],
          platform: params[2],
          status: params[3],
          payload: params[4],
          createdAt: new Date().toISOString()
        });
        return { rows: [] };
      }

      // 5. store_settings queries
      if (s.includes('FROM store_settings')) {
        const val = tables.store_settings.get('platform_upgrades_settings');
        return { rows: val ? [{ setting_value: val }] : [] };
      }
      if (s.includes('INSERT INTO store_settings')) {
        tables.store_settings.set('platform_upgrades_settings', params[0]);
        return { rows: [] };
      }

      return { rows: [] };
    },
    async connect() {
      return {
        query: (...args) => poolInstance.query(...args),
        release() {}
      };
    }
  };

  return poolInstance;
}

test('Platform Upgrades End-to-End Integration Flow', async (t) => {
  const pool = createMockPool();

  // Test 1: Order -> Loyalty VIP Point Accumulation & Tier Upgrade
  await t.test('1. Customer Order triggers Loyalty Point Accumulation and Tier Promotion', async () => {
    const customerId = 'cust-12345';

    // Đơn hàng: Khách chi tiêu 250.000₫ -> Tích 2.500 điểm (Hạng Bạc)
    const result1 = await addLoyaltyPoints(pool, {
      customerId,
      orderId: 'ORD-001',
      amountVnd: 250000,
      reason: 'Tích điểm đơn hàng #ORD-001'
    });

    assert.ok(result1);
    assert.equal(result1.pointsAdded, 2500, '1% of 250.000 VND should be 2.500 points');
    assert.equal(result1.tier, 'silver', '2.500 points should promote customer to Silver tier (min 1.000)');

    const profile = await getLoyaltyProfile(pool, customerId);
    assert.equal(profile.tier, 'silver');
    assert.equal(profile.tierName, 'Bạc');
    assert.equal(profile.maxRedeemableVnd, 2500);

    // Đơn hàng lớn tiếp theo: 800.000₫ (nhận 105% điểm hạng Bạc = 8.400 điểm -> tổng 10.900 điểm -> Hạng Kim Cương)
    const result2 = await addLoyaltyPoints(pool, {
      customerId,
      orderId: 'ORD-002',
      amountVnd: 800000,
      reason: 'Tích điểm đơn hàng lớn #ORD-002'
    });

    assert.equal(result2.tier, 'diamond', 'Over 10.000 points should promote customer to Diamond tier');
  });

  // Test 2: Affiliate / Referral Attribution & Commission Distribution
  await t.test('2. Order via Affiliate Referral Link attributes commission to Partner', async () => {
    const partner = await registerPartner(pool, {
      partnerCode: 'TECHREVIEWER',
      name: 'Kênh Review Công Nghệ',
      commissionPercent: 10.0
    });
    assert.equal(partner.partnerCode, 'TECHREVIEWER');
    assert.equal(partner.commissionPercent, 10.0);

    // Đơn hàng ORD-001 trị giá 250.000₫ giới thiệu bởi TECHREVIEWER -> Nhận 10% = 25.000₫
    const comm = await attributeOrderCommission(pool, {
      orderId: 'ord-uuid-001',
      orderCode: 'ORD-001',
      totalVnd: 250000,
      partnerCode: 'TECHREVIEWER'
    });

    assert.ok(comm);
    assert.equal(comm.commissionVnd, 25000);
    assert.equal(comm.status, 'pending');

    const updatedPartner = pool.tables.affiliate_partners.get('TECHREVIEWER');
    assert.equal(updatedPartner.totalEarningsVnd, 25000);
    assert.equal(updatedPartner.totalOrders, 1);
  });

  // Test 3: Product Fault -> RMA Ticket Creation -> Admin Approval & SPX Outbound Tracking
  await t.test('3. Defective Device triggers RMA Request and Admin Resolution with SPX Outbound Tracking', async () => {
    const phone = '0912345678';

    // Khách hàng tạo phiếu RMA
    const ticket = await submitRmaTicket(pool, {
      customerName: 'Nguyễn Văn A',
      customerPhone: phone,
      orderNumber: 'ORD-001',
      productName: 'Micro Không Dây GAERU K9',
      issueType: 'power_loss',
      issueDescription: 'Micro không nhận sạc pin sau 1 tuần sử dụng',
      mediaUrls: ['https://storage.gaeru.com/proof-video.mp4'],
      returnDeliveryAddress: 'Số 45 Lê Lợi, Quận 1, TP.HCM'
    });

    assert.ok(ticket.ticketCode.startsWith('RMA-'));
    assert.equal(ticket.status, 'pending');

    // Khách tra cứu phiếu của mình theo số điện thoại
    const lookup = await lookupRmaTicket(pool, phone);
    assert.equal(lookup.length, 1);
    assert.equal(lookup[0].ticket_code, ticket.ticketCode);
    assert.equal(lookup[0].status, 'pending');

    // Admin thẩm định: Duyệt đổi mới 1-1 và cấp mã vận đơn Shopee Express gửi máy mới
    const updated = await updateRmaStatus(pool, ticket.id, {
      status: 'approved_replacement',
      resolutionType: 'replace_1_1',
      outboundTracking: 'SPXVN088223344',
      technicianNotes: 'Đã xác nhận lỗi IC nguồn. Duyệt xuất kho đổi máy mới 100% nguyên seal.'
    });

    assert.equal(updated.status, 'approved_replacement');
    assert.equal(updated.tracking_code_outbound, 'SPXVN088223344');

    // Khách tra cứu lại thấy tiến độ hoàn tất đổi mới
    const lookupAfter = await lookupRmaTicket(pool, phone);
    assert.equal(lookupAfter[0].status, 'approved_replacement');
    assert.equal(lookupAfter[0].tracking_code_outbound, 'SPXVN088223344');
  });

  // Test 4: Buy Now Pay Later (BNPL) Schedule Calculation & Transaction Lifecycle
  await t.test('4. BNPL 0% Installment Calculation and Transaction Life Cycle', async () => {
    const calc = calculateInstallments(1800000, 3);
    assert.equal(calc.eligible, true);
    assert.equal(calc.installmentsCount, 3);
    assert.equal(calc.installmentAmountVnd, 600000);
    assert.equal(calc.schedule.length, 3);

    const res = await createBnplTransaction(pool, {
      orderNumber: 'ORD-002',
      provider: 'fundiin',
      amountVnd: 1800000,
      installmentsCount: 3
    });

    assert.ok(res.transaction);
    assert.equal(res.transaction.provider, 'fundiin');
    assert.equal(res.transaction.amount_vnd, 1800000);
  });

  // Test 5: Server-Side Conversion API (CAPI) Logging
  await t.test('5. Server-Side CAPI Purchase Event Logging and Storage', async () => {
    await logCapiEvent(pool, {
      eventId: 'evt-capi-999',
      eventName: 'Purchase',
      platform: 'meta',
      status: 'sent',
      payloadSummary: { value: 1500000, currency: 'VND', orderNumber: 'ORD-001' }
    });

    assert.equal(pool.tables.server_capi_logs.length, 1);
    assert.equal(pool.tables.server_capi_logs[0].eventName, 'Purchase');
    assert.equal(pool.tables.server_capi_logs[0].status, 'sent');
  });

  // Test 6: Upgrades Centralized Settings Persistence & Multi-Carrier Support
  await t.test('6. Admin Upgrades Hub Settings Persistence & Multi-Carrier Support', async () => {
    await saveUpgradesSettings(pool, {
      rma: { returnDays: 45, supportHotline: '0829191080' },
      affiliate: { commissionPercent: 10 },
      shipping: { defaultCarrier: 'flexible', enabledCarriers: ['ghn', 'ghtk', 'viettel', 'spx', 'jt'] }
    });

    const settings = await getUpgradesSettings(pool);
    assert.equal(settings.rma.returnDays, 45);
    assert.equal(settings.rma.supportHotline, '0829191080');
    assert.equal(settings.affiliate.commissionPercent, 10);
    assert.equal(settings.shipping.defaultCarrier, 'flexible');
    assert.ok(settings.shipping.enabledCarriers.includes('ghn'));
    assert.ok(settings.shipping.enabledCarriers.includes('viettel'));
    assert.ok(settings.shipping.enabledCarriers.includes('ghtk'));
  });

  // Test 7: Footer Shell Synchronization, Brand Consistency & Multi-Carrier Order Tracking
  await t.test('7. Footer Shell Synchronization, Brand Consistency & Multi-Carrier Order Tracking', () => {
    const shell = fs.readFileSync(path.join(__dirname, '..', 'store-shell.js'), 'utf8');
    assert.match(shell, /Dịch vụ &amp; Tiện ích/, 'Footer must contain Services & Utilities column');
    assert.match(shell, /\/tra-cuu-don-hang/, 'Footer must link to order tracking');
    assert.doesNotMatch(shell, /Tra cứu đơn hàng SPX/, 'Footer must not lock to SPX only');
    assert.match(shell, /Tra cứu đơn hàng &amp; Vận đơn/, 'Footer must display diversified shipping text');
    assert.match(shell, /rma\.html/, 'Footer must link to RMA policy');
    assert.match(shell, /quiz\.html/, 'Footer must link to AI Quiz');
    assert.match(shell, /news\.html/, 'Footer must link to News');

    const trackingHtml = fs.readFileSync(path.join(__dirname, '..', 'tracking.html'), 'utf8');
    assert.doesNotMatch(trackingHtml, /giao hàng Shopee Express \(SPX\)\.</, 'Tracking hero must not lock to SPX only');
    assert.match(trackingHtml, /GHN, GHTK, Viettel Post, SPX/, 'Tracking hero must list diverse carriers');

    const adminHtml = fs.readFileSync(path.join(__dirname, '..', 'admin', 'index.html'), 'utf8');
    assert.doesNotMatch(adminHtml, />GAERU Store</, 'Admin UI must not display GAERU Store');
    assert.match(adminHtml, />GAERU</, 'Admin UI must consistently display GAERU');

    const rmaHtml = fs.readFileSync(path.join(__dirname, '..', 'rma.html'), 'utf8');
    assert.doesNotMatch(rmaHtml, /GAERU Store/, 'RMA page must not display GAERU Store');
    assert.doesNotMatch(rmaHtml, /Tra cứu đơn hàng SPX/, 'RMA footer must not lock to SPX only');

    const quizHtml = fs.readFileSync(path.join(__dirname, '..', 'quiz.html'), 'utf8');
    assert.doesNotMatch(quizHtml, /GAERU Store/, 'Quiz page must not display GAERU Store');
    assert.doesNotMatch(quizHtml, /Tra cứu đơn hàng SPX/, 'Quiz footer must not lock to SPX only');
  });

  // Test 8: Storefront Header & Footer Shell Synchronization on All New Functional Pages
  await t.test('8. Storefront Header & Footer Shell Synchronization on All New Functional Pages', () => {
    const pages = ['rma.html', 'quiz.html', 'tracking.html'];

    for (const pageName of pages) {
      const pageHtml = fs.readFileSync(path.join(__dirname, '..', pageName), 'utf8');
      assert.match(pageHtml, /<div id="site-header"><\/div>/, `${pageName} must contain site-header mount point`);
      assert.match(pageHtml, /<div id="site-footer"><\/div>/, `${pageName} must contain site-footer mount point`);
      assert.match(pageHtml, /store-shell\.js/, `${pageName} must load store-shell.js script`);
      assert.match(pageHtml, /styles\.css/, `${pageName} must load styles.css stylesheet`);
      assert.match(pageHtml, /brand\.css/, `${pageName} must load brand.css stylesheet`);

      // Ensure no standalone custom headers or footers left
      assert.doesNotMatch(pageHtml, /<header class="rma-header"/, `${pageName} must not have custom rma-header`);
      assert.doesNotMatch(pageHtml, /<footer class="rma-footer"/, `${pageName} must not have custom rma-footer`);
      assert.doesNotMatch(pageHtml, /<header class="quiz-header"/, `${pageName} must not have custom quiz-header`);
      assert.doesNotMatch(pageHtml, /<footer class="quiz-footer"/, `${pageName} must not have custom quiz-footer`);
    }

    // Verify critical action buttons on functional pages
    const rmaContent = fs.readFileSync(path.join(__dirname, '..', 'rma.html'), 'utf8');
    assert.match(rmaContent, /id="tab-lookup-btn"/, 'RMA must have lookup tab button');
    assert.match(rmaContent, /id="tab-submit-btn"/, 'RMA must have submit tab button');
    assert.match(rmaContent, /id="rma-lookup-submit"/, 'RMA must have lookup submit button');
    assert.match(rmaContent, /id="rma-submit-btn-action"/, 'RMA must have submit action button');

    const quizContent = fs.readFileSync(path.join(__dirname, '..', 'quiz.html'), 'utf8');
    assert.match(quizContent, /id="quiz-progress"/, 'Quiz must have progress bar indicator');
    assert.match(quizContent, /id="quiz-question-container"/, 'Quiz must have question container');
    assert.match(quizContent, /id="quiz-result-container"/, 'Quiz must have result container');

    const trackingContent = fs.readFileSync(path.join(__dirname, '..', 'tracking.html'), 'utf8');
    assert.match(trackingContent, /id="tracking-form"/, 'Tracking must have tracking form');
    assert.match(trackingContent, /id="tracking-query"/, 'Tracking must have query input');
    assert.match(trackingContent, /id="btn-track"/, 'Tracking must have search submit button');
  });
});
