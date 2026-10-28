const accountFeedback = document.querySelector("[data-account-feedback]");
const accountPanels = [...document.querySelectorAll("[data-account-panel]")];
let accountCsrfToken = "";
let currentCustomer = null;

function setAccountFeedback(message, isError = false) {
  accountFeedback.textContent = message;
  accountFeedback.classList.toggle("is-error", isError);
  accountFeedback.classList.toggle("is-success", Boolean(message) && !isError);
}

function setAccountPresentation(customer) {
  document.querySelector('.account-layout')?.classList.toggle('is-authenticated', Boolean(customer));
  const navigation = document.querySelector('[data-account-navigation]');
  if (navigation) navigation.hidden = !customer;
  const heading = document.querySelector('[data-account-heading]');
  if (heading) heading.hidden = Boolean(customer);
  const intro = document.querySelector('[data-account-intro]');
  if (intro) intro.textContent = customer
    ? 'Thông tin, đơn hàng và bảo hành. Tất cả ở một nơi.'
    : 'Sử dụng email hoặc số điện thoại và mật khẩu để tiếp tục mua sắm và quản lý thông tin tài khoản.';
  const badge = document.querySelector('[data-customer-verification-status]');
  if (badge) {
    badge.textContent = customer?.emailVerified ? 'Đã xác minh email' : 'Chưa xác minh email';
    badge.classList.toggle('is-verified', Boolean(customer?.emailVerified));
  }
}

function finishAccountLoading() {
  const loading=document.querySelector("[data-account-loading]");
  if(loading) loading.hidden=true;
  document.querySelector("[data-account-card]")?.setAttribute("aria-busy","false");
}

function activateAccountPanel(panelName) {
  finishAccountLoading();
  setAccountPresentation(null);
  const profile = document.querySelector("[data-account-profile]");
  profile.hidden = true;
  accountPanels.forEach((panel) => {
    panel.hidden = panel.dataset.accountPanel !== panelName;
  });
  setAccountFeedback("");
}

async function accountRequest(url, body) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
  const freshCsrf = await fetch('/api/csrf', {credentials:'same-origin',cache:'no-store',signal:controller.signal});
  if (!freshCsrf.ok) throw new Error('Không thể khởi tạo phiên. Hãy thử lại.');
  accountCsrfToken = (await freshCsrf.json()).csrfToken;
  const response = await fetch(url, {
    method: "POST",
    credentials: "same-origin",
    signal: controller.signal,
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-Token": accountCsrfToken
    },
    body: JSON.stringify(body)
  });
  const result = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) throw new Error(result?.error || "Không thể hoàn tất yêu cầu. Vui lòng thử lại.");
  return result;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('Máy chủ phản hồi quá lâu. Chưa xác nhận được kết quả; hãy kiểm tra hộp thư trước khi thử lại.');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function showCustomerProfile(customer, publish = true) {
  finishAccountLoading();
  document.querySelector('[data-address-book]')?.remove();
  document.querySelector('[data-security-panel]')?.remove();
  currentCustomer = customer;
  setAccountPresentation(customer);
  accountPanels.forEach((panel) => { panel.hidden = true; });
  const profile = document.querySelector("[data-account-profile]");
  profile.hidden = false;
  profile.querySelector("[data-customer-name]").textContent = customer.fullName;
  profile.querySelector("[data-customer-email]").textContent = customer.email;
  profile.querySelector("[data-customer-phone]").textContent = customer.phone;
  profile.querySelector("[data-email-verification-notice]").hidden = customer.emailVerified;
  setAccountFeedback("");
  renderVerificationButton();
  if (publish) window.GAERUCustomerSession?.set(customer);
}

