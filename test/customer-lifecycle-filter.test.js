const test = require('node:test');
const assert = require('node:assert/strict');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const { PGlite } = require('@electric-sql/pglite');
const { createApp } = require('../src/app');
const { migrateDatabase } = require('../src/migrate');
const {
  isValidVietnamMobile,
  isDisposableEmail,
  checkCustomerPhoneStatus,
  checkCustomerRegEmailStatus,
  autoLockAccount,
  softDeleteCustomer,
  permanentDeleteCustomer,
  restoreCustomerFromTrash
} = require('../src/customer-lifecycle');

test('unit: phone validation and disposable email detection', () => {
  assert.equal(isValidVietnamMobile('0901234567'), true);
  assert.equal(isValidVietnamMobile('+84829191080'), true);
  assert.equal(isValidVietnamMobile('0358888536'), true);
  assert.equal(isValidVietnamMobile('0701122334'), true);
  assert.equal(isValidVietnamMobile('0899998877'), true);

  assert.equal(isValidVietnamMobile('0000000000'), false);
  assert.equal(isValidVietnamMobile('1111111111'), false);
  assert.equal(isValidVietnamMobile('0123456789'), false);
  assert.equal(isValidVietnamMobile('12345678'), false);
  assert.equal(isValidVietnamMobile('0241234567'), false);
  assert.equal(isValidVietnamMobile('abc'), false);

  assert.equal(isDisposableEmail('test@mailinator.com'), true);
  assert.equal(isDisposableEmail('fake@tempmail.com'), true);
  assert.equal(isDisposableEmail('user@10minutemail.com'), true);
  assert.equal(isDisposableEmail('throw@throwawaymail.com'), true);
  assert.equal(isDisposableEmail('real.person@gmail.com'), false);
  assert.equal(isDisposableEmail('contact@gaeru.com'), false);

  const now = new Date();
  const twoHoursAgo = new Date(now.getTime() - 2 * 3600 * 1000);
  const statusWarning = checkCustomerPhoneStatus({ phone: '12345678', created_at: twoHoursAgo }, now);
  assert.equal(statusWarning.isValid, false);
  assert.equal(statusWarning.isWarning, true);
  assert.equal(statusWarning.isExpired, false);
  assert.equal(statusWarning.remainingHours, 10);

  const thirteenHoursAgo = new Date(now.getTime() - 13 * 3600 * 1000);
  const statusExpired = checkCustomerPhoneStatus({ phone: '12345678', created_at: thirteenHoursAgo }, now);
  assert.equal(statusExpired.isValid, false);
  assert.equal(statusExpired.isWarning, false);
  assert.equal(statusExpired.isExpired, true);

  // Accounts without phone: NO warning, NO lock
  assert.equal(checkCustomerPhoneStatus({ phone: '' }).isWarning, false);
  assert.equal(checkCustomerPhoneStatus({ phone: null }).isWarning, false);
  assert.equal(checkCustomerPhoneStatus({ phone: '   ' }).isWarning, false);
  assert.equal(checkCustomerPhoneStatus({ phone: '' }).hasPhone, false);

  // Registration email status checks:
  // 1. Google account excluded
  const googleStatus = checkCustomerRegEmailStatus({ google_id: 'sub-google-123', reg_email_failed_at: thirteenHoursAgo }, now);
  assert.equal(googleStatus.isWarning, false);
  assert.equal(googleStatus.isExpired, false);

  // 2. Normal account with failed email within 12h
  const regEmailWarn = checkCustomerRegEmailStatus({ reg_email_failed_at: twoHoursAgo }, now);
  assert.equal(regEmailWarn.isWarning, true);
  assert.equal(regEmailWarn.isExpired, false);
  assert.equal(regEmailWarn.remainingHours, 10);

  // 3. Normal account with failed email past 12h
  const regEmailExp = checkCustomerRegEmailStatus({ reg_email_failed_at: thirteenHoursAgo }, now);
  assert.equal(regEmailExp.isWarning, false);
  assert.equal(regEmailExp.isExpired, true);
});

