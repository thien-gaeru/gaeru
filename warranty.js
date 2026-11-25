(() => {
  const section = document.querySelector('#warranty-activation');
  if (!section) return;
  const isStandalone = section.dataset?.standalone === 'true';
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const queryAll = (root, sel) => (root && typeof root.querySelectorAll === 'function') ? Array.prototype.slice.call(root.querySelectorAll(sel)) : [];
  const normSearch = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/đ/g, 'd').trim();
  const channels = { website: 'Website GAERU', shopee: 'Shopee', tiktok: 'TikTok Shop', lazada: 'Lazada' };
  const channelPlaceholders = {
    shopee: 'Nhập hoặc dán mã đơn Shopee (VD: 261125ABCXYZ)',
    tiktok: 'Nhập hoặc dán mã đơn TikTok Shop',
    lazada: 'Nhập hoặc dán mã đơn Lazada',
    website: 'Nhập mã đơn Website GAERU (VD: GA-2026...)'
  };
  // 34 province-level units under Resolution 202/2025/QH15.
  const provinces = ['Hà Nội', 'Hải Phòng', 'Huế', 'Đà Nẵng', 'Hồ Chí Minh', 'Cần Thơ', 'An Giang', 'Bắc Ninh', 'Cà Mau', 'Cao Bằng', 'Đắk Lắk', 'Điện Biên', 'Đồng Nai', 'Đồng Tháp', 'Gia Lai', 'Hà Tĩnh', 'Hưng Yên', 'Khánh Hòa', 'Lai Châu', 'Lâm Đồng', 'Lạng Sơn', 'Lào Cai', 'Nghệ An', 'Ninh Bình', 'Phú Thọ', 'Quảng Ngãi', 'Quảng Ninh', 'Quảng Trị', 'Sơn La', 'Tây Ninh', 'Thái Nguyên', 'Thanh Hóa', 'Tuyên Quang', 'Vĩnh Long'].sort((a, b) => a.localeCompare(b, 'vi'));
  const cityKey = value => normSearch(value).replace(/^(?:tinh|thanh pho|tp)\.?\s*/, '').trim();
  const formatDateVN = offsetDays => {
    const d = new Date(Date.now() + (offsetDays || 0) * 86400000);
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  };
  const todayStr = formatDateVN(0);

  let catalogItems = [
    { slug: 'gaeru-m3', shortName: 'M3', name: 'GAERU M3', image: '/assets/products/m3-home-cutout.webp', variants: ['Type C', 'Type C + đầu chuyển Lightning', 'Type C + chuyển USB', 'Type C + chuyển Micro usb'] },
    { slug: 'gaeru-k9', shortName: 'K9', name: 'GAERU K9', image: '/assets/products/k9.webp', variants: ['Bộ 2 Mic · Type-C', 'Bộ 2 Mic · Lightning', 'Bộ 1 Mic · Type-C', 'Bộ 1 Mic · Lightning'] },
    { slug: 'gaeru-g1-ultra', shortName: 'G1 Ultra', name: 'GAERU G1 ULTRA', image: '/assets/products/g1-ultra-clean.webp', variants: [] },
    { slug: 'gaeru-p01', shortName: 'P01', name: 'GAERU P01', image: '/assets/products/p01.webp', variants: ['Bản để bàn', 'Kèm chân Tripod 2m1'] },
    { slug: 'gaeru-p185', shortName: 'P185', name: 'GAERU P185', image: '/assets/products/p185-cutout-1cc9dfde9fa3.webp', variants: [] }
  ];

  const defaultChannel = isStandalone ? 'shopee' : 'website';

  section.innerHTML = `
    <details class="care-surface warranty-surface care-disclosure warranty-quick-shell" data-w-disclosure>
      <summary><div><p class="eyebrow">GAERU CARE+</p><h2>Kích hoạt bảo hành</h2></div><span aria-hidden="true">+</span></summary>
      <div class="care-disclosure-body">
        <div class="w-top-bar">
          <p class="w-session-pill" data-w-session role="status">Đăng ký nhanh không cần tài khoản · Bảo hành 12 tháng</p>
        </div>
        <form id="warranty-form" class="w-compact-form">
          <div class="w-step-block">
            <span class="w-step-label" id="w-channel-heading">1. Kênh mua hàng</span>
            <div class="w-channel-pills" role="group" aria-labelledby="w-channel-heading" data-w-channel-pills>
              <button type="button" class="w-channel-pill${defaultChannel === 'shopee' ? ' is-active' : ''}" data-w-pill="shopee" aria-pressed="${defaultChannel === 'shopee'}"><span class="w-pill-dot is-shopee" aria-hidden="true"></span>Shopee</button>
              <button type="button" class="w-channel-pill" data-w-pill="tiktok" aria-pressed="false"><span class="w-pill-dot is-tiktok" aria-hidden="true"></span>TikTok</button>
              <button type="button" class="w-channel-pill" data-w-pill="lazada" aria-pressed="false"><span class="w-pill-dot is-lazada" aria-hidden="true"></span>Lazada</button>
              <button type="button" class="w-channel-pill${defaultChannel === 'website' ? ' is-active' : ''}" data-w-pill="website" aria-pressed="${defaultChannel === 'website'}"><span class="w-pill-dot is-website" aria-hidden="true"></span>Website</button>
            </div>
            <label class="w-sr-only">Nơi mua hàng<select name="source" required tabindex="-1">
              <option value="account" disabled>Đơn trong tài khoản GAERU</option>
              <option value="website"${defaultChannel === 'website' ? ' selected' : ''}>Đơn website chưa có trong tài khoản</option>
              <option value="shopee"${defaultChannel === 'shopee' ? ' selected' : ''}>Shopee</option>
              <option value="tiktok">TikTok Shop</option>
              <option value="lazada">Lazada</option>
            </select></label>
          </div>

          <fieldset data-w-account hidden disabled class="w-account-box">
            <legend>Đơn mua trên gaeru.com</legend>
            <div class="w-auto-banner">
              <strong>✓ Kích hoạt tự động 12 tháng:</strong> Đơn đặt trên website GAERU tự động kích hoạt bảo hành ngay khi giao thành công và thanh toán đủ (không cần gửi đăng ký lại).
              <button type="button" class="w-inline-link" data-w-manual-web>Nhập mã đơn đặt không đăng nhập →</button>
            </div>
            <div class="warranty-fieldset-body">
              <label>Kiểm tra đơn trong tài khoản<select name="orderId" required><option value="">Chọn đơn của bạn</option></select></label>
              <label>Sản phẩm trong đơn<select name="orderItemId" required disabled><option value="">Chọn đơn hàng trước</option></select></label>
            </div>
            <button type="button" class="care-plain" data-w-orders hidden>Tải thêm đơn hàng</button>
          </fieldset>

          <fieldset data-w-external class="w-external-fieldset">
            <legend class="w-sr-only">Thông tin sản phẩm và mã đơn</legend>
            <div class="w-step-block w-prod-combo" data-w-combobox>
              <label for="w-product-input" class="w-step-label">2. Chọn thiết bị đã mua</label>
              <div class="w-combo-input-wrap">
                <input
                  id="w-product-input"
                  name="productName"
                  minlength="2"
                  maxlength="200"
                  autocomplete="off"
                  role="combobox"
                  aria-autocomplete="list"
                  aria-expanded="false"
                  aria-controls="w-prod-listbox"
                  placeholder="Chọn từ danh sách, gõ tìm kiếm hoặc tự nhập tên sản phẩm…"
                  required>
                <button type="button" class="w-combo-clear" data-w-combo-clear title="Xóa để chọn lại" aria-label="Xóa tên thiết bị" hidden>×</button>
                <button type="button" class="w-combo-toggle" data-w-combo-toggle title="Mở danh sách thiết bị" aria-label="Danh sách thiết bị" tabindex="-1">
                  <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 6l4 4 4-4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
                </button>
              </div>
              <div id="w-prod-listbox" class="w-prod-dropdown" role="listbox" aria-label="Danh sách thiết bị GAERU" data-w-prod-menu hidden></div>
            </div>

            <div class="w-core-grid">
              <label class="w-order-field">
                <span data-w-order-label>3. Mã đơn hàng Shopee</span>
                <div class="w-input-action-wrap">
                  <input name="externalOrderNumber" minlength="3" maxlength="100" autocomplete="off" placeholder="${escape(channelPlaceholders[defaultChannel] || channelPlaceholders.shopee)}" required>
                  <button type="button" class="w-paste-btn" data-w-paste title="Dán mã đơn từ bộ nhớ tạm">Dán</button>
                </div>
              </label>
            </div>
          </fieldset>

          <fieldset class="warranty-contact w-contact-fieldset" data-w-contact-fieldset>
            <legend class="w-step-label">4. Thông tin bảo hành</legend>
            <div class="warranty-contact-row w-compact-row">
              <label>Họ và tên<input name="fullName" minlength="2" maxlength="120" autocomplete="name" placeholder="Nguyễn Văn A" required></label>
              <label>Số điện thoại<input name="phone" type="tel" minlength="10" maxlength="20" autocomplete="tel" placeholder="09xxxxxxxx (10 số)" required></label>
            </div>
          </fieldset>

          <details class="w-optional-details" data-w-optional>
            <summary class="w-optional-summary">
              <span>Bổ sung Email nhận chứng nhận, Ngày mua hoặc Địa chỉ</span>
              <span class="w-optional-badge">Tùy chọn</span>
            </summary>
            <div class="w-optional-body">
              <div class="warranty-contact-row w-compact-row">
                <label>Email nhận thông báo<input name="email" type="email" maxlength="254" autocomplete="email" placeholder="Không bắt buộc (nhận chứng nhận qua email)"></label>
                <label>
                  <span class="w-date-label-row"><span>Ngày mua trên đơn</span><span class="w-date-shortcuts"><button type="button" data-w-date-quick="0">Hôm nay</button><button type="button" data-w-date-quick="-1">Hôm qua</button></span></span>
                  <input name="purchaseDate" type="date" min="2000-01-01" max="${todayStr}">
                </label>
              </div>
              <div class="warranty-contact-row w-compact-row">
                <label>Địa chỉ liên hệ<input name="address" maxlength="250" autocomplete="street-address" placeholder="Số nhà, đường, phường/xã (tùy chọn)"></label>
                <label>Tỉnh / thành phố<select name="city" autocomplete="address-level1" aria-describedby="warranty-city-note"><option value="">Chọn tỉnh / thành phố</option>${provinces.map(name => `<option value="${escape(name)}">${escape(name)}</option>`).join('')}</select></label>
              </div>
              <p class="care-field-note" id="warranty-city-note" data-w-city-note hidden></p>
            </div>
          </details>

          <div class="w-submit-bar">
            <button class="button button-blue w-submit-btn" type="submit" disabled>Kích hoạt bảo hành ngay</button>
            <button class="care-plain" type="button" data-w-cancel-edit hidden>Hủy sửa</button>
            <span class="w-privacy-hint">Bảo mật theo <a href="privacy.html">chính sách riêng tư</a>.</span>
          </div>
          <p role="status" aria-live="polite" data-w-status class="w-status-line"></p>
        </form>
      </div>
    </details>
    <div class="care-surface warranty-history" data-w-history hidden>
      <div class="w-history-head">
        <h3>Hồ sơ bảo hành của bạn</h3>
        <button class="care-plain w-refresh-btn" type="button" data-w-page="0">Tải lại</button>
      </div>
      <div data-w-list></div>
      <div class="care-pagination" data-w-pagination hidden>
        <button class="care-plain" type="button" data-w-page="-1" disabled>Trước</button>
        <span data-w-page-label>Trang 1</span>
        <button class="care-plain" type="button" data-w-page="1" disabled>Tiếp</button>
      </div>
    </div>`;

  const disclosure = section.querySelector('[data-w-disclosure]');
  const form = section.querySelector('form');
  const feedback = section.querySelector('[data-w-status]');
  const optionalBox = section.querySelector('[data-w-optional]');
  const comboBox = section.querySelector('[data-w-combobox]');
  const prodMenu = section.querySelector('[data-w-prod-menu]');
  const comboClearBtn = section.querySelector('[data-w-combo-clear]');
  const productInput = form.elements.productName;

  if (isStandalone) disclosure.open = true;
  function openActivation() { disclosure.open = true; }
  function openFromHash() { if (location.hash === '#warranty-activation') openActivation(); }
  window.addEventListener('hashchange', openFromHash);

  let activeComboIdx = -1;
  let lastFilterQuery = '';

  function syncComboClear() {
    if (comboClearBtn) comboClearBtn.hidden = !String(productInput?.value || '').trim();
  }

  function closeComboMenu() {
    if (!prodMenu) return;
    prodMenu.hidden = true;
    activeComboIdx = -1;
    comboBox?.classList?.remove?.('is-open');
    productInput?.setAttribute?.('aria-expanded', 'false');
  }

  function renderComboMenu(filterText) {
    if (!prodMenu) return;
    lastFilterQuery = filterText == null ? '' : String(filterText);
    const currentVal = String(productInput?.value || '').trim();
    const rawTyped = String(filterText || '').trim();
    const tokens = normSearch(rawTyped).split(/\s+/).filter(Boolean);
    const htmlParts = [];
    let exactMatchExists = false;

    for (let i = 0; i < catalogItems.length; i++) {
      const item = catalogItems[i];
      const baseHay = normSearch(item.name + ' ' + item.shortName);
      const itemMatchesAll = tokens.length === 0 || tokens.every(t => baseHay.indexOf(t) !== -1);
      const allVars = Array.isArray(item.variants) ? item.variants : [];
      const matchingVars = tokens.length === 0
        ? allVars
        : allVars.filter(v => {
            const fullHay = normSearch(item.name + ' ' + item.shortName + ' ' + v);
            return tokens.every(t => fullHay.indexOf(t) !== -1);
          });

      if (!itemMatchesAll && matchingVars.length === 0) continue;

      const varsToShow = itemMatchesAll ? allVars : matchingVars;
      const isBaseSelected = currentVal.toLowerCase() === item.name.toLowerCase();
      if (rawTyped && item.name.toLowerCase() === rawTyped.toLowerCase()) exactMatchExists = true;

      let varsHtml = '';
      if (varsToShow.length > 0) {
        varsHtml = `<div class="w-combo-vars">` + varsToShow.map(v => {
          const composed = item.name + ' · ' + v;
          if (rawTyped && composed.toLowerCase() === rawTyped.toLowerCase()) exactMatchExists = true;
          const isVarSel = currentVal.toLowerCase() === composed.toLowerCase();
          return `<button type="button" class="w-combo-var${isVarSel ? ' is-selected' : ''}" role="option" aria-selected="${isVarSel}" data-w-combo-pick="${escape(composed)}">${escape(v)}</button>`;
        }).join('') + `</div>`;
      }

      htmlParts.push(
        `<div class="w-combo-group">` +
          `<button type="button" class="w-combo-option${isBaseSelected ? ' is-selected' : ''}" role="option" aria-selected="${isBaseSelected}" data-w-combo-pick="${escape(item.name)}">` +
            `<img src="${escape(item.image)}" alt="" width="26" height="26" loading="lazy" decoding="async">` +
            `<span class="w-combo-title">${escape(item.name)}</span>` +
            `<span class="w-combo-sub">${varsToShow.length > 0 ? 'Chọn chung hoặc chọn bản bên dưới' : 'Chọn thiết bị'}</span>` +
          `</button>` +
          varsHtml +
        `</div>`
      );
    }

    if (rawTyped.length >= 1 && !exactMatchExists) {
      htmlParts.push(
        `<button type="button" class="w-combo-option is-custom-entry" role="option" aria-selected="false" data-w-combo-pick="${escape(rawTyped)}">` +
          `<span class="w-combo-custom-icon" aria-hidden="true">✎</span>` +
          `<span class="w-combo-title">Dùng tên tự nhập: <strong>${escape(rawTyped)}</strong></span>` +
        `</button>`
      );
    }

    prodMenu.innerHTML = htmlParts.join('') || `<p class="w-combo-empty">Gõ tiếp để tự điền tên sản phẩm của bạn.</p>`;
    activeComboIdx = -1;
  }

  function openComboMenu(filterText) {
    if (!prodMenu) return;
    renderComboMenu(filterText);
    prodMenu.hidden = false;
    comboBox?.classList?.add?.('is-open');
    productInput?.setAttribute?.('aria-expanded', 'true');
  }

  function pickComboValue(val) {
    if (!productInput) return;
    productInput.value = val;
    syncComboClear();
    closeComboMenu();
    if (form.elements.externalOrderNumber && !form.elements.externalOrderNumber.value) {
      form.elements.externalOrderNumber.focus?.();
    }
  }

  function highlightComboOption(delta) {
    const opts = queryAll(prodMenu, '[data-w-combo-pick]');
    if (!opts.length) return;
    activeComboIdx = (activeComboIdx + delta + opts.length) % opts.length;
    opts.forEach((btn, idx) => {
      const act = idx === activeComboIdx;
      btn.classList?.toggle?.('is-active', act);
      if (act) btn.scrollIntoView?.({ block: 'nearest' });
    });
  }

  if (productInput) {
    productInput.addEventListener('focus', () => {
      syncComboClear();
      openComboMenu('');
    });
    productInput.addEventListener('click', () => {
      if (prodMenu?.hidden) openComboMenu('');
    });
    productInput.addEventListener('input', () => {
      syncComboClear();
      openComboMenu(productInput.value);
    });
    productInput.addEventListener('keydown', event => {
      if (event.key === 'ArrowDown') {
        event.preventDefault?.();
        if (prodMenu?.hidden) openComboMenu(productInput.value);
        highlightComboOption(1);
      } else if (event.key === 'ArrowUp') {
        event.preventDefault?.();
        if (prodMenu?.hidden) openComboMenu(productInput.value);
        highlightComboOption(-1);
      } else if (event.key === 'Enter' && prodMenu && !prodMenu.hidden) {
        const opts = queryAll(prodMenu, '[data-w-combo-pick]');
        if (activeComboIdx >= 0 && opts[activeComboIdx]) {
          event.preventDefault?.();
          pickComboValue(opts[activeComboIdx].dataset.wComboPick);
        } else {
          closeComboMenu();
          if (form.elements.externalOrderNumber && !form.elements.externalOrderNumber.value) {
            event.preventDefault?.();
            form.elements.externalOrderNumber.focus?.();
          }
        }
      } else if (event.key === 'Escape' && prodMenu && !prodMenu.hidden) {
        event.preventDefault?.();
        event.stopPropagation?.();
        closeComboMenu();
      } else if (event.key === 'Tab') {
        closeComboMenu();
      }
    });
  }

  prodMenu?.addEventListener?.('mousedown', event => {
    if (event.target?.closest?.('[data-w-combo-pick]')) event.preventDefault?.();
  });

  document.addEventListener('click', event => {
    const direct = event.target?.closest?.('a[href="#warranty-activation"]');
    const link = direct || event.target?.closest?.('a[href$="#warranty-activation"]');
    if (direct || (link && (!link.getAttribute || link.getAttribute('href')?.startsWith('#') || (link.href && new URL(link.href, location.href).pathname === location.pathname)))) openActivation();
    if (prodMenu && !prodMenu.hidden && !event.target?.closest?.('[data-w-combobox]')) closeComboMenu();
  });
  openFromHash();

  window.GAERUAddress?.enhance?.(form);

  let page = 1, orderPage = 1, sequence = 0, key = null, serialized = null, customer = null, editing = null, rows = [];
  let userTouchedOptionalAddress = false;
  let guestTokens = {};
  try { localStorage?.removeItem?.('gaeru-warranty-tokens'); } catch {}
  try {
    const saved = JSON.parse(sessionStorage.getItem('gaeru-warranty-tokens') || '{}');
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
      guestTokens = Object.fromEntries(Object.entries(saved).filter(([id, token]) => /^[a-f0-9-]{36}$/.test(id) && typeof token === 'string' && /^[a-f0-9]{64}$/.test(token)));
    }
  } catch {}
  function storeToken(id, token) {
    guestTokens[id] = token;
    try { sessionStorage.setItem('gaeru-warranty-tokens', JSON.stringify(guestTokens)); } catch {}
  }

  renderComboMenu('');

  async function api(url, method = 'GET', body) {
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 20000);
    try {
      const headers = {};
      const requestId = url.match(/^\/api\/warranty-requests\/([a-f0-9-]+)$/)?.[1];
      if (requestId && guestTokens[requestId]) headers['X-Warranty-Token'] = guestTokens[requestId];
      if (method !== 'GET') {
        const response = await fetch('/api/csrf', { credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
        if (!response.ok) throw Error('Không thể khởi tạo phiên. Hãy tải lại trang.');
        headers['X-CSRF-Token'] = (await response.json()).csrfToken;
        headers['Content-Type'] = 'application/json';
      }
      const response = await fetch(url, { method, headers, credentials: 'same-origin', cache: 'no-store', signal: controller.signal, ...(body ? { body: JSON.stringify(body) } : {}) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw Error(data.error || 'Không thể tải hồ sơ bảo hành.');
      return data;
    } catch (error) {
      if (error.name === 'AbortError') throw Error('Máy chủ phản hồi quá lâu. Hãy thử lại để kiểm tra kết quả đăng ký.');
      throw error;
    } finally { clearTimeout(timeout); }
  }

  function fillContact(data, overwrite = true) {
    let currentAddress = form.elements.address.value;
    try { currentAddress = window.GAERUAddress?.getAddress?.(form) || currentAddress; } catch {}
    const currentCity = form.elements.city.value;
    const mergedAddress = overwrite ? (data.address || currentAddress) : (currentAddress || data.address);
    const mergedCity = overwrite ? (data.city || currentCity) : (currentCity || data.city);
    for (const [name, value] of Object.entries({ fullName: data.fullName || data.customerName, email: data.email, phone: data.phone, address: data.address, city: data.city })) {
      if (value && form.elements[name] && (overwrite || !form.elements[name].value)) {
        if (name === 'city') {
          const canonical = provinces.find(province => cityKey(province) === cityKey(value));
          form.elements.city.value = canonical || '';
          const note = section.querySelector('[data-w-city-note]');
          note.hidden = Boolean(canonical);
          note.textContent = canonical ? '' : 'Tỉnh/thành phố đã lưu: ' + value + '. Vui lòng chọn đơn vị hành chính hiện hành.';
        } else form.elements[name].value = value;
      }
    }
    if ((data.address || data.city) && window.GAERUAddress?.setAddress) {
      window.GAERUAddress.setAddress(form, { address: mergedAddress || '', city: mergedCity || '' });
    }
  }

  form.elements.city.addEventListener('change', () => {
    userTouchedOptionalAddress = true;
    section.querySelector('[data-w-city-note]').hidden = true;
  });
  form.elements.address.addEventListener('input', () => { userTouchedOptionalAddress = true; });

  function syncChannelPills() {
    const val = form.elements.source.value;
    const activePillKey = val === 'account' ? 'website' : val;
    queryAll(section, '[data-w-pill]').forEach(btn => {
      const isAct = btn.dataset.wPill === activePillKey;
      btn.classList.toggle('is-active', isAct);
      btn.setAttribute('aria-pressed', String(isAct));
      btn.disabled = Boolean(form.elements.source.disabled);
    });
  }

  function changeSource() {
    const srcVal = form.elements.source.value;
    const account = srcVal === 'account';
    for (const [selector, enabled] of [['[data-w-account]', account], ['[data-w-external]', !account]]) {
      const fieldset = section.querySelector(selector);
      fieldset.hidden = !enabled;
      fieldset.disabled = !enabled;
    }
    const contactFs = section.querySelector('[data-w-contact-fieldset]');
    if (contactFs) contactFs.hidden = account;
    if (optionalBox) optionalBox.hidden = account;
    if (account) closeComboMenu();
    const channelLabel = channels[srcVal] || 'website';
    section.querySelector('[data-w-order-label]').textContent = '3. Mã đơn hàng ' + channelLabel;
    if (form.elements.externalOrderNumber) {
      form.elements.externalOrderNumber.placeholder = channelPlaceholders[srcVal] || channelPlaceholders.shopee;
    }
    const submitBtn = form.querySelector('[type=submit]');
    submitBtn.disabled = account;
    submitBtn.hidden = account;
    feedback.textContent = account ? 'Đơn website tự động kích hoạt khi hoàn tất và thanh toán. Xem hồ sơ bảo hành bên dưới; không cần gửi đăng ký.' : '';
    syncChannelPills();
    key = null;
    serialized = null;
  }

  async function orders() {
    const data = await api('/api/customer/orders?page=' + orderPage);
    for (const order of data.orders) {
      if (order.status === 'cancelled') continue;
      const option = document.createElement('option');
      option.value = order.id;
      option.textContent = order.orderNumber;
      form.elements.orderId.append(option);
    }
    section.querySelector('[data-w-orders]').hidden = data.orders.length < 20;
    if (orderPage === 1 && form.elements.orderId.options.length === 1 && form.elements.source.value === 'account') {
      feedback.textContent = 'Chưa có đơn trong tài khoản. Bạn có thể chọn Shopee / TikTok / Lazada bên trên để đăng ký.';
    }
  }

  const labels = { pending: 'Chờ xác nhận', active: 'Đã kích hoạt', rejected: 'Chưa được duyệt', revoked: 'Đã thu hồi' };
  async function list() {
    let data = await api((customer ? '/api/customer/warranties' : '/api/warranty-requests') + '?page=' + page);
    if (Object.keys(guestTokens).length) {
      const recovered = await Promise.allSettled(Object.keys(guestTokens).reverse().slice((page - 1) * 20, page * 20).map(id => api('/api/warranty-requests/' + id)));
      const merged = new Map(data.activations.map(w => [w.id, w]));
      for (const r of recovered) if (r.status === 'fulfilled') merged.set(r.value.activation.id, r.value.activation);
      data.activations = [...merged.values()].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    }
    rows = data.activations;
    const historyBox = section.querySelector('[data-w-history]');
    if (historyBox) historyBox.hidden = data.activations.length === 0 && page === 1;
    const pagerBox = section.querySelector('[data-w-pagination]');
    if (pagerBox) pagerBox.hidden = page === 1 && data.activations.length < 20;

    section.querySelector('[data-w-list]').innerHTML = data.activations.map(w =>
      `<article class="care-case">` +
        `<span class="care-status">${w.status === 'active' && w.expiresOn <= data.today ? 'Đã hết hạn' : escape(w.automatic && w.status === 'pending' ? 'Chờ đơn hoàn tất và thanh toán' : labels[w.status])}</span>` +
        `<h4>${escape(w.productName)}${w.variantName ? ' · ' + escape(w.variantName) : ''}</h4>` +
        `<p>${escape(channels[w.channel] || 'Website GAERU')} · Đơn: ${escape(w.orderNumber)}${w.serial ? '<br>Serial: ' + escape(w.serial) : ''}<br>Mã hồ sơ: ${escape(w.id)}</p>` +
        `${w.purchaseDate ? `<p>Ngày mua xác nhận: ${escape(w.purchaseDate)} · Hết hạn: ${escape(w.expiresOn)}</p>` : '<p>Thời hạn 12 tháng hiển thị sau khi GAERU đối chiếu đơn hàng.</p>'}` +
        `${w.reason ? `<p>${escape(w.reason)}</p>` : ''}` +
        `${!w.automatic && ['pending', 'rejected'].includes(w.status) ? `<div class="warranty-request-actions"><button type="button" class="care-plain" data-w-edit="${escape(w.id)}">Sửa và gửi lại</button><button type="button" class="care-plain" data-w-delete="${escape(w.id)}">Xóa yêu cầu</button></div><div data-w-delete-confirm="${escape(w.id)}"></div>` : ''}` +
      `</article>`
    ).join('') || '<p>Chưa có hồ sơ ở trang này.</p>';
    section.querySelector('[data-w-page-label]').textContent = 'Trang ' + page;
    section.querySelector('[data-w-page="-1"]').disabled = page === 1;
    section.querySelector('[data-w-page="1"]').disabled = data.activations.length < 20;
  }

  let userChangedSource = false;
  form.elements.source.addEventListener('change', () => {
    userChangedSource = true;
    if (!editing) changeSource();
  });

  form.elements.orderId.addEventListener('change', async () => {
    const current = ++sequence, select = form.elements.orderItemId;
    select.innerHTML = '<option value="">Đang tải sản phẩm…</option>';
    select.disabled = true;
    if (!form.elements.orderId.value) { select.innerHTML = '<option value="">Chọn đơn hàng trước</option>'; return; }
    try {
      const { order } = await api('/api/customer/orders/' + form.elements.orderId.value);
      if (current !== sequence) return;
      select.innerHTML = '<option value="">Chọn sản phẩm đã mua</option>' + order.items.map(i => `<option value="${i.id}">${escape(i.productName)} · ${escape(i.variantName)} · Số lượng ${i.quantity}</option>`).join('');
      select.disabled = false;
      fillContact(order);
    } catch (error) { if (current === sequence) feedback.textContent = error.message; }
  });

  form.addEventListener('submit', async event => {
    event.preventDefault();
    closeComboMenu();
    if (form.elements.source.value === 'account') {
      feedback.textContent = 'Đơn website được kích hoạt tự động; không cần gửi lại.';
      return;
    }
    const button = form.querySelector('[type=submit]');
    button.disabled = true;
    button.textContent = 'Đang gửi đăng ký…';
    feedback.textContent = 'Đang lưu đăng ký, vui lòng chờ…';
    try {
      const account = form.elements.source.value === 'account';
      if (!account && (!form.elements.productName.value || String(form.elements.productName.value).trim().length < 2)) {
        throw Error('Vui lòng chọn hoặc nhập tên thiết bị GAERU đã mua ở mục 2.');
      }
      const contact = Object.fromEntries(['fullName', 'phone', 'address', 'city', 'email'].filter(name => form.elements[name]).map(name => [name, form.elements[name].value]));
      if (window.GAERUAddress?.getAddress) contact.address = window.GAERUAddress.getAddress(form);
      const hasAddr = Boolean(String(contact.address || '').trim());
      const hasCity = Boolean(String(contact.city || '').trim());
      if (hasAddr !== hasCity) {
        if (userTouchedOptionalAddress) {
          if (optionalBox) optionalBox.open = true;
          throw Error('Nhập đầy đủ địa chỉ và tỉnh/thành phố, hoặc xóa trống cả hai mục tùy chọn.');
        }
        contact.address = '';
        contact.city = '';
      }
      if (!String(contact.email || '').trim()) delete contact.email;

      if (account && (form.elements.orderItemId.disabled || !form.elements.orderItemId.value)) {
        throw Error('Chọn sản phẩm trong đơn hàng trước khi đăng ký.');
      }
      const body = account
        ? { orderItemId: form.elements.orderItemId.value, contact }
        : {
            channel: form.elements.source.value,
            externalOrderNumber: form.elements.externalOrderNumber.value,
            productName: form.elements.productName.value.trim(),
            serial: form.elements.serial?.value || editing?.serial || '',
            ...(form.elements.purchaseDate?.value ? { purchaseDate: form.elements.purchaseDate.value } : {}),
            contact
          };
      const genKey = () => typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : 'w-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
      if (JSON.stringify(body) !== serialized) { serialized = JSON.stringify(body); key = genKey(); }
      const data = await api(editing ? '/api/warranty-requests/' + editing.id : (account ? '/api/customer/warranties' : '/api/warranty-requests'), editing ? 'PATCH' : 'POST', editing ? { ...body, serial: form.elements.serial?.value || editing?.serial || '', version: editing.version } : { ...body, requestKey: key });
      if (data.managementToken) storeToken(data.activation.id, data.managementToken);
      feedback.textContent = '✓ Đã tiếp nhận đăng ký (Mã hồ sơ: ' + data.activation.id.slice(0, 8).toUpperCase() + '). GAERU sẽ đối chiếu đơn và xác nhận kích hoạt.';
      if (!customer) feedback.textContent += ' Vui lòng lưu mã hồ sơ ' + data.activation.id + ' để theo dõi kết quả.';
      if (form.elements.externalOrderNumber) form.elements.externalOrderNumber.value = '';
      if (form.elements.productName) form.elements.productName.value = '';
      if (form.elements.serial) form.elements.serial.value = '';
      if (form.elements.purchaseDate) form.elements.purchaseDate.value = '';
      syncComboClear();
      editing = null;
      form.elements.source.disabled = false;
      syncChannelPills();
      section.querySelector('[data-w-cancel-edit]').hidden = true;
      key = null;
      serialized = null;
      page = 1;
      try { await list(); } catch { feedback.textContent += ' Chưa tải lại được danh sách; bạn có thể bấm Tải lại.'; }
    } catch (error) {
      feedback.textContent = error.message;
    } finally {
      button.disabled = form.elements.source.value === 'account';
      button.textContent = editing ? 'Gửi lại hồ sơ' : 'Kích hoạt bảo hành ngay';
    }
  });

  section.addEventListener('click', async event => {
    const pillBtn = event.target.closest('[data-w-pill]');
    if (pillBtn && !form.elements.source.disabled) {
      userChangedSource = true;
      const targetKey = pillBtn.dataset.wPill;
      if (targetKey === 'website' && customer && !form.elements.source.querySelector?.('[value=account]')?.disabled) {
        form.elements.source.value = 'account';
      } else {
        form.elements.source.value = targetKey;
      }
      changeSource();
      return;
    }

    if (event.target.closest('[data-w-manual-web]')) {
      userChangedSource = true;
      form.elements.source.value = 'website';
      changeSource();
      productInput?.focus?.();
      return;
    }

    const comboPick = event.target.closest('[data-w-combo-pick]');
    if (comboPick) {
      pickComboValue(comboPick.dataset.wComboPick);
      return;
    }

    if (event.target.closest('[data-w-combo-clear]')) {
      if (productInput) {
        productInput.value = '';
        syncComboClear();
        openComboMenu('');
        productInput.focus?.();
      }
      return;
    }

    if (event.target.closest('[data-w-combo-toggle]')) {
      if (prodMenu && !prodMenu.hidden) {
        closeComboMenu();
      } else {
        openComboMenu('');
        productInput?.focus?.();
      }
      return;
    }

    const pasteBtn = event.target.closest('[data-w-paste]');
    if (pasteBtn) {
      if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.readText === 'function') {
        try {
          const clip = (await navigator.clipboard.readText()).trim();
          if (clip) {
            form.elements.externalOrderNumber.value = clip.slice(0, 100);
            const oldLabel = pasteBtn.textContent;
            pasteBtn.textContent = '✓ Đã dán';
            setTimeout(() => { pasteBtn.textContent = oldLabel; }, 1600);
            return;
          }
        } catch {}
      }
      form.elements.externalOrderNumber?.focus?.();
      feedback.textContent = 'Nhấn giữ vào ô mã đơn hàng rồi chọn Dán.';
      return;
    }

    const dateQuick = event.target.closest('[data-w-date-quick]');
    if (dateQuick && form.elements.purchaseDate) {
      form.elements.purchaseDate.value = formatDateVN(Number(dateQuick.dataset.wDateQuick || 0));
      return;
    }

    const edit = event.target.closest('[data-w-edit]');
    const remove = event.target.closest('[data-w-delete]');
    const confirm = event.target.closest('[data-w-delete-yes]');

    if (event.target.closest('[data-w-cancel-edit]')) {
      editing = null;
      form.elements.source.disabled = false;
      syncChannelPills();
      section.querySelector('[data-w-cancel-edit]').hidden = true;
      form.querySelector('[type=submit]').textContent = 'Kích hoạt bảo hành ngay';
      feedback.textContent = 'Đã hủy chỉnh sửa.';
      return;
    }

    if (edit) {
      const row = rows.find(w => w.id === edit.dataset.wEdit);
      if (!row) return;
      form.elements.source.value = row.channel;
      changeSource();
      editing = row;
      form.elements.source.disabled = true;
      syncChannelPills();
      form.elements.externalOrderNumber.value = row.orderNumber;
      if (productInput) {
        productInput.value = row.productName || '';
        syncComboClear();
      }
      if (form.elements.serial) form.elements.serial.value = row.serial || '';
      form.elements.purchaseDate.value = row.claimedPurchaseDate || '';
      for (const name of ['fullName', 'phone', 'address', 'city', 'email']) if (form.elements[name]) form.elements[name].value = '';
      fillContact({ fullName: row.contactName, phone: row.contactPhone, address: row.contactAddress, city: row.contactCity, email: row.contactEmail || customer?.email });
      if ((row.contactEmail || row.claimedPurchaseDate || row.contactAddress) && optionalBox) optionalBox.open = true;
      form.querySelector('[type=submit]').textContent = 'Gửi lại hồ sơ';
      section.querySelector('[data-w-cancel-edit]').hidden = false;
      feedback.textContent = 'Cập nhật thông tin rồi gửi lại để GAERU đối chiếu.';
      openActivation();
      form.scrollIntoView({ block: 'start', behavior: 'smooth' });
      return;
    }

    if (event.target.closest('[data-w-delete-cancel]')) {
      const wrap = event.target.closest('[data-w-delete-confirm]');
      if (wrap) wrap.innerHTML = '';
      return;
    }

    if (remove) {
      section.querySelector('[data-w-delete-confirm="' + remove.dataset.wDelete + '"]').innerHTML = '<p>Yêu cầu chưa kích hoạt sẽ được xóa khỏi danh sách. Bạn có thể tạo đăng ký mới.</p><div style="display:flex;gap:8px;flex-wrap:wrap;"><button class="care-plain" type="button" data-w-delete-yes="' + escape(remove.dataset.wDelete) + '">Xác nhận xóa yêu cầu</button><button class="care-plain" type="button" data-w-delete-cancel>Hủy</button></div>';
      return;
    }

    if (confirm) {
      const row = rows.find(w => w.id === confirm.dataset.wDeleteYes);
      if (!row) return;
      confirm.disabled = true;
      try {
        await api('/api/warranty-requests/' + row.id, 'DELETE', { version: row.version, confirmation: 'DELETE_WARRANTY_REQUEST' });
        delete guestTokens[row.id];
        try { sessionStorage.setItem('gaeru-warranty-tokens', JSON.stringify(guestTokens)); } catch {}
        if (editing?.id === row.id) {
          editing = null;
          form.elements.source.disabled = false;
          syncChannelPills();
          section.querySelector('[data-w-cancel-edit]').hidden = true;
          form.querySelector('[type=submit]').textContent = 'Kích hoạt bảo hành ngay';
        }
        await list();
        feedback.textContent = 'Đã xóa yêu cầu.';
      } catch (error) {
        feedback.textContent = error.message;
        confirm.disabled = false;
      }
    }
  });

  section.addEventListener('click', async event => {
    const button = event.target.closest('[data-w-page],[data-w-orders]');
    if (!button) return;
    button.disabled = true;
    const previous = page;
    try {
      if (button.hasAttribute('data-w-orders')) {
        orderPage++;
        try { await orders(); } catch (error) { orderPage--; throw error; }
      } else {
        page = button.dataset.wPage === '0' ? page : Math.max(1, page + Number(button.dataset.wPage));
        await list();
      }
    } catch (error) {
      page = previous;
      feedback.textContent = error.message;
      button.disabled = false;
    } finally {
      if (button.hasAttribute('data-w-orders') || button.dataset.wPage === '0') button.disabled = false;
    }
  });

  // Dynamically enrich searchable catalog list with active products from store API
  (async () => {
    try {
      const res = await fetch('/api/products', { credentials: 'same-origin' });
      if (!res || !res.ok) return;
      const body = await res.json().catch(() => null);
      if (!body || !Array.isArray(body.products) || !body.products.length) return;
      const knownSlugs = new Set(catalogItems.map(c => c.slug));
      for (const p of body.products) {
        if (!p || !p.slug || !p.name) continue;
        const activeVars = Array.isArray(p.variants) ? p.variants.filter(v => v.active !== false).map(v => v.name).filter(Boolean) : [];
        const existing = catalogItems.find(c => c.slug === p.slug);
        if (existing) {
          if (activeVars.length > 1) existing.variants = activeVars;
          else if (activeVars.length <= 1) existing.variants = [];
        } else if (!knownSlugs.has(p.slug)) {
          catalogItems.push({
            slug: p.slug,
            shortName: p.name.replace(/^GAERU\s+/i, '').trim() || p.name,
            name: p.name,
            image: p.imageUrl || '/assets/brand/gaeru-logo.webp',
            variants: activeVars.length > 1 ? activeVars : []
          });
        }
      }
      if (prodMenu && !prodMenu.hidden) renderComboMenu(lastFilterQuery);
      else renderComboMenu('');
    } catch {}
  })();

  (async () => {
    try {
      const session = await api('/api/customer-auth/me');
      if (session.authenticated) {
        customer = session.customer;
        fillContact(customer, false);
        const accOpt = form.elements.source.querySelector?.('[value=account]');
        if (accOpt) accOpt.disabled = false;
        if (!userChangedSource && !isStandalone) {
          form.elements.source.value = 'account';
          changeSource();
        }
        section.querySelector('[data-w-session]').textContent = '✓ Đã tự điền thông tin của ' + customer.fullName;
        const results = await Promise.allSettled([
          orders(),
          list(),
          api('/api/customer/addresses').then(({ addresses }) => {
            const address = addresses.find(a => a.isDefault) || addresses[0];
            if (address) fillContact(address, false);
          })
        ]);
        if (results.some(r => r.status === 'rejected') && !feedback.textContent) {
          feedback.textContent = 'Một số dữ liệu chưa tải được. Bạn vẫn có thể chọn kênh mua và đăng ký bình thường.';
        }
      } else {
        try { await list(); } catch {}
        section.querySelector('[data-w-session]').innerHTML = 'Đăng ký nhanh không cần tài khoản · <a href="account.html">Đăng nhập</a> để lưu vào hồ sơ';
      }
    } catch {
      section.querySelector('[data-w-session]').textContent = 'Điền mã đơn và số điện thoại bên dưới để đăng ký nhanh.';
    } finally {
      form.querySelector('[type=submit]').disabled = form.elements.source.value === 'account';
      changeSource();
    }
  })();
})();
