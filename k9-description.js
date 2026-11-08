/* Curated GAERU K9 story from the supplied product artwork. */
function renderK9() {
  const image = (n, alt, w = 800, h = 1024) =>
    `<figure><a href="/assets/products/k9-description/${n}.webp" target="_blank" rel="noopener" aria-label="Xem ảnh lớn: ${alt} (mở trong tab mới)"><img src="/assets/products/k9-description/${n}.webp" srcset="/assets/products/k9-description/${n}.webp?w=480 480w, /assets/products/k9-description/${n}.webp?w=800 800w, /assets/products/k9-description/${n}.webp 1024w" sizes="(max-width: 760px) calc(100vw - 40px), 520px" alt="${alt}" width="${w}" height="${h}" loading="lazy" decoding="async"></a></figure>`;

  const section = (title, copy, imageHtml, eyebrow) =>
    `<section class="k9-chapter"><div class="k9-chapter-inner"><div class="k9-chapter-copy">${eyebrow ? `<p class="eyebrow">${eyebrow}</p>` : ''}<h3>${title}</h3><p>${copy}</p></div><div class="k9-chapter-art">${imageHtml}</div></div></section>`;

  const specs = [
    ['Hướng thu âm', 'Đa hướng 360° (Omnidirectional)'],
    ['Tần số sóng truyền', 'Kỹ thuật số không dây 2.4 GHz (chống nhiễu cao)'],
    ['Độ trễ tín hiệu', '< 15 ms, đồng bộ hình ảnh và tiếng tức thì'],
    ['Khoảng cách truyền', 'Lên đến 20 mét (không gian mở, tầm nhìn thẳng)'],
    ['Khử ồn & Chống rè', 'Chip DSP lọc ồn thông minh kết hợp mút xốp mật độ cao'],
    ['Cơ chế kết nối', 'Cắm là dùng (Plug & Play), không cần Bluetooth hay cài đặt ứng dụng'],
    ['Thời lượng pin micro', 'Lên đến 6 – 8 giờ sử dụng liên tục sau mỗi lần sạc đầy'],
    ['Dung lượng pin micro', 'Pin sạc Lithium Polymer dung lượng cao'],
    ['Cổng sạc micro', 'Type-C tiêu chuẩn (nguồn sạc 5V/1A)'],
    ['Đầu thu tín hiệu (RX)', 'Cổng Type-C (Android / iPhone 15+ / iPad) hoặc Lightning (iPhone)'],
    ['Tùy chọn phiên bản', 'Bộ 1 Micro (1 người dùng) hoặc Bộ 2 Micro (2 người thu âm song song)'],
    ['Trọng lượng micro', 'Siêu nhẹ ~7g (cài áo êm ái, không xệ vải áo)'],
    ['Phụ kiện tiêu chuẩn', 'Micro cài áo (TX), Đầu thu tín hiệu (RX), Cáp sạc Type-C, Bông lọc gió mút xốp']
  ];

  return `<div class="product-description-media k9-story">
  <section class="k9-intro">
    <p class="eyebrow">THIẾT KẾ CHO SỰ TỰ DO &amp; TIỆN LỢI</p>
    <h3>Bắt trọn giọng nói.<br>Tự do kết nối không dây.</h3>
    <p>GAERU K9 mang đến trải nghiệm thu âm không dây tinh gọn và hiệu quả vượt trội. Với công nghệ kết nối tự động "Cắm là dùng", bán kính thu sóng ổn định 20 mét và màng thu 360° khử nhiễu thông minh, K9 là trợ thủ hoàn hảo cho livestream bán hàng, vlog, phỏng vấn và giảng dạy trực tuyến.</p>
    <div class="k9-highlights">
      <span><strong>Cắm là dùng</strong>Tự động kết nối tức thì, không cần Bluetooth / App</span>
      <span><strong>20 mét</strong>Khoảng cách thu sóng 2.4 GHz ổn định</span>
      <span><strong>360° toàn hướng</strong>Màng thu đa hướng khử rè, không góc chết</span>
    </div>
    <div class="k9-intro-artwork">
      ${image(1, 'GAERU K9: 6 điểm nổi bật cốt lõi của micro thu âm không dây', 1024, 970)}
    </div>
  </section>

  ${section(
    'Tự do không dây vướng víu.<br>Tự động kết nối • Cắm là dùng.',
    'Không còn nỗi lo vướng víu bởi dây nối rườm rà hay thao tác ghép đôi Bluetooth phức tạp. GAERU K9 ứng dụng cơ chế cắm là dùng (Plug &amp; Play) thông minh: chỉ cần cắm đầu thu vào điện thoại và bật nguồn micro, bộ đôi sẽ tự động đồng bộ tần số không dây 2.4 GHz ngay lập tức. Sẵn sàng bắt đầu buổi livestream hay ghi hình mọi lúc, mọi nơi.',
    image(2, 'GAERU K9 tự động kết nối và cắm là dùng trên điện thoại', 555, 1024),
    'KẾT NỐI TỨC THÌ'
  )}

  ${section(
    'Thu âm 360° toàn hướng.<br>Không góc chết, trọn vẹn từng dải âm.',
    'Trang bị capsule độ nhạy cao thu âm đa hướng 360 độ, GAERU K9 ghi lại giọng nói rõ ràng từ mọi phía mà không yêu cầu người dùng phải hướng trực diện vào micro. Kết hợp cùng bông lọc mút xốp mật độ cao chống rè và chip xử lý âm thanh kỹ thuật số, thiết bị giảm thiểu tối đa tiếng gió và tạp âm môi trường, mang lại âm thanh trong trẻo, chân thực.',
    image(3, 'GAERU K9 thu âm 360 độ toàn hướng không góc chết', 597, 1024),
    'CHẤT ÂM ĐA CHIỀU'
  )}

  ${section(
    'Chi tiết sản phẩm tỉ mỉ.<br>Bền bỉ, công thái học trong từng chi tiết.',
    'Từng chi tiết của GAERU K9 được chăm chút kỹ lưỡng: kẹp cài áo răng cưa chắc chắn giúp cố định micro vững vàng trên trang phục; bông lọc gió mút xốp đàn hồi cao ngăn ngừa hiện tượng vỡ tiếng; và đầu thu tín hiệu bo cong nhỏ gọn, truyền tải âm thanh không suy hao qua giao diện kết nối kỹ thuật số.',
    image(4, 'Chi tiết cấu tạo kẹp cài áo, bông lọc gió và đầu thu GAERU K9', 647, 1024),
    'CẤU TẠO PHẦN CỨNG'
  )}

  ${section(
    'Tương thích đa thiết bị.<br>Điện thoại, máy tính bảng và laptop.',
    'GAERU K9 hỗ trợ kết nối rộng rãi với hầu hết các dòng điện thoại thông minh, máy tính bảng, iPad, laptop và máy tính để bàn phổ biến hiện nay. Dù bạn sử dụng cổng Type-C hiện đại hay cổng Lightning truyền thống, thiết bị đều nhận diện nhanh chóng mà không cần thêm đầu chuyển rườm rà. Dễ dàng chuyển đổi linh hoạt giữa các thiết bị làm việc và sáng tạo nội dung hàng ngày.',
    image(8, 'GAERU K9 tương thích đa thiết bị: điện thoại, máy tính bảng, laptop', 637, 1024),
    'KẾT NỐI TOÀN DIỆN'
  )}

  ${section(
    'Trợ thủ livestream đắc lực.<br>Tối ưu cho bán hàng và sáng tạo nội dung.',
    'Âm thanh rõ ràng quyết định thành công của một buổi bán hàng trực tiếp hay sản xuất video ngắn. GAERU K9 giúp người dẫn live tự do tương tác, di chuyển và giới thiệu sản phẩm mà giọng nói vẫn truyền đến người xem to rõ và sống động. Tương thích hoàn hảo với các nền tảng phát sóng trực tiếp phổ biến hiện nay.',
    image(5, 'GAERU K9 trợ thủ livestream chuyên nghiệp đa thiết bị', 367, 1024),
    'LIVESTREAM BÁN HÀNG'
  )}

  ${section(
    'Thu âm &amp; Livestream ngoài trời tiện lợi.<br>Sóng xa 20 mét, tự tin sải bước.',
    'Thiết kế siêu nhẹ chỉ khoảng 7 gram cùng khả năng truyền sóng ổn định trong phạm vi 20 mét (tầm nhìn thẳng không vật cản) giúp bạn thoải mái sáng tạo nội dung ngoài trời, quay vlog dã ngoại, du lịch hay phỏng vấn dạo. Tần số 2.4 GHz chống nhiễu hiệu quả, đảm bảo tín hiệu liền mạch suốt buổi ghi hình.',
    image(6, 'Thu âm và livestream ngoài trời tiện lợi cùng GAERU K9', 701, 1024),
    'CƠ ĐỘNG NGOÀI TRỜI'
  )}

  ${section(
    'Ứng dụng mọi tình huống.<br>Đáp ứng trọn vẹn mọi nhu cầu thu âm thực tế.',
    'Dù bạn là nhà sáng tạo nội dung, người bán hàng online, phóng viên, giáo viên hay người yêu thích ghi lại nhật ký video, GAERU K9 đều đáp ứng linh hoạt: từ livestream ngoài trời, phát sóng trực tiếp tại studio, phỏng vấn ghi hình hai người, đến quay vlog cá nhân hay dạy học trực tuyến.',
    image(7, 'Ứng dụng đa dạng trong mọi tình huống của micro GAERU K9', 733, 1024),
    'LINH HOẠT MỌI TÌNH HUỐNG'
  )}

  <section class="k9-chapter k9-specs" id="product-specs">
    <header>
      <p class="eyebrow">CHI TIẾT THIẾT BỊ</p>
      <h3>Thông số kỹ thuật GAERU K9.</h3>
      <p>Thông số kỹ thuật chuẩn xác theo tài liệu GAERU. Thời lượng pin và khoảng cách truyền tín hiệu thực tế có thể thay đổi tùy thuộc vào môi trường sử dụng.</p>
    </header>
    <dl>
      ${specs.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')}
    </dl>
    <div class="k9-specs-footer">
      <p>Thiết kế nhỏ gọn, dễ dàng mang theo bất cứ nơi đâu. Đối chiếu cổng kết nối của thiết bị để lựa chọn đúng phiên bản Type-C hoặc Lightning.</p>
      <a class="text-link" href="/huong-dan/gaeru-k9">Hướng dẫn sử dụng GAERU K9 ↗</a>
    </div>
  </section>
</div>`;
}

