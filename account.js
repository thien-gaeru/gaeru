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
    const result = await accountRequest("/api/customer-auth/password-reset/complete", {
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
