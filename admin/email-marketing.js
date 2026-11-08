(()=>{
  const admin = window.GAERUAdmin;
  let root, data;
  const h = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const label = { draft: 'Bản nháp', scheduled: 'Đã lên lịch', sending: 'Đang gửi', completed: 'Đã xử lý', cancelled: 'Đã hủy' };
  const subLabel = { subscribed: 'Đã xác nhận', pending: 'Chờ xác nhận', unsubscribed: 'Đã ngừng nhận' };
  const local = v => {
    const d = new Date(v);
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  };

  const templates = {
    k9: {
      title: 'Giới thiệu Microphone GAERU K9',
      subject: 'Khám phá Microphone Không Dây GAERU K9 - Thu âm đỉnh cao mọi góc nhìn',
      body: 'Chào bạn,\n\nGAERU trân trọng giới thiệu dòng Microphone thu âm không dây GAERU K9 - giải pháp âm thanh chuyên nghiệp dành riêng cho nhà sáng tạo nội dung, livestream và phỏng vấn di động.\n\nĐặc điểm nổi bật của GAERU K9:\n• Kết nối không dây tức thì, độ trễ cực thấp dưới 15ms\n• Khử tiếng ồn môi trường DSP thông minh\n• Thời lượng pin liên tục lên đến 8 giờ\n• Tương thích hoàn hảo với điện thoại thông minh, máy tính bảng và máy ảnh\n\nKhám phá chi tiết sản phẩm và nhận ưu đãi tại: https://gaeru.com/discover-k9.html\n\nTrân trọng,\nĐội ngũ GAERU'
    },
    g1: {
      title: 'Ra mắt GAERU G1 ULTRA Studio',
      subject: 'Đột phá âm thanh chuyên nghiệp cùng GAERU G1 ULTRA',
      body: 'Chào bạn,\n\nĐỉnh cao công nghệ thu âm studio nay nằm gọn trong tầm tay với GAERU G1 ULTRA.\n\nSức mạnh vượt trội:\n• Chip xử lý âm thanh AI-Core thế hệ mới lọc tạp âm 3 cấp độ\n• Hộp sạc thông minh hiển thị pin OLED, tổng thời lượng lên tới 36 giờ\n• Khoảng cách truyền tín hiệu ổn định 50 mét xuyên vật cản\n• Kèm ngàm kẹp từ tính cao cấp và cáp chuyển đổi chuyên dụng\n\nTìm hiểu thêm về GAERU G1 ULTRA tại: https://gaeru.com/discover-g1-ultra.html\n\nTrân trọng,\nĐội ngũ GAERU'
    }
  };

  async function load() {
    root = document.querySelector('#marketing-email-workspace');
    if (!root) return;
    try {
      data = await admin.request('/api/gaeru_ceo/marketing/emails');
      const subs = data.subscriberStats || {};
      const smtp = data.smtpStats || {};

      root.innerHTML = `
        <div class="marketing-section-heading">
          <div>
            <h2>Email marketing</h2>
            <p class="help-text">${data.audienceCount || subs.subscribed || 0} người đăng ký đã xác nhận · ${data.configured ? '<span style="color:#2e7d32;font-weight:600;">SMTP đã cấu hình</span>' : '<span style="color:#d32f2f;font-weight:600;">Chưa cấu hình SMTP</span>'}</p>
          </div>
          <div class="marketing-email-actions">
            <button type="button" class="secondary-button" data-email-refresh>Làm mới</button>
            ${admin.can('marketing.write') ? '<button type="button" class="primary-button" data-email-new>Soạn email</button>' : ''}
          </div>
        </div>

        <div class="marketing-email-stats-grid">
          <div class="metric-card">
            <span>Đã đăng ký (Double Opt-In)</span>
            <strong class="stat-blue">${subs.subscribed ?? data.audienceCount ?? 0}</strong>
          </div>
          <div class="metric-card">
            <span>Chờ xác nhận</span>
            <strong class="stat-orange">${subs.pending ?? 0}</strong>
          </div>
          <div class="metric-card">
            <span>SMTP tiếp nhận</span>
            <strong class="stat-green">${smtp.total_sent ?? 0}</strong>
          </div>
          <div class="metric-card">
            <span>Lỗi gửi SMTP</span>
            <strong class="stat-red">${smtp.total_failed ?? 0}</strong>
          </div>
          <div class="metric-card">
            <span>Tổng chiến dịch</span>
            <strong class="stat-dark">${data.campaigns.length}</strong>
          </div>
        </div>

        <p class="help-text">Tuân thủ Nghị định 13/2023/NĐ-CP và RFC 8058: Chỉ gửi email marketing đến khách hàng đã chủ động xác nhận (Double Opt-In). Thư gửi có tiêu đề List-Unsubscribe hủy nhận một chạm.</p>
        <div data-email-editor></div>

        <div class="marketing-email-list">
          ${(data.campaigns.map(c => `
            <article class="marketing-email-card">
              <div class="marketing-promotion-top">
                <span class="status-pill status-${c.status}">${label[c.status] || c.status}</span>
                <small style="color:#86868b;">${new Date(c.scheduled_at).toLocaleString('vi-VN')}</small>
              </div>
              <h3>${h(c.title)}</h3>
              <p class="campaign-subject">${h(c.subject)}</p>
              <div class="marketing-email-metrics">
                <div class="metric-item"><strong>${c.total}</strong><span>Người nhận</span></div>
                <div class="metric-item"><strong style="color:#2e7d32;">${c.sent}</strong><span>SMTP tiếp nhận</span></div>
                <div class="metric-item"><strong style="color:#e65100;">${c.pending}</strong><span>Đang chờ</span></div>
                <div class="metric-item"><strong style="color:#d32f2f;">${c.failed}</strong><span>Bị từ chối</span></div>
                <div class="metric-item"><strong style="color:#757575;">${c.unknown}</strong><span>Chưa rõ</span></div>
                <div class="metric-item"><strong style="color:#9e9e9e;">${c.skipped}</strong><span>Bỏ qua</span></div>
              </div>
              <div class="marketing-email-actions">
                <button type="button" class="secondary-button" data-email-view="${c.id}">${c.status === 'draft' && admin.can('marketing.write') ? 'Mở bản nháp' : 'Xem nội dung'}</button>
                ${admin.can('marketing.write') && ['draft', 'scheduled', 'sending'].includes(c.status) ? `<button type="button" class="secondary-button" data-email-cancel="${c.id}">${c.status === 'draft' ? 'Hủy bản nháp' : 'Dừng chiến dịch'}</button>` : ''}
              </div>
              <div data-email-confirm="${c.id}"></div>
            </article>
          `).join('')) || '<div class="workspace-empty"><strong>Email đầu tiên bắt đầu từ một bản nháp</strong><p>Soạn nội dung, chọn nguồn email đã xác nhận và cài giờ gửi.</p></div>'}
        </div>

        ${data.subscribers && data.subscribers.length ? `
          <div class="marketing-subscribers-section">
            <div class="marketing-section-heading">
              <div>
                <h3 style="font-size:17px;color:#1d1d1f;margin:0 0 4px;">Người đăng ký gần nhất</h3>
                <p class="help-text">Danh sách người dùng đã đăng ký và đồng ý nhận email marketing qua Double Opt-In.</p>
              </div>
            </div>
            <div class="enterprise-table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Email</th>
                    <th>Trạng thái</th>
                    <th>Nguồn</th>
                    <th>Thời gian</th>
                  </tr>
                </thead>
                <tbody>
                  ${data.subscribers.map(s => `
                    <tr>
                      <td data-label="Email"><strong>${h(s.email)}</strong></td>
                      <td data-label="Trạng thái"><span class="status-pill status-${s.status}">${subLabel[s.status] || s.status}</span></td>
                      <td data-label="Nguồn"><small style="color:#515156;">${h(s.consent_source || 'web')}</small></td>
                      <td data-label="Thời gian"><small style="color:#86868b;">${s.confirmed_at ? new Date(s.confirmed_at).toLocaleString('vi-VN') : (s.consent_at ? new Date(s.consent_at).toLocaleString('vi-VN') : '—')}</small></td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            </div>
          </div>
        ` : ''}

        <p class="help-text" style="margin-top:24px;">Hiển thị 25 chiến dịch gần nhất. “SMTP tiếp nhận” không xác nhận thư đã vào hộp thư. Thư chưa rõ kết quả không tự gửi lại. Người nhận có thể ngừng nhận bất kỳ lúc nào.</p>
      `;
    } catch (error) {
      root.textContent = error.message;
    }
  }

  function editor(id) {
    const c = data.campaigns.find(x => x.id === id);
    const editable = (!c || c.status === 'draft') && admin.can('marketing.write');
    const sources = c?.sources || ['subscribers'];

    root.querySelector('[data-email-editor]').innerHTML = `
      <form class="editor-card marketing-email-editor" data-email-form data-id="${c?.id || ''}" data-version="${c?.version || 0}">
        <div class="editor-heading">
          <h3 style="margin:0;font-size:18px;color:#1d1d1f;">${editable ? (c ? 'Chỉnh sửa bản nháp' : 'Soạn chiến dịch email') : 'Nội dung email'}</h3>
          <button type="button" class="secondary-button" data-email-close>Đóng</button>
        </div>

        ${editable ? `
          <div class="marketing-template-bar">
            <span class="template-title">Mẫu nội dung có sẵn:</span>
            <button type="button" class="template-chip" data-email-template="k9">🎙️ GAERU K9 (Không dây)</button>
            <button type="button" class="template-chip" data-email-template="g1">⚡ GAERU G1 ULTRA (Studio)</button>
          </div>
        ` : ''}

        <fieldset ${editable ? '' : 'disabled'}>
          <div class="form-grid">
            <label>Tên chiến dịch
              <input name="title" required minlength="3" maxlength="160" value="${h(c?.title)}" placeholder="Ví dụ: Giới thiệu ưu đãi micro K9 tháng 11">
            </label>
            <label>Tiêu đề thư
              <input name="subject" required minlength="3" maxlength="160" value="${h(c?.subject)}" placeholder="Tiêu đề hiển thị trong hộp thư khách hàng">
            </label>
            <label>Thời gian gửi · giờ trên thiết bị
              <input name="scheduledAt" type="datetime-local" required value="${local(c?.scheduled_at || Date.now() + 3600000)}">
            </label>
            <label>Tốc độ tối đa (thư/phút)
              <input name="ratePerMinute" type="number" required min="1" max="12" step="1" value="${c?.rate_per_minute || 6}">
            </label>
          </div>

          <label style="margin-top:14px;display:block;">Nội dung thư
            <textarea name="body" required minlength="10" maxlength="12000" rows="9" placeholder="Soạn nội dung thư gửi đến khách hàng...">${h(c?.body)}</textarea>
          </label>

          <h4 style="margin:20px 0 8px;font-size:14px;color:#1d1d1f;">Nguồn người nhận (Yêu cầu Double Opt-In)</h4>
          <div class="marketing-email-sources" style="display:flex;flex-direction:column;gap:8px;">
            ${[
              ['subscribers', 'Khách đã xác nhận đăng ký nhận tin (Double Opt-In · Khuyến nghị)'],
              ['customers', 'Khách hàng có tài khoản (đã xác nhận đăng ký)'],
              ['orders', 'Khách đã từng mua hàng (đã xác nhận đăng ký)'],
              ['suppliers', 'Nhà cung cấp (đã xác nhận đăng ký)']
            ].map(([srcId, title]) => `
              <label style="display:flex;align-items:center;gap:8px;font-size:13px;color:#333;cursor:pointer;">
                <input type="checkbox" name="sources" value="${srcId}" ${sources.includes(srcId) ? 'checked' : ''}>
                <span>${title}</span>
              </label>
            `).join('')}
          </div>
        </fieldset>

        <p class="help-text" style="margin-top:12px;">Chỉ gửi tới người dùng có trạng thái xác nhận hợp lệ. Tự động loại trừ người đã ngừng nhận và tài khoản bị vô hiệu hóa.</p>

        <div class="marketing-email-preview" data-email-preview></div>

        ${editable ? `
          <div class="marketing-test-send-box">
            <div class="marketing-test-send-header">
              <h4>Gửi email thử nghiệm (Test Send)</h4>
              <p>Gửi thử trực tiếp nội dung soạn thảo tới hộp thư của bạn trước khi lên lịch.</p>
            </div>
            <div class="marketing-test-send-controls">
              <input type="email" data-email-test-to placeholder="Nhập địa chỉ email nhận thư thử nghiệm">
              <button type="button" class="secondary-button" data-email-test-btn>Gửi thử nghiệm</button>
            </div>
            <div class="marketing-test-send-feedback" data-email-test-feedback></div>
          </div>
        ` : ''}

        <div class="marketing-email-actions" style="margin-top:20px;">
          <button type="button" class="secondary-button" data-email-preview-button>Xem trước thư</button>
          ${editable ? '<button class="primary-button" type="submit">Lưu bản nháp</button>' : ''}
          ${c?.status === 'draft' && editable ? `<button class="secondary-button" type="button" data-email-check="${c.id}" ${data.configured ? '' : 'disabled'}>Kiểm tra &amp; lên lịch</button>` : ''}
        </div>

        <div data-email-schedule-confirm></div>
        <p role="status" aria-live="polite" style="margin-top:8px;font-size:13px;"></p>
      </form>
    `;
    root.querySelector('[data-email-editor]').scrollIntoView({
      block: 'start',
      behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'
    });
  }

  document.addEventListener('submit', async e => {
    const f = e.target.closest('[data-email-form]');
    if (!f) return;
    e.preventDefault();
    const button = f.querySelector('[type=submit]');
    const status = f.querySelector('[role=status]');
    button.disabled = true;
    try {
      const d = {
        title: f.elements.title.value,
        subject: f.elements.subject.value,
        body: f.elements.body.value,
        scheduledAt: new Date(f.elements.scheduledAt.value).toISOString(),
        ratePerMinute: Number(f.elements.ratePerMinute.value),
        sources: [...f.querySelectorAll('[name=sources]:checked')].map(i => i.value)
      };
      if (!d.sources.length) throw Error('Chọn ít nhất một nguồn email.');
      const r = await admin.request('/api/gaeru_ceo/marketing/emails' + (f.dataset.id ? '/' + f.dataset.id : ''), {
        method: f.dataset.id ? 'PUT' : 'POST',
        body: JSON.stringify({ data: d, version: Number(f.dataset.version) })
      });
      await load();
      editor(r.item.id);
      admin.showGlobal('Đã lưu bản nháp. Chưa gửi thư.');
    } catch (error) {
      status.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });

  document.addEventListener('click', async e => {
    if (!e.target.closest('#marketing-email-workspace')) return;
    const b = e.target.closest('button');
    if (!b) return;

    try {
      if (b.hasAttribute('data-email-refresh')) await load();
      if (b.hasAttribute('data-email-new')) editor();
      if (b.dataset.emailView) editor(b.dataset.emailView);
      if (b.hasAttribute('data-email-close')) root.querySelector('[data-email-editor]').innerHTML = '';

      // Template selection
      if (b.dataset.emailTemplate) {
        const tpl = templates[b.dataset.emailTemplate];
        const f = b.closest('form');
        if (tpl && f) {
          f.elements.title.value = tpl.title;
          f.elements.subject.value = tpl.subject;
          f.elements.body.value = tpl.body;
          admin.showGlobal('Đã áp dụng mẫu ' + tpl.title);
        }
      }

      // Preview
      if (b.hasAttribute('data-email-preview-button')) {
        const f = b.closest('form');
        f.querySelector('[data-email-preview]').innerHTML = `
          <div class="marketing-email-preview-box">
            <div class="marketing-email-preview-header">
              <span class="marketing-email-preview-badge">Xem trước hiển thị email</span>
              <p class="marketing-email-preview-meta"><strong>Từ:</strong> GAERU &lt;business@gaeru.com&gt;</p>
              <p class="marketing-email-preview-meta"><strong>Đến:</strong> {{email_khach_hang}}</p>
              <h4 class="marketing-email-preview-subject">${h(f.elements.subject.value || 'Tiêu đề thư')}</h4>
            </div>
            <div class="marketing-email-preview-body">${h(f.elements.body.value || 'Chưa có nội dung thư.')}</div>
            <div class="marketing-email-preview-footer">
              <span>GAERU Store · <a href="#unsubscribe" class="marketing-preview-unsub" role="button" aria-disabled="true" style="pointer-events:none;">Ngừng nhận email khuyến mại (One-Click Unsubscribe)</a></span>
            </div>
          </div>
        `;
      }

      // Test Send
      if (b.hasAttribute('data-email-test-btn')) {
        const f = b.closest('form');
        const toInput = f.querySelector('[data-email-test-to]');
        const fb = f.querySelector('[data-email-test-feedback]');
        const to = toInput?.value?.trim();
        if (!to) throw Error('Vui lòng nhập địa chỉ email nhận thư thử nghiệm.');
        b.disabled = true;
        fb.innerHTML = '<span style="color:#86868b;">Đang gửi thư thử nghiệm...</span>';
        try {
          const res = await admin.request('/api/gaeru_ceo/marketing/emails/test-send', {
            method: 'POST',
            body: JSON.stringify({
              to,
              subject: f.elements.subject.value,
              body: f.elements.body.value
            })
          });
          fb.innerHTML = '<span style="color:#2e7d32;font-weight:600;">' + h(res.message) + '</span>';
        } catch (err) {
          fb.innerHTML = '<span style="color:#d32f2f;">' + h(err.message) + '</span>';
        } finally {
          b.disabled = false;
        }
      }

      // Check & Schedule
      if (b.dataset.emailCheck) {
        const c = data.campaigns.find(x => x.id === b.dataset.emailCheck);
        const f = b.closest('form');
        if (
          f.elements.title.value !== c.title ||
          f.elements.subject.value !== c.subject ||
          f.elements.body.value !== c.body ||
          new Date(f.elements.scheduledAt.value).getTime() !== new Date(c.scheduled_at).getTime() ||
          Number(f.elements.ratePerMinute.value) !== c.rate_per_minute ||
          JSON.stringify([...f.querySelectorAll('[name=sources]:checked')].map(i => i.value)) !== JSON.stringify(c.sources)
        ) {
          throw Error('Lưu thay đổi bản nháp trước khi lên lịch.');
        }
        const count = (await admin.request('/api/gaeru_ceo/marketing/emails/audience', {
          method: 'POST',
          body: JSON.stringify({ sources: c.sources })
        })).count;

        f.querySelector('[data-email-schedule-confirm]').innerHTML = `
          <div class="marketing-schedule-box">
            <p>Gửi tới <strong>${count} địa chỉ đã xác nhận</strong> từ ${new Date(c.scheduled_at).toLocaleString('vi-VN')}.</p>
            <label><input type="checkbox" data-email-agree> Tôi đã kiểm tra nội dung và xác nhận danh sách nhận email.</label>
            <button class="primary-button" type="button" data-email-schedule="${c.id}" data-count="${count}">Xác nhận lên lịch</button>
          </div>
        `;
      }

      if (b.dataset.emailSchedule) {
        const f = b.closest('form');
        if (!f.querySelector('[data-email-agree]').checked) throw Error('Đánh dấu xác nhận trước khi lên lịch.');
        const c = data.campaigns.find(x => x.id === b.dataset.emailSchedule);
        if (
          f.elements.title.value !== c.title ||
          f.elements.subject.value !== c.subject ||
          f.elements.body.value !== c.body ||
          new Date(f.elements.scheduledAt.value).getTime() !== new Date(c.scheduled_at).getTime() ||
          Number(f.elements.ratePerMinute.value) !== c.rate_per_minute ||
          JSON.stringify([...f.querySelectorAll('[name=sources]:checked')].map(i => i.value)) !== JSON.stringify(c.sources)
        ) {
          throw Error('Bản nháp có thay đổi chưa lưu. Lưu rồi kiểm tra lại trước khi xác nhận.');
        }
        b.disabled = true;
        const r = await admin.request('/api/gaeru_ceo/marketing/emails/' + c.id + '/schedule', {
          method: 'POST',
          body: JSON.stringify({ version: c.version, expectedCount: Number(b.dataset.count), confirmation: 'SCHEDULE_EMAILS' })
        });
        await load();
        admin.showGlobal(r.message);
      }

      // Cancel campaign
      if (b.dataset.emailCancel) {
        const c = data.campaigns.find(x => x.id === b.dataset.emailCancel);
        root.querySelector('[data-email-confirm="' + c.id + '"]').innerHTML = `
          <div style="margin-top:10px;padding:12px 14px;background:#fff5f5;border:1px solid #fed7d7;border-radius:12px;">
            <p class="help-text" style="color:#c53030;margin:0 0 8px;">Thư đã chuyển cho SMTP không thể thu hồi; chỉ dừng các thư đang chờ trong hàng đợi.</p>
            <button type="button" class="secondary-button" data-email-cancel-confirm="${c.id}" style="color:#c53030;border-color:#feb2b2;">Xác nhận dừng chiến dịch</button>
          </div>
        `;
      }

      if (b.dataset.emailCancelConfirm) {
        const c = data.campaigns.find(x => x.id === b.dataset.emailCancelConfirm);
        b.disabled = true;
        const r = await admin.request('/api/gaeru_ceo/marketing/emails/' + c.id + '/cancel', {
          method: 'POST',
          body: JSON.stringify({ version: c.version })
        });
        await load();
        admin.showGlobal(r.message);
      }
    } catch (error) {
      b.disabled = false;
      const status = b.closest('form')?.querySelector('[role=status]');
      if (status) status.textContent = error.message;
      else admin.showGlobal(error.message, true);
    }
  });

  window.GAERUEmailMarketing = { load };
})();