renderK9.content = function () {
  const paragraphs = [
    'Bắt trọn giọng nói. Tự do kết nối không dây.\nGAERU K9 mang đến trải nghiệm thu âm không dây tinh gọn và hiệu quả vượt trội. Với công nghệ kết nối tự động "Cắm là dùng", bán kính thu sóng ổn định 20 mét và màng thu 360° khử nhiễu thông minh, K9 là trợ thủ hoàn hảo cho livestream bán hàng, vlog, phỏng vấn và giảng dạy trực tuyến.',
    'Tự do không dây vướng víu. Tự động kết nối • Cắm là dùng.\nKhông còn nỗi lo vướng víu bởi dây nối rườm rà hay thao tác ghép đôi Bluetooth phức tạp. GAERU K9 ứng dụng cơ chế cắm là dùng (Plug & Play) thông minh: chỉ cần cắm đầu thu vào điện thoại và bật nguồn micro, bộ đôi sẽ tự động đồng bộ tần số không dây 2.4 GHz ngay lập tức. Sẵn sàng bắt đầu buổi livestream hay ghi hình mọi lúc, mọi nơi.',
    'Thu âm 360° toàn hướng. Không góc chết, trọn vẹn từng dải âm.\nTrang bị capsule độ nhạy cao thu âm đa hướng 360 độ, GAERU K9 ghi lại giọng nói rõ ràng từ mọi phía mà không yêu cầu người dùng phải hướng trực diện vào micro. Kết hợp cùng bông lọc mút xốp mật độ cao chống rè và chip xử lý âm thanh kỹ thuật số, thiết bị giảm thiểu tối đa tiếng gió và tạp âm môi trường, mang lại âm thanh trong trẻo, chân thực.',
    'Chi tiết sản phẩm tỉ mỉ. Bền bỉ, công thái học trong từng chi tiết.\nTừng chi tiết của GAERU K9 được chăm chút kỹ lưỡng: kẹp cài áo răng cưa chắc chắn giúp cố định micro vững vàng trên trang phục; bông lọc gió mút xốp đàn hồi cao ngăn ngừa hiện tượng vỡ tiếng; và đầu thu tín hiệu bo cong nhỏ gọn, truyền tải âm thanh không suy hao qua giao diện kết nối kỹ thuật số.',
    'Tương thích đa thiết bị. Điện thoại, máy tính bảng và laptop.\nGAERU K9 hỗ trợ kết nối rộng rãi với hầu hết các dòng điện thoại thông minh, máy tính bảng, iPad, laptop và máy tính để bàn phổ biến hiện nay. Dù bạn sử dụng cổng Type-C hiện đại hay cổng Lightning truyền thống, thiết bị đều nhận diện nhanh chóng mà không cần thêm đầu chuyển rườm rà. Dễ dàng chuyển đổi linh hoạt giữa các thiết bị làm việc và sáng tạo nội dung hàng ngày.',
    'Trợ thủ livestream đắc lực. Tối ưu cho bán hàng và sáng tạo nội dung.\nÂm thanh rõ ràng quyết định thành công của một buổi bán hàng trực tiếp hay sản xuất video ngắn. GAERU K9 giúp người dẫn live tự do tương tác, di chuyển và giới thiệu sản phẩm mà giọng nói vẫn truyền đến người xem to rõ và sống động. Tương thích hoàn hảo với các nền tảng phát sóng trực tiếp phổ biến hiện nay.',
    'Thu âm & Livestream ngoài trời tiện lợi. Sóng xa 20 mét, tự tin sải bước.\nThiết kế siêu nhẹ chỉ khoảng 7 gram cùng khả năng truyền sóng ổn định trong phạm vi 20 mét (tầm nhìn thẳng không vật cản) giúp bạn thoải mái sáng tạo nội dung ngoài trời, quay vlog dã ngoại, du lịch hay phỏng vấn dạo. Tần số 2.4 GHz chống nhiễu hiệu quả, đảm bảo tín hiệu liền mạch suốt buổi ghi hình.',
    'Ứng dụng mọi tình huống. Đáp ứng trọn vẹn mọi nhu cầu thu âm thực tế.\nDù bạn là nhà sáng tạo nội dung, người bán hàng online, phóng viên, giáo viên hay người yêu thích ghi lại nhật ký video, GAERU K9 đều đáp ứng linh hoạt: từ livestream ngoài trời, phát sóng trực tiếp tại studio, phỏng vấn ghi hình hai người, đến quay vlog cá nhân hay dạy học trực tuyến.',
    'Thông số kỹ thuật GAERU K9\nThu âm đa hướng 360° · Sóng không dây 2.4 GHz · Độ trễ < 15ms · Khoảng cách xa 20m.\nLọc ồn thông minh DSP & mút xốp mật độ cao · Pin 6-8 giờ · Cổng sạc Type-C · Trọng lượng ~7g.\nĐầu thu Type-C hoặc Lightning tùy chọn theo cổng điện thoại. Phù hợp cho 1 hoặc 2 người nói.'
  ];

  const entries = [
    [1, 1, 'GAERU K9: 6 Điểm nổi bật cốt lõi của micro thu âm không dây'],
    [2, 2, 'Tự do không dây, tự động kết nối cắm là dùng'],
    [3, 3, 'Thu âm 360 độ toàn hướng không góc chết'],
    [4, 4, 'Chi tiết cấu tạo kẹp cài áo, bông lọc gió và đầu thu GAERU K9'],
    [8, 5, 'GAERU K9 tương thích đa thiết bị: điện thoại, máy tính bảng, laptop'],
    [5, 6, 'Trợ thủ livestream chuyên nghiệp cho điện thoại, máy tính, máy ảnh'],
    [6, 7, 'Thu âm và livestream ngoài trời tiện lợi với khoảng cách 20 mét'],
    [7, 8, 'Ứng dụng đa dạng trong mọi tình huống thực tế']
  ];

  return {
    description: paragraphs.join('\n\n'),
    descriptionMedia: entries.map(([n, afterParagraph, alt]) => ({
      type: 'image',
      url: `/assets/products/k9-description/${n}.webp`,
      alt,
      caption: '',
      afterParagraph
    }))
  };
};

renderK9.isLegacyDescription = function (value) {
  return typeof value === 'string' && /^MIC CÀI ÁO GAERU K9/i.test(value);
};

if (typeof module === 'object' && module.exports) module.exports = renderK9;