document.addEventListener('gaeru:customer-updated',()=>{const customer=window.GAERUCustomerSession?.customer;if(customer){if(currentCustomer?.id===customer.id){currentCustomer=customer;setAccountPresentation(customer);const profile=document.querySelector('[data-account-profile]');profile.querySelector('[data-customer-name]').textContent=customer.fullName;profile.querySelector('[data-customer-email]').textContent=customer.email;profile.querySelector('[data-customer-phone]').textContent=customer.phone;profile.querySelector('[data-email-verification-notice]').hidden=customer.emailVerified;}else showCustomerProfile(customer,false);}else if(currentCustomer){currentCustomer=null;document.querySelector('[data-address-book]')?.remove();activateAccountPanel('login');}});

async function confirmContactChangeFromUrl() {
  const token=new URLSearchParams(window.location.search).get('contactVerify');
  if(!token)return;
  if(!currentCustomer){activateAccountPanel('login');setAccountFeedback('Đăng nhập đúng tài khoản để xác nhận thay đổi email hoặc số điện thoại.');return;}
  try {
    const result=await accountRequest('/api/customer-auth/contact-change/complete',{token});
    if(result.customer)showCustomerProfile(result.customer);
    history.replaceState(null,'',window.location.pathname+'#customer-account');
    setAccountFeedback(result.message);
  }catch(error){setAccountFeedback(error.message,true);}
}

async function initializeCustomerAccount() {
  let authenticated = false;
  const controller=new AbortController();
  const timeout=setTimeout(()=>controller.abort(),15000);
  try {
    const sessionResponse = await fetch("/api/customer-auth/me", { credentials: "same-origin", cache: "no-store", signal:controller.signal });
    if (!sessionResponse.ok) throw new Error("Không thể tải thông tin tài khoản.");
    const session = await sessionResponse.json();
    authenticated = session.authenticated;
    if (authenticated) showCustomerProfile(session.customer);
    else activateAccountPanel("login");
  } catch (error) {
    if(currentCustomer) {
      showCustomerProfile(currentCustomer,false);
      setAccountFeedback('Chưa thể làm mới phiên tài khoản. Vui lòng thử lại.',true);
    } else {
      const message=document.querySelector('[data-account-loading-message]');
      if(message) message.textContent='Chưa thể tải tài khoản. Vui lòng kiểm tra kết nối và thử lại.';
      const retry=document.querySelector('[data-account-retry]');
      if(retry) retry.hidden=false;
      document.querySelector('[data-account-card]')?.setAttribute('aria-busy','false');
    }
    return;
  } finally {
    clearTimeout(timeout);
  }

  const resetToken = new URLSearchParams(window.location.search).get("token");
  const verificationToken = new URLSearchParams(window.location.search).get("verify");
  if (new URLSearchParams(window.location.search).get('contactVerify')) {
    await confirmContactChangeFromUrl();
  } else if (verificationToken) {
    try {
      const result = await accountRequest("/api/customer-auth/email-verification/complete", { token: verificationToken });
      history.replaceState(null, "", `${window.location.pathname}#customer-account`);
      if (result.verified && currentCustomer) {
        currentCustomer.emailVerified = true;
        showCustomerProfile(currentCustomer);
      }
      setAccountFeedback(result.message);
    } catch (error) {
      history.replaceState(null, "", `${window.location.pathname}#customer-account`);
      setAccountFeedback(error.message, true);
    }
  } else if (resetToken) {
    activateAccountPanel("password-reset");
    document.querySelector("[data-reset-request-panel]").hidden = true;
    document.querySelector("[data-reset-complete-panel]").hidden = false;
  } else if (window.location.hash === "#password-reset") {
    activateAccountPanel("password-reset");
  } else if (!authenticated && window.location.hash === "#register") {
    activateAccountPanel("register");
  } else if (!authenticated && window.location.hash === "#login") {
    activateAccountPanel("login");
  }
}

