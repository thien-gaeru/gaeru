const test = require("node:test");
const assert = require("node:assert/strict");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const { createApp } = require("../src/app");

const customer = {
  id: "11111111-1111-4111-8111-111111111111",
  fullName: "GAERU Customer",
  email: "customer@example.com",
  phone: "0829191080",
  password_hash: bcrypt.hashSync("customer-password-123", 4)
};

const baseConfig = {
  NODE_ENV: "test",
  PORT: 0,
  SESSION_SECRET: "test-session-secret-with-at-least-32-characters",
  ADMIN_USERNAME: "manager",
  ADMIN_PASSWORD_HASH: bcrypt.hashSync("test-password", 4)
};

async function startApp(context, { pool, smtp, mailer } = {}) {
  // These legacy fixtures represent accounts without configured MFA.
  const adaptedPool=Object.create(pool);
  adaptedPool.query=(sql,...args)=>sql.includes("account_security")?Promise.resolve({rows:[],rowCount:0}):pool.query(sql,...args);
  if(pool.connect)adaptedPool.connect=async()=>{const client=await pool.connect();return {...client,query:(sql,...args)=>sql.includes("account_security")?Promise.resolve({rows:[],rowCount:0}):client.query(sql,...args)};};
  const app = createApp({
    config: { ...baseConfig, smtp },
    pool:adaptedPool,
    sessionStore: new session.MemoryStore(),
    customerMailer: mailer
  });
  const server = app.listen(0, "127.0.0.1");
  context.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve) => server.once("listening", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

async function getCsrf(baseUrl) {
  const response = await fetch(`${baseUrl}/api/csrf`);
  const body = await response.json();
  return { token: body.csrfToken, cookie: response.headers.get("set-cookie").split(";")[0] };
}

test("customers can register, sign in, inspect their own profile, and sign out", async (context) => {
  let registeredCustomer;
  const pool = {
    query: async (sql, values) => {
      if (sql.includes("INSERT INTO customers")) {
        assert.equal(values[1], "new@example.com");
        assert.equal(values[2], "+84829191080");
        registeredCustomer = {
          id: customer.id,
          fullName: values[0],
          email: values[1],
          phone: values[2],
          emailVerified: false
        };
        return { rows: [registeredCustomer] };
      }
      if (sql.includes("FROM customers WHERE email = $1")) {
        return { rows: [{ ...customer }] };
      }
      if (sql.includes("FROM customers WHERE id = $1")) {
        return { rows: [registeredCustomer] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    }
  };
  const baseUrl = await startApp(context, { pool });
  const initialCsrf = await getCsrf(baseUrl);
  const registration = await fetch(`${baseUrl}/api/customer-auth/register`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-Token": initialCsrf.token,
      Cookie: initialCsrf.cookie
    },
    body: JSON.stringify({
      fullName: "New Customer",
      email: "NEW@example.com",
      phone: "+84 829 191 080",
      password: "12345678"
    })
  });
  assert.equal(registration.status, 200);
  const registrationBody = await registration.json();
  assert.equal(registrationBody.customer.email, "new@example.com");
  assert.equal(registrationBody.customer.phone, "+84829191080");
  const cookie = registration.headers.get("set-cookie").split(";")[0];

  const profileResponse = await fetch(`${baseUrl}/api/customer-auth/me`, { headers: { Cookie: cookie } });
  assert.deepEqual(await profileResponse.json(), {
    authenticated: true,
    customer: {
      id: customer.id,
      fullName: "New Customer",
      email: "new@example.com",
      phone: "+84829191080",
      emailVerified: false
    }
  });

  const login = await fetch(`${baseUrl}/api/customer-auth/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-Token": registrationBody.csrfToken,
      Cookie: cookie
    },
    body: JSON.stringify({ email: customer.email, password: "customer-password-123" })
  });
  assert.equal(login.status, 200);
  const loginBody = await login.json();
  assert.equal(loginBody.customer.emailVerified, false);
  const loginCookie = login.headers.get("set-cookie").split(";")[0];

  const logout = await fetch(`${baseUrl}/api/customer-auth/logout`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-Token": loginBody.csrfToken,
      Cookie: loginCookie
    },
    body: "{}"
  });
  assert.equal(logout.status, 200);
  const logoutBody = await logout.json();
  assert.equal(logoutBody.authenticated, false);
  assert.equal(logoutBody.csrfToken.length, 64);
});

test("password reset reports when SMTP has not been configured", async (context) => {
  const baseUrl = await startApp(context, {
    pool: { query: async () => { throw new Error("Should not query customers without an email service."); } }
  });
  const csrf = await getCsrf(baseUrl);
  const response = await fetch(`${baseUrl}/api/customer-auth/password-reset/request`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-Token": csrf.token,
      Cookie: csrf.cookie
    },
    body: JSON.stringify({ email: customer.email, phone: customer.phone })
  });
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /dịch vụ email/);
});

test("password reset requires matching email and phone, sends a single-use link, and updates the password", async (context) => {
  const savedTokens = new Map();
  let sentMessage;
  let tokenUsed = false;
  const pool = {
    query: async (sql, values) => {
      if (sql.includes("SELECT id, email FROM customers WHERE email = $1 AND phone = $2")) {
        return { rows: values[0] === customer.email && values[1] === customer.phone ? [customer] : [] };
      }
      if (sql.includes("DELETE FROM customer_password_reset_tokens")) return { rows: [] };
      if (sql.includes("INSERT INTO customer_password_reset_tokens")) {
        savedTokens.set(values[1], customer.id);
        return { rows: [] };
      }
      throw new Error(`Unexpected pool query: ${sql}`);
    },
    connect: async () => ({
      query: async (sql, values) => {
        if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };
        if (sql.includes("SELECT id FROM customers WHERE id = $1 FOR UPDATE")) return { rows: [{ id: customer.id }] };
        if (sql.includes("DELETE FROM customer_password_reset_tokens")) {
          savedTokens.clear();
          return { rows: [] };
        }
        if (sql.includes("INSERT INTO customer_password_reset_tokens")) {
          savedTokens.set(values[1], customer.id);
          return { rows: [] };
        }
        if (sql.includes("FROM customer_password_reset_tokens") && sql.includes("FOR UPDATE")) {
          return { rows: !tokenUsed && savedTokens.has(values[0]) ? [{
            id: "22222222-2222-4222-8222-222222222222",
            customerId: customer.id
          }] : [] };
        }
        if (sql.includes("UPDATE customers SET password_hash")) {
          assert.equal(values[0], customer.id);
          tokenUsed = true;
          return { rowCount: 1, rows: [] };
        }
        if (sql.includes("UPDATE customer_password_reset_tokens")||sql.includes("UPDATE customer_account_setup_tokens")) return { rowCount: 1, rows: [] };
        throw new Error(`Unexpected client query: ${sql}`);
      },
      release() {}
    })
  };
  const smtp = {
    host: "smtp.example.com",
    port: 587,
    secure: false,
    user: "mailer",
    password: "mail-secret",
    from: "support@example.com",
    publicBaseUrl: "https://store.example"
  };
  const mailer = { sendMail: async (message) => { sentMessage = message; } };
  const baseUrl = await startApp(context, { pool, smtp, mailer });
  const csrf = await getCsrf(baseUrl);
  const response = await fetch(`${baseUrl}/api/customer-auth/password-reset/request`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-Token": csrf.token,
      Cookie: csrf.cookie
    },
    body: JSON.stringify({ email: customer.email, phone: "082 919 1080" })
  });
  assert.equal(response.status, 200);
  assert.equal(sentMessage.to, customer.email);
  assert.match(sentMessage.text, /password-reset/);
  const resetUrl = new URL(sentMessage.text.match(/https:\/\/\S+/)[0]);
  const token = resetUrl.searchParams.get("token");
  assert.ok(token);
  assert.equal(savedTokens.has(require("node:crypto").createHash("sha256").update(token).digest("hex")), true);

  const reset = await fetch(`${baseUrl}/api/customer-auth/password-reset/complete`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-Token": csrf.token,
      Cookie: csrf.cookie
    },
    body: JSON.stringify({ token, password: "abcdefgh" })
  });
  assert.equal(reset.status, 200);
  assert.match((await reset.json()).message, /đã được cập nhật/);

  const replay = await fetch(`${baseUrl}/api/customer-auth/password-reset/complete`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-Token": csrf.token,
      Cookie: csrf.cookie
    },
    body: JSON.stringify({ token, password: "another-new-password" })
  });
  assert.equal(replay.status, 400);
});

test("unverified customers can log in and verify their email with a single-use link", async (context) => {
  let emailVerified = false;
  const verificationTokens = new Map();
  let sentMessage;
  const pool = {
    query: async (sql, values) => {
      if (sql.includes("FROM customers WHERE email = $1")) {
        return { rows: [{ ...customer, emailVerified }] };
      }
      if (sql.includes("FROM customers WHERE id = $1")) {
        return { rows: [{ ...customer, emailVerified }] };
      }
      throw new Error(`Unexpected pool query: ${sql}`);
    },
    connect: async () => ({
      query: async (sql, values) => {
        if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };
        if (sql.includes("FROM customers WHERE email = $1")) {
          return { rows: [{ ...customer, emailVerified }] };
        }
        if (sql.includes("FROM customers WHERE id = $1 AND email_verified_at IS NULL")) {
          return { rows: emailVerified ? [] : [{ id: customer.id, fullName: customer.fullName, email: customer.email }] };
        }
        if (sql.includes("DELETE FROM customer_email_verification_tokens")) {
          verificationTokens.clear();
          return { rows: [] };
        }
        if (sql.includes("INSERT INTO customer_email_verification_tokens")) {
          verificationTokens.set(values[1], { id: "33333333-3333-4333-8333-333333333333", customerId: values[0] });
          return { rows: [] };
        }
        if (sql.includes("SELECT customer_id AS") && sql.includes("customer_email_verification_tokens")) {
          const storedToken = verificationTokens.get(values[0]);
          return { rows: storedToken ? [{ customerId: storedToken.customerId }] : [] };
        }
        if (sql.includes("SELECT id FROM customers WHERE id = $1 FOR UPDATE")) return { rows: [{ id: customer.id }] };
        if (sql.includes("SELECT id FROM customer_email_verification_tokens") && sql.includes("FOR UPDATE")) {
          return { rows: verificationTokens.has(values[0]) ? [{ id: verificationTokens.get(values[0]).id }] : [] };
        }
        if (sql.includes("UPDATE customers SET email_verified_at")) {
          emailVerified = true;
          return { rowCount: 1, rows: [{ ...customer, emailVerified: true }] };
        }
        if (sql.includes("UPDATE customer_email_verification_tokens")) {
          verificationTokens.clear();
          return { rowCount: 1, rows: [] };
        }
        throw new Error(`Unexpected client query: ${sql}`);
      },
      release() {}
    })
  };
  const smtp = {
    host: "smtp.example.com",
    port: 587,
    secure: false,
    user: "mailer",
    password: "mail-secret",
    from: "support@example.com",
    publicBaseUrl: "https://store.example"
  };
  const mailer = { sendMail: async (message) => { sentMessage = message; } };
  const baseUrl = await startApp(context, { pool, smtp, mailer });
  const csrf = await getCsrf(baseUrl);
  const login = await fetch(`${baseUrl}/api/customer-auth/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-Token": csrf.token,
      Cookie: csrf.cookie
    },
    body: JSON.stringify({ email: customer.email, password: "customer-password-123" })
  });
  assert.equal(login.status, 200);
  const loginBody = await login.json();
  assert.equal(loginBody.customer.emailVerified, false);
  const cookie = login.headers.get("set-cookie").split(";")[0];

  const request = await fetch(`${baseUrl}/api/customer-auth/email-verification/request`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-Token": loginBody.csrfToken,
      Cookie: cookie
    },
    body: "{}"
  });
  assert.equal(request.status, 200);
  assert.equal(sentMessage.to, customer.email);
  assert.match(sentMessage.text, /30 phút/);
  const verificationUrl = new URL(sentMessage.text.match(/https:\/\/\S+/)[0]);
  const token = verificationUrl.searchParams.get("verify");
  assert.ok(token);
  const tokenHash = require("node:crypto").createHash("sha256").update(token).digest("hex");
  assert.equal(verificationTokens.has(tokenHash), true);

  const complete = await fetch(`${baseUrl}/api/customer-auth/email-verification/complete`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-Token": loginBody.csrfToken,
      Cookie: cookie
    },
    body: JSON.stringify({ token })
  });
  assert.equal(complete.status, 200);
  assert.equal((await complete.json()).verified, true);

  const profile = await fetch(`${baseUrl}/api/customer-auth/me`, { headers: { Cookie: cookie } });
  assert.equal((await profile.json()).customer.emailVerified, true);

  const replay = await fetch(`${baseUrl}/api/customer-auth/email-verification/complete`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-Token": loginBody.csrfToken,
      Cookie: cookie
    },
    body: JSON.stringify({ token })
  });
  assert.equal(replay.status, 400);
});

