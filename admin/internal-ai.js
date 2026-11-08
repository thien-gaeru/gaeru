'use strict';

/**
 * GAERU AI Admin Frontend Controller
 */
(function () {
  let currentThreadId = null;
  let threads = [];
  let isSending = false;

  function getCsrfToken() {
    return document.querySelector('meta[name="csrf-token"]')?.getAttribute('content') ||
           document.querySelector('input[name="_csrf"]')?.value ||
           window.__GAERU_CSRF__ || '';
  }

  async function api(path, options = {}) {
    if (window.GAERUAdmin?.request) {
      return window.GAERUAdmin.request('/api/gaeru_ceo/internal-ai' + path, options);
    }
    const headers = {
      'Content-Type': 'application/json',
      'X-CSRF-Token': getCsrfToken(),
      ...(options.headers || {})
    };
    const res = await fetch('/api/gaeru_ceo/internal-ai' + path, {
      ...options,
      headers
    });
    if (!res.ok) {
      let errText = 'Lỗi hệ thống';
      try {
        const d = await res.json();
        errText = d.error || d.message || errText;
      } catch (_) {}
      throw new Error(errText);
    }
    return res.json();
  }

  // Khởi tạo Copilot View khi Admin sẵn sàng
  document.addEventListener('gaeru:admin-ready', async (e) => {
    initCopilotView(e.detail);
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => initCopilotView(window.GAERUAdmin?.user || null));
  } else {
    initCopilotView(window.GAERUAdmin?.user || null);
  }

  function initCopilotView(session) {
    const viewPanel = document.getElementById('internal-ai-view');
    if (!viewPanel) return;

    if (!viewPanel.dataset.initialized) {
      viewPanel.dataset.initialized = 'true';

      // Gắn sự kiện các nút
      document.getElementById('btn-new-copilot-thread')?.addEventListener('click', () => createNewThread());
      document.getElementById('btn-clear-copilot-chat')?.addEventListener('click', () => deleteCurrentThread());
      document.getElementById('copilot-chat-form')?.addEventListener('submit', (e) => {
        e.preventDefault();
        handleSendMessage();
      });

      // Auto resize textarea
      const input = document.getElementById('copilot-input');
      if (input) {
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSendMessage();
          }
        });
        input.addEventListener('input', () => {
          input.style.height = 'auto';
          input.style.height = Math.min(120, input.scrollHeight) + 'px';
        });
      }

      // Floating Button
      const floatingBtn = document.getElementById('floating-copilot-btn');
      if (floatingBtn) {
        floatingBtn.addEventListener('click', () => {
          const navBtn = document.querySelector('[data-view="internal-ai"]');
          if (navBtn) navBtn.click();
        });
      }

      // Phím tắt Ctrl + Space
      window.addEventListener('keydown', (e) => {
        if (e.ctrlKey && e.code === 'Space') {
          e.preventDefault();
          const navBtn = document.querySelector('[data-view="internal-ai"]');
          if (navBtn) navBtn.click();
        }
      });

      // Gắn sự kiện khi click vào nav item Copilot
      const navBtn = document.querySelector('[data-view="internal-ai"]');
      if (navBtn) {
        navBtn.addEventListener('click', () => {
          loadQuickPrompts();
          if (!currentThreadId) loadThreads();
        });
      }
    }

    if (session) {
      // Cập nhật role badge
      const roleBadge = document.getElementById('copilot-user-role');
      if (roleBadge) {
        const isOwner = session?.isOwner || session?.role === 'owner' || document.querySelector('[data-view="owner"]:not([hidden])');
        roleBadge.textContent = isOwner ? 'Role: CEO / Owner' : 'Role: Staff / Management';
      }
      loadQuickPrompts();
      loadThreads();
    }
  }

  // 1. Nạp danh sách quick prompts
  async function loadQuickPrompts() {
    try {
      const { prompts } = await api('/quick-prompts');
      const container = document.getElementById('copilot-quick-prompts');
      if (!container || !prompts) return;
      container.innerHTML = prompts.map(p => `
        <button type="button" class="copilot-prompt-chip" data-prompt="${escapeAttr(p.prompt)}">
          ${escapeHtml(p.label)}
        </button>
      `).join('');

      container.querySelectorAll('.copilot-prompt-chip').forEach(chip => {
        chip.addEventListener('click', async () => {
          const input = document.getElementById('copilot-input');
          if (input) {
            input.value = chip.dataset.prompt;
            input.focus();
            await handleSendMessage();
          }
        });
      });
    } catch (_) {}
  }

  // 2. Nạp danh sách threads
  async function loadThreads() {
    const listEl = document.getElementById('copilot-thread-list');
    try {
      const data = await api('/threads');
      threads = data.threads || [];
      renderThreadList();
      if (threads.length > 0 && !currentThreadId) {
        selectThread(threads[0].id);
      } else if (threads.length === 0) {
        createNewThread();
      }
    } catch (e) {
      if (listEl) listEl.innerHTML = `<p class="help-text" style="padding:12px;color:#dc2626;">${escapeHtml(e.message)}</p>`;
    }
  }

  function renderThreadList() {
    const listEl = document.getElementById('copilot-thread-list');
    if (!listEl) return;
    if (!threads.length) {
      listEl.innerHTML = '<p class="help-text" style="padding:12px;">Chưa có hội thoại nào.</p>';
      return;
    }
    listEl.innerHTML = threads.map(t => `
      <div class="copilot-thread-item ${t.id === currentThreadId ? 'is-active' : ''}" data-id="${t.id}">
        <span class="copilot-thread-title">💬 ${escapeHtml(t.title)}</span>
      </div>
    `).join('');

    listEl.querySelectorAll('.copilot-thread-item').forEach(item => {
      item.addEventListener('click', () => selectThread(item.dataset.id));
    });
  }

  // 3. Tạo thread mới
  async function createNewThread() {
    try {
      const data = await api('/threads', {
        method: 'POST',
        body: JSON.stringify({ title: 'Hội thoại mới' })
      });
      threads.unshift(data.thread);
      selectThread(data.thread.id);
    } catch (e) {
      window.alert('Không thể tạo phiên mới: ' + e.message);
    }
  }

  // 4. Chọn thread
  async function selectThread(threadId) {
    currentThreadId = threadId;
    renderThreadList();
    const messagesEl = document.getElementById('copilot-messages');
    if (!messagesEl) return;
    messagesEl.innerHTML = '<p class="help-text" style="margin:auto;">Đang tải tin nhắn...</p>';

    try {
      const { messages } = await api(`/threads/${threadId}`);
      if (!messages || messages.length === 0) {
        messagesEl.innerHTML = `
          <div class="copilot-welcome">
            <div class="copilot-avatar">🤖</div>
            <h2>Xin chào! Tôi là GAERU AI</h2>
            <p>Trợ lý Điều hành Doanh nghiệp AI thông minh 24/7. Tôi có thể giúp bạn phân tích doanh thu, kiểm tra tồn kho, đối soát đơn hàng và tự động hóa các tác vụ quản trị.</p>
          </div>
        `;
      } else {
        messagesEl.innerHTML = '';
        for (const msg of messages) {
          appendMessageUI(msg.role, msg.content, msg.actionCard);
        }
      }
      scrollMessagesBottom();
    } catch (e) {
      messagesEl.innerHTML = `<p class="help-text" style="color:#dc2626;margin:auto;">Lỗi tải tin nhắn: ${escapeHtml(e.message)}</p>`;
    }
  }

  // 5. Xóa thread hiện tại
  async function deleteCurrentThread() {
    if (!currentThreadId) return;
    if (!window.confirm('Bạn có chắc muốn xóa phiên hội thoại này?')) return;
    try {
      await api(`/threads/${currentThreadId}`, { method: 'DELETE' });
      threads = threads.filter(t => t.id !== currentThreadId);
      currentThreadId = null;
      if (threads.length > 0) {
        selectThread(threads[0].id);
      } else {
        createNewThread();
      }
    } catch (e) {
      window.alert('Lỗi xóa hội thoại: ' + e.message);
    }
  }

  // 6. Gửi tin nhắn
  async function handleSendMessage() {
    const input = document.getElementById('copilot-input');
    const question = input?.value?.trim();
    if (!question || isSending) return;

    if (!currentThreadId) {
      await createNewThread();
    }
    if (!currentThreadId) return;

    input.value = '';
    input.style.height = 'auto';
    isSending = true;

    // Render câu hỏi của user ngay lập tức
    appendMessageUI('user', question);
    scrollMessagesBottom();

    // Tạo placeholder của assistant
    const assistantBubble = appendMessageUI('assistant', '<span class="copilot-loading">🤖 GAERU AI đang truy vấn dữ liệu...</span>');
    scrollMessagesBottom();

    try {
      // Dùng standard POST JSON
      const res = await api(`/threads/${currentThreadId}/chat`, {
        method: 'POST',
        body: JSON.stringify({ question })
      });

      // Render nội dung phản hồi hoàn chỉnh
      assistantBubble.innerHTML = renderMarkdown(res.answer);
      if (res.actionCard) {
        appendActionCardUI(assistantBubble, res.actionCard);
      }

      // Cập nhật tiêu đề thread trong danh sách nếu vừa đổi
      loadThreads();
    } catch (err) {
      assistantBubble.innerHTML = `<span style="color:#dc2626;">⚠️ Lỗi: ${escapeHtml(err.message)}</span>`;
    } finally {
      isSending = false;
      scrollMessagesBottom();
    }
  }

  function appendMessageUI(role, content, actionCard = null) {
    const container = document.getElementById('copilot-messages');
    if (!container) return null;

    // Xóa welcome nếu có
    const welcome = container.querySelector('.copilot-welcome');
    if (welcome) welcome.remove();

    const row = document.createElement('div');
    row.className = `copilot-msg-row ${role}`;
    
    const bubble = document.createElement('div');
    bubble.className = 'copilot-msg-bubble';
    bubble.innerHTML = role === 'user' ? escapeHtml(content).replace(/\n/g, '<br>') : renderMarkdown(content);

    if (actionCard) {
      appendActionCardUI(bubble, actionCard);
    }

    row.appendChild(bubble);
    container.appendChild(row);
    return bubble;
  }

  function appendActionCardUI(parentBubble, card) {
    const cardEl = document.createElement('div');
    cardEl.className = `copilot-action-card ${card.status === 'executed' ? 'is-executed' : ''}`;
    cardEl.id = `action-card-${card.actionId}`;

    cardEl.innerHTML = `
      <div class="copilot-action-header">${escapeHtml(card.title)}</div>
      <p class="copilot-action-desc">${escapeHtml(card.description)}</p>
      ${card.status === 'pending' ? `
        <div class="copilot-action-buttons">
          <button type="button" class="btn-confirm-action" data-action-id="${card.actionId}">✓ Xác nhận thực hiện</button>
          <button type="button" class="btn-cancel-action" data-action-id="${card.actionId}">✕ Hủy bỏ</button>
        </div>
      ` : `
        <div style="font-size:12px;color:#16a34a;font-weight:600;">✓ Đã thực thi thành công trên hệ thống</div>
      `}
    `;

    const confirmBtn = cardEl.querySelector('.btn-confirm-action');
    if (confirmBtn) {
      confirmBtn.addEventListener('click', async () => {
        confirmBtn.disabled = true;
        confirmBtn.textContent = 'Đang thực thi...';
        try {
          const res = await api(`/actions/${card.actionId}/execute`, { method: 'POST' });
          cardEl.classList.add('is-executed');
          cardEl.querySelector('.copilot-action-buttons').innerHTML = `<div style="font-size:12px;color:#16a34a;font-weight:600;">✓ ${escapeHtml(res.result?.message || 'Đã áp dụng thành công')}</div>`;
          if (window.GAERUNotify?.toast) window.GAERUNotify.toast(res.result?.message || 'Đã thực thi thành công!', 'success');
        } catch (e) {
          if (window.GAERUNotify?.toast) window.GAERUNotify.toast('Lỗi thực thi: ' + e.message, 'error');
          else console.error('Lỗi thực thi:', e.message);
          confirmBtn.disabled = false;
          confirmBtn.textContent = '✓ Xác nhận thực hiện';
        }
      });
    }

    const cancelBtn = cardEl.querySelector('.btn-cancel-action');
    if (cancelBtn) {
      cancelBtn.addEventListener('click', async () => {
        try {
          await api(`/actions/${card.actionId}/cancel`, { method: 'POST' });
          cardEl.remove();
        } catch (_) {}
      });
    }

    parentBubble.appendChild(cardEl);
  }

  function scrollMessagesBottom() {
    const el = document.getElementById('copilot-messages');
    if (el) el.scrollTop = el.scrollHeight;
  }

  function escapeHtml(str) {
    if (str == null) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function escapeAttr(str) {
    return escapeHtml(str).replace(/"/g, '&quot;');
  }

  // Trình render Markdown cơ bản an toàn (Bảng, Đậm, Nghiêng, Danh sách, Tiêu đề)
  function renderMarkdown(md) {
    if (!md) return '';
    let html = escapeHtml(md);

    // Bảng Markdown
    html = html.replace(/\n\|(.+)\|\n\|[-:| ]+\|\n((?:\|.+\|\n?)+)/g, (match, header, rows) => {
      const ths = header.split('|').map(s => s.trim()).filter(Boolean).map(h => `<th>${h}</th>`).join('');
      const trs = rows.trim().split('\n').map(row => {
        const tds = row.split('|').map(s => s.trim()).filter(Boolean).map(d => `<td>${d}</td>`).join('');
        return `<tr>${tds}</tr>`;
      }).join('');
      return `<table><thead><tr>${ths}</tr></thead><tbody>${trs}</tbody></table>`;
    });

    // Tiêu đề
    html = html.replace(/^### (.*$)/gim, '<h4>$1</h4>');
    html = html.replace(/^## (.*$)/gim, '<h3>$1</h3>');
    html = html.replace(/^# (.*$)/gim, '<h2>$1</h2>');

    // Chữ đậm, nghiêng, code
    html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\*(.*?)\*/g, '<em>$1</em>');
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

    // Bullet points
    html = html.replace(/^\- (.*$)/gim, '<li>$1</li>');
    html = html.replace(/(<li>.*<\/li>)/s, '<ul>$1</ul>');

    // Dòng mới
    html = html.replace(/\n/g, '<br>');

    return html;
  }
})();