document.querySelector("[data-account-show-reset]")?.addEventListener("click", () => {
  activateAccountPanel("password-reset");
});
document.querySelector("[data-account-show-register]")?.addEventListener("click", (event) => {
  event.preventDefault();
  history.replaceState(null, "", `${window.location.pathname}#register`);
  activateAccountPanel("register");
});
document.querySelector("[data-account-show-login]")?.addEventListener("click", (event) => {
  event.preventDefault();
  history.replaceState(null, "", `${window.location.pathname}#login`);
  activateAccountPanel("login");
});

document.querySelector('[data-account-form="login"]')?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const values = Object.fromEntries(new FormData(form));
  try {
    let result = await accountRequest("/api/customer-auth/login", values);
    if(result.mfaRequired)result=await window.GAERUSecurity.loginChallenge(result);
    accountCsrfToken = result.csrfToken;
    showCustomerProfile(result.customer);
    await confirmContactChangeFromUrl();
  } catch (error) {
    setAccountFeedback(error.message, true);
  }
});

document.querySelector('[data-account-form="register"]')?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const values = Object.fromEntries(new FormData(form));
  if (values.password !== values.passwordConfirm) {
    setAccountFeedback("Mật khẩu nhập lại chưa khớp.", true);
    return;
  }
  try {
    const result = await accountRequest("/api/customer-auth/register", {
      fullName: values.fullName,
      email: values.email,
      phone: values.phone,
      password: values.password
    });
    accountCsrfToken = result.csrfToken;
    form.reset();
    showCustomerProfile(result.customer);
  } catch (error) {
    setAccountFeedback(error.message, true);
  }
});

document.querySelector('[data-account-form="password-reset-request"]')?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const values = Object.fromEntries(new FormData(event.currentTarget));
  try {
    const result = await accountRequest("/api/customer-auth/password-reset/request", values);
    setAccountFeedback(result.message);
  } catch (error) {
    setAccountFeedback(error.message, true);
  }
});

document.querySelector('[data-account-form="password-reset-complete"]')?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const values = Object.fromEntries(new FormData(form));
  if (values.password !== values.passwordConfirm) {
    setAccountFeedback("Mật khẩu nhập lại chưa khớp.", true);
    return;
  }
  const token = new URLSearchParams(window.location.search).get("token");
  try {
    const result = await accountRequest(new URLSearchParams(window.location.search).get("setup")==="1"?"/api/customer-auth/account-setup":"/api/customer-auth/password-reset/complete", {
      token,
      password: values.password
    });
    form.reset();
    history.replaceState(null, "", `${window.location.pathname}#password-reset`);
    document.querySelector("[data-reset-request-panel]").hidden = false;
    document.querySelector("[data-reset-complete-panel]").hidden = true;
    activateAccountPanel("login");
    setAccountFeedback(result.message);
  } catch (error) {
    setAccountFeedback(error.message, true);
  }
});

document.querySelector("[data-account-logout]")?.addEventListener("click", async () => {
  try {
    const result = await accountRequest("/api/customer-auth/logout", {});
    if (result.csrfToken) accountCsrfToken = result.csrfToken;
    activateAccountPanel("login");
    currentCustomer = null;
    document.querySelector('[data-address-book]')?.remove();
    window.GAERUCustomerSession?.set(null);
    setAccountFeedback("Bạn đã đăng xuất.");
  } catch (error) {
    setAccountFeedback(error.message, true);
  }
});

let verificationSending = false;
let verificationCooldownTimer;
const verificationCooldowns = new Map();

function renderVerificationButton() {
  const button = document.querySelector('[data-email-verification-request]');
  const feedback = document.querySelector('[data-email-verification-feedback]');
  if (!button) return;
  if (verificationSending) return;
  const deadline = verificationCooldowns.get(currentCustomer?.id) || 0;
  const remaining = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
  button.disabled = remaining > 0;
  button.textContent = remaining > 0 ? 'Đã gửi xác minh' : deadline ? 'Gửi lại xác minh' : 'Gửi email xác minh';
  if (feedback && deadline) {
    feedback.textContent = remaining > 0
      ? 'Nếu chưa nhận được mail, bạn có thể bấm gửi lại sau ' + remaining + ' giây.'
      : 'Nếu chưa nhận được mail, hãy kiểm tra thư rác hoặc bấm Gửi lại xác minh.';
    feedback.classList.remove('is-error', 'is-success');
  }
  return remaining;
}

