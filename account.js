const accountFeedback = document.querySelector("[data-account-feedback]");
const accountPanels = [...document.querySelectorAll("[data-account-panel]")];
let accountCsrfToken = "";
let currentCustomer = null;

function setAccountFeedback(message, isError = false) {
  accountFeedback.textContent = message;
  accountFeedback.classList.toggle("is-error", isError);
  accountFeedback.classList.toggle("is-success", Boolean(message) && !isError);
}

let currentActiveTab = 'orders';

function resolveInitialAccountTab() {
  const hash = (typeof window !== 'undefined' && window.location?.hash ? window.location.hash : '').replace('#', '').toLowerCase();
  if (hash === 'offers' || hash === 'account-offers' || hash === 'vouchers') return 'offers';
  if (hash === 'profile' || hash === 'account-overview' || hash === 'account-addresses') return 'profile';
  if (hash === 'security' || hash === 'account-security') return 'security';
  if (hash === 'warranties' || hash === 'account-warranties') return 'warranties';
  if (hash === 'orders' || hash === 'customer-orders') return 'orders';
  return 'orders';
}

function openAccountPopup(tabName) {
  const validTabs = ['orders', 'offers', 'profile', 'warranties', 'security'];
  if (!validTabs.includes(tabName)) tabName = 'orders';
  switchAccountTab(tabName, true);

  const dialog = document.querySelector('[data-account-popup-dialog]');
  if (!dialog) return;

  const meta = {
    orders: {
      icon: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="20" height="14" rx="2" ry="2"></rect><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"></path></svg>',
      iconBg: '#e8f2fe',
      iconColor: '#0071e3',
      title: 'Đơn hàng của bạn',
      subtitle: 'Theo dõi tiến trình vận chuyển, thanh toán và lịch sử đơn hàng'
    },
    profile: {
      icon: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>',
      iconBg: '#f3e8ff',
      iconColor: '#7c3aed',
      title: 'Hồ sơ & Sổ địa chỉ',
      subtitle: 'Chỉnh sửa thông tin cá nhân và quản lý sổ địa chỉ giao nhận hàng'
    },
    security: {
      icon: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>',
      iconBg: '#e6f8f0',
      iconColor: '#0d9488',
      title: 'Cài đặt bảo mật',
      subtitle: 'Xác thực hai yếu tố (2FA), đổi mật khẩu và đăng nhập Google'
    },
    warranties: {
      icon: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path></svg>',
      iconBg: '#fef3c7',
      iconColor: '#d97706',
      title: 'Bảo hành CARE+',
      subtitle: 'Quản lý thiết bị bảo hành chính hãng GAERU 12 tháng và tra cứu hồ sơ'
    },
    offers: {
      icon: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"></path><line x1="7" y1="7" x2="7.01" y2="7"></line></svg>',
      iconBg: '#fee2e2',
      iconColor: '#e11d48',
      title: 'Ví voucher & Ưu đãi',
      subtitle: 'Xem và lưu mã ưu đãi độc quyền, mã giảm giá áp dụng khi thanh toán'
    }
  }[tabName] || { icon: '📁', iconBg: '#f5f5f7', iconColor: '#1d1d1f', title: 'Chi tiết tài khoản', subtitle: '' };

  const iconEl = dialog.querySelector('[data-popup-icon]');
  const titleEl = dialog.querySelector('[data-popup-title]');
  const subtitleEl = dialog.querySelector('[data-popup-subtitle]');
  if (iconEl) {
    iconEl.innerHTML = meta.icon;
    iconEl.style.backgroundColor = meta.iconBg;
    iconEl.style.color = meta.iconColor;
  }
  if (titleEl) titleEl.textContent = meta.title;
  if (subtitleEl) subtitleEl.textContent = meta.subtitle;

  if (typeof dialog.showModal === 'function') {
    if (!dialog.open) dialog.showModal();
  } else {
    dialog.setAttribute('open', '');
  }
}

function closeAccountPopup() {
  const dialog = document.querySelector('[data-account-popup-dialog]');
  if (!dialog) return;
  if (typeof dialog.close === 'function') {
    if (dialog.open) dialog.close();
  } else {
    dialog.removeAttribute('open');
  }
  if (typeof window !== 'undefined' && window.location?.hash) {
    history.replaceState(null, '', window.location.pathname + '#customer-account');
  }
}


