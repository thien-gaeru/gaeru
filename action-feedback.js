(() => {
  const add = EventTarget.prototype.addEventListener;
  const remove = EventTarget.prototype.removeEventListener;
  const listeners = new WeakMap(), events = new WeakMap(), buttons = new WeakMap();
  const active = new Set();
  let current = null, region;
  const statusSelector = '[role="status"],.feedback,.security-feedback,.workspace-status,[data-global-feedback]';
  const text = node => (node.textContent || '').trim();

  function updateRegionState() {
    if (!region) return;
    const hasNotices = region.children && region.children.length > 0;
    if (hasNotices) {
      region.classList?.add?.('is-active');
    } else {
      region.classList?.remove?.('is-active');
    }
  }

  function notify(message, error = false) {
    if (!message) return;
    const host = [...document.querySelectorAll('dialog[open]')].at(-1) || document.body;
    if (!region?.isConnected) {
      region = document.createElement('div');
      region.className = 'gaeru-action-notices';
      region.setAttribute('aria-live', 'polite');
      region.setAttribute('aria-label', 'Thông báo thao tác');
      add.call(region, 'click', (e) => {
        if (e.target === region && region.lastElementChild) {
          region.lastElementChild.remove();
        }
      });
      host.append(region);
    }
    if (region.parentElement !== host) host.append(region);
    const item = document.createElement('div');
    item.className = 'gaeru-action-notice' + (error ? ' is-error' : '');
    const messageNode = document.createElement('span');
    messageNode.textContent = String(message).slice(0, 600);
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'gaeru-notice-close';
    close.textContent = '×';
    close.setAttribute('aria-label', 'Đóng thông báo');
    add.call(close, 'click', () => item.remove());

    const actionBtn = document.createElement('button');
    actionBtn.type = 'button';
    actionBtn.className = 'gaeru-notice-action-btn';
    actionBtn.textContent = 'Đã hiểu';
    add.call(actionBtn, 'click', () => item.remove());

    item.append(messageNode, close, actionBtn);

    const origRemove = typeof item.remove === 'function' ? item.remove.bind(item) : null;
    if (origRemove) {
      item.remove = () => {
        origRemove();
        updateRegionState();
      };
    }

    region.append(item);
    updateRegionState();
    while (region.children.length > 3) region.firstElementChild.remove();
    setTimeout(() => item.remove(), error ? 10000 : 6500);
  }

  function context(event) {
    if (events.has(event)) return events.get(event);
    const button = event.type === 'submit'
      ? event.submitter || event.target.querySelector('button[type="submit"],button:not([type]),input[type="submit"]')
      : event.target.closest?.('button,input[type="submit"],input[type="button"]');
    if (!button || button.closest('.gaeru-action-notices') || button.hasAttribute('data-no-action-feedback')) return null;
    const ctx = {
      button, form: button.form || button.closest('form'), pending: 0, started: false,
      before: new Map([...document.querySelectorAll(statusSelector)].map(node => [node, text(node)])),
      busy: button.getAttribute('aria-busy'), disabled: button.getAttribute('aria-disabled'), responses: []
    };
    events.set(event, ctx);
    return ctx;
  }

  function start(ctx) {
    if (!ctx.pending || ctx.started) return;
    ctx.started = true;
    buttons.set(ctx.button, ctx);
    ctx.button.classList.add('gaeru-action-busy');
    ctx.button.setAttribute('aria-busy', 'true');
    ctx.button.setAttribute('aria-disabled', 'true');
    if (ctx.button.tagName === 'INPUT') {
      ctx.spinner = document.createElement('span');
      ctx.spinner.className = 'gaeru-input-spinner';
      ctx.spinner.setAttribute('aria-hidden', 'true');
      ctx.button.insertAdjacentElement('afterend', ctx.spinner);
    }
  }

  function begin(ctx) {
    clearTimeout(ctx.finishTimer);
    ctx.pending++;
    active.add(ctx);
    queueMicrotask(() => start(ctx));
  }

  function finish(ctx) {
    if (--ctx.pending) return;
    // Keep one action across chained fetch calls and their DOM updates.
    ctx.finishTimer = setTimeout(() => settle(ctx), 0);
  }

  function settle(ctx) {
    if (ctx.pending) return;
    active.delete(ctx);
    if (buttons.get(ctx.button) === ctx) {
      buttons.delete(ctx.button);
      ctx.button.classList.remove('gaeru-action-busy');
      for (const [name, value] of [['aria-busy', ctx.busy], ['aria-disabled', ctx.disabled]]) {
        if (value === null) ctx.button.removeAttribute(name); else ctx.button.setAttribute(name, value);
      }
      ctx.spinner?.remove();
    }
    const statuses = [...document.querySelectorAll(statusSelector)]
      .filter(node => text(node) && text(node) !== ctx.before.get(node) && !/^Đang\b/u.test(text(node)));
    const local = statuses.find(node => ctx.form?.contains(node));
    const messageNode = local || statuses.at(-1);
    const last = ctx.responses.at(-1);
    if (ctx.error || ctx.networkError) return notify(ctx.error || ctx.networkError, true);
    if (last && !last.ok) return notify(last.error || 'Không thể thực hiện thao tác. Vui lòng thử lại.', true);
    if (messageNode) {
      const message = text(messageNode);
      const error = /error|danger|invalid/.test(messageNode.className || '') || (!last?.ok && /không thể|không đúng|không hợp lệ|chưa thể|chưa .*được|thất bại|đã hủy|^(?:nhập |vui lòng|chọn |hãy )|chưa cấu hình/i.test(message));
      return notify(message, error);
    }
    if (last?.ok) notify(last.message || (last.mfaRequired ? 'Vui lòng hoàn tất bước xác thực tiếp theo.' : 'Đã hoàn tất thao tác.'));
  }

  function invoke(event, callback) {
    const ctx = context(event), previous = current;
    current = ctx;
    let result;
    try { result = callback(); }
    catch (error) { if (ctx) notify(error.message || 'Không thể thực hiện thao tác.', true); throw error; }
    finally { current = previous; }
    if (!ctx || !result || typeof result.then !== 'function') return result;
    begin(ctx);
    const promise = Promise.resolve(result).then(value => { finish(ctx); return value; }, error => {
      ctx.error = error.message || 'Không thể thực hiện thao tác.';
      finish(ctx);
      // The application may already have handled the request; never retry a mutation here.
      console.error('Action failed:', error.message);
    });
    return promise;
  }

  
  // --- Global Form Field Validation (Phone & Email) ---
  function isPhoneInput(input) {
    if (!input || input.tagName !== 'INPUT') return false;
    const type = (input.type || '').toLowerCase();
    const name = (input.name || '').toLowerCase();
    const autocomplete = (input.autocomplete || '').toLowerCase();
    if (name === 'identifier' || name === 'username' || type === 'search' || (input.id && input.id.includes('search'))) return false;
    return type === 'tel' ||
           name === 'phone' ||
           name === 'customerphone' ||
           name === 'shippingphone' ||
           name.endsWith('phone') ||
           autocomplete === 'tel' ||
           (typeof input.hasAttribute === 'function' && input.hasAttribute('data-phone'));
  }

  function isEmailInput(input) {
    if (!input || input.tagName !== 'INPUT') return false;
    const type = (input.type || '').toLowerCase();
    const name = (input.name || '').toLowerCase();
    const autocomplete = (input.autocomplete || '').toLowerCase();
    if (name === 'identifier' || name === 'username' || type === 'search' || (input.id && input.id.includes('search'))) return false;
    return type === 'email' ||
           name === 'email' ||
           name === 'customeremail' ||
           name.endsWith('email') ||
           autocomplete === 'email' ||
           (typeof input.hasAttribute === 'function' && input.hasAttribute('data-email'));
  }

  function validatePhoneNumber(value, isRequired = false) {
    const raw = String(value ?? '').trim();
    if (!raw) {
      if (isRequired) return { valid: false, message: 'Vui lòng nhập số điện thoại di động.' };
      return { valid: true };
    }
    let clean = raw.replace(/[\s\-\.\(\)]/g, '');
    if (clean.startsWith('+84')) {
      clean = '0' + clean.slice(3);
    } else if (clean.startsWith('84') && clean.length === 11) {
      clean = '0' + clean.slice(2);
    }
    if (!/^\d+$/.test(clean)) {
      return { valid: false, message: 'Số điện thoại chỉ được chứa chữ số (Ví dụ: 0912345678).' };
    }
    if (clean.length !== 10) {
      return { valid: false, message: 'Số điện thoại phải gồm đúng 10 chữ số (hiện có ' + clean.length + ' số).' };
    }
    if (!clean.startsWith('0')) {
      return { valid: false, message: 'Số điện thoại di động phải bắt đầu bằng số 0 (Ví dụ: 0912345678).' };
    }
    if (!/^0[35789]\d{8}$/.test(clean)) {
      return { valid: false, message: 'Đầu số không hợp lệ. Vui lòng nhập đầu số di động (03, 05, 07, 08, 09).' };
    }
    return { valid: true, normalized: clean };
  }

  function validateEmailAddress(value, isRequired = false) {
    const raw = String(value ?? '').trim();
    if (!raw) {
      if (isRequired) return { valid: false, message: 'Vui lòng nhập địa chỉ email.' };
      return { valid: true };
    }
    const emailRegex = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;
    if (!emailRegex.test(raw) || /\s/.test(raw) || !raw.includes('.')) {
      return { valid: false, message: 'Email không đúng định dạng. Ví dụ: hotro@gaeru.com.' };
    }
    return { valid: true, normalized: raw.toLowerCase() };
  }

  function showInputError(input, message) {
    if (!input || !input.classList) return;
    input.classList.add('is-invalid');
    input.setAttribute('aria-invalid', 'true');
    input.setAttribute('data-invalid', 'true');
    if (typeof input.setCustomValidity === 'function') {
      try { input.setCustomValidity(message); } catch {}
    }

    const container = input.parentElement;
    let msgEl = null;
    if (container && typeof container.querySelector === 'function') {
      msgEl = container.querySelector('.field-error-msg');
    }
    if (!msgEl && input.nextElementSibling && input.nextElementSibling.classList?.contains('field-error-msg')) {
      msgEl = input.nextElementSibling;
    }

    if (!msgEl && typeof document.createElement === 'function') {
      msgEl = document.createElement('span');
      msgEl.className = 'field-error-msg';
      msgEl.setAttribute('role', 'alert');
      msgEl.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg><span></span>';
      if (input.parentNode) {
        if (input.nextSibling) {
          input.parentNode.insertBefore(msgEl, input.nextSibling);
        } else {
          input.parentNode.appendChild(msgEl);
        }
      }
    }

    if (msgEl) {
      const textNode = (typeof msgEl.querySelector === 'function' ? msgEl.querySelector('span') : null) || msgEl;
      textNode.textContent = message;
      msgEl.hidden = false;
    }
  }

  function clearInputError(input) {
    if (!input || !input.classList) return;
    input.classList.remove('is-invalid');
    input.removeAttribute('aria-invalid');
    input.removeAttribute('data-invalid');
    if (typeof input.setCustomValidity === 'function') {
      try { input.setCustomValidity(''); } catch {}
    }

    const container = input.parentElement;
    let msgEl = null;
    if (container && typeof container.querySelector === 'function') {
      msgEl = container.querySelector('.field-error-msg');
    }
    if (!msgEl && input.nextElementSibling && input.nextElementSibling.classList?.contains('field-error-msg')) {
      msgEl = input.nextElementSibling;
    }
    if (msgEl && typeof msgEl.remove === 'function') {
      msgEl.remove();
    }
  }

  function validateField(input) {
    if (!input || input.disabled || input.readOnly) return true;
    if (isPhoneInput(input)) {
      const res = validatePhoneNumber(input.value, input.required);
      if (!res.valid) {
        showInputError(input, res.message);
        return false;
      }
      clearInputError(input);
      return true;
    }
    if (isEmailInput(input)) {
      const res = validateEmailAddress(input.value, input.required);
      if (!res.valid) {
        showInputError(input, res.message);
        return false;
      }
      clearInputError(input);
      return true;
    }
    return true;
  }

  function validateForm(form) {
    if (!form || typeof form.querySelectorAll !== 'function') return true;
    const inputs = form.querySelectorAll('input');
    if (!inputs || !inputs.length) return true;
    let firstInvalid = null;
    for (const input of inputs) {
      if (isPhoneInput(input) || isEmailInput(input)) {
        const ok = validateField(input);
        if (!ok && !firstInvalid) {
          firstInvalid = input;
        }
      }
    }
    if (firstInvalid) {
      try { firstInvalid.focus(); } catch {}
      const msg = firstInvalid.getAttribute?.('aria-invalid') === 'true'
        ? (firstInvalid.parentElement?.querySelector?.('.field-error-msg')?.textContent || 'Vui lòng kiểm tra lại thông tin nhập liệu.')
        : 'Vui lòng kiểm tra lại số điện thoại hoặc email.';
      notify(msg, true);
      return false;
    }
    return true;
  }

  EventTarget.prototype.addEventListener = function(type, listener, options) {
    if (!['click', 'submit'].includes(type) || typeof listener !== 'function') return add.call(this, type, listener, options);
    let map = listeners.get(this);
    if (!map) listeners.set(this, map = new WeakMap());
    let wrappers = map.get(listener);
    if (!wrappers) map.set(listener, wrappers = new Map());
    const key = type + ':' + Boolean(typeof options === 'boolean' ? options : options?.capture);
    if (!wrappers.has(key)) wrappers.set(key, function(event) {
      if (event?.type === 'submit') {
        const form = this?.tagName === 'FORM' ? this : (event.target?.tagName === 'FORM' ? event.target : event.target?.form || event.target?.closest?.('form'));
        if (form && !validateForm(form)) {
          event.preventDefault();
          event.stopImmediatePropagation?.();
          return;
        }
      }
      return invoke(event, () => listener.call(this, event));
    });
    return add.call(this, type, wrappers.get(key), options);
  };
  EventTarget.prototype.removeEventListener = function(type, listener, options) {
    const key = type + ':' + Boolean(typeof options === 'boolean' ? options : options?.capture);
    return remove.call(this, type, listeners.get(this)?.get(listener)?.get(key) || listener, options);
  };

  for (const property of ['onclick', 'onsubmit']) {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, property);
    if (!descriptor?.configurable || !descriptor.set || !descriptor.get) continue;
    const assigned = new WeakMap();
    Object.defineProperty(HTMLElement.prototype, property, {
      ...descriptor,
      get() { return assigned.has(this) ? assigned.get(this) : descriptor.get.call(this); },
      set(listener) {
        if (typeof listener === 'function') assigned.set(this, listener); else assigned.delete(this);
        descriptor.set.call(this, typeof listener === 'function'
          ? function(event) { return invoke(event, () => listener.call(this, event)); } : listener);
      }
    });
  }

  for (const type of ['click', 'submit']) add.call(document, type, event => {
    const button = event.type === 'submit'
      ? event.submitter || event.target.querySelector('button[type="submit"],button:not([type]),input[type="submit"]')
      : event.target.closest?.('button,input[type="submit"],input[type="button"]');
    const busy = button && buttons.get(button);
    if (busy?.pending) { event.preventDefault(); event.stopImmediatePropagation(); }
  }, true);

  let lastInvalid = 0;
  add.call(document, 'invalid', event => {
    if (Date.now() - lastInvalid < 500) return;
    lastInvalid = Date.now();
    notify(event.target.validationMessage || 'Vui lòng kiểm tra các thông tin bắt buộc trước khi gửi.', true);
  }, true);

  const fetchRequest = window.fetch.bind(window);
  window.fetch = async (input, options = {}) => {
    const method = (options.method || input?.method || 'GET').toUpperCase();
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, location.href);
    const ctx = current || (active.size === 1 ? [...active][0] : null);
    const mutation = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);
    const track = !options.gaeruBackground && ctx && url.origin === location.origin && url.pathname.startsWith('/api/') && (current || mutation);
    if (track) begin(ctx);
    try {
      const response = await fetchRequest(input, options);
      if (track) {
        if (response.ok) ctx.networkError = null;
        let data = {};
        if (response.headers.get('content-type')?.includes('application/json')) {
          try { data = await response.clone().json(); } catch { /* Keep the original response intact. */ }
        }
        if (mutation || !response.ok) ctx.responses.push({ok: response.ok, error: data.error, message: data.message, mfaRequired: data.mfaRequired});
      }
      return response;
    } catch (error) {
      if (track) ctx.networkError = error.name === 'AbortError'
        ? 'Yêu cầu đã dừng hoặc hết thời gian chờ. Kiểm tra kết quả trước khi gửi lại.'
        : error.message?.includes('xác minh') ? error.message : 'Không thể kết nối máy chủ. Kiểm tra kết quả trước khi gửi lại.';
      throw error;
    } finally {
      if (track) finish(ctx);
    }
  };


  // Bind capture listeners on document for instant feedback
  add.call(document, 'blur', event => {
    const target = event.target;
    if (target && (isPhoneInput(target) || isEmailInput(target))) {
      validateField(target);
    }
  }, true);

  add.call(document, 'input', event => {
    const target = event.target;
    if (target && (isPhoneInput(target) || isEmailInput(target))) {
      if (target.classList?.contains('is-invalid') || target.getAttribute?.('aria-invalid') === 'true') {
        validateField(target);
      }
    }
  }, true);

  add.call(document, 'submit', event => {
    const form = event.target?.tagName === 'FORM' ? event.target : event.target?.form || event.target?.closest?.('form');
    if (form && !validateForm(form)) {
      event.preventDefault();
      event.stopImmediatePropagation?.();
    }
  }, true);

  if (typeof window !== 'undefined') {
    window.GAERUNotify = notify;
    window.GAERUFeedback = Object.assign(window.GAERUFeedback || {}, { notify });
    window.GAERUValidation = Object.freeze({
      validatePhone: validatePhoneNumber,
      validateEmail: validateEmailAddress,
      showError: showInputError,
      clearError: clearInputError,
      validateField,
      validateForm,
      isPhoneInput,
      isEmailInput
    });
  }

})();