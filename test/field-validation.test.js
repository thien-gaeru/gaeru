const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');

function setupEnvironment() {
  const { window, document } = parseHTML(`
    <!doctype html>
    <html>
      <head></head>
      <body>
        <form id="test-form">
          <label>
            Số điện thoại
            <input type="tel" name="phone" required>
          </label>
          <label>
            Email
            <input type="email" name="email" required>
          </label>
          <button type="submit">Gửi</button>
        </form>
      </body>
    </html>
  `);

  const code = fs.readFileSync(path.join(__dirname, '../action-feedback.js'), 'utf8');
  const context = {
    window,
    document,
    EventTarget: window.EventTarget,
    HTMLElement: window.HTMLElement,
    HTMLInputElement: window.HTMLInputElement,
    URL: window.URL,
    Request: window.Request,
    Promise,
    location: { href: 'https://gaeru.com/test.html', origin: 'https://gaeru.com' },
    queueMicrotask,
    clearTimeout,
    setTimeout,
    console
  };
  vm.createContext(context);
  vm.runInContext(code, context);

  return { window, document, form: document.querySelector('#test-form') };
}

test('phone validation accepts standard 10-digit Vietnamese mobile formats', () => {
  const { window } = setupEnvironment();
  const { validatePhone } = window.GAERUValidation;

  // Valid numbers
  const validNumbers = [
    '0912345678',       // Viettel 09
    '0901234567',       // Mobifone 09
    '0918765432',       // Vinaphone 09
    '0387654321',       // Viettel 03
    '0701234567',       // Mobifone 07
    '0561234567',       // Vietnamobile 05
    '082 919 1080',     // with spaces
    '0912-345-678',     // with hyphens
    '0912.345.678',     // with dots
    '+84912345678',     // international +84
    '84912345678'       // international 84 prefix (11 chars)
  ];

  for (const num of validNumbers) {
    const res = validatePhone(num, true);
    assert.equal(res.valid, true, `Expected "${num}" to be valid`);
    assert.equal(res.normalized?.length, 10);
    assert.match(res.normalized, /^0[35789]\d{8}$/);
  }
});

test('phone validation rejects non-standard mobile formats with clear error messages', () => {
  const { window } = setupEnvironment();
  const { validatePhone } = window.GAERUValidation;

  // Short numbers (< 10 digits)
  assert.equal(validatePhone('0912345', true).valid, false);
  assert.match(validatePhone('0912345', true).message, /10 chữ số/);

  // Long numbers (> 10 digits)
  assert.equal(validatePhone('091234567890', true).valid, false);
  assert.match(validatePhone('091234567890', true).message, /10 chữ số/);

  // Not starting with 0
  assert.equal(validatePhone('1234567890', true).valid, false);
  assert.match(validatePhone('1234567890', true).message, /bắt đầu bằng số 0/);

  // Non-mobile prefixes (e.g. landline 024, legacy 012)
  assert.equal(validatePhone('0241234567', true).valid, false);
  assert.match(validatePhone('0241234567', true).message, /đầu số di động/);

  // Letters
  assert.equal(validatePhone('09123abcde', true).valid, false);
  assert.match(validatePhone('09123abcde', true).message, /chữ số/);

  // Empty required
  assert.equal(validatePhone('', true).valid, false);
  assert.match(validatePhone('', true).message, /Vui lòng nhập/);

  // Empty optional
  assert.equal(validatePhone('', false).valid, true);
});

test('email validation accepts valid email formats and rejects invalid ones', () => {
  const { window } = setupEnvironment();
  const { validateEmail } = window.GAERUValidation;

  // Valid
  assert.equal(validateEmail('hotro@gaeru.com', true).valid, true);
  assert.equal(validateEmail('user.name@domain.vn', true).valid, true);
  assert.equal(validateEmail('test+tag@example.test', true).valid, true);
  assert.equal(validateEmail('customer@example.invalid', true).valid, true);

  // Invalid
  assert.equal(validateEmail('user', true).valid, false);
  assert.match(validateEmail('user', true).message, /định dạng/);

  assert.equal(validateEmail('user@', true).valid, false);
  assert.equal(validateEmail('user@domain', true).valid, false);
  assert.equal(validateEmail('user@.com', true).valid, false);
  assert.equal(validateEmail('user @domain.com', true).valid, false);

  // Empty required
  assert.equal(validateEmail('', true).valid, false);
  assert.match(validateEmail('', true).message, /Vui lòng nhập/);

  // Empty optional
  assert.equal(validateEmail('', false).valid, true);
});

test('form submission blocks when phone or email is invalid and displays red border with error message', () => {
  const { window, document, form } = setupEnvironment();
  const phoneInput = form.querySelector('[name="phone"]');
  const emailInput = form.querySelector('[name="email"]');

  phoneInput.value = '12345'; // Invalid phone
  emailInput.value = 'invalid-email'; // Invalid email

  let submitted = false;
  form.addEventListener('submit', () => { submitted = true; });

  const event = new window.Event('submit', { bubbles: true, cancelable: true });
  form.dispatchEvent(event);

  assert.equal(submitted, false, 'Form submission should be blocked when fields are invalid');
  assert.equal(event.defaultPrevented, true);

  // Check red border class
  assert.equal(phoneInput.classList.contains('is-invalid'), true);
  assert.equal(phoneInput.getAttribute('aria-invalid'), 'true');
  assert.equal(emailInput.classList.contains('is-invalid'), true);
  assert.equal(emailInput.getAttribute('aria-invalid'), 'true');

  // Check error message element
  const phoneError = phoneInput.parentElement.querySelector('.field-error-msg');
  assert.ok(phoneError);
  assert.match(phoneError.textContent, /10 chữ số|bắt đầu bằng số 0/);

  const emailError = emailInput.parentElement.querySelector('.field-error-msg');
  assert.ok(emailError);
  assert.match(emailError.textContent, /định dạng/);
});

test('typing valid values clears error message and red border immediately', () => {
  const { window, document, form } = setupEnvironment();
  const phoneInput = form.querySelector('[name="phone"]');

  phoneInput.value = '12345';
  phoneInput.dispatchEvent(new window.Event('blur', { bubbles: true }));

  assert.equal(phoneInput.classList.contains('is-invalid'), true);
  assert.ok(phoneInput.parentElement.querySelector('.field-error-msg'));

  // User corrects the phone number
  phoneInput.value = '0912345678';
  phoneInput.dispatchEvent(new window.Event('input', { bubbles: true }));

  assert.equal(phoneInput.classList.contains('is-invalid'), false);
  assert.equal(phoneInput.parentElement.querySelector('.field-error-msg'), null);
});