test('lifecycle: disposable email auto-lock, 12h invalid phone warning & auto-lock, admin filter, soft-delete and permanent delete', { timeout: 60000 }, async (t) => {
  const db = await PGlite.create();
  let queue = Promise.resolve();
  async function lock() {
    const before = queue;
    let release;
    queue = new Promise((r) => (release = r));
    await before;
    return release;
  }
  async function query(sql, values) {
    const r = !values && sql.includes(';') ? (await db.exec(sql)).at(-1) : await db.query(sql, values);
    return { ...r, rows: r?.rows || [], rowCount: r?.affectedRows ?? r?.rows?.length ?? 0 };
  }
  const pool = {
    async query(sql, values) {
      const release = await lock();
      try { return await query(sql, values); } finally { release(); }
    },
    async connect() {
      const release = await lock();
      return { query, release };
    }
  };

  await migrateDatabase(pool);

  const password = 'Lifecycle-Password-2026';
  let emailDeliveryFailure = false;
  const mailer = {
    async sendMail(opts) {
      if (emailDeliveryFailure) {
        const err = new Error('550 User unknown: recipient address rejected');
        err.responseCode = 550;
        throw err;
      }
      return { messageId: 'fixture-email-id' };
    }
  };

  const app = createApp({
    pool,
    customerMailer: mailer,
    sessionStore: new session.MemoryStore(),
    config: {
      NODE_ENV: 'test',
      PUBLIC_BASE_URL: 'https://gaeru.example',
      smtp: { from: 'support@gaeru.example', publicBaseUrl: 'https://gaeru.example' },
      SESSION_SECRET: 'lifecycle-test-secret-at-least-32-chars',
      ADMIN_USERNAME: 'owner',
      ADMIN_PASSWORD_HASH: bcrypt.hashSync(password, 4)
    }
  });

  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  t.after(async () => {
    await new Promise((r) => server.close(r));
    await db.close();
  });
  const base = 'http://127.0.0.1:' + server.address().port;

  function client() {
    let cookie = '', csrf = '';
    return {
      async request(path, method = 'GET', body, sendCsrf = true) {
        const r = await fetch(base + path, {
          method,
          headers: {
            Cookie: cookie,
            'X-CSRF-Token': sendCsrf ? csrf : '',
            ...(body ? { 'Content-Type': 'application/json' } : {})
          },
          body: body ? JSON.stringify(body) : undefined
        });
        if (r.headers.get('set-cookie')) {
          cookie = r.headers.get('set-cookie').split(';')[0];
        }
        const data = await r.json().catch(() => null);
        if (data?.csrfToken) csrf = data.csrfToken;
        return { status: r.status, data };
      },
      async ok(path, method = 'GET', body, expected = 200) {
        const res = await this.request(path, method, body);
        assert.equal(res.status, expected, `${path}: ${JSON.stringify(res.data)}`);
        return res.data;
      }
    };
  }

  // 1. Admin login
  const admin = client();
  await admin.ok('/api/csrf');
  await admin.ok('/api/auth/login', 'POST', { username: 'owner', password });

  // 2. Disposable email auto-lock when requesting verification email
  const spamBuyer = client();
  await spamBuyer.ok('/api/csrf');
  const regSpam = await spamBuyer.ok('/api/customer-auth/register', 'POST', {
    fullName: 'Spam User',
    email: 'throwaway@mailinator.com',
    phone: '0901234567',
    password
  });
  assert.equal(regSpam.customer.email, 'throwaway@mailinator.com');

  const verifyAttempt = await spamBuyer.request('/api/customer-auth/email-verification/request', 'POST');
  assert.equal(verifyAttempt.status, 403);
  assert.match(verifyAttempt.data.error, /email rác/);

  // Trying to log in with this account is locked
  const spamLogin = await spamBuyer.request('/api/customer-auth/login', 'POST', {
    identifier: 'throwaway@mailinator.com',
    password
  });
  assert.equal(spamLogin.status, 403);
  assert.match(spamLogin.data.error, /email rác/);

  // 3. Registration email delivery failure: 12h countdown & auto-lock
  emailDeliveryFailure = true;
  const bounceBuyer = client();
  await bounceBuyer.ok('/api/csrf');
  const regBounce = await bounceBuyer.ok('/api/customer-auth/register', 'POST', {
    fullName: 'Bounce User',
    email: 'nonexistent.user.test@example.com',
    phone: '0901234567',
    password
  });
  assert.equal(regBounce.customer.regEmailWarning, true);
  assert.equal(regBounce.customer.regEmailWarningRemainingHours, 12);

  // Logging in within 12h returns regEmailWarning
  const bounceLoginWarn = await bounceBuyer.ok('/api/customer-auth/login', 'POST', {
    identifier: 'nonexistent.user.test@example.com',
    password
  });
  assert.equal(bounceLoginWarn.customer.regEmailWarning, true);

  // Permanent sendMail delivery failure (550) on verification request also auto-locks account
  const bounceVerify = await bounceBuyer.request('/api/customer-auth/email-verification/request', 'POST');
  assert.equal(bounceVerify.status, 403);
  assert.match(bounceVerify.data.error, /không thể nhận thư xác thực/);
  emailDeliveryFailure = false;

  // 4. Invalid phone number warning within 12h
  const warningBuyer = client();
  await warningBuyer.ok('/api/csrf');
  await warningBuyer.ok('/api/customer-auth/register', 'POST', {
    fullName: 'Invalid Phone User',
    email: 'badphone@example.com',
    phone: '12345678', // Invalid phone format
    password
  });

  // Logging in within 12h succeeds but returns phoneWarning
  const warningLogin = await warningBuyer.ok('/api/customer-auth/login', 'POST', {
    identifier: 'badphone@example.com',
    password
  });
  assert.equal(warningLogin.customer.phoneWarning, true);
  assert.ok(warningLogin.customer.phoneWarningRemainingHours > 0);
  assert.match(warningLogin.customer.phoneWarningMessage, /không đúng định dạng/);

  // /me also reports warning
  const meRes = await warningBuyer.ok('/api/customer-auth/me');
  assert.equal(meRes.customer.phoneWarning, true);

  // 5. Updating to a valid Vietnam mobile clears the phone warning
  const updateRes = await warningBuyer.ok('/api/customer/profile', 'PATCH', {
    fullName: 'Invalid Phone User',
    phone: '0908889999'
  });
  assert.equal(updateRes.customer.phone, '0908889999');

  const meAfterFix = await warningBuyer.ok('/api/customer-auth/me');
  assert.equal(Boolean(meAfterFix.customer.phoneWarning), false);

  // 6. Invalid phone past 12h is automatically locked upon login / me
  const expiredBuyer = client();
  await expiredBuyer.ok('/api/csrf');
  await expiredBuyer.ok('/api/customer-auth/register', 'POST', {
    fullName: 'Expired Phone User',
    email: 'expiredphone@example.com',
    phone: '0000000000',
    password
  });
  // Simulate 13 hours passed
  await pool.query("UPDATE customers SET phone_invalid_at = now() - interval '13 hours' WHERE email = 'expiredphone@example.com'");

  const expiredLogin = await expiredBuyer.request('/api/customer-auth/login', 'POST', {
    identifier: 'expiredphone@example.com',
    password
  });
  assert.equal(expiredLogin.status, 403);
  assert.match(expiredLogin.data.error, /12 giờ/);

  // 7. Admin Customer Filter
  const customersAll = await admin.ok('/api/gaeru_ceo/customers?status=all');
  assert.ok(customersAll.customers.length >= 4);
  assert.ok(customersAll.statusCounts.all >= 4);
  assert.ok(customersAll.statusCounts.locked >= 3); // spam + bounce + expired phone

  const customersLocked = await admin.ok('/api/gaeru_ceo/customers?status=locked');
  assert.ok(customersLocked.customers.every((c) => !c.active));

  const customersSpam = await admin.ok('/api/gaeru_ceo/customers?status=spam');
  assert.ok(customersSpam.customers.length >= 2);
  assert.ok(customersSpam.customers.every((c) => ['spam_email', 'invalid_phone_timeout'].includes(c.lockReason)));

  // 8. Admin Soft-Delete (Move to trash) & Restore
  const normalBuyer = client();
  await normalBuyer.ok('/api/csrf');
  const regNormal = await normalBuyer.ok('/api/customer-auth/register', 'POST', {
    fullName: 'Normal Customer',
    email: 'normal@example.com',
    phone: '0901234567',
    password
  });
  const normalId = regNormal.customer.id;

  // Soft delete customer
  const softDelRes = await admin.ok(`/api/gaeru_ceo/customers/${normalId}/soft-delete`, 'POST', {
    reason: 'Khách hàng yêu cầu khóa và đưa vào thùng rác'
  });
  assert.equal(softDelRes.id, normalId);

  // Verify soft-deleted customer cannot log in
  const normalLoginBlocked = await normalBuyer.request('/api/customer-auth/login', 'POST', {
    identifier: 'normal@example.com',
    password
  });
  assert.equal(normalLoginBlocked.status, 403);

  // Appears in trash filter
  const trashList = await admin.ok('/api/gaeru_ceo/customers?status=trash');
  assert.ok(trashList.customers.some((c) => c.id === normalId));

  // Admin restores customer
  const restoreRes = await admin.ok(`/api/gaeru_ceo/customers/${normalId}/restore`, 'POST', {
    reason: 'Khách liên hệ mở lại tài khoản'
  });
  assert.match(restoreRes.message, /khôi phục/);

  // Customer can log in again
  await normalBuyer.ok('/api/customer-auth/login', 'POST', {
    identifier: 'normal@example.com',
    password
  });

  // 9. Registration email delivery timeout (>12h) auto-locks on login
  await pool.query("UPDATE customers SET reg_email_failed_at = now() - interval '13 hours', active = true, lock_reason = NULL WHERE id = $1", [regBounce.customer.id]);
  const loginExpiredRes = await bounceBuyer.request('/api/customer-auth/login', 'POST', {
    identifier: 'nonexistent.user.test@example.com',
    password
  });
  assert.equal(loginExpiredRes.status, 403);
  assert.match(loginExpiredRes.data.error, /không thể gửi email thông báo đăng ký trong vòng 12 giờ/);

  // 10. Admin Permanent-Delete requires admin password and admin authentication
  // Missing password -> 400
  const noPassRes = await admin.request(`/api/gaeru_ceo/customers/${normalId}/permanent-delete`, 'POST', {
    reason: 'Khách yêu cầu xóa vĩnh viễn'
  });
  assert.equal(noPassRes.status, 400);
  assert.match(noPassRes.data.error, /nhập mật khẩu quản trị viên/);

  // Wrong password -> 403
  const wrongPassRes = await admin.request(`/api/gaeru_ceo/customers/${normalId}/permanent-delete`, 'POST', {
    password: 'wrong-admin-password',
    reason: 'Khách yêu cầu xóa vĩnh viễn'
  });
  assert.equal(wrongPassRes.status, 403);
  assert.match(wrongPassRes.data.error, /không chính xác/);

  // Correct password -> 200 and permanently deletes
  const permDelRes = await admin.ok(`/api/gaeru_ceo/customers/${normalId}/permanent-delete`, 'POST', {
    password,
    reason: 'Khách yêu cầu xóa vĩnh viễn'
  });
  assert.equal(permDelRes.id, normalId);

  const checkDb = await pool.query('SELECT id FROM customers WHERE id = $1', [normalId]);
  assert.equal(checkDb.rows.length, 0);
});
