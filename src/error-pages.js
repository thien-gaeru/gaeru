'use strict';

function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[ch]));
}

function renderStorefrontErrorHtml(options) {
  const opts = options || {};
  const code = Number.isInteger(opts.status) ? opts.status : 404;
  const isUnavailable = code >= 500;
  const defaultEyebrow = code === 503
    ? '503 · TẠM THỜI GIÁN ĐOẠN'
    : (code === 400 ? '400 · YÊU CẦU KHÔNG HỢP LỆ' : (code + ' · KHÔNG TÌM THẤY TRANG'));
  const defaultTitle = code === 503
    ? 'Tạm thời chưa tải được nội dung'
    : (code === 400 ? 'Trang yêu cầu không hợp lệ' : 'Không tìm thấy trang bạn đang tìm');
  const defaultMessage = code === 503
    ? 'Hệ thống đang bận hoặc đang đồng bộ dữ liệu. Vui lòng thử lại sau ít phút hoặc gọi hotline 082 919 1080 để được tư vấn trực tiếp.'
    : (code === 400
      ? 'Đường dẫn hoặc tham số truy cập chưa hợp lệ. Vui lòng kiểm tra lại hoặc chọn một mục bên dưới để tiếp tục.'
      : 'Đường dẫn có thể đã được cập nhật hoặc không tồn tại trên hệ thống GAERU. Hãy chọn một điểm đến bên dưới để tiếp tục mua sắm và tra cứu.');

  const resolvedEyebrow = String(opts.eyebrow || defaultEyebrow).trim();
  const resolvedTitle = String(opts.title || defaultTitle).trim();
  const resolvedMessage = String(opts.message || defaultMessage).trim();
  const extraLinks = Array.isArray(opts.extraLinks) ? opts.extraLinks : [];

  const outlineItems = [
    { href: '/cua-hang', label: 'Cửa hàng' },
    { href: '/tra-cuu-don-hang', label: 'Tra cứu đơn hàng' },
    { href: '/ho-tro', label: 'Hỗ trợ' }
  ];
  for (let i = 0; i < extraLinks.length; i += 1) {
    const item = extraLinks[i];
    if (item && typeof item.href === 'string' && typeof item.label === 'string' && !outlineItems.some((x) => x.href === item.href)) {
      outlineItems.push({ href: item.href, label: item.label });
    }
  }

  const badgeClass = isUnavailable ? 'storefront-error-badge is-warning' : 'storefront-error-badge';
  const outlineHtml = outlineItems
    .map((item) => '<a class="button button-outline storefront-error-secondary" href="' + escapeHtml(item.href) + '">' + escapeHtml(item.label) + '</a>')
    .join('');

  return '<!doctype html>' +
    '<html lang="vi">' +
    '<head>' +
    '<meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<meta name="robots" content="noindex">' +
    '<meta name="theme-color" content="#fbfbfd">' +
    '<meta name="description" content="' + escapeHtml(resolvedMessage) + '">' +
    '<title>' + escapeHtml(resolvedTitle) + ' — GAERU</title>' +
    '<link rel="icon" type="image/webp" href="/assets/brand/gaeru-logo.webp">' +
    '<link rel="apple-touch-icon" href="/assets/brand/gaeru-app-192.png">' +
    '<link rel="stylesheet" href="/styles.css">' +
    '<link rel="stylesheet" href="/brand.css">' +
    '<link rel="stylesheet" href="/typography.css">' +
    '<style>' +
    'body.storefront-error-page{background:#f5f5f7;color:#1d1d1f;color-scheme:light;margin:0;}' +
    '.storefront-error-main{min-height:68vh;display:flex;align-items:center;justify-content:center;padding:56px 20px 72px;box-sizing:border-box;}' +
    '.storefront-error-card{width:100%;max-width:600px;background:#ffffff;border:1px solid rgba(0, 0, 0, 0.08);border-radius:24px;padding:48px 40px;text-align:center;box-shadow:0 12px 36px rgba(0, 0, 0, 0.05);box-sizing:border-box;}' +
    '.storefront-error-badge{display:inline-flex;align-items:center;justify-content:center;padding:5px 14px;border-radius:999px;font-size:12px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;background:rgba(0, 113, 227, 0.09);color:#0060c7;margin:0 0 18px;}' +
    '.storefront-error-badge.is-warning{background:rgba(217, 119, 6, 0.12);color:#b45309;}' +
    '.storefront-error-card h1{font-size:clamp(26px, 4vw, 34px);line-height:1.18;letter-spacing:-0.025em;font-weight:700;color:#1d1d1f;margin:0 0 14px;}' +
    '.storefront-error-message{font-size:16px;line-height:1.62;color:#515154;max-width:48ch;margin:0 auto 28px;}' +
    '.storefront-error-primary-row{display:flex;justify-content:center;margin:0 0 14px;}' +
    '.storefront-error-primary{min-width:190px;min-height:46px;padding:11px 28px;border-radius:999px;font-size:15px;font-weight:600;text-decoration:none;display:inline-flex;align-items:center;justify-content:center;background:#0071e3;color:#ffffff;border:1px solid #0071e3;}' +
    '.storefront-error-primary:hover{background:#0077ed;border-color:#0077ed;}' +
    '.storefront-error-links{display:flex;flex-wrap:wrap;justify-content:center;gap:10px;margin:0 0 24px;}' +
    '.storefront-error-secondary{min-height:40px;padding:8px 18px;border-radius:999px;font-size:14px;font-weight:500;text-decoration:none;display:inline-flex;align-items:center;justify-content:center;border:1px solid #d2d2d7;background:#ffffff;color:#1d1d1f;}' +
    '.storefront-error-secondary:hover{border-color:#0060c7;color:#0060c7;background:#f5faff;}' +
    '.storefront-error-help{margin:0;padding-top:20px;border-top:1px solid #f0f0f3;font-size:13.5px;line-height:1.5;color:#6e6e73;}' +
    '.storefront-error-help a{color:#0060c7;text-decoration:none;font-weight:600;}' +
    '.storefront-error-help a:hover{text-decoration:underline;}' +
    '@media (max-width: 560px){.storefront-error-main{padding:32px 14px 48px;}.storefront-error-card{padding:32px 20px;border-radius:24px;}.storefront-error-primary{width:100%;}.storefront-error-links{gap:8px;}.storefront-error-secondary{flex:1 1 calc(50% - 8px);padding:8px 12px;font-size:13.5px;}}' +
    '</style>' +
    '<script src="/customer-session.js" defer></script>' +
    '<script src="/footer-products.js" defer></script>' +
    '<script src="/store-shell.js" defer></script>' +
    '</head>' +
    '<body class="storefront-error-page">' +
    '<a class="skip-link" href="#main">Bỏ qua điều hướng</a>' +
    '<div id="site-header"></div>' +
    '<main id="main" class="store-main storefront-error-main">' +
    '<section class="storefront-error-card" aria-labelledby="storefront-error-heading">' +
    '<span class="' + badgeClass + '">' + escapeHtml(resolvedEyebrow) + '</span>' +
    '<h1 id="storefront-error-heading">' + escapeHtml(resolvedTitle) + '</h1>' +
    '<p class="storefront-error-message">' + escapeHtml(resolvedMessage) + '</p>' +
    '<div class="storefront-error-primary-row"><a class="button button-blue storefront-error-primary" href="/">Về trang chủ</a></div>' +
    '<nav class="storefront-error-links" aria-label="Điều hướng nhanh">' + outlineHtml + '</nav>' +
    '<p class="storefront-error-help">Cần hỗ trợ trực tiếp? Gọi <a href="tel:0829191080">082 919 1080</a> hoặc gửi thư tới <a href="mailto:business@gaeru.com">business@gaeru.com</a>.</p>' +
    '</section>' +
    '</main>' +
    '<div id="site-footer"></div>' +
    '</body>' +
    '</html>';
}

module.exports = { renderStorefrontErrorHtml };
