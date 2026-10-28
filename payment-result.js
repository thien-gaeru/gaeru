(() => {
  const result = new URLSearchParams(location.search);
  const content = document.querySelector('#payment-result');
  if (!content) return;
  const orderNumber = result.get('order');
  const providerNames = { vnpay:'VNPAY', '9pay':'9Pay', momo:'MoMo', zalopay:'ZaloPay', bank_transfer:'Chuyển khoản ngân hàng' };
  const waiting = {
    title:'Đang kiểm tra trạng thái thanh toán.',
    detail:'GAERU đang chờ xác nhận từ máy chủ. Trang chuyển hướng chưa phải bằng chứng thanh toán thành công.'
  };
  const messages = {
    pending:waiting,
    processing:waiting,
    failed:{title:'Giao dịch chưa hoàn tất.',detail:'Đơn hàng chưa được xác nhận đã thanh toán. Nếu tài khoản đã bị trừ tiền, liên hệ GAERU để đối chiếu trước khi thanh toán lại.'},
    invalid:{title:'Không thể xác minh kết quả giao dịch.',detail:'Không sử dụng trang chuyển hướng này làm xác nhận thanh toán. Liên hệ GAERU để kiểm tra đơn hàng.'}
  };
  const initialState = result.get('result');
  const canCheck = ['pending','processing'].includes(initialState) && orderNumber && orderNumber.length <= 120;
  const message = ['pending','processing'].includes(initialState) && !canCheck ? messages.invalid : Object.hasOwn(messages,initialState) ? messages[initialState] : messages.invalid;
  const title = document.createElement('h2');
  const detail = document.createElement('p');
  title.textContent = message.title;
  detail.textContent = message.detail;
  content.replaceChildren(title, detail);
  if (orderNumber) {
    const order = document.createElement('p');
    order.textContent = `Mã đơn: ${orderNumber}`;
    content.append(order);
  }
  if (!canCheck) return;

  const retry = document.createElement('button');
  retry.type = 'button';
  retry.className = 'button button-blue';
  retry.textContent = 'Kiểm tra lại trạng thái';
  retry.setAttribute('data-payment-status-retry','');
  retry.hidden = true;
  content.append(retry);
  const MAX_ATTEMPTS = 6, POLL_DELAY = 2500, MAX_DURATION = 30000, REQUEST_TIMEOUT = 4500;
  let generation = 0, running = false, pageActive = true, pollTimer, deadlineTimer, requestTimer, controller, deadlineAt;

  function stopPolling() {
    running = false;
    generation++;
    clearTimeout(pollTimer);
    clearTimeout(deadlineTimer);
    clearTimeout(requestTimer);
    controller?.abort();
    controller = null;
  }
  function unknown() {
    stopPolling();
    title.textContent = 'Chưa có xác nhận thanh toán từ máy chủ.';
    detail.textContent = 'Việc kiểm tra tự động đã dừng. Bạn có thể kiểm tra lại hoặc liên hệ GAERU nếu đã bị trừ tiền; không cần thanh toán lại khi chưa đối chiếu.';
    retry.hidden = false;
  }
  function showOrder(order) {
    if (!order || order.orderNumber !== orderNumber) return false;
    if (order.paymentStatus === 'paid') {
      stopPolling();
      retry.hidden = true;
      if (order.status === 'cancelled') {
        title.textContent = 'Đơn hàng đã hủy; đã ghi nhận thanh toán.';
        detail.textContent = 'Liên hệ GAERU để đối chiếu khoản tiền và xử lý hoàn tiền nếu cần. Đơn đã hủy không được tự chuyển sang giao hàng.';
      } else {
        const provider = Object.hasOwn(providerNames,order.paymentMethod) ? providerNames[order.paymentMethod] : 'cổng thanh toán';
        title.textContent = `Đã thanh toán thành công qua ${provider}.`;
        const states = {pending:'Đơn hàng đang chờ xử lý.',confirmed:'Đơn hàng đã xác nhận và đang chờ xử lý.',processing:'Đơn hàng đang chờ gửi hàng.',shipped:'Đơn hàng đang được giao.',completed:'Đơn hàng đã hoàn tất.'};
        detail.textContent = Object.hasOwn(states,order.status) ? states[order.status] : 'Máy chủ đã ghi nhận thanh toán. Liên hệ GAERU để kiểm tra tiến độ đơn hàng.';
      }
      return true;
    }
    if (order.status === 'cancelled' || ['failed','cancelled','expired'].includes(order.paymentStatus)) {
      stopPolling();
      title.textContent = order.status === 'cancelled' ? 'Đơn hàng đã hủy.' : messages.failed.title;
      detail.textContent = 'Máy chủ chưa ghi nhận thanh toán thành công cho đơn hàng. Nếu tài khoản đã bị trừ tiền, liên hệ GAERU để đối chiếu trước khi thanh toán lại.';
      retry.hidden = false;
      return true;
    }
    return false;
  }
  function startPolling() {
    if (!pageActive || running) return;
    stopPolling();
    running = true;
    retry.hidden = true;
    title.textContent = waiting.title;
    detail.textContent = waiting.detail;
    const current = generation;
    deadlineAt = Date.now() + MAX_DURATION;
    let attempts = 0;
    const isCurrent = () => running && pageActive && current === generation;
    deadlineTimer = setTimeout(() => { if (isCurrent()) unknown(); }, MAX_DURATION);
    async function check() {
      if (!isCurrent()) return;
      if (Date.now() >= deadlineAt) return unknown();
      attempts++;
      const request = new AbortController();
      controller = request;
      const timeout = setTimeout(() => request.abort(), Math.min(REQUEST_TIMEOUT, deadlineAt - Date.now()));
      requestTimer = timeout;
      let body;
      try {
        const response = await fetch(`/api/payments/order-status?order=${encodeURIComponent(orderNumber)}`,{credentials:'same-origin',cache:'no-store',signal:request.signal});
        if (response.ok) body = await response.json();
      } catch {
        // An unavailable network is unknown, never a successful or failed payment.
      } finally {
        clearTimeout(timeout);
        if (requestTimer === timeout) requestTimer = undefined;
        if (controller === request) controller = null;
      }
      if (!isCurrent()) return;
      if (showOrder(body?.order)) return;
      if (attempts >= MAX_ATTEMPTS || Date.now() >= deadlineAt) return unknown();
      pollTimer = setTimeout(check,Math.min(POLL_DELAY,deadlineAt-Date.now()));
    }
    void check();
  }
  retry.addEventListener('click',startPolling);
  window.addEventListener('pagehide',() => {pageActive=false;stopPolling();});
  window.addEventListener('pageshow',event => {pageActive=true;if(event.persisted)startPolling();});
  startPolling();
})();
