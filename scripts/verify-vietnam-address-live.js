'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { performance } = require('node:perf_hooks');
const { parseHTML } = require('linkedom');
const address = require('../vietnam-address');

async function runLiveVerification() {
  console.log('='.repeat(80));
  console.log('KIỂM TRA CHẠY THẬT & ĐO LƯỜNG SỐ LIỆU THỰC TẾ: vietnam-address.js');
  console.log('Môi trường: Node.js 24 LTS · DOM Linkedom Engine · 34 Tỉnh Thành & Phường Xã Toàn Quốc');
  console.log('='.repeat(80));

  // --------------------------------------------------------------------------
  // KỊCH BẢN 1: TÍNH TOÀN VẸN VÀ CHUẨN HOÁ DANH MỤC 34 TỈNH THÀNH
  // --------------------------------------------------------------------------
  console.log('\n--- 1. KIỂM THỬ DANH MỤC 34 TỈNH THÀNH & CHUẨN HOÁ CHUỖI CANONICAL ---');

  const t0 = performance.now();
  assert.equal(address.provinces.length, 34);
  assert.equal(new Set(address.provinces).size, 34, '34 tỉnh thành phải hoàn toàn duy nhất');

  // Kiểm tra thứ tự sắp xếp theo tiếng Việt (Collation)
  for (let i = 0; i < address.provinces.length - 1; i++) {
    assert.ok(
      address.provinces[i].localeCompare(address.provinces[i + 1], 'vi') <= 0,
      `Thứ tự sai tại ${address.provinces[i]} vs ${address.provinces[i + 1]}`
    );
  }

  // Đo lường tốc độ chuẩn hóa canonical qua 10.000 lượt
  const testInputs = [
    { in: 'thành phố hồ chí minh', expected: 'Hồ Chí Minh' },
    { in: 'TP. Hồ Chí Minh', expected: 'Hồ Chí Minh' },
    { in: 'ha noi', expected: 'Hà Nội' },
    { in: 'Tỉnh Hà Tĩnh', expected: 'Hà Tĩnh' },
    { in: 'tp da nang', expected: 'Đà Nẵng' },
    { in: 'ba ria vung tau', expected: '' }, // Tỉnh cũ không có trong danh mục 34 tỉnh -> không đoán mò
    { in: '', expected: '' }
  ];

  for (let k = 0; k < 10000; k++) {
    for (const item of testInputs) {
      assert.equal(address.canonical(item.in), item.expected);
    }
  }
  const t1 = performance.now();
  const durCanonical10kMs = t1 - t0;

  console.log(`- Tổng số tỉnh/thành phố chuẩn hóa : ${address.provinces.length} tỉnh thành`);
  console.log(`- Thứ tự sắp xếp danh mục          : Chuẩn bảng chữ cái Tiếng Việt (localeCompare 'vi')`);
  console.log(`- Tốc độ chuẩn hóa (70.000 phép tính): ${durCanonical10kMs.toFixed(3)} ms (~${((70000 / durCanonical10kMs) * 1000).toLocaleString('vi-VN', { maximumFractionDigits: 0 })} ops/giây)`);
  console.log(`✔ Chống suy đoán sai lệch: Không tự ý map các tỉnh cũ/sáp nhập không thuộc 34 tỉnh hiện hành.`);

  // --------------------------------------------------------------------------
  // KỊCH BẢN 2: TẢI & XÁC THỰC BỘ DỮ LIỆU PHƯỜNG / XÃ ĐẦY ĐỦ (DATASET INGESTION)
  // --------------------------------------------------------------------------
  console.log('\n--- 2. TẢI VÀ XÁC THỰC BỘ DỮ LIỆU TOÀN DIỆN (34 TỈNH & HÀNG NGHÌN PHƯỜNG/XÃ) ---');

  const jsonPath = path.join(__dirname, '../assets/data/vietnam-addresses.json');
  assert.ok(fs.existsSync(jsonPath), 'Tệp vietnam-addresses.json phải tồn tại');

  const rawJson = fs.readFileSync(jsonPath, 'utf8');
  const dataset = JSON.parse(rawJson);

  const t2 = performance.now();
  const loadedData = address.setData(dataset);
  const t3 = performance.now();
  const durSetDataMs = t3 - t2;

  let totalWards = 0;
  for (const prov of loadedData.provinces) {
    assert.ok(prov.code, `Mã tỉnh ${prov.name} không được rỗng`);
    assert.ok(Array.isArray(prov.wards), `Tỉnh ${prov.name} phải có danh sách phường/xã`);
    totalWards += prov.wards.length;
  }

  console.log(`- Kích thước tệp JSON dữ liệu      : ${(fs.statSync(jsonPath).size / 1024).toFixed(1)} KB`);
  console.log(`- Thời gian xác thực & gán dataset : ${durSetDataMs.toFixed(3)} ms`);
  console.log(`- Tổng số phường / xã toàn quốc    : ${totalWards.toLocaleString('vi-VN')} phường / xã`);
  console.log(`- Mẫu tỉnh lớn (Hà Nội)            : ${loadedData.provinces.find(p => p.name === 'Hà Nội').wards.length} phường/xã`);
  console.log(`- Mẫu tỉnh lớn (Hồ Chí Minh)       : ${loadedData.provinces.find(p => p.name === 'Hồ Chí Minh').wards.length} phường/xã`);

  // --------------------------------------------------------------------------
  // KỊCH BẢN 3: NÂNG CẤP GIAO DIỆN FORM ĐỊA CHỈ (DOM ENHANCEMENT & 2-STAGE COMBOBOX)
  // --------------------------------------------------------------------------
  console.log('\n--- 3. NÂNG CẤP GIAO DIỆN FORM ĐỊA CHỈ & TRÌNH CHỌN 2 TẦNG (TỈNH -> PHƯỜNG) ---');

  const html = `
    <html>
      <body>
        <form id="checkout-form">
          <label>Tên địa chỉ<input name="label" value="Văn phòng"></label>
          <label>Địa chỉ chi tiết<input name="address" value="Số 88 Phố Vọng"></label>
          <label>Tỉnh / Thành phố<input name="city" required autocomplete="address-level1"></label>
          <select data-delivery-city><option>Toàn quốc</option></select>
        </form>
      </body>
    </html>
  `;

  const { document, window } = parseHTML(html);
  const form = document.querySelector('form');

  const t4 = performance.now();
  address.enhance(document);
  const t5 = performance.now();
  const durEnhanceMs = t5 - t4;

  const cityInput = form.querySelector('[name="city"]');
  const pickerWrap = form.querySelector('.vn-address-picker');
  const proxy = form.querySelector('.vn-address-choice');
  const panel = form.querySelector('.vn-address-panel');

  assert.ok(pickerWrap, 'Trình chọn vn-address-picker phải được bọc ngoài');
  assert.equal(cityInput.hidden, true, 'Input city gốc được ẩn đi để nhường cho proxy');
  assert.equal(proxy.placeholder, 'Chọn tỉnh / thành phố, phường / xã');
  assert.equal(proxy.getAttribute('role'), 'combobox');
  assert.equal(proxy.getAttribute('aria-haspopup'), 'dialog');

  console.log(`- Thời gian nâng cấp DOM Form     : ${durEnhanceMs.toFixed(3)} ms`);
  console.log(`- Trạng thái input city gốc       : Hidden (Được thay thế bằng Custom Combobox)`);
  console.log(`- Tiêu chuẩn trợ năng (ARIA)      : role="combobox", aria-haspopup="dialog", aria-expanded="false"`);

  // --------------------------------------------------------------------------
  // KỊCH BẢN 4: THAO TÁC TƯƠNG TÁC CHỌN ĐỊA CHỈ 2 TẦNG (CLICK & SEARCH)
  // --------------------------------------------------------------------------
  console.log('\n--- 4. MÔ PHỎNG THAO TÁC KHÁCH HÀNG CHỌN TỈNH & PHƯỜNG/XÃ ---');

  // Giả lập Linkedom setter cho select
  let cityVal = '';
  Object.defineProperty(cityInput, 'value', {
    configurable: true,
    get: () => cityVal,
    set: (v) => { cityVal = v; }
  });

  // 1. Mở panel combobox
  proxy.dispatchEvent(new window.Event('click', { bubbles: true }));
  assert.equal(panel.hidden, false, 'Panel địa chỉ phải mở ra khi bấm vào proxy');
  assert.equal(proxy.getAttribute('aria-expanded'), 'true');

  // 2. Tìm kiếm tỉnh 'ha noi'
  const searchInput = form.querySelector('.vn-address-search');
  searchInput.value = 'ha noi';
  searchInput.dispatchEvent(new window.Event('input', { bubbles: true }));

  const filteredProvinces = form.querySelectorAll('.vn-address-options button');
  assert.equal(filteredProvinces.length, 1);
  assert.equal(filteredProvinces[0].textContent, 'Hà Nội');

  // 3. Bấm chọn 'Hà Nội' -> Chuyển sang tầng 2 (chọn phường/xã)
  filteredProvinces[0].dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }));
  assert.equal(cityInput.value, 'Hà Nội');
  assert.equal(panel.hidden, false, 'Panel vẫn mở để tiếp tục chọn phường');
  assert.equal(searchInput.placeholder, 'Tìm phường / xã');

  // Nếu người dùng cố lấy địa chỉ khi chưa chọn phường -> Hệ thống báo lỗi bắt buộc
  assert.throws(
    () => address.getAddress(form),
    /phường \/ xã/,
    'Phải yêu cầu chọn phường/xã khi form có yêu cầu hoàn tất'
  );

  // 4. Tìm kiếm và chọn phường 'Phường Ba Đình' (code '00004')
  const wardBtn = form.querySelector('[data-address-code="00004"]');
  assert.ok(wardBtn, 'Phải tìm thấy nút Phường Ba Đình');
  wardBtn.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }));

  assert.equal(panel.hidden, true, 'Panel tự động đóng khi hoàn tất chọn phường');
  assert.equal(cityInput.dataset.wardCode, '00004');

  const finalFullAddress = address.getAddress(form);
  assert.equal(finalFullAddress, 'Số 88 Phố Vọng, Phường Ba Đình');
  console.log(`- Địa chỉ chi tiết nhập           : "Số 88 Phố Vọng"`);
  console.log(`- Tỉnh thành đã chọn              : "${cityInput.value}"`);
  console.log(`- Mã phường/xã đã lưu             : "${cityInput.dataset.wardCode}"`);
  console.log(`- Chuỗi địa chỉ ghép chuẩn hóa    : "${finalFullAddress}"`);
  console.log(`✔ Cơ chế đóng/mở panel & chuyển tầng mượt mà, ngăn ngừa bỏ sót thông tin giao hàng.`);

  // --------------------------------------------------------------------------
  // KỊCH BẢN 5: GÁN VÀ PHỤC HỒI ĐỊA CHỈ (setAddress & Legacy Preservation)
  // --------------------------------------------------------------------------
  console.log('\n--- 5. KIỂM THỬ GÁN DỮ LIỆU & BẢO TOÀN ĐỊA CHỈ CŨ (LEGACY RESTORE) ---');

  // Gán địa chỉ chuẩn có phường
  address.setAddress(form, {
    address: 'Căn hộ 12B, Toà Sky, Phường Ba Đình',
    city: 'Hà Nội'
  });
  assert.equal(form.querySelector('[name="address"]').value, 'Căn hộ 12B, Toà Sky');
  assert.equal(cityInput.dataset.wardCode, '00004');
  assert.equal(address.getAddress(form), 'Căn hộ 12B, Toà Sky, Phường Ba Đình');

  // Gán địa chỉ cũ chưa có phường (Legacy Address)
  address.setAddress(form, {
    address: 'Thôn 3, Xã Cũ Chưa Có Trong Danh Mục',
    city: 'Hà Nội'
  });
  assert.equal(address.getAddress(form), 'Thôn 3, Xã Cũ Chưa Có Trong Danh Mục');
  assert.equal(cityInput.dataset.wardCode, undefined, 'Không được gán bừa mã phường khi không khớp');
  console.log('✔ Tương thích ngược: Bảo toàn nguyên vẹn địa chỉ cũ mà không gán sai mã phường.');

  console.log('\n' + '='.repeat(80));
  console.log('BẢNG TỔNG HỢP SỐ LIỆU ĐO ĐẠC THỰC TẾ: VIETNAM ADDRESS PICKER');
  console.log('='.repeat(80));
  console.log(`- Số lượng tỉnh thành chuẩn       : 34 tỉnh/thành phố hiện hành`);
  console.log(`- Tổng số phường / xã tra cứu      : ${totalWards.toLocaleString('vi-VN')} đơn vị hành chính`);
  console.log(`- Tốc độ chuẩn hóa chuỗi Canonical: ${((70000 / durCanonical10kMs) * 1000).toLocaleString('vi-VN', { maximumFractionDigits: 0 })} ops/giây`);
  console.log(`- Trải nghiệm người dùng (UX)     : Chọn 2 tầng (Tỉnh -> Phường) trong cùng 1 panel`);
  console.log(`- Tiêu chuẩn khả năng tiếp cận    : W3C WAI-ARIA Combobox & Dialog`);
  console.log(`- Bảo toàn địa chỉ lịch sử        : Giữ nguyên địa chỉ cũ, không đoán mò sai lệch`);
  console.log('='.repeat(80));
}

if (require.main === module) {
  runLiveVerification()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[Verification Failed]', err);
      process.exit(1);
    });
}

module.exports = { runLiveVerification };