function switchAccountTab(tabName, updateHash = true) {
  const validTabs = ['orders', 'offers', 'profile', 'warranties', 'security'];
  if (!validTabs.includes(tabName)) tabName = 'orders';
  currentActiveTab = tabName;

  const links = document.querySelectorAll?.('[data-account-tab]') || [];
  links.forEach(link => {
    const isActive = link.dataset?.accountTab === tabName;
    link.classList?.toggle('is-active', isActive);
    link.setAttribute?.('aria-selected', isActive ? 'true' : 'false');
  });

  const panels = document.querySelectorAll?.('[data-account-tab-panel]') || [];
  panels.forEach(panel => {
    const isActive = panel.dataset?.accountTabPanel === tabName;
    panel.classList?.toggle('is-active', isActive);
  });

  if (tabName === 'security') {
    const secPanel = document.querySelector?.('[data-security-panel]');
    if (secPanel) {
      secPanel.open = true;
      secPanel.dispatchEvent?.(new Event('toggle'));
    }
  }

  if (updateHash && typeof window !== 'undefined' && window.location?.hash !== '#' + tabName) {
    history.replaceState(null, '', window.location.pathname + '#' + tabName);
  }
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
  const userBadge = document.querySelector?.('[data-account-user-badge]');
  if (userBadge) {
    userBadge.hidden = !customer;
    if (customer) {
      const nameEl = userBadge.querySelector?.('[data-account-user-name]');
      const emailEl = userBadge.querySelector?.('[data-account-user-email]');
      const avatarEl = userBadge.querySelector?.('[data-account-user-avatar]');
      if (nameEl) nameEl.textContent = customer.fullName || 'Khách hàng';
      if (emailEl) emailEl.textContent = customer.email || customer.phone || '';
      if (avatarEl) avatarEl.textContent = (customer.fullName || 'G').trim().charAt(0).toUpperCase();
    }
  }
  const headerBanner = document.querySelector?.('[data-account-header-banner]');
  if (headerBanner) {
    headerBanner.hidden = !customer;
    if (customer) {
      const nameEl = headerBanner.querySelector?.('[data-account-banner-name]');
      const emailEl = headerBanner.querySelector?.('[data-account-banner-email]');
      const phoneEl = headerBanner.querySelector?.('[data-account-banner-phone]');
      const avatarEl = headerBanner.querySelector?.('[data-account-banner-avatar]');
      const badgeEl = headerBanner.querySelector?.('[data-account-banner-badge]');
      if (nameEl) nameEl.textContent = customer.fullName || 'Khách hàng';
      if (emailEl) emailEl.textContent = customer.email || '';
      if (phoneEl) phoneEl.textContent = customer.phone ? (' · ' + customer.phone) : '';
      if (avatarEl) avatarEl.textContent = (customer.fullName || 'G').trim().charAt(0).toUpperCase();
      if (badgeEl) {
        badgeEl.textContent = customer.emailVerified ? 'Đã xác minh email' : 'Chưa xác minh email';
        badgeEl.classList.toggle('is-verified', Boolean(customer.emailVerified));
      }
    }
  }
  const hubGrid = document.querySelector?.('[data-account-hub-grid]');
  if (hubGrid) hubGrid.hidden = !customer;

  if (customer) {
    const initialTab = resolveInitialAccountTab();
    switchAccountTab(initialTab, false);
    const hash = (typeof window !== 'undefined' && window.location?.hash ? window.location.hash : '').replace('#', '').toLowerCase();
    if (['orders', 'offers', 'profile', 'warranties', 'security'].includes(hash)) {
      openAccountPopup(hash);
    } else {
      closeAccountPopup();
    }
  } else {
    closeAccountPopup();
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
  if (profile) profile.hidden = true;
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

const initialOauthError = new URLSearchParams(window.location.search).get('oauthError');
if (initialOauthError) {
  setAccountFeedback(decodeURIComponent(initialOauthError), true);
  history.replaceState(null, '', window.location.pathname + (window.location.hash || '#login'));
}

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

async function handleCustomerLogout() {
  try {
    const result = await accountRequest("/api/customer-auth/logout", {});
    if (result?.csrfToken) accountCsrfToken = result.csrfToken;
    activateAccountPanel("login");
    currentCustomer = null;
    document.querySelector('[data-address-book]')?.remove();
    document.querySelector('[data-security-panel]')?.remove();
    window.GAERUCustomerSession?.set(null);
    setAccountFeedback("Bạn đã đăng xuất.");
  } catch (error) {
    setAccountFeedback(error.message, true);
  }
}

document.querySelector("[data-account-logout]")?.addEventListener("click", handleCustomerLogout);

document.addEventListener("click", (e) => {
  const tabLink = e.target?.closest?.('[data-account-tab]');
  if (tabLink) {
    e.preventDefault();
    openAccountPopup(tabLink.dataset?.accountTab);
    return;
  }
  const closeBtn = e.target?.closest?.('[data-popup-close]');
  if (closeBtn) {
    e.preventDefault();
    closeAccountPopup();
    return;
  }
  const dialog = document.querySelector('[data-account-popup-dialog]');
  if (dialog && e.target === dialog) {
    closeAccountPopup();
    return;
  }
  const logoutBtn = e.target?.closest?.('[data-account-logout]');
  if (logoutBtn) {
    e.preventDefault();
    closeAccountPopup();
    handleCustomerLogout();
    return;
  }
});

if (typeof window !== 'undefined') {
  window.addEventListener?.('hashchange', () => {
    if (document.querySelector?.('.account-layout')?.classList?.contains('is-authenticated')) {
      const h = (window.location?.hash || '').replace('#', '').toLowerCase();
      if (['orders', 'offers', 'profile', 'warranties', 'security'].includes(h)) {
        openAccountPopup(h);
      } else {
        closeAccountPopup();
      }
    }
  });

  window.addEventListener?.('gaeru:workspace-ready', () => {
    if (currentCustomer) switchAccountTab(currentActiveTab, false);
  });

  window.addEventListener?.('gaeru:security-ready', () => {
    if (currentCustomer) switchAccountTab(currentActiveTab, false);
  });
}

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

  modal.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:16px;">
      <h3 style="margin:0;font-size:20px;letter-spacing:-0.02em;">Cấu hình Đăng nhập Google</h3>
      <button type="button" style="border:none;background:none;font-size:24px;cursor:pointer;color:#86868b;padding:4px 8px;" data-oauth-dialog-close aria-label="Đóng">×</button>
    </div>
    <p style="font-size:14px;line-height:1.6;color:#515154;margin-bottom:16px;">
      Để khách hàng có thể đăng nhập bằng tài khoản <strong>Google</strong>, hệ thống cần được cấu hình mã định danh <code>GOOGLE_CLIENT_ID</code>.
    </p>

    <div style="background:#f5f5f7;border-radius:14px;padding:16px;margin-bottom:20px;font-size:13px;line-height:1.65;color:#1d1d1f;">
      <strong style="display:block;margin-bottom:6px;color:#0071e3;">📌 2 Cách cấu hình nhanh:</strong>
      <strong>Cách 1: Trực quan trong Trang Quản trị (Khuyên dùng)</strong><br>
      Đăng nhập Quản trị viên (Chủ shop) ➔ vào menu <strong>Đăng nhập Google</strong> ➔ nhập Google Client ID và bấm Lưu.<br>
      <a href="/gaeru_ceo/#oauth" target="_blank" rel="noopener" class="button button-blue" style="display:inline-block;padding:8px 14px;border-radius:8px;font-size:12px;font-weight:600;text-decoration:none;margin-top:6px;margin-bottom:8px;">Mở ngay trang Cấu hình Google trong Quản trị ↗</a><br><br>
      <strong>Cách 2: Cấu hình qua tệp .env trên máy chủ</strong><br>
      Thêm dòng sau vào tệp <code>.env</code>:<br>
      <code style="display:block;background:#ffffff;padding:8px 12px;border-radius:8px;border:1px solid #d2d2d7;margin-top:6px;word-break:break-all;">
        GOOGLE_CLIENT_ID=123456789-xyz.apps.googleusercontent.com
      </code>
    </div>

    ${cfg?.isDev ? `
    <div style="background:#e7f5ee;border:1px solid #187443;border-radius:14px;padding:14px;margin-bottom:20px;font-size:13px;line-height:1.6;color:#187443;">
      <strong>🧪 Chế độ phát triển (Development / Admin Test):</strong><br>
      Bạn có thể thử nghiệm ngay luồng đăng nhập mà không cần Client ID thật.
      <div style="margin-top:10px;">
        <button type="button" class="button-blue" data-oauth-demo-test style="width:100%;min-height:38px;padding:8px 14px;border-radius:10px;font-size:13px;font-weight:600;">
          Thử nghiệm Đăng nhập Mock Google ngay
        </button>
      </div>
    </div>
    ` : ''}

    <div style="display:flex;gap:10px;justify-content:flex-end;align-items:center;">
      <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noopener" class="secondary-button" style="text-decoration:none;display:inline-flex;align-items:center;padding:9px 16px;border-radius:20px;font-size:13px;color:#0071e3;">
        Mở trang cấp mã Google ↗
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
        setAccountFeedback('Đang mô phỏng đăng nhập Google…');
        const result = await accountRequest('/api/customer-auth/oauth/google', { credential: 'mock-google-demo-token' });
        accountCsrfToken = result.csrfToken;
        showCustomerProfile(result.customer);
        setAccountFeedback('Đăng nhập thành công tài khoản Google (Demo)!');
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

let googleGsiInitialized = false;

function redirectToGoogleOAuth(cfg) {
  if (!cfg?.google?.clientId) return;
  const origin = (typeof window !== 'undefined' && window.location?.origin) ? window.location.origin : '';
  const redirectUri = origin + '/api/customer-auth/oauth/google-callback';
  const state = Math.random().toString(36).substring(2) + Date.now().toString(36);
  const nonce = Math.random().toString(36).substring(2) + Date.now().toString(36);
  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.set('client_id', cfg.google.clientId);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('response_type', 'id_token');
  authUrl.searchParams.set('response_mode', 'form_post');
  authUrl.searchParams.set('scope', 'openid email profile');
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('nonce', nonce);
  authUrl.searchParams.set('prompt', 'select_account');
  window.location.href = authUrl.toString();
}

async function initGoogleOAuth(interactive = false) {
  let cfg = null;
  try {
    cfg = await loadOAuthConfig();
    if (!cfg?.google?.clientId) {
      if (interactive) showOAuthConfigModal('Google', cfg);
      return;
    }

    if (!interactive) return;

    let sdkReady = Boolean(window.google?.accounts?.id);
    if (!sdkReady) {
      try {
        await new Promise((resolve, reject) => {
          const existing = document.querySelector('script[src*="accounts.google.com/gsi/client"]');
          if (existing && window.google?.accounts?.id) return resolve();
          const s = existing || document.createElement('script');
          if (!existing) {
            s.src = 'https://accounts.google.com/gsi/client';
            s.async = true;
            s.defer = true;
            document.head.appendChild(s);
          }
          s.addEventListener('load', resolve, { once: true });
          s.addEventListener('error', () => reject(new Error('GIS_LOAD_ERROR')), { once: true });
          setTimeout(() => {
            if (window.google?.accounts?.id) resolve();
            else reject(new Error('GIS_TIMEOUT'));
          }, 2500);
        });
        sdkReady = Boolean(window.google?.accounts?.id);
      } catch (e) {
        sdkReady = false;
      }
    }

    if (sdkReady && !googleGsiInitialized && window.google?.accounts?.id) {
      window.google.accounts.id.initialize({
        client_id: cfg.google.clientId,
        ux_mode: 'popup',
        login_uri: window.location.origin + '/api/customer-auth/oauth/google-callback',
        cancel_on_tap_outside: true,
        callback: async (response) => {
          try {
            if (!response?.credential) throw new Error('Không nhận được thông tin xác thực từ Google.');
            setAccountFeedback('Đang xác thực thông tin tài khoản Google...');
            const result = await accountRequest('/api/customer-auth/oauth/google', {
              credential: response.credential
            });
            accountCsrfToken = result.csrfToken;
            showCustomerProfile(result.customer);
            history.replaceState(null, '', window.location.pathname + '#customer-account');
            setAccountFeedback('Đăng nhập Google thành công!');
            const returnUrl = new URLSearchParams(window.location.search).get('returnUrl') || new URLSearchParams(window.location.search).get('redirect');
            if (returnUrl && returnUrl.startsWith('/')) {
              setTimeout(() => { window.location.href = returnUrl; }, 600);
            }
          } catch (err) {
            setAccountFeedback(err.message || 'Không thể đăng nhập Google lúc này.', true);
          }
        }
      });
      googleGsiInitialized = true;
    }

    if (sdkReady && window.google?.accounts?.id) {
      window.google.accounts.id.prompt((notification) => {
        if (notification.isNotDisplayed() || notification.isSkippedMoment()) {
          redirectToGoogleOAuth(cfg);
        }
      });
    } else {
      redirectToGoogleOAuth(cfg);
    }
  } catch (err) {
    if (interactive) {
      if (cfg?.google?.clientId) {
        redirectToGoogleOAuth(cfg);
        return;
      }
      setAccountFeedback(err.message || 'Chức năng đăng nhập Google cần được bật cấu hình GOOGLE_CLIENT_ID.', true);
    }
  }
}

if (typeof window !== 'undefined') {
  window.GAERUConnectGoogle = () => initGoogleOAuth(true);
}

function bindOAuthButtons() {
  document.querySelectorAll('[data-oauth-action="google"]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      initGoogleOAuth(true);
    });
  });
}

bindOAuthButtons();

if (typeof window !== 'undefined') {
  const popupDialog = document.querySelector('[data-account-popup-dialog]');
  if (popupDialog) {
    popupDialog.addEventListener('cancel', (e) => {
      e.preventDefault();
      closeAccountPopup();
    });
  }
}