test("customer registration and password reset reject passwords shorter than eight characters", async context => {
  const baseUrl = await startApp(context, { pool: { query: async () => { throw Error('Invalid password must not reach the database'); } } });
  const csrf = await getCsrf(baseUrl);
  for (const [path, data] of [
    ['register', {fullName:'Test Customer',email:'eight@example.test',phone:'0900000000',password:'1234567'}],
    ['password-reset/complete', {token:'a'.repeat(64),password:'1234567'}]
  ]) {
    const response = await fetch(`${baseUrl}/api/customer-auth/${path}`, {method:'POST', headers:{'Content-Type':'application/json','X-CSRF-Token':csrf.token,Cookie:csrf.cookie}, body:JSON.stringify(data)});
    assert.equal(response.status,400);
  }
});
test("verification SMTP authentication failures return an actionable error and discard the unused token", async context => {
  let tokenCount=0;
  const pool={
    query:async(sql)=>{if(sql.includes('DELETE FROM customer_email_verification_tokens')){tokenCount=0;return {rows:[]};}if(sql.includes('FROM customers WHERE email'))return {rows:[customer]};throw Error('Unexpected query');},
    connect:async()=>({query:async(sql)=>{if(sql.includes('FROM customers WHERE id'))return {rows:[customer]};if(sql.includes('INSERT INTO customer_email_verification_tokens'))tokenCount++;return {rows:[]};},release(){}})
  };
  const baseUrl=await startApp(context,{pool,smtp:{host:'smtp.example.test',port:587,secure:false,user:'test',password:'test',from:'sender@example.test',publicBaseUrl:'https://gaeru.com'},mailer:{sendMail:async()=>{throw Object.assign(Error('Private SMTP response'),{code:'EAUTH',responseCode:535});}}});
  const csrf=await getCsrf(baseUrl);
  const login=await fetch(baseUrl+'/api/customer-auth/login',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf.token,Cookie:csrf.cookie},body:JSON.stringify({email:customer.email,password:'customer-password-123'})});
  assert.equal(login.status,200);
  const session=await login.json();
  const response=await fetch(baseUrl+'/api/customer-auth/email-verification/request',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':session.csrfToken,Cookie:login.headers.get('set-cookie').split(';')[0]},body:'{}'});
  assert.equal(response.status,503);
  const result=await response.json();assert.match(result.error,/từ chối xác thực/);assert.doesNotMatch(result.error,/Private SMTP/);assert.equal(tokenCount,0);
});