document.querySelector("[data-email-verification-request]")?.addEventListener("click", async (event) => {
  const button = event.currentTarget;
  if (verificationSending || (verificationCooldowns.get(currentCustomer?.id) || 0) > Date.now()) return;
  const customerId = currentCustomer?.id;
  const feedback = document.querySelector('[data-email-verification-feedback]');
  const notify = (message, isError = false) => {
    if (currentCustomer?.id !== customerId) return;
    setAccountFeedback(message, isError);
    if (feedback) {
      feedback.textContent = message;
      feedback.classList.toggle('is-error', isError);
      feedback.classList.toggle('is-success', !isError);
    }
  };
  verificationSending = true;
  button.disabled = true;
  button.textContent = 'Đang gửi…';
  button.setAttribute('aria-busy', 'true');
  notify('Đang gửi email xác minh, vui lòng chờ…');
  try {
    const result = await accountRequest("/api/customer-auth/email-verification/request", {});
    if (result.verified) {
      if (currentCustomer?.id === customerId && currentCustomer) {
        currentCustomer.emailVerified = true;
        showCustomerProfile(currentCustomer);
      }
    } else {
      verificationCooldowns.set(customerId, Date.now() + 90_000);
      clearInterval(verificationCooldownTimer);
      verificationCooldownTimer = setInterval(() => {
        renderVerificationButton();
        if (![...verificationCooldowns.values()].some(deadline => deadline > Date.now())) clearInterval(verificationCooldownTimer);
      }, 1000);
    }
    notify(result.message);
    verificationSending = false;
    renderVerificationButton();
  } catch (error) {
    verificationSending = false;
    renderVerificationButton();
    notify(error.message || 'Chưa gửi được email. Vui lòng thử lại.', true);
  } finally {
    button.removeAttribute('aria-busy');
  }
});

document.querySelector('[data-account-retry]')?.addEventListener('click', () => {
  const retry=document.querySelector('[data-account-retry]');
  if(retry) retry.hidden=true;
  const message=document.querySelector('[data-account-loading-message]');
  if(message) message.textContent='Đang tải tài khoản…';
  document.querySelector('[data-account-card]')?.setAttribute('aria-busy','true');
  initializeCustomerAccount();
});

initializeCustomerAccount();


let oauthConfig = null;
async function loadOAuthConfig() {
  if (oauthConfig) return oauthConfig;
  try {
    const res = await fetch('/api/customer-auth/oauth/config', { cache: 'no-store' });
    if (res.ok) oauthConfig = await res.json();
  } catch (e) {
    console.warn('Cannot load oauth config', e);
  }
  return oauthConfig || { google: { configured: false, clientId: '' }, apple: { configured: false, clientId: '' } };
}

