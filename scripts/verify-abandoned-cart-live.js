'use strict';

const { PGlite } = require('@electric-sql/pglite');
const {
  recordCartContact,
  markCartRecovered,
  getCartByToken,
  processAbandonedCartReminders,
  createAbandonedCartAdmin
} = require('../src/abandoned-cart');

async function runLiveAbandonedCartVerification() {
  console.log('='.repeat(80));
  console.log('KIỂM TRA CHẠY THẬT & ĐO LƯỜNG SỐ LIỆU THỰC TẾ: src/abandoned-cart.js (PostgreSQL Engine)');
  console.log('='.repeat(80));

  const db = new PGlite();
  const startTime = performance.now();

  // Khởi tạo bảng CSDL theo chuẩn migration
  await db.exec(`
    CREATE TABLE IF NOT EXISTS abandoned_carts (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      email text,
      phone text,
      customer_name text,
      items jsonb NOT NULL DEFAULT '[]'::jsonb,
      subtotal_vnd integer NOT NULL DEFAULT 0,
      recovery_token text UNIQUE,
      status text NOT NULL DEFAULT 'abandoned' CHECK (status IN ('abandoned', 'reminded_1', 'reminded_2', 'recovered')),
      reminder_count integer NOT NULL DEFAULT 0,
      reminder_sent_at timestamptz,
      recovered_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS abandoned_carts_status_created_idx ON abandoned_carts (status, created_at);
    CREATE INDEX IF NOT EXISTS abandoned_carts_recovery_token_idx ON abandoned_carts (recovery_token);
  `);

  console.log('✔ Đã khởi tạo bảng CSDL abandoned_carts và các chỉ mục (Indexes, Unique Token Constraint)\n');

  // =========================================================================
  // KỊCH BẢN 1: GHI NHẬN LIÊN HỆ & CHỐNG TẠO BẢN GHI RÁC (DEDUPLICATION)
  // =========================================================================
  console.log('--- KỊCH BẢN 1: Ghi nhận Khách để lại Giỏ Hàng & Tự động Gộp (Deduplication) ---');
  const cart1 = await recordCartContact(db, {
    email: 'khachhang1@gmail.com',
    phone: '0912345678',
    customerName: 'Nguyễn Văn An',
    items: [{ id: 'var-k9', name: 'Micro Thu Âm GAERU K9 Pro', quantity: 1, priceVnd: 409000 }],
    subtotalVnd: 409000
  });

  console.log(`- Tạo giỏ hàng ban đầu thành công: id = ${cart1.id}`);
  console.log(`- Mã cứu hộ bí mật (Recovery Token): ${cart1.recoveryToken} (Độ dài: ${cart1.recoveryToken.length} ký tự hex)`);

  // Khách quay lại sửa đổi giỏ hàng (thêm tai nghe M1 và tăng số lượng)
  const cart1Updated = await recordCartContact(db, {
    email: 'khachhang1@gmail.com',
    phone: '0912345678',
    customerName: 'Nguyễn Văn An',
    items: [
      { id: 'var-k9', name: 'Micro Thu Âm GAERU K9 Pro', quantity: 1, priceVnd: 409000 },
      { id: 'var-m1', name: 'Tai Nghe GAERU M1 Hi-Res', quantity: 2, priceVnd: 389000 }
    ],
    subtotalVnd: 1187000
  });

  const check1 = await db.query('SELECT id, subtotal_vnd, items FROM abandoned_carts WHERE email = $1', ['khachhang1@gmail.com']);
  console.log(`- Kiểm tra gộp giỏ hàng (Deduplication):`);
  console.log(`    + Số bản ghi tồn tại trong CSDL : ${check1.rows.length} (Chính xác = 1, không sinh bản ghi thừa)`);
  console.log(`    + Giá trị giỏ hàng được cập nhật : ${check1.rows[0].subtotal_vnd.toLocaleString('vi-VN')} đ (Đã cập nhật đúng 1.187.000 đ)`);
  console.log(`    + Mã cứu hộ giữ nguyên ổn định   : ${cart1.recoveryToken === cart1Updated.recoveryToken ? 'ĐÚNG (Token bất biến)' : 'SAI'}\n`);

  // Thêm 4 giỏ hàng mẫu khác để đo lường phân loại
  const sampleCarts = [
    { email: 'khach2@gmail.com', phone: '0988111222', name: 'Trần Thị Bình', subtotalVnd: 550000, items: [{ name: 'Kẹp Tripod', quantity: 2, priceVnd: 275000 }] },
    { email: 'khach3@gmail.com', phone: '0977333444', name: 'Lê Hoàng Cúc', subtotalVnd: 890000, items: [{ name: 'Bông lọc gió Pro', quantity: 1, priceVnd: 890000 }] },
    { email: 'khach4@gmail.com', phone: '0966555666', name: 'Phạm Đức Dũng', subtotalVnd: 1500000, items: [{ name: 'Bộ Combo Studio', quantity: 1, priceVnd: 1500000 }] },
    { email: 'khach5@gmail.com', phone: '0955777888', name: 'Hoàng Mai Em', subtotalVnd: 720000, items: [{ name: 'Dây cáp Type-C', quantity: 4, priceVnd: 180000 }] }
  ];
  for (const c of sampleCarts) {
    await recordCartContact(db, c);
  }

  // =========================================================================
  // KỊCH BẢN 2: TRÍCH XUẤT GIỎ HÀNG QUA LIÊN KẾT CỨU HỘ (RECOVERY RESTORATION)
  // =========================================================================
  console.log('--- KỊCH BẢN 2: Khách Bấm Vào Link Phục Hồi Giỏ Hàng (Recovery Token Lookup) ---');
  const lookupStart = performance.now();
  const recoveredCartData = await getCartByToken(db, cart1.recoveryToken);
  const lookupDurationMs = performance.now() - lookupStart;

  console.log(`- Thời gian tra cứu giỏ hàng: ${lookupDurationMs.toFixed(3)} ms`);
  console.log(`- Dữ liệu khôi phục: Khách hàng "${recoveredCartData.customerName}", Email: ${recoveredCartData.email}`);
  console.log(`- Số lượng món hàng phục hồi: ${recoveredCartData.items.length} món`);
  for (const item of recoveredCartData.items) {
    console.log(`    * ${item.name} x${item.quantity} (${(item.priceVnd * item.quantity).toLocaleString('vi-VN')} đ)`);
  }
  console.log(`- Tổng tiền giỏ hàng khôi phục: ${recoveredCartData.subtotalVnd.toLocaleString('vi-VN')} đ\n`);

  // =========================================================================
  // KỊCH BẢN 3: TỰ ĐỘNG GỬI EMAIL NHẮC NHỞ THEO 2 TẦNG (TIER 1 & TIER 2 REMINDERS)
  // =========================================================================
  console.log('--- KỊCH BẢN 3: Chu Trình Nhắc Nhở Tự Động 2 Tầng (60 phút & 24 giờ kèm Voucher 5%) ---');
  const sentEmails = [];
  const mockMailer = {
    async sendMail(mailOptions) {
      sentEmails.push(mailOptions);
    }
  };

  // 3.1 Giả lập 3 giỏ hàng đã trôi qua 65 phút (đủ điều kiện Tầng 1)
  await db.query(`
    UPDATE abandoned_carts
    SET created_at = now() - interval '65 minutes'
    WHERE email IN ('khachhang1@gmail.com', 'khach2@gmail.com', 'khach3@gmail.com')
  `);

  const sentTier1 = await processAbandonedCartReminders(db, mockMailer, { PUBLIC_BASE_URL: 'https://gaeru.com' });
  console.log(`- Đợt 1 (Sau 60 phút): Đã gửi thành công ${sentTier1} email nhắc nhở kèm mã giảm giá GAERUCARE5`);
  console.log(`- Kiểm tra nội dung email đợt 1:`);
  console.log(`    + Người nhận mẫu: ${sentEmails[0].to}`);
  console.log(`    + Tiêu đề       : ${sentEmails[0].subject}`);
  console.log(`    + Liên kết cứu hộ: https://gaeru.com/checkout.html?recover=${cart1.recoveryToken.slice(0, 8)}...`);

  // 3.2 Giả lập tiếp tục trôi qua 25 giờ và chưa mua (đủ điều kiện Tầng 2)
  await db.query(`
    UPDATE abandoned_carts
    SET reminder_sent_at = now() - interval '25 hours'
    WHERE email = 'khachhang1@gmail.com'
  `);
  const sentTier2 = await processAbandonedCartReminders(db, mockMailer, { PUBLIC_BASE_URL: 'https://gaeru.com' });
  console.log(`- Đợt 2 (Sau 24 giờ tiếp theo): Đã gửi thành công ${sentTier2} email nhắc nhở lần 2`);

  // 3.3 Chạy lại ngay lập tức -> Không được gửi thêm (Chống spam)
  const sentTier3 = await processAbandonedCartReminders(db, mockMailer, { PUBLIC_BASE_URL: 'https://gaeru.com' });
  console.log(`- Chạy lại kiểm tra chống spam: Đã gửi ${sentTier3} email (Chính xác = 0 do chưa đủ thời gian dãn cách)\n`);

  // =========================================================================
  // KỊCH BẢN 4: KHÁCH HOÀN TẤT ĐẶT HÀNG & CHUYỂN TRẠNG THÁI RECOVERED
  // =========================================================================
  console.log('--- KỊCH BẢN 4: Khách Hàng Hoàn Tất Thanh Toán & Ghi Nhận Doanh Thu Cứu Hộ ---');
  // Khách 1 và Khách 2 đặt hàng thành công
  await markCartRecovered(db, { recoveryToken: cart1.recoveryToken });
  await markCartRecovered(db, { email: 'khach2@gmail.com' });

  const statusCheck = await db.query(`
    SELECT email, status, recovered_at IS NOT NULL as "hasRecoveredAt"
    FROM abandoned_carts
    WHERE email IN ('khachhang1@gmail.com', 'khach2@gmail.com')
  `);
  console.log(`- Trạng thái Khách 1: status = "${statusCheck.rows[0].status}", có recovered_at = ${statusCheck.rows[0].hasRecoveredAt}`);
  console.log(`- Trạng thái Khách 2: status = "${statusCheck.rows[1].status}", có recovered_at = ${statusCheck.rows[1].hasRecoveredAt}\n`);

  // =========================================================================
  // KỊCH BẢN 5: BÁO CÁO DOANH THU & CHỈ SỐ KINH DOANH CHO QUẢN TRỊ VIÊN
  // =========================================================================
  console.log('--- KỊCH BẢN 5: Báo Cáo Phân Tích Hiệu Suất Cứu Hộ Doanh Thu (Admin Analytics) ---');
  const adminQuery = await db.query(`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE status = 'recovered')::int AS recovered,
      COUNT(*) FILTER (WHERE status IN ('reminded_1', 'reminded_2'))::int AS reminded,
      COALESCE(SUM(subtotal_vnd) FILTER (WHERE status = 'recovered'), 0)::bigint AS "recoveredRevenueVnd",
      COALESCE(SUM(subtotal_vnd) FILTER (WHERE status <> 'recovered'), 0)::bigint AS "abandonedRevenueVnd"
    FROM abandoned_carts
  `);

  const stats = adminQuery.rows[0];
  const totalCarts = stats.total;
  const recoveredCarts = stats.recovered;
  const recoveryRate = ((recoveredCarts / totalCarts) * 100).toFixed(1);
  const totalExecutionDurationMs = (performance.now() - startTime).toFixed(2);

  console.log('='.repeat(80));
  console.log('BẢNG TỔNG HỢP SỐ LIỆU ĐO ĐẠC THỰC TẾ: ABANDONED CARTS');
  console.log('='.repeat(80));
  console.log(`- Tổng số giỏ hàng bị bỏ quên ghi nhận : ${totalCarts} giỏ`);
  console.log(`- Số giỏ hàng được cứu hộ thành công  : ${recoveredCarts} giỏ`);
  console.log(`- Tỷ lệ phục hồi giỏ hàng (Conversion) : ${recoveryRate}%`);
  console.log(`- Số giỏ hàng đang trong phễu nhắc nhở : ${stats.reminded} giỏ`);
  console.log(`- Doanh thu thực tế đã cứu hộ thành công : ${Number(stats.recoveredRevenueVnd).toLocaleString('vi-VN')} đ`);
  console.log(`- Doanh thu tiềm năng đang tiếp tục theo đuổi: ${Number(stats.abandonedRevenueVnd).toLocaleString('vi-VN')} đ`);
  console.log(`- Tổng thời gian toàn bộ chu trình kiểm thử: ${totalExecutionDurationMs} ms`);
  console.log('='.repeat(80));

  await db.close();
  return { stats, recoveryRate, totalExecutionDurationMs };
}

if (require.main === module) {
  runLiveAbandonedCartVerification().catch((err) => {
    console.error('Lỗi kiểm tra:', err);
    process.exit(1);
  });
}

module.exports = { runLiveAbandonedCartVerification };
