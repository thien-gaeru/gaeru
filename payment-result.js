(() => {
  const result = new URLSearchParams(location.search);
  const content = document.querySelector('#payment-result');
  if (!content) return;
  const orderNumber = result.get('order');
  const trackingToken = result.get('token') || result.get('trackingToken') || '';
  const providerNames = { vnpay:'VNPAY',  momo:'MoMo', zalopay:'ZaloPay', bank_transfer:'Chuyển khoản ngân hàng' };
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
  const vnpayCodeDetails = {
    '24': {
      title: 'Bạn đã hủy giao dịch thanh toán.',
      detail: 'Giao dịch thanh toán VNPAY đã được hủy theo yêu cầu. Đơn hàng của bạn vẫn được lưu lại; bạn có thể thanh toán lại bất kỳ lúc nào.'
    },
    '09': {
      title: 'Thẻ chưa kích hoạt Internet Banking.',
      detail: 'Thẻ hoặc tài khoản ngân hàng chưa kích hoạt dịch vụ thanh toán trực tuyến. Vui lòng liên hệ ngân hàng phát hành hoặc sử dụng phương thức khác.'
    },
    '10': {
      title: 'Xác thực OTP không thành công.',
      detail: 'Xác thực thông tin thẻ hoặc mã OTP không chính xác quá số lần quy định, hoặc thẻ đã hết hạn.'
    },
    '11': {
      title: 'Đã hết thời gian chờ thanh toán.',
      detail: 'Giao dịch thanh toán trên cổng VNPAY đã quá hạn thời gian chờ. Vui lòng thử lại.'
    },
    '12': {
      title: 'Thẻ hoặc tài khoản bị khóa.',
      detail: 'Thẻ hoặc tài khoản ngân hàng của bạn đang bị khóa. Vui lòng liên hệ ngân hàng phát hành.'
    },
    '51': {
      title: 'Số dư tài khoản không đủ.',
      detail: 'Số dư tài khoản ngân hàng không đủ để thực hiện thanh toán cho đơn hàng này.'
    },
    '65': {
      title: 'Vượt quá hạn mức giao dịch trong ngày.',
      detail: 'Tài khoản đã vượt quá hạn mức thanh toán trong ngày được ngân hàng cho phép.'
    },
    '75': {
      title: 'Ngân hàng đang bảo trì.',
      detail: 'Hệ thống ngân hàng thanh toán đang tạm thời bảo trì dịch vụ. Vui lòng thử lại sau.'
    },
    '79': {
      title: 'Nhập sai mật khẩu quá số lần.',
      detail: 'Bạn đã nhập sai mật khẩu thanh toán quá số lần quy định.'
    }
  };
  
  const momoCodeDetails = {
    '0': {
      title: 'Đã thanh toán thành công qua MoMo.',
      detail: 'Giao dịch qua Ví MoMo đã được xác nhận thành công.'
    },
    '1006': {
      title: 'Bạn đã hủy giao dịch trên Ví MoMo.',
      detail: 'Giao dịch thanh toán MoMo đã được hủy theo yêu cầu của bạn. Đơn hàng vẫn được lưu lại; bạn có thể thanh toán lại hoặc chọn phương thức khác.'
    },
    '1005': {
      title: 'Đã hết thời gian chờ thanh toán MoMo.',
      detail: 'Liên kết thanh toán trên ứng dụng MoMo đã hết hạn. Vui lòng thực hiện lại giao dịch.'
    },
    '1004': {
      title: 'Số tiền vượt quá hạn mức MoMo.',
      detail: 'Số tiền giao dịch vượt quá hạn mức thanh toán quy định của Ví MoMo.'
    },
    '2001': {
      title: 'Số dư Ví MoMo không đủ.',
      detail: 'Số dư trong Ví MoMo không đủ để thanh toán đơn hàng này. Vui lòng nạp thêm tiền hoặc đổi nguồn tiền thanh toán.'
    },
    '1001': {
      title: 'Tài khoản MoMo không đủ số dư.',
      detail: 'Tài khoản MoMo không đủ số dư để thực hiện thanh toán.'
    },
    '4100': {
      title: 'Tài khoản MoMo chưa xác thực.',
      detail: 'Tài khoản Ví MoMo của bạn cần được xác thực định danh (KYC) hoặc liên kết ngân hàng trước khi thực hiện giao dịch này.'
    }
  };
  
  const zalopayCodeDetails = {
    '1': {
      title: 'Đã thanh toán thành công qua ZaloPay.',
      detail: 'Giao dịch qua Ví điện tử ZaloPay đã được xác nhận thành công.'
    },
    '-49': {
      title: 'Bạn đã hủy giao dịch trên ZaloPay.',
      detail: 'Giao dịch thanh toán ZaloPay đã được hủy theo yêu cầu. Đơn hàng của bạn vẫn được lưu lại; bạn có thể thanh toán lại hoặc chọn phương thức khác.'
    },
    '-68': {
      title: 'Giao dịch ZaloPay không thành công.',
      detail: 'Nguồn tiền thanh toán không hợp lệ hoặc tài khoản không đủ số dư. Vui lòng kiểm tra lại số dư Ví ZaloPay hoặc thẻ liên kết.'
    },
    '-102': {
      title: 'Đã hết thời gian chờ thanh toán ZaloPay.',
      detail: 'Phiên thanh toán trên ZaloPay đã quá hạn thời gian cho phép. Vui lòng tạo lại giao dịch.'
    }
  };
  const responseCode = result.get('code');
  const provider = result.get('provider');
  const customFailed = (initialState === 'failed' && responseCode)
    ? (provider === 'vnpay' ? vnpayCodeDetails[responseCode] : provider === 'momo' ? momoCodeDetails[responseCode] : provider === 'zalopay' ? zalopayCodeDetails[responseCode] : null)
    : null;
  const message = ['pending','processing'].includes(initialState) && !canCheck ? messages.invalid : customFailed || (Object.hasOwn(messages,initialState) ? messages[initialState] : messages.invalid);
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
      try {
        window.GAERUAnalytics?.trackPurchase?.({
          orderNumber: order.orderNumber,
          totalVnd: order.totalVnd,
          shippingFeeVnd: order.shippingFeeVnd,
          items: order.items || []
        });
      } catch (_) {}
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
        const tokenParam = trackingToken ? `&token=${encodeURIComponent(trackingToken)}` : '';
        const response = await fetch(`/api/payments/order-status?order=${encodeURIComponent(orderNumber)}${tokenParam}`,{credentials:'same-origin',cache:'no-store',signal:request.signal});
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
