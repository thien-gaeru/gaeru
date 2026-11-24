(() => {
  /* GAERU Legacy Mobile Browser Compatibility Polyfills (iOS 12-15.8 / Android 7-10 / WebView) */
  if (typeof Object.hasOwn !== 'function') {
    Object.defineProperty(Object, 'hasOwn', {
      configurable: true,
      writable: true,
      value: function (obj, prop) {
        if (obj == null) throw new TypeError('Cannot convert undefined or null to object');
        return Object.prototype.hasOwnProperty.call(Object(obj), prop);
      }
    });
  }
  if (typeof Object.fromEntries !== 'function') {
    Object.defineProperty(Object, 'fromEntries', {
      configurable: true,
      writable: true,
      value: function (iterable) {
        const result = {};
        if (iterable == null) throw new TypeError('Object.fromEntries requires an iterable');
        for (const pair of iterable) {
          if (pair == null || typeof pair !== 'object') throw new TypeError('Iterator value is not an entry object');
          result[pair[0]] = pair[1];
        }
        return result;
      }
    });
  }
  if (typeof Promise !== 'undefined' && typeof Promise.allSettled !== 'function') {
    Promise.allSettled = function (promises) {
      return Promise.all(Array.from(promises, (p) => Promise.resolve(p).then(
        (value) => ({ status: 'fulfilled', value }),
        (reason) => ({ status: 'rejected', reason })
      )));
    };
  }
  if (typeof Array.prototype.flat !== 'function') {
    Object.defineProperty(Array.prototype, 'flat', {
      configurable: true,
      writable: true,
      value: function (depth) {
        const d = depth === undefined ? 1 : Math.floor(Number(depth) || 0);
        const flatten = (arr, level) => {
          const out = [];
          for (let i = 0; i < arr.length; i++) {
            if (!(i in arr)) continue;
            const item = arr[i];
            if (level > 0 && Array.isArray(item)) out.push(...flatten(item, level - 1));
            else out.push(item);
          }
          return out;
        };
        return flatten(this, d);
      }
    });
  }
  if (typeof Array.prototype.flatMap !== 'function') {
    Object.defineProperty(Array.prototype, 'flatMap', {
      configurable: true,
      writable: true,
      value: function (fn, thisArg) {
        return Array.prototype.map.call(this, fn, thisArg).flat(1);
      }
    });
  }
  if (typeof String.prototype.replaceAll !== 'function') {
    Object.defineProperty(String.prototype, 'replaceAll', {
      configurable: true,
      writable: true,
      value: function (search, replacement) {
        if (search instanceof RegExp) {
          if (!search.global) throw new TypeError('replaceAll must be called with a global RegExp');
          return String(this).replace(search, replacement);
        }
        return String(this).split(String(search)).join(typeof replacement === 'function' ? replacement : String(replacement));
      }
    });
  }
  if (typeof Array.prototype.at !== 'function') {
    Object.defineProperty(Array.prototype, 'at', {
      configurable: true,
      writable: true,
      value: function (n) {
        const len = this.length >>> 0;
        let k = Math.trunc(Number(n)) || 0;
        if (k < 0) k += len;
        return k < 0 || k >= len ? undefined : this[k];
      }
    });
  }
  if (typeof String.prototype.at !== 'function') {
    Object.defineProperty(String.prototype, 'at', {
      configurable: true,
      writable: true,
      value: function (n) {
        const str = String(this);
        let k = Math.trunc(Number(n)) || 0;
        if (k < 0) k += str.length;
        return k < 0 || k >= str.length ? undefined : str.charAt(k);
      }
    });
  }
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout !== 'function' && typeof AbortController !== 'undefined') {
    AbortSignal.timeout = function (ms) {
      const controller = new AbortController();
      setTimeout(() => {
        try { controller.abort(typeof DOMException === 'function' ? new DOMException('The operation timed out.', 'TimeoutError') : undefined); }
        catch (_) { controller.abort(); }
      }, Math.max(0, Number(ms) || 0));
      return controller.signal;
    };
  }
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID !== 'function') {
    const fallbackUuid = function () {
      if (typeof crypto.getRandomValues === 'function') {
        const bytes = new Uint8Array(16);
        crypto.getRandomValues(bytes);
        bytes[6] = (bytes[6] & 0x0f) | 0x40;
        bytes[8] = (bytes[8] & 0x3f) | 0x80;
        const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
        return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20);
      }
      return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
      });
    };
    try { Object.defineProperty(crypto, 'randomUUID', { configurable: true, writable: true, value: fallbackUuid }); }
    catch (_) { try { crypto.randomUUID = fallbackUuid; } catch (_) {} }
  }
  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    const polyfillReplaceChildren = function () {
      while (this.firstChild) this.removeChild(this.firstChild);
      for (let i = 0; i < arguments.length; i++) {
        const node = arguments[i];
        this.appendChild(typeof node === 'string' ? document.createTextNode(node) : node);
      }
    };
    if (typeof Element !== 'undefined' && typeof Element.prototype.replaceChildren !== 'function') {
      Element.prototype.replaceChildren = polyfillReplaceChildren;
    }
    if (typeof Document !== 'undefined' && typeof Document.prototype.replaceChildren !== 'function') {
      Document.prototype.replaceChildren = polyfillReplaceChildren;
    }
    if (typeof DocumentFragment !== 'undefined' && typeof DocumentFragment.prototype.replaceChildren !== 'function') {
      DocumentFragment.prototype.replaceChildren = polyfillReplaceChildren;
    }
    if (typeof window.CSS === 'undefined') window.CSS = {};
    if (typeof window.CSS.escape !== 'function') {
      window.CSS.escape = function (value) {
        const str = String(value);
        let out = '';
        for (let i = 0; i < str.length; i++) {
          const ch = str.charAt(i);
          const code = str.charCodeAt(i);
          if (code === 0) out += '\uFFFD';
          else if ((code >= 1 && code <= 31) || code === 127 || (i === 0 && code >= 48 && code <= 57) || (i === 1 && code >= 48 && code <= 57 && str.charCodeAt(0) === 45)) {
            out += '\\' + code.toString(16) + ' ';
          } else if (code >= 128 || code === 45 || code === 95 || (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122)) {
            out += ch;
          } else {
            out += '\\' + ch;
          }
        }
        return out;
      };
    }
    try {
      const flexProbe = document.createElement('div');
      flexProbe.style.display = 'flex';
      flexProbe.style.flexDirection = 'column';
      flexProbe.style.rowGap = '1px';
      flexProbe.appendChild(document.createElement('div'));
      flexProbe.appendChild(document.createElement('div'));
      if (document.documentElement) {
        document.documentElement.appendChild(flexProbe);
        const supportsFlexGap = flexProbe.scrollHeight === 1;
        flexProbe.remove();
        if (!supportsFlexGap && document.documentElement.classList) {
          document.documentElement.classList.add('gaeru-no-flex-gap');
        }
      }
    } catch (_) {}
    const testDlg = document.createElement('dialog');
    if (typeof testDlg.showModal !== 'function') {
      const proto = Object.getPrototypeOf(testDlg);
      const backdrops = new WeakMap();
      const closePolyfillDialog = function (returnValue) {
        if (arguments.length && returnValue !== undefined) this.returnValue = String(returnValue);
        this.removeAttribute('open');
        this.classList.remove('gaeru-dialog-polyfilled');
        const bd = backdrops.get(this);
        if (bd) { try { bd.remove(); } catch (_) {} backdrops.delete(this); }
        try { this.dispatchEvent(new Event('close')); } catch (_) {}
      };
      const openPolyfillDialog = function (modal) {
        if (this.hasAttribute('open')) return;
        this.setAttribute('open', '');
        this.classList.add('gaeru-dialog-polyfilled');
        if (modal && !backdrops.has(this) && document.body) {
          const bd = document.createElement('div');
          bd.className = 'gaeru-dialog-polyfill-backdrop';
          bd.addEventListener('click', () => {
            const ev = new Event('cancel', { cancelable: true });
            if (this.dispatchEvent(ev)) closePolyfillDialog.call(this);
          });
          document.body.appendChild(bd);
          backdrops.set(this, bd);
        }
      };
      if (proto && !Object.prototype.hasOwnProperty.call(proto, 'showModal')) {
        if (!('open' in testDlg)) {
          Object.defineProperty(proto, 'open', {
            configurable: true,
            get() { return Boolean(this && this.tagName === 'DIALOG' && typeof this.hasAttribute === 'function' && this.hasAttribute('open')); },
            set(v) {
              if (!this || this.tagName !== 'DIALOG' || typeof this.hasAttribute !== 'function') return;
              if (v) { if (!this.hasAttribute('open')) this.setAttribute('open', ''); }
              else if (this.hasAttribute('open')) this.removeAttribute('open');
            }
          });
        }
        proto.showModal = function () { if (this && this.tagName === 'DIALOG') openPolyfillDialog.call(this, true); };
        proto.show = function () { if (this && this.tagName === 'DIALOG') openPolyfillDialog.call(this, false); };
        proto.close = function (rv) { if (this && this.tagName === 'DIALOG') closePolyfillDialog.call(this, rv); };
        document.addEventListener('keydown', (ev) => {
          if (ev.key !== 'Escape') return;
          const openList = document.querySelectorAll('dialog.gaeru-dialog-polyfilled[open]');
          const topDlg = openList[openList.length - 1];
          if (topDlg) {
            const cancelEv = new Event('cancel', { cancelable: true });
            if (topDlg.dispatchEvent(cancelEv)) closePolyfillDialog.call(topDlg);
          }
        });
      }
    }
  }

  const add = EventTarget.prototype.addEventListener;
  const remove = EventTarget.prototype.removeEventListener;
  const listeners = new WeakMap(), events = new WeakMap(), buttons = new WeakMap(), noticeTimers = new WeakMap();
  const active = new Set();
  const DEFAULT_TOAST_DURATION = 3000;
  let current = null, region, boundDialog = null;
  const recentNotices = new Map();
  const statusSelector = '[role="status"],.feedback,.security-feedback,.workspace-status,[data-global-feedback]';
  const text = node => (node.textContent || '').trim();

  function friendlyHttpError(status) {
    if (status === 502 || status === 503 || status === 504) return 'Máy chủ tạm thời gián đoạn. Vui lòng thử lại sau giây lát.';
    if (status === 429) return 'Bạn thao tác quá nhanh. Vui lòng chờ vài giây rồi thử lại.';
    if (status === 403) return 'Bạn không có quyền thực hiện thao tác này.';
    if (status === 404) return 'Không tìm thấy dữ liệu yêu cầu hoặc dữ liệu đã thay đổi.';
    if (status === 409) return 'Dữ liệu vừa thay đổi từ nơi khác. Vui lòng tải lại để cập nhật.';
    if (status >= 500) return 'Hệ thống gặp sự cố tạm thời. Vui lòng thử lại.';
    return 'Không thể thực hiện thao tác. Vui lòng thử lại.';
  }

  function dismissNotice(item) {
    if (!item) return;
    const prevTimer = noticeTimers.get(item);
    if (prevTimer) {
      clearTimeout(prevTimer);
      noticeTimers.delete(item);
    }
    try { item.remove(); } catch (_) {}
  }

  function armNoticeTimer(item, durationMs) {
    const prevTimer = noticeTimers.get(item);
    if (prevTimer) clearTimeout(prevTimer);
    if (item.style && typeof item.style.setProperty === 'function') {
      item.style.setProperty('--gaeru-toast-duration', durationMs + 'ms');
    }
    const timer = setTimeout(() => dismissNotice(item), durationMs);
    noticeTimers.set(item, timer);
  }

  function reparentRegionToActiveHost() {
    if (!region) return;
    const openDialogs = typeof document.querySelectorAll === 'function' ? [...document.querySelectorAll('dialog[open]')] : [];
    const targetHost = openDialogs.at(-1) || document.body;
    if (targetHost && region.parentElement !== targetHost) {
      targetHost.append(region);
    }
    if (targetHost && targetHost.tagName === 'DIALOG' && targetHost !== boundDialog && typeof targetHost.addEventListener === 'function') {
      boundDialog = targetHost;
      add.call(targetHost, 'close', () => {
        if (boundDialog === targetHost) boundDialog = null;
        if (region && region.parentElement === targetHost) {
          const fallbackHost = (typeof document.querySelectorAll === 'function' ? [...document.querySelectorAll('dialog[open]')].filter(d => d !== targetHost).at(-1) : null) || document.body;
          if (fallbackHost) fallbackHost.append(region);
        }
      }, { once: true });
    }
  }

  function clearNotices(filterType) {
    if (!region?.children) return;
    for (const node of Array.from(region.children)) {
      if (!filterType || node.classList?.contains?.('is-' + filterType)) {
        dismissNotice(node);
      }
    }
  }

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
    const cleanMsg = typeof message === 'string' ? message.trim() : (typeof message?.message === 'string' ? message.message.trim() : '');
    if (!cleanMsg || cleanMsg === '[object Object]') return null;

    if (current) current.notified = true;
    for (const c of active) c.notified = true;

    const isErr = typeOrError === true || typeOrError === 'error' || (typeof typeOrError === 'object' && typeOrError?.error);
    const type = isErr ? 'error' : (typeof typeOrError === 'string' && ['success', 'warning', 'info'].includes(typeOrError) ? typeOrError : 'success');

    const duration = Number(options?.duration) > 0 ? Number(options.duration) : DEFAULT_TOAST_DURATION;

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
        reparentRegionToActiveHost();
        armNoticeTimer(existing, duration);
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
        if (existing) {
          reparentRegionToActiveHost();
          armNoticeTimer(existing, duration);
          return existing;
        }
      }
      return null;
    }
    recentNotices.set(noticeKey, now);
    if (recentNotices.size > 50) {
      for (const [k, t] of recentNotices.entries()) {
        if (now - t > 10000) recentNotices.delete(k);
      }
    }

    if (!region?.isConnected) {
      region = document.createElement('div');
      region.className = 'gaeru-action-notices';
      region.setAttribute('aria-live', 'polite');
      region.setAttribute('aria-label', 'Thông báo thao tác');
    }
    reparentRegionToActiveHost();
    const item = document.createElement('div');
    item.className = 'gaeru-action-notice' + (isErr ? ' is-error' : '') + (' is-' + type);
    const messageNode = document.createElement('span');
    messageNode.textContent = cleanMsg.slice(0, 600);
    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = '×';
    close.setAttribute('aria-label', 'Đóng thông báo');
    add.call(close, 'click', () => dismissNotice(item));
    add.call(item, 'click', (e) => {
      if (e.target !== close && !window.getSelection?.()?.toString()) dismissNotice(item);
    });
    item.append(messageNode, close);
    region.append(item);
    while (region.children.length > 3) dismissNotice(region.firstElementChild);
    armNoticeTimer(item, duration);
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

      const escModal = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
      let inputSection = '';
      if (mode === 'prompt') {
        const inputType = isPassword ? 'password' : 'text';
        inputSection = `<div class="gaeru-modal-input-wrap"><input class="gaeru-modal-input" type="${inputType}" value="${escModal(defaultValue)}" placeholder="${escModal(placeholder)}" autocomplete="off" /></div>`;
      }

      const isAlert = mode === 'alert';
      card.innerHTML = `
        <div class="gaeru-modal-header">
          <div class="gaeru-modal-icon gaeru-modal-icon-${type}${danger ? ' is-danger' : ''}">${iconSvg}</div>
          <div class="gaeru-modal-text">
            <h3 class="gaeru-modal-title">${escModal(title)}</h3>
            <p class="gaeru-modal-message">${escModal(message)}</p>
          </div>
        </div>
        ${inputSection}
        <div class="gaeru-modal-actions">
          ${!isAlert ? `<button type="button" class="gaeru-modal-btn gaeru-modal-btn-cancel">${escModal(cancelText)}</button>` : ''}
          <button type="button" class="gaeru-modal-btn gaeru-modal-btn-confirm ${danger ? 'is-danger' : 'is-primary'}">${escModal(confirmText)}</button>
        </div>
      `;

      backdrop.append(card);
      const openDialogs = typeof document.querySelectorAll === 'function'
        ? [...document.querySelectorAll('dialog[open]')].filter(d => !d.classList?.contains?.('gaeru-center-popup'))
        : [];
      const activeDialog = openDialogs.length
        ? openDialogs[openDialogs.length - 1]
        : (typeof document.querySelector === 'function' ? (() => { const d = document.querySelector('dialog[open]'); return d && !d.classList?.contains?.('gaeru-center-popup') ? d : null; })() : null);
      const mountTarget = activeDialog || document.body;
      mountTarget?.append?.(backdrop);
      if (activeDialog && typeof activeDialog.addEventListener === 'function') {
        activeDialog.addEventListener('close', () => {
          if (!resolved && backdrop.parentElement === activeDialog) {
            document.body?.append?.(backdrop);
          }
        }, { once: true });
      }

      const previousFocus = document.activeElement;
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
        try { if (previousFocus && previousFocus.isConnected && typeof previousFocus.focus === 'function') previousFocus.focus({ preventScroll: true }); } catch (_) {}
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
        } else if (e.key === 'Tab') {
          const focusables = [input, cancelBtn, confirmBtn].filter(el => el && !el.disabled && el.isConnected !== false);
          if (focusables.length > 0) {
            const idx = focusables.indexOf(document.activeElement);
            e.preventDefault();
            const nextIdx = e.shiftKey
              ? (idx <= 0 ? focusables.length - 1 : idx - 1)
              : (idx < 0 || idx >= focusables.length - 1 ? 0 : idx + 1);
            focusables[nextIdx].focus?.();
          }
        } else if (e.key === 'Enter') {
          if (cancelBtn && e.target === cancelBtn) {
            e.preventDefault();
            e.stopPropagation();
            handleCancel();
          } else if (confirmBtn && e.target === confirmBtn) {
            e.preventDefault();
            e.stopPropagation();
            handleConfirm();
          } else if (!input || e.target === input) {
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
    // Lock immediately in the current tick so rapid duplicate clicks cannot fire a second request
    buttons.set(ctx.button, ctx);
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

    // Passive background indicators (polling/live-sync labels) must never surface as action toasts
    const isPassiveStatus = node => Boolean(
      node.hasAttribute?.('data-passive-status') ||
      node.hasAttribute?.('data-no-action-feedback') ||
      /-live-status$/.test(node.id || '')
    );
    const statuses = [...document.querySelectorAll(statusSelector)]
      .filter(node => !isPassiveStatus(node) && text(node) && text(node) !== ctx.before.get(node) && !/^Đang\b/u.test(text(node)));
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
    if (last?.ok) {
      const msg = typeof last.message === 'string' ? last.message : (last.mfaRequired ? 'Vui lòng hoàn tất bước xác thực tiếp theo.' : 'Đã hoàn tất thao tác.');
      if (typeof msg === 'string' && msg !== '[object Object]') notify(msg);
    }
  }

  function invoke(event, callback) {
    const ctx = context(event), previous = current;
    current = ctx;
    let result;
    try { result = callback(); }
    catch (error) { if (ctx) notify(error.message || 'Không thể thực hiện thao tác.', true); throw error; }
    finally {
      current = previous;
    }
    if (!ctx || !result || typeof result.then !== 'function') return result;
    begin(ctx);
    const promise = Promise.resolve(result).then(value => {
      if (current === ctx) current = active.has(previous) ? previous : null;
      finish(ctx);
      return value;
    }, error => {
      if (current === ctx) current = active.has(previous) ? previous : null;
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
      return { valid: false, message: 'Email không đúng định dạng. Ví dụ: business@gaeru.com.' };
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
    if (form.hasAttribute?.('data-no-action-feedback') || form.closest?.('#admin-app') || (typeof location !== 'undefined' && /^\/gaeru_ceo(?:\/|$)/.test(String(location.pathname || '')))) return true;
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
        if (mutation || !response.ok) ctx.responses.push({
          ok: response.ok,
          error: typeof data.error === 'string' ? data.error : (typeof data.error?.message === 'string' ? data.error.message : (!response.ok ? friendlyHttpError(response.status) : null)),
          message: typeof data.message === 'string' ? data.message : null,
          mfaRequired: Boolean(data.mfaRequired)
        });
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
    clear: (filterType) => clearNotices(filterType),
    dismissAll: () => clearNotices(),
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
