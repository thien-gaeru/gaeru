'use strict';

const SITE_FOOTER_HTML = `<footer class="site-footer">
      <div class="footer-main">
        <div class="footer-brand">
          <a class="wordmark" href="/"><span class="brand-window"><picture><source srcset="/assets/brand/gaeru-logo.webp" type="image/webp"><img class="brand-logo" src="/assets/brand/gaeru-logo.png" alt="GAERU" width="375" height="375" loading="lazy" decoding="async"></picture></span></a>
          <p>Nhỏ gọn để bắt đầu.<br>Tự do để sáng tạo.</p>
        </div>
        <details class="footer-column" open>
          <summary>Khám phá GAERU</summary>
          <div class="footer-links" data-footer-products data-footer-signature="[[&quot;gaeru-m3&quot;,&quot;GAERU M3&quot;],[&quot;gaeru-k9&quot;,&quot;GAERU K9&quot;],[&quot;gaeru-p185&quot;,&quot;GAERU P185&quot;],[&quot;gaeru-p01&quot;,&quot;GAERU P01&quot;],[&quot;gaeru-g1-ultra&quot;,&quot;GAERU G1 ULTRA&quot;]]"><a href="/cua-hang">Cửa hàng</a><a href="/san-pham/gaeru-m3">GAERU M3</a><a href="/san-pham/gaeru-k9">GAERU K9</a><a href="/san-pham/gaeru-p185">GAERU P185</a><a href="/san-pham/gaeru-p01">GAERU P01</a><a href="/san-pham/gaeru-g1-ultra">GAERU G1 ULTRA</a></div>
        </details>
        <details class="footer-column" open>
          <summary>Hỗ trợ &amp; tài khoản</summary>
          <div class="footer-links">
            <a href="/care">GAERU Care+</a>
            <a href="/ho-tro#guide">Hướng dẫn</a>
            <a href="/ho-tro">Trung tâm hỗ trợ</a>
            <a href="/tra-cuu-don-hang">Tra cứu đơn hàng</a>
            <a href="/tai-khoan">Tài khoản</a>
          </div>
        </details>
        <details class="footer-column" open>
          <summary>Về GAERU</summary>
          <div class="footer-links">
            <a href="/cau-chuyen">Câu chuyện GAERU</a>
          </div>
        </details>
        <div class="footer-column footer-newsletter-column">
          <span class="footer-column-heading">Bản tin GAERU</span>
          <p class="footer-newsletter-note">Cập nhật sản phẩm &amp; ưu đãi mới nhất.</p>
          <form class="footer-newsletter-compact-form" data-newsletter-form data-source="web_footer">
            <div class="footer-newsletter-field">
              <input type="email" name="email" class="footer-newsletter-compact-input" placeholder="Nhập địa chỉ email" required maxlength="254" autocomplete="email">
              <button type="submit" class="footer-newsletter-compact-submit" aria-label="Đăng ký nhận tin">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
              </button>
            </div>
            <label class="footer-newsletter-consent">
              <input type="checkbox" name="consent" required>
              <span>Tôi đồng ý nhận email từ GAERU.</span>
            </label>
            <div class="footer-newsletter-feedback" data-newsletter-feedback role="status" aria-live="polite"></div>
          </form>
        </div>
      </div>
      <div class="footer-help">
        <p>Cần hỗ trợ? <button type="button" class="chat-product-button footer-chat-link" data-product-chat="">Chat ngay ↗</button>, email <a href="mailto:business@gaeru.com">business@gaeru.com</a> hoặc gọi <a href="tel:0829191080">082 919 1080</a>. Giờ hỗ trợ: Thứ Hai–Thứ Sáu 10:00–17:00, cuối tuần và ngày lễ 10:00–16:00.</p>
      </div>
      <div class="footer-bottom">
        <span class="footer-region">Việt Nam</span>
        <div class="footer-legal">
          <span>Bản quyền GAERU © 2026 · GAERU HOUSEHOLD BUSINESS (GAERU)</span>
          <nav aria-label="Chính sách và pháp lý">
            <a href="/chinh-sach/quyen-rieng-tu">Chính sách quyền riêng tư</a>
            <a href="/chinh-sach/dieu-khoan">Điều khoản sử dụng</a>
            <a href="/chinh-sach/gia">Chính sách giá</a>
            <a href="/chinh-sach/thanh-toan">Chính sách thanh toán</a>
            <a href="/chinh-sach/giao-hang-doi-tra">Bán hàng và hoàn tiền</a>
            <a href="/khieu-nai">Giải quyết khiếu nại</a>
            <a href="/phap-ly">Pháp lý</a>
            <a href="/so-do-trang-web">Sơ đồ trang web</a>
          </nav>
        </div>
        <p class="footer-business-info">
          HỘ KINH DOANH GAERU (GAERU HOUSEHOLD BUSINESS) · Mã số đăng ký &amp; Mã số thuế: 8836293843-002 do Phòng Kinh tế UBND Xã Rạng Đông cấp ngày 05/01/2024.<br>
          Địa chỉ: Thôn 2, Xã Rạng Đông, Tỉnh Ninh Bình · Hotline: 082 919 1080 · Email: business@gaeru.com<br>
          Website thương mại điện tử bán hàng tuân thủ Nghị định 52/2013/NĐ-CP và Nghị định 85/2021/NĐ-CP.
        </p>
      </div>
    </footer>`;

module.exports = { SITE_FOOTER_HTML };
