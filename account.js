const accountFeedback = document.querySelector("[data-account-feedback]");
const accountPanels = [...document.querySelectorAll("[data-account-panel]")];
let accountCsrfToken = "";
let currentCustomer = null;

function setAccountFeedback(message, isError = false) {
  accountFeedback.textContent = message;
  accountFeedback.classList.toggle("is-error", isError);
  accountFeedback.classList.toggle("is-success", Boolean(message) && !isError);
}

function activateAccountPanel(panelName) {
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
  document.querySelector('[data-address-book]')?.remove();
  currentCustomer = customer;
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

document.addEventListener('gaeru:customer-updated',()=>{const customer=window.GAERUCustomerSession?.customer;if(customer){if(currentCustomer?.id===customer.id){currentCustomer=customer;const profile=document.querySelector('[data-account-profile]');profile.querySelector('[data-customer-name]').textContent=customer.fullName;profile.querySelector('[data-customer-email]').textContent=customer.email;profile.querySelector('[data-customer-phone]').textContent=customer.phone;profile.querySelector('[data-email-verification-notice]').hidden=customer.emailVerified;}else showCustomerProfile(customer,false);}else if(currentCustomer){currentCustomer=null;document.querySelector('[data-address-book]')?.remove();activateAccountPanel('login');}});

async function initializeCustomerAccount() {
  let authenticated = false;
  try {
    const csrfResponse = await fetch("/api/csrf", { credentials: "same-origin" });
    const csrfBody = await csrfResponse.json().catch(() => null);
    if (!csrfResponse.ok || !csrfBody.csrfToken) throw new Error("Không thể khởi tạo phiên bảo mật.");
    accountCsrfToken = csrfBody.csrfToken;

    const sessionResponse = await fetch("/api/customer-auth/me", { credentials: "same-origin" });
    if (!sessionResponse.ok) throw new Error("Không thể tải thông tin tài khoản.");
    const session = await sessionResponse.json();
    authenticated = session.authenticated;
    if (authenticated) showCustomerProfile(session.customer);
  } catch (error) {
    setAccountFeedback(error.message || "Không thể kết nối máy chủ tài khoản.", true);
  }

  const resetToken = new URLSearchParams(window.location.search).get("token");
  const verificationToken = new URLSearchParams(window.location.search).get("verify");
  if (verificationToken) {
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
    const result = await accountRequest("/api/customer-auth/login", values);
    accountCsrfToken = result.csrfToken;
    showCustomerProfile(result.customer);
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

initializeCustomerAccount();
