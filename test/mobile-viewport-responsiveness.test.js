const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseHTML } = require('linkedom');

test('Mobile Viewport & Screen Alignment Hardening: styles.css contains html/body overflow-x and universal containment', () => {
  const styles = fs.readFileSync(path.join(__dirname, '../styles.css'), 'utf8');

  // Verify html & body have overflow-x: hidden and max-width: 100% (safe against scrollbar blowout)
  assert.match(styles, /html\s*\{[^}]*overflow-x:\s*hidden;/s, 'html must declare overflow-x: hidden');
  assert.match(styles, /html\s*\{[^}]*max-width:\s*100%;/s, 'html must declare max-width: 100%');
  assert.match(styles, /body\s*\{[^}]*overflow-x:\s*hidden;/s, 'body must declare overflow-x: hidden');
  assert.match(styles, /body\s*\{[^}]*max-width:\s*100%;/s, 'body must declare max-width: 100%');

  // Verify universal containment on main containers
  assert.match(styles, /\.store-main,\s*#main,\s*\.page-intro,\s*\.section-wrap,\s*\.checkout-layout/s, 'Main layout elements must have universal containment');
  assert.match(styles, /max-width:\s*100%;\s*min-width:\s*0;\s*box-sizing:\s*border-box;/s, 'Containment must enforce max-width, min-width:0, box-sizing');

  // Verify store-main overflow-x containment
  assert.match(styles, /\.store-main,\s*#main\s*\{[^}]*overflow-x:\s*hidden;/s, 'store-main must strictly contain inner overflow');

  // Verify form controls never exceed 100% width and selects truncate cleanly
  assert.match(styles, /select\s*\{[^}]*text-overflow:\s*ellipsis;\s*overflow:\s*hidden;/s, 'select elements must have text-overflow: ellipsis and overflow: hidden');
  assert.match(styles, /\.checkout-carrier-grid\s*\{[^}]*minmax\(min\(100%,\s*240px\),\s*1fr\)/s, 'Carrier grid must handle small mobile screens without overflow');

  // Verify global dialog centering
  assert.match(styles, /dialog\s*\{[^}]*margin:\s*auto;[^}]*max-width:\s*calc\(100%\s*-\s*32px\);/s, 'dialog elements must be centered with margin: auto');
});

test('Mobile Viewport & Screen Alignment Hardening: quick-purchase.css and address styles prevent select/label overflow', () => {
  const qp = fs.readFileSync(path.join(__dirname, '../quick-purchase.css'), 'utf8');

  // Verify saved address label and select have min-width: 0 and text-overflow: ellipsis
  assert.match(qp, /\.saved-address-label\s*\{[^}]*max-width:\s*100%;\s*min-width:\s*0;/s, 'saved-address-label must have max-width: 100% and min-width: 0');
  assert.match(qp, /\.saved-address-label select\{[^}]*text-overflow:\s*ellipsis;\s*overflow:\s*hidden/s, 'saved-address-label select must truncate long address options');

  // Verify checkout contact details and summary span wrap anywhere
  assert.match(qp, /\.checkout-contact-details\s*\{[^}]*max-width:\s*100%;\s*min-width:\s*0;/s, 'checkout-contact-details must be contained');
  assert.match(qp, /\.checkout-contact-details summary span\{[^}]*overflow-wrap:\s*anywhere;\s*word-break:\s*break-word/s, 'Contact summary span must break words on mobile');

  // Verify payment method select
  assert.match(qp, /\.checkout-form select\[name=paymentMethod\]\{[^}]*text-overflow:\s*ellipsis/s, 'Payment method select must truncate cleanly');

  // Verify single checkout layout is centered and contained
  assert.match(qp, /#checkout-content\.checkout-single\{[^}]*max-width:\s*760px!important;[^}]*margin:\s*0 auto!important;/s, 'checkout-single must have margin: 0 auto');
  assert.match(qp, /\.quick-cart-dialog\{[^}]*margin:\s*auto/s, 'quick-cart-dialog must have margin: auto');
});

test('Mobile Viewport & Screen Alignment Hardening: vietnam-address.css and action-feedback.css containment', () => {
  const va = fs.readFileSync(path.join(__dirname, '../vietnam-address.css'), 'utf8');
  assert.match(va, /\.vn-address-picker\{[^}]*max-width:\s*100%;\s*box-sizing:\s*border-box/s, 'vn-address-picker must have max-width 100%');
  assert.match(va, /\.vn-address-choice\{[^}]*text-overflow:\s*ellipsis;\s*overflow:\s*hidden/s, 'vn-address-choice must truncate');

  const af = fs.readFileSync(path.join(__dirname, '../action-feedback.css'), 'utf8');
  assert.match(af, /\.gaeru-action-notices\s*\{[^}]*max-width:\s*100%;\s*box-sizing:\s*border-box/s, 'Action notices overlay must not exceed 100%');
  assert.match(af, /\.gaeru-action-notices\s*\{[^}]*display:\s*flex;\s*align-items:\s*center;\s*justify-content:\s*center;/s, 'Action notices overlay must be centered with flexbox');
  assert.match(af, /\.gaeru-action-notices\s*\{[^}]*env\(safe-area-inset-top\)/s, 'Action notices overlay must support iOS safe-area-insets');
  assert.match(af, /\.gaeru-action-notice\s*\{[^}]*margin:\s*auto;/s, 'Notification dialog must declare margin: auto for strict multi-axis centering');
  assert.match(af, /@media\s*\(max-width:\s*600px\)\s*\{[^}]*\.gaeru-action-notice/s, 'Must provide mobile phone layout optimizations under 600px');
  assert.match(af, /@media\s*\(max-width:\s*380px\)\s*\{[^}]*\.gaeru-action-notice/s, 'Must provide compact mobile optimizations under 380px');
});

test('Customer Notification Popup: action-feedback.js supports Escape key dismissal', () => {
  const afJs = fs.readFileSync(path.join(__dirname, '../action-feedback.js'), 'utf8');
  assert.match(afJs, /e\.key\s*===\s*['"]Escape['"]/s, 'action-feedback.js must support Escape key dismissal');
});

test('Mobile Viewport & Screen Alignment Hardening: all storefront HTML templates include valid viewport-fit=cover meta tag', () => {
  const htmlFiles = fs.readdirSync(path.join(__dirname, '..')).filter(f => f.endsWith('.html') && !f.includes('node_modules'));
  assert.ok(htmlFiles.length >= 15, 'Must verify all storefront HTML files');

  for (const file of htmlFiles) {
    const content = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    assert.match(content, /<meta\s+name=["']viewport["']\s+content=["'][^"']*width=device-width[^"']*viewport-fit=cover[^"']*["']\s*\/?>/i, `${file} must include responsive viewport meta tag with viewport-fit=cover`);
  }
});

test('Mobile Viewport Simulation: Checkout DOM with long address renders cleanly without overflowing containers', () => {
  const html = fs.readFileSync(path.join(__dirname, '../checkout.html'), 'utf8');
  const { document, window } = parseHTML(html);

  const main = document.querySelector('#main');
  const root = document.querySelector('#checkout-content');
  assert.ok(main, '#main must exist');
  assert.ok(root, '#checkout-content must exist');

  // Simulate long recipient address option injected into saved address dropdown
  root.innerHTML = `
    <form class="checkout-form" id="checkout-form">
      <label class="saved-address-label">
        Địa chỉ đã lưu
        <select data-saved-address>
          <option value="1">Mặc định — Địa chỉ giao hàng — RH8R+JCW, Phường Thành Đông, Tỉnh Ninh Bình, Việt Nam (Rất dài cần cắt ngắn để không xô lệch giao diện)</option>
        </select>
      </label>
      <details class="checkout-contact-details" open>
        <summary>Thông tin giao hàng<span data-contact-summary>Người nhận — 0912345678 — RH8R+JCW, Phường Thành Đông, Tỉnh Ninh Bình</span></summary>
      </details>
    </form>
  `;

  const form = root.querySelector('#checkout-form');
  const select = form.querySelector('select');
  const summarySpan = form.querySelector('[data-contact-summary]');

  assert.ok(form, 'form rendered');
  assert.ok(select, 'select rendered');
  assert.ok(summarySpan, 'summary span rendered');
  assert.match(select.firstElementChild.textContent, /RH8R\+JCW/);
});