function showOAuthConfigModal(provider, cfg) {
  let modal = document.querySelector('[data-oauth-setup-dialog]');
  if (!modal) {
    modal = document.createElement('dialog');
    modal.setAttribute('data-oauth-setup-dialog', '');
    modal.className = 'security-dialog';
    document.body.appendChild(modal);
  }

  const isGoogle = provider === 'Google';
  const paramName = isGoogle ? 'GOOGLE_CLIENT_ID' : 'APPLE_CLIENT_ID';
  const guideLink = isGoogle
    ? 'https://console.cloud.google.com/apis/credentials'
    : 'https://developer.apple.com/account/resources/identifiers/list/serviceId';

  modal.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:16px;">
      <h3 style="margin:0;font-size:20px;letter-spacing:-0.02em;">Cấu hình Đăng nhập ${provider}</h3>
      <button type="button" style="border:none;background:none;font-size:24px;cursor:pointer;color:#86868b;padding:4px 8px;" data-oauth-dialog-close aria-label="Đóng">×</button>
    </div>
    <p style="font-size:14px;line-height:1.6;color:#515154;margin-bottom:16px;">
      Để khách hàng có thể đăng nhập bằng tài khoản <strong>${provider}</strong>, hệ thống cần được cấu hình mã định danh <code>${paramName}</code>.
    </p>

    <div style="background:#f5f5f7;border-radius:14px;padding:16px;margin-bottom:20px;font-size:13px;line-height:1.65;color:#1d1d1f;">
      <strong style="display:block;margin-bottom:6px;color:#0071e3;">📌 2 Cách cấu hình nhanh:</strong>
      <strong>Cách 1: Trực quan trong Trang Quản trị (Khuyên dùng)</strong><br>
      Đăng nhập Quản trị viên (Chủ shop) ➔ vào menu <strong>Đăng nhập Google & Apple</strong> ➔ nhập Client ID / Service ID và bấm Lưu.<br>
      <a href="/gaeru_ceo/#oauth" target="_blank" rel="noopener" class="button button-blue" style="display:inline-block;padding:8px 14px;border-radius:8px;font-size:12px;font-weight:600;text-decoration:none;margin-top:6px;margin-bottom:8px;">Mở ngay trang Cấu hình Google &amp; Apple trong Quản trị ↗</a><br><br>
      <strong>Cách 2: Cấu hình qua tệp .env trên máy chủ</strong><br>
      Thêm dòng sau vào tệp <code>.env</code>:<br>
      <code style="display:block;background:#ffffff;padding:8px 12px;border-radius:8px;border:1px solid #d2d2d7;margin-top:6px;word-break:break-all;">
        ${paramName}=${isGoogle ? '123456789-xyz.apps.googleusercontent.com' : 'com.gaeru.web.signin'}
      </code>
    </div>

    ${cfg?.isDev ? `
    <div style="background:#e7f5ee;border:1px solid #187443;border-radius:14px;padding:14px;margin-bottom:20px;font-size:13px;line-height:1.6;color:#187443;">
      <strong>🧪 Chế độ phát triển (Development / Admin Test):</strong><br>
      Bạn có thể thử nghiệm ngay luồng đăng nhập mà không cần Client ID thật.
      <div style="margin-top:10px;">
        <button type="button" class="button-blue" data-oauth-demo-test="${isGoogle ? 'google' : 'apple'}" style="width:100%;min-height:38px;padding:8px 14px;border-radius:10px;font-size:13px;font-weight:600;">
          Thử nghiệm Đăng nhập Mock ${provider} ngay
        </button>
      </div>
    </div>
    ` : ''}

    <div style="display:flex;gap:10px;justify-content:flex-end;align-items:center;">
      <a href="${guideLink}" target="_blank" rel="noopener" class="secondary-button" style="text-decoration:none;display:inline-flex;align-items:center;padding:9px 16px;border-radius:20px;font-size:13px;color:#0071e3;">
        Mở trang cấp mã ${provider} ↗
      </a>
      <button type="button" class="button-blue" data-oauth-dialog-close style="min-height:38px;padding:8px 18px;border-radius:20px;font-size:13px;">
        Đã hiểu
      </button>
    </div>
  `;

  modal.querySelectorAll('[data-oauth-dialog-close]').forEach(btn => {
    btn.onclick = () => modal.close();
  });

  const demoBtn = modal.querySelector('[data-oauth-demo-test]');
  if (demoBtn) {
    demoBtn.onclick = async () => {
      modal.close();
      try {
        setAccountFeedback(`Đang mô phỏng đăng nhập ${provider}…`);
        const endpoint = isGoogle ? '/api/customer-auth/oauth/google' : '/api/customer-auth/oauth/apple';
        const payload = isGoogle
          ? { credential: 'mock-google-demo-token' }
          : { idToken: 'mock-apple-demo-token', user: { name: { firstName: 'Demo', lastName: 'Apple' } } };
        const result = await accountRequest(endpoint, payload);
        accountCsrfToken = result.csrfToken;
        showCustomerProfile(result.customer);
        setAccountFeedback(`Đăng nhập thành công tài khoản ${provider} (Demo)!`);
      } catch (err) {
        setAccountFeedback(err.message, true);
      }
    };
  }

  if (typeof modal.showModal === 'function') {
    modal.showModal();
  } else {
    modal.setAttribute('open', '');
  }
}

async function handleGoogleOAuth() {
  try {
    const cfg = await loadOAuthConfig();
    if (!cfg?.google?.clientId) {
      showOAuthConfigModal('Google', cfg);
      return;
    }
    if (!window.google?.accounts?.id) {
      await new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'https://accounts.google.com/gsi/client';
        s.async = true;
        s.defer = true;
        s.onload = resolve;
        s.onerror = () => reject(new Error('Không thể tải Google Identity Services SDK. Vui lòng kiểm tra kết nối mạng.'));
        document.head.appendChild(s);
      });
    }
    window.google.accounts.id.initialize({
      client_id: cfg.google.clientId,
      callback: async (response) => {
        try {
          if (!response?.credential) throw new Error('Không nhận được thông tin xác thực từ Google.');
          const result = await accountRequest('/api/customer-auth/oauth/google', {
            credential: response.credential
          });
          accountCsrfToken = result.csrfToken;
          showCustomerProfile(result.customer);
          setAccountFeedback(result.isNew ? 'Đăng ký tài khoản Google thành công!' : 'Đăng nhập Google thành công!');
        } catch (err) {
          setAccountFeedback(err.message, true);
        }
      }
    });
    window.google.accounts.id.prompt();
  } catch (err) {
    setAccountFeedback(err.message || 'Không thể đăng nhập với Google lúc này.', true);
  }
}

async function handleAppleOAuth() {
  try {
    const cfg = await loadOAuthConfig();
    if (!cfg?.apple?.clientId) {
      showOAuthConfigModal('Apple', cfg);
      return;
    }
    if (!window.AppleID) {
      await new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'https://appleid.cdn-apple.com/appleauth/static/jsapi/appleid/auth.js';
        s.async = true;
        s.onload = resolve;
        s.onerror = () => reject(new Error('Không thể tải Apple Sign In SDK. Vui lòng kiểm tra kết nối mạng.'));
        document.head.appendChild(s);
      });
    }
    window.AppleID.auth.init({
      clientId: cfg.apple.clientId,
      scope: 'name email',
      redirectURI: window.location.origin + '/account.html',
      usePopup: true
    });
    const response = await window.AppleID.auth.signIn();
    const idToken = response?.authorization?.id_token;
    const user = response?.user;
    if (!idToken) throw new Error('Không nhận được mã xác thực Apple.');
    const result = await accountRequest('/api/customer-auth/oauth/apple', {
      idToken,
      user
    });
    accountCsrfToken = result.csrfToken;
    showCustomerProfile(result.customer);
    setAccountFeedback(result.isNew ? 'Đăng ký tài khoản Apple thành công!' : 'Đăng nhập Apple thành công!');
  } catch (err) {
    if (err && err.error === 'popup_closed_by_user') return;
    setAccountFeedback(err?.message || 'Đăng nhập Apple không thành công.', true);
  }
}

function bindOAuthButtons() {
  document.querySelectorAll('[data-oauth-action="google"]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      handleGoogleOAuth();
    });
  });
  document.querySelectorAll('[data-oauth-action="apple"]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      handleAppleOAuth();
    });
  });
}

bindOAuthButtons();
