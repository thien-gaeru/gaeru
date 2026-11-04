const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

async function setupPage({ hasPassword = true } = {}) {
  const listeners = {};
  const attributes = {};
  let focus = 0;
  let scroll = 0;
  let posts = 0;
  let lastPostUrl = '';
  let lastPostBody = null;

  const input = {
    value: '',
    setAttribute(k, v) {
      attributes[k] = v;
    },
    removeAttribute(k) {
      delete attributes[k];
    },
    focus() {
      focus++;
    },
    addEventListener(name, fn) {
      listeners[name] = fn;
    }
  };

  const feedback = {};
  const form = {
    isConnected: true,
    elements: {
      password: input,
      newPassword: { value: 'NewPassword123!' },
      confirmPassword: { value: 'NewPassword123!' },
      email: { value: 'user@example.test' },
      phone: { value: '0900000000' },
      method: { value: 'off' }
    },
    addEventListener() {},
    querySelector() {
      return feedback;
    }
  };

  const accordionPassword = {
    dataset: { accordionItem: 'password' },
    open: true,
    querySelector() {
      return null;
    }
  };

  const root = {
    isConnected: true,
    classList: { add() {}, toggle() {} },
    closest(sel) {
      if (sel === '[data-account-profile]') return true;
      return null;
    },
    contains() {
      return true;
    },
    querySelectorAll() {
      return [];
    },
    querySelector(selector) {
      if (selector === 'form' || selector === 'form.security-form') return form;
      if (selector === 'select') return form.elements.method;
      if (selector === '.security-identity') return { scrollIntoView() { scroll++; } };
      return feedback;
    },
    addEventListener(name, fn) {
      listeners[name] = fn;
    }
  };

  const context = {
    window: { matchMedia: () => ({ matches: true }) },
    document: {
      body: { append() {} },
      querySelector: () => null,
      querySelectorAll: () => []
    },
    MutationObserver: class {
      observe() {}
    },
    fetch: async (url, options) => {
      if (url === '/api/csrf') return { ok: true, json: async () => ({ csrfToken: 'mock-csrf' }) };
      if (options?.method === 'POST') {
        posts++;
        lastPostUrl = url;
        lastPostBody = JSON.parse(options.body);
        return {
          ok: true,
          json: async () => ({
            message: hasPassword ? 'Đã đổi mật khẩu.' : 'Đã tạo mật khẩu thành công.'
          })
        };
      }
      return {
        ok: true,
        json: async () => ({
          method: 'off',
          recoveryCodesRemaining: 0,
          hasPassword
        })
      };
    }
  };

  vm.runInNewContext(fs.readFileSync(require.resolve('../account-security.js'), 'utf8'), context);
  await context.window.GAERUSecurity.render(root);

  return {
    input,
    attributes,
    feedback,
    root,
    get focus() {
      return focus;
    },
    get scroll() {
      return scroll;
    },
    get posts() {
      return posts;
    },
    get lastPostUrl() {
      return lastPostUrl;
    },
    get lastPostBody() {
      return lastPostBody;
    },
    async click(action) {
      const button = {
        dataset: { action },
        isConnected: true,
        closest(sel) {
          if (sel === '.security-accordion-item') return accordionPassword;
          return null;
        }
      };
      await listeners.click({ target: { closest: () => button } });
    }
  };
}

test('UI: when hasPassword is false, submitting password does not require current password and calls /password', async () => {
  const ui = await setupPage({ hasPassword: false });
  assert.equal(ui.root.innerHTML.includes('Tạo mật khẩu đăng nhập'), true, 'Should render Create Password title');
  assert.equal(ui.root.innerHTML.includes('Thiết lập mật khẩu'), true, 'Should render Set Password button');

  // Click password button without entering current password
  await ui.click('password');

  // Should NOT focus or scroll to current password
  assert.equal(ui.focus, 0);
  assert.equal(ui.scroll, 0);
  // Should post directly to /password
  assert.equal(ui.posts, 1);
  assert.equal(ui.lastPostUrl, '/api/account-security/password');
  assert.equal(ui.lastPostBody.newPassword, 'NewPassword123!');
  assert.equal(ui.lastPostBody.password, '');
});

test('UI: when hasPassword is true, submitting password without current password blocks and focuses password field', async () => {
  const ui = await setupPage({ hasPassword: true });
  assert.equal(ui.root.innerHTML.includes('Đổi mật khẩu đăng nhập'), true, 'Should render Change Password title');
  assert.equal(ui.root.innerHTML.includes('Đổi mật khẩu'), true, 'Should render Change Password button');

  // Click password button without entering current password
  await ui.click('password');

  // Must block and focus current password field
  assert.equal(ui.focus, 1);
  assert.equal(ui.scroll, 1);
  assert.equal(ui.posts, 0);
  assert.equal(ui.attributes['aria-invalid'], 'true');
});
