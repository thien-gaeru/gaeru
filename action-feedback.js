(() => {
  const add = EventTarget.prototype.addEventListener;
  const remove = EventTarget.prototype.removeEventListener;
  const listeners = new WeakMap(), events = new WeakMap(), buttons = new WeakMap();
  const active = new Set();
  let current = null, region;
  const recentNotices = new Map();
  const statusSelector = '[role="status"],.feedback,.security-feedback,.workspace-status,[data-global-feedback]';
  const text = node => (node.textContent || '').trim();

  function isElementVisiblyActive(el) {
    if (!el || el.hidden || el.hasAttribute?.('hidden') || el.classList?.contains?.('is-closing')) return false;
    if (el.tagName === 'DIALOG' && !el.open && !el.hasAttribute?.('open')) return false;
    if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
      try {
        const st = window.getComputedStyle(el);
        if (st && (st.display === 'none' || st.visibility === 'hidden')) return false;
      } catch (_) {}
    }
    return true;
  }

  function isCenterPopupActive() {
    if (typeof document === 'undefined') return false;
    try {
      if (typeof document.querySelectorAll === 'function') {
        const dialogs = document.querySelectorAll('dialog[open]');
        const dialogList = Array.isArray(dialogs) ? dialogs : [...(dialogs || [])];
        if (dialogList.some(d => d.classList?.contains?.('gaeru-center-popup') && isElementVisiblyActive(d))) return true;
      }
      if (typeof document.querySelector === 'function') {
        const el = document.querySelector('.product-success-popup-backdrop:not([hidden]), #product-success-popup:not([hidden]), #product-added-popup:not([hidden]), .gaeru-center-popup:not([hidden])');
        if (isElementVisiblyActive(el)) return true;
      }
    } catch (_) {}
    return false;
  }

  function notify(message, typeOrError = false, options = {}) {
    if (!message || isCenterPopupActive()) {
      if (region?.isConnected && isCenterPopupActive()) {
        try { region.replaceChildren(); } catch (_) { region.innerHTML = ''; }
      }
      return null;
    }
    const cleanMsg = String(message).trim();
    if (!cleanMsg) return null;

    if (current) current.notified = true;
    for (const c of active) c.notified = true;

    const isErr = typeOrError === true || typeOrError === 'error' || (typeof typeOrError === 'object' && typeOrError?.error);
    const type = isErr ? 'error' : (typeof typeOrError === 'string' && ['success', 'warning', 'info'].includes(typeOrError) ? typeOrError : 'success');

    // 1. Check if an identical notification is currently visible in the DOM region
    const normClean = cleanMsg.replace(/^×|×$/g, '').trim().replace(/[\.\!\,\s]+$/g, '').toLowerCase();
    if (region?.children) {
      const children = Array.from(region.children);
      const existing = children.find(node => {
        const span = node.children ? node.children[0] : null;
        const txt = (span?.textContent || node.textContent || '').trim().replace(/^×|×$/g, '').trim().replace(/[\.\!\,\s]+$/g, '').toLowerCase();
        return txt === normClean;
      });
      if (existing) {
        return existing;
      }
    }

    // 2. Debounce identical messages within 2500ms
    const now = Date.now();
    const noticeKey = type + ':' + normClean;
    if (recentNotices.has(noticeKey) && (now - recentNotices.get(noticeKey) < 2500)) {
      if (region?.children) {
        const children = Array.from(region.children);
        const existing = children.find(node => {
          const span = node.children ? node.children[0] : null;
          const txt = (span?.textContent || node.textContent || '').trim().replace(/^×|×$/g, '').trim().replace(/[\.\!\,\s]+$/g, '').toLowerCase();
          return txt === normClean;
        });
        if (existing) return existing;
      }
      return null;
    }
    recentNotices.set(noticeKey, now);
    if (recentNotices.size > 50) {
      for (const [k, t] of recentNotices.entries()) {
        if (now - t > 10000) recentNotices.delete(k);
      }
    }

    const host = [...document.querySelectorAll('dialog[open]')].at(-1) || document.body;
    if (!region?.isConnected) {
      region = document.createElement('div');
      region.className = 'gaeru-action-notices';
      region.setAttribute('aria-live', 'polite');
      region.setAttribute('aria-label', 'Thông báo thao tác');
      host.append(region);
    }
    if (region.parentElement !== host) host.append(region);
    const item = document.createElement('div');
    item.className = 'gaeru-action-notice' + (isErr ? ' is-error' : '') + (' is-' + type);
    const messageNode = document.createElement('span');
    messageNode.textContent = cleanMsg.slice(0, 600);
    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = '×';
    close.setAttribute('aria-label', 'Đóng thông báo');
    add.call(close, 'click', () => item.remove());
    add.call(item, 'click', (e) => {
      if (e.target !== close && !window.getSelection?.()?.toString()) item.remove();
    });
    item.append(messageNode, close);
    region.append(item);
    while (region.children.length > 3) region.firstElementChild.remove();
    const duration = options?.duration || (isErr ? 9000 : type === 'warning' ? 7500 : 5500);
    setTimeout(() => item.remove(), duration);
    return item;
  }

  function showModal(opts = {}) {
    return new Promise(resolve => {
      if (typeof document === 'undefined' || !document.body) {
        return resolve(opts.mode === 'confirm' ? false : opts.mode === 'prompt' ? null : undefined);
      }
      const mode = opts.mode || 'alert'; // 'alert' | 'confirm' | 'prompt'
      const type = opts.type || (opts.danger ? 'error' : 'info');
      let title = opts.title;
      if (!title) {
        if (mode === 'confirm') title = opts.danger ? 'Xác nhận xóa / Thay đổi' : 'Xác nhận thao tác';
        else if (mode === 'prompt') title = 'Yêu cầu xác nhận';
        else title = type === 'error' ? 'Thông báo lỗi' : type === 'success' ? 'Thành công' : 'Thông báo';
      }
      const confirmText = opts.confirmText || (mode === 'alert' ? 'Đã hiểu' : opts.danger ? 'Xác nhận' : 'Đồng ý');
      const cancelText = opts.cancelText || 'Hủy bỏ';
      const message = opts.message || '';
      const defaultValue = opts.defaultValue ?? '';
      const placeholder = opts.placeholder || '';
      const isPassword = Boolean(opts.isPassword || opts.type === 'password');
      const danger = Boolean(opts.danger || type === 'error');

      let iconSvg = '';
      if (danger) {
        iconSvg = '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>';
      } else if (type === 'warning') {
        iconSvg = '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>';
      } else if (type === 'success') {
        iconSvg = '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg>';
      } else {
        iconSvg = '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>';
      }

      const backdrop = document.createElement('div');
      backdrop.className = 'gaeru-modal-backdrop gaeru-center-popup';
      backdrop.setAttribute('open', '');
      backdrop.setAttribute('role', 'dialog');
      backdrop.setAttribute('aria-modal', 'true');

      const card = document.createElement('div');
      card.className = 'gaeru-modal-card gaeru-modal-' + type + (danger ? ' is-danger-card' : '');

      let inputSection = '';
      if (mode === 'prompt') {
        const inputType = isPassword ? 'password' : 'text';
        inputSection = `<div class="gaeru-modal-input-wrap"><input class="gaeru-modal-input" type="${inputType}" value="${String(defaultValue).replace(/"/g, '&quot;')}" placeholder="${String(placeholder).replace(/"/g, '&quot;')}" autocomplete="off" /></div>`;
      }

      const isAlert = mode === 'alert';
      card.innerHTML = `
        <div class="gaeru-modal-header">
          <div class="gaeru-modal-icon gaeru-modal-icon-${type}${danger ? ' is-danger' : ''}">${iconSvg}</div>
          <div class="gaeru-modal-text">
            <h3 class="gaeru-modal-title">${String(title).replace(/</g, '&lt;')}</h3>
            <p class="gaeru-modal-message">${String(message).replace(/</g, '&lt;')}</p>
          </div>
        </div>
        ${inputSection}
        <div class="gaeru-modal-actions">
          ${!isAlert ? `<button type="button" class="gaeru-modal-btn gaeru-modal-btn-cancel">${String(cancelText).replace(/</g, '&lt;')}</button>` : ''}
          <button type="button" class="gaeru-modal-btn gaeru-modal-btn-confirm ${danger ? 'is-danger' : 'is-primary'}">${String(confirmText).replace(/</g, '&lt;')}</button>
        </div>
      `;

      backdrop.append(card);
      const rawActiveDialog = typeof document.querySelector === 'function' ? document.querySelector('dialog[open]') : null;
      const activeDialog = rawActiveDialog && !rawActiveDialog.classList?.contains?.('gaeru-center-popup') ? rawActiveDialog : null;
      const mountTarget = activeDialog || document.body;
      mountTarget?.append?.(backdrop);
      if (activeDialog && typeof activeDialog.addEventListener === 'function') {
        activeDialog.addEventListener('close', () => {
          if (!resolved && backdrop.parentElement === activeDialog) {
            document.body?.append?.(backdrop);
          }
        }, { once: true });
      }

      const input = card.querySelector?.('.gaeru-modal-input');
      const confirmBtn = card.querySelector?.('.gaeru-modal-btn-confirm');
      const cancelBtn = card.querySelector?.('.gaeru-modal-btn-cancel');

      let resolved = false;
      const cleanup = (result) => {
        if (resolved) return;
        resolved = true;
        document.removeEventListener('keydown', onKeyDown, true);
        try { backdrop.removeAttribute('open'); } catch (_) {}
        backdrop.remove();
        resolve(result);
      };

      const handleConfirm = () => {
        if (mode === 'prompt') cleanup(input ? input.value : '');
        else if (mode === 'confirm') cleanup(true);
        else cleanup(undefined);
      };

      const handleCancel = () => {
        if (mode === 'prompt') cleanup(null);
        else if (mode === 'confirm') cleanup(false);
        else cleanup(undefined);
      };

      if (confirmBtn) confirmBtn.onclick = handleConfirm;
      if (cancelBtn) cancelBtn.onclick = handleCancel;

      backdrop.onclick = (e) => {
        if (e.target === backdrop) handleCancel();
      };

      const onKeyDown = (e) => {
        if (backdrop.isConnected === false) {
          handleCancel();
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          handleCancel();
        } else if (e.key === 'Enter') {
          if (!input || e.target === input) {
            e.preventDefault();
            e.stopPropagation();
            handleConfirm();
          }
        }
      };
      document.addEventListener('keydown', onKeyDown, true);

      setTimeout(() => {
        if (input && typeof input.focus === 'function') {
          input.focus();
          try { input.select(); } catch (_) {}
        } else if (confirmBtn && typeof confirmBtn.focus === 'function') {
          confirmBtn.focus();
        }
      }, 30);
    });
  }

  function context(event) {
    if (events.has(event)) return events.get(event);
    const button = event.type === 'submit'
      ? event.submitter || event.target.querySelector('button[type="submit"],button:not([type]),input[type="submit"]')
      : event.target.closest?.('button,input[type="submit"],input[type="button"]');
    if (!button || button.closest('.gaeru-action-notices') || button.hasAttribute('data-no-action-feedback') || button.form?.hasAttribute?.('data-no-action-feedback')) return null;
    const existing = buttons.get(button) || [...active].find(action => action.button === button);
    if (existing) { events.set(event, existing); return existing; }
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

    // Clear leftover transient "Đang..." loading messages from status nodes in the form
    if (ctx.form && typeof ctx.form.querySelectorAll === 'function') {
      try {
        const statusesInForm = ctx.form.querySelectorAll(statusSelector);
        for (const node of statusesInForm) {
          if (/^Đang\b/u.test(text(node))) {
            node.textContent = '';
          }
        }
      } catch (_) {}
    }

    // If an explicit notification was already dispatched during this action, skip automatic toast
    if (ctx.notified) return;

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
    finally {
      if (!result || typeof result.then !== 'function') {
        current = previous;
      }
    }
    if (!ctx || !result || typeof result.then !== 'function') return result;
    begin(ctx);
    const promise = Promise.resolve(result).then(value => {
      current = previous;
      finish(ctx);
      return value;
    }, error => {
      current = previous;
      ctx.error = error.message || 'Không thể thực hiện thao tác.';
      finish(ctx);
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

  const notifyApi = Object.freeze({
    toast: (msg, type = 'success', opts = {}) => notify(msg, type, opts),
    success: (msg, opts = {}) => notify(msg, 'success', opts),
    error: (msg, opts = {}) => notify(msg, 'error', opts),
    warning: (msg, opts = {}) => notify(msg, 'warning', opts),
    info: (msg, opts = {}) => notify(msg, 'info', opts),
    alert: (msg, opts = {}) => showModal({ ...opts, message: msg, mode: 'alert' }),
    confirm: (msg, opts = {}) => showModal({ ...opts, message: msg, mode: 'confirm' }),
    prompt: (msg, defaultValue = '', opts = {}) => showModal({ ...opts, message: msg, defaultValue, mode: 'prompt' }),
    showModal
  });

  if (typeof window !== 'undefined') {
    window.GAERUNotify = notifyApi;
    window.notify = (msg, err = false) => notify(msg, err ? 'error' : 'success');
    window.showToast = (msg, type, opts) => notify(msg, type, opts);
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
