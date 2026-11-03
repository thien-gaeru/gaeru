(() => {
  'use strict';
  const labels = { pending: 'Chờ xử lý', retry: 'Chờ thử lại', processing: 'Đang xử lý', unknown: 'Chưa rõ kết quả', dead: 'Đã dừng do lỗi', completed: 'Đã xử lý', skipped: 'Đã bỏ qua' };
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const date = value => value && Number.isFinite(new Date(value).getTime()) ? new Date(value).toLocaleString('vi-VN') : 'Chưa ghi nhận';
  let loading = false, selected = null, page = 1, state = 'all', jobsVersion = 0, latest = null, generation = 0;
  const owner = () => window.GAERUAdmin?.user?.role === 'owner' && window.GAERUAdmin?.user?.source === 'bootstrap';
  function box() {
    const root = document.querySelector('#overview-view'); if (!root) return null;
    let el = root.querySelector('#operational-checks');
    if (!el) {
      el = document.createElement('section'); el.id = 'operational-checks'; el.className = 'configuration-panel operations-center';
      el.innerHTML = '<div class="operations-heading"><div><p class="eyebrow">Vận hành</p><h2>Hàng đợi hệ thống</h2></div><button type="button" class="secondary-button" data-operations-refresh>Kiểm tra lại</button></div><p data-operations-health></p><p role="status" data-operations-status></p><div data-operations-queues></div><section class="operations-jobs" data-operations-jobs hidden></section>';
      root.append(el);
      el.querySelector('[data-operations-refresh]').addEventListener('click', () => void load());
      el.addEventListener('click', async event => {
        const target = event.target;
        const queue = target.closest('[data-operations-queue]');
        if (queue) { selected = queue.dataset.operationsQueue; page = 1; state = 'all'; await loadJobs(); }
        const paging = target.closest('[data-operations-page]');
        if (paging) { page += Number(paging.dataset.operationsPage); await loadJobs(); }
        const retry = target.closest('[data-operations-retry]');
        if (!retry || selected !== 'chat-compression') return;
        retry.disabled = true;
        const status = el.querySelector('[data-operations-job-status]'); status.textContent = 'Đang đưa tệp trở lại hàng đợi…';
        try {
          const result = await window.GAERUAdmin.request('/api/gaeru_ceo/shopping-chat/compression-jobs/' + encodeURIComponent(retry.dataset.operationsRetry) + '/retry', { method: 'POST', body: '{}' });
          await load(); await loadJobs();
          const currentStatus = el.querySelector('[data-operations-job-status]'); if (currentStatus) currentStatus.textContent = result.message;
        } catch (error) { status.textContent = error.message || 'Chưa thử lại được. Tải lại dữ liệu.'; retry.disabled = false; }
      });
      el.addEventListener('change', event => {
        if (event.target.matches('[data-operations-state]')) { state = event.target.value; page = 1; void loadJobs(); }
      });
    }
    return el;
  }
  function renderQueues(el, data) {
    latest = data;
    el.querySelector('[data-operations-status]').textContent = 'Đã kiểm tra ' + date(data.checkedAt) + '. Chưa đo nhịp hoạt động của tiến trình nền.';
    el.querySelector('[data-operations-queues]').innerHTML = '<p class="operations-note">Số liệu từ cơ sở dữ liệu tại thời điểm kiểm tra. Email “đã xử lý” nghĩa là SMTP đã tiếp nhận; chưa xác nhận thư đến hộp thư. Tác vụ chưa rõ kết quả cần đối soát tại dịch vụ, không tự gửi lại.</p><div class="operations-queue-grid">' + data.queues.map(q => '<article class="operations-queue ' + (q.health === 'attention' ? 'needs-attention' : '') + '"><h3>' + esc(q.title) + '</h3>' + (q.availability !== 'measured'
      ? '<p role="alert">Chưa đọc được dữ liệu; số lượng chưa xác định.</p>'
      : '<dl class="operations-counts">' + Object.entries(labels).map(([key, label]) => '<div><dt>' + label + '</dt><dd>' + Number(q.counts[key] || 0) + '</dd></div>').join('') + '</dl><p class="operations-meta">Chờ lâu nhất: ' + esc(date(q.oldestPendingAt)) + '<br>Lần xử lý gần nhất: ' + esc(date(q.lastAttemptedAt)) + (q.staleCount ? '<br><strong>' + Number(q.staleCount) + ' tác vụ quá thời gian xử lý, cần kiểm tra.</strong>' : '') + '</p>') + '<div class="operations-actions"><button type="button" class="secondary-button" data-operations-queue="' + esc(q.id) + '">Xem tác vụ</button><a href="' + esc(q.href) + '">Mở nghiệp vụ ↗</a></div></article>').join('') + '</div>';
  }
  function jobMarkup(job) {
    const fields = [['Lần thử', job.attempts == null ? 'Chưa ghi nhận' : Number(job.attempts)], ['Tạo lúc', date(job.createdAt)], ['Thử gần nhất', date(job.attemptedAt)], ['Hoàn tất lúc', date(job.finishedAt)]];
    if (['pending', 'retry'].includes(job.state)) fields.push(['Lịch xử lý', date(job.nextAttemptAt)]);
    if (job.leaseUntil) fields.push(['Giữ tác vụ đến', date(job.leaseUntil)]);
    return '<article class="operations-job"><div class="operations-job-title"><code>' + esc(job.id) + '</code><strong>' + esc(labels[job.state] || job.state) + '</strong></div><dl>' + fields.map(([key, value]) => '<div><dt>' + key + '</dt><dd>' + esc(value) + '</dd></div>').join('') + '</dl>' + (job.stale ? '<p class="operations-warning">Quá thời gian xử lý đã ghi nhận. Kiểm tra nghiệp vụ trước khi tiếp tục.</p>' : '') + (job.errorCode ? '<p>Mã lỗi: <code>' + esc(job.errorCode) + '</code></p>' : '') + (job.retryAllowed && window.GAERUAdmin.can('customers.write') ? '<button type="button" class="secondary-button" data-operations-retry="' + esc(job.id) + '">Thử lại nén tệp</button>' : '') + '</article>';
  }
  async function loadJobs() {
    const el = box(), queue = latest?.queues.find(q => q.id === selected);
    if (!el || !owner() || !queue) return;
    const version = ++jobsVersion, content = el.querySelector('[data-operations-jobs]');
    content.hidden = false; content.setAttribute('aria-busy', 'true');
    content.innerHTML = '<h3>' + esc(queue.title) + '</h3><p role="status">Đang đọc tác vụ…</p>';
    try {
      const data = await window.GAERUAdmin.request('/api/gaeru_ceo/owner/operations/queues/' + encodeURIComponent(selected) + '/jobs?state=' + encodeURIComponent(state) + '&page=' + page);
      if (version !== jobsVersion || !owner()) return;
      content.innerHTML = '<div class="operations-heading"><h3>' + esc(queue.title) + '</h3><label>Trạng thái<select data-operations-state><option value="all">Tất cả</option>' + Object.entries(labels).map(([key, label]) => '<option value="' + key + '"' + (state === key ? ' selected' : '') + '>' + label + '</option>').join('') + '</select></label></div><p class="operations-note">Email và vận đơn có kết quả chưa rõ chỉ được theo dõi tại đây. Nén tệp chỉ có thể thử lại khi đã lỗi hoặc hết thời gian giữ tác vụ và còn trong thời hạn xử lý 30 ngày.</p><p role="status" data-operations-job-status></p><div class="operations-job-list">' + (data.jobs.length ? data.jobs.map(jobMarkup).join('') : '<p>Không có tác vụ phù hợp.</p>') + '</div><nav class="operations-pagination" aria-label="Phân trang tác vụ"><button type="button" class="secondary-button" data-operations-page="-1"' + (page <= 1 ? ' disabled' : '') + '>Trước</button><span>Trang ' + page + ' · ' + Number(data.total) + ' tác vụ</span><button type="button" class="secondary-button" data-operations-page="1"' + (page * data.pageSize >= data.total ? ' disabled' : '') + '>Tiếp</button></nav>';
    } catch (error) {
      if (version !== jobsVersion) return;
      content.innerHTML = '<h3>' + esc(queue.title) + '</h3><p role="alert">' + esc(error.message || 'Chưa đọc được tác vụ. Vui lòng kiểm tra lại.') + '</p>';
    } finally { if (version === jobsVersion) content.removeAttribute('aria-busy'); }
  }
  async function load() {
    const admin = window.GAERUAdmin; if (loading || !admin?.can('dashboard.read')) return;
    const el = box(); if (!el) return;
    loading = true; const loadGeneration = generation, refresh = el.querySelector('[data-operations-refresh]'); refresh.disabled = true;
    const status = el.querySelector('[data-operations-status]'); status.setAttribute('role', 'status'); status.textContent = 'Đang kiểm tra vận hành…';
    try {
      const health = await admin.request('/api/gaeru_ceo/system-health'), checks = health.checks || {};
      if (loadGeneration !== generation) return;
      el.querySelector('[data-operations-health]').textContent = 'HTTPS: ' + (health.security?.tlsEnforced === true ? 'Có' : health.security?.tlsEnforced === false ? 'Không' : 'Chưa đo') + ' · Lưu trữ: ' + ({ accessible: 'Đọc/ghi được; chưa kiểm chứng sao lưu', unavailable: 'Chưa truy cập được', not_configured: 'Chưa cấu hình' }[checks.storage?.status] || 'Chưa đo') + ' · Email: ' + (checks.smtp?.status === 'configured_unverified' ? 'Đã cấu hình; chưa xác minh gửi thực tế' : 'Chưa cấu hình');
      if (owner()) {
        const data = await admin.request('/api/gaeru_ceo/owner/operations/queues');
        if (loadGeneration !== generation || !owner()) return;
        renderQueues(el, data);
      }
      else {
        latest = null; jobsVersion++; selected = null; el.querySelector('[data-operations-jobs]').hidden = true;
        el.querySelector('[data-operations-queues]').innerHTML = '<p>' + Number(checks.failedOrUnknown || 0) + ' tác vụ email lỗi hoặc chưa rõ kết quả. Chủ doanh nghiệp có thể xem chi tiết hàng đợi tại Tổng quan.</p>';
        status.textContent = 'Đã kiểm tra. Chưa đo nhịp hoạt động của tiến trình nền.';
      }
    } catch (error) {
      if (loadGeneration !== generation) return;
      status.textContent = 'Chưa cập nhật được dữ liệu: ' + (error.message || 'Vui lòng kiểm tra lại.'); status.setAttribute('role', 'alert');
      el.querySelector('[data-operations-queues]').innerHTML = ''; el.querySelector('[data-operations-jobs]').hidden = true;
    } finally { loading = false; refresh.disabled = false; if (loadGeneration !== generation) void load(); }
  }
  document.addEventListener('gaeru:admin-ready', () => {
    generation++; jobsVersion++; selected = null; latest = null;
    const el = box();
    if (el) { el.querySelector('[data-operations-queues]').innerHTML = ''; el.querySelector('[data-operations-jobs]').hidden = true; }
    void load();
  });
  window.addEventListener('hashchange', () => { if (!location.hash || location.hash === '#overview') void load(); });
  window.GAERUOperations = Object.freeze({ load });
})();
