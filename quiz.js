'use strict';

let quizQuestions = [];
let currentStepIndex = 0;
const userAnswers = {};

async function initQuiz() {
  const container = document.getElementById('quiz-question-container');
  if (container) {
    container.innerHTML = '<p style="text-align:center;color:#6e6e73;padding:32px;">Đang tải bộ câu hỏi tư vấn thiết bị GAERU...</p>';
  }

  try {
    const res = await fetch('/api/quiz/questions');
    const data = await res.json();
    quizQuestions = data.questions || [];
    renderCurrentStep();
  } catch (err) {
    if (container) {
      container.innerHTML =
        '<p style="color:#d70015;text-align:center;padding:24px;">Không tải được bộ câu hỏi tư vấn. Vui lòng tải lại trang hoặc kiểm tra kết nối mạng.</p>';
    }
  }
}

function renderCurrentStep() {
  if (currentStepIndex >= quizQuestions.length) {
    submitQuiz();
    return;
  }

  const q = quizQuestions[currentStepIndex];
  const progressPercent = ((currentStepIndex + 1) / quizQuestions.length) * 100;
  const progressEl = document.getElementById('quiz-progress');
  if (progressEl) progressEl.style.width = progressPercent + '%';

  const container = document.getElementById('quiz-question-container');
  if (!container) return;

  container.innerHTML = `
    <div class="quiz-step-tag">Bước ${q.step} / ${quizQuestions.length}</div>
    <h2 class="quiz-title">${escapeHtml(q.title)}</h2>
    <p class="quiz-desc">${escapeHtml(q.description)}</p>
    <div class="quiz-options-grid">
      ${q.options.map(opt => `
        <div class="quiz-option-card" data-question-id="${q.id}" data-option-id="${opt.id}" onclick="window.selectQuizOption('${q.id}', '${opt.id}')" role="button" tabindex="0">
          <span class="quiz-option-icon">${opt.icon}</span>
          <span class="quiz-option-label">${escapeHtml(opt.label)}</span>
        </div>
      `).join('')}
    </div>
  `;
}

function selectQuizOption(questionId, optionId) {
  userAnswers[questionId] = optionId;
  currentStepIndex++;
  renderCurrentStep();
}

async function submitQuiz() {
  const qContainer = document.getElementById('quiz-question-container');
  const rContainer = document.getElementById('quiz-result-container');
  if (qContainer) qContainer.style.display = 'none';
  if (rContainer) {
    rContainer.style.display = 'block';
    rContainer.innerHTML = '<p style="text-align:center;color:#6e6e73;padding:48px;font-size:1.05rem;">AI đang phân tích và tìm kiếm combo thiết bị tối ưu nhất cho bạn...</p>';
  }

  try {
    const res = await fetch('/api/quiz/recommend', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(userAnswers)
    });
    const data = await res.json();
    const rec = data.recommendation;

    if (!rContainer) return;

    rContainer.innerHTML = `
      <div class="quiz-step-tag">GỢI Ý SETUP TỐI ƯU TỪ AI</div>
      <h2 class="quiz-title">${escapeHtml(rec.bundleTitle)}</h2>
      <p class="quiz-desc">${escapeHtml(rec.tagline)}</p>

      <div style="font-size:14px;background:#eef7ff;border-left:3px solid #0071e3;padding:12px 16px;border-radius:8px;margin-bottom:20px;color:#1d1d1f;">
        💡 <strong>Tư vấn kết nối GAERU:</strong> ${escapeHtml(data.connectorAdvice)}
      </div>

      <div class="quiz-recommend-box">
        <h4 style="margin:0 0 12px 0;font-size:16px;color:#1d1d1f;font-weight:700;">Các thiết bị trong bộ combo:</h4>
        <ul style="padding-left:20px;color:#333;margin:0 0 18px 0;line-height:1.8;">
          <li><strong>${escapeHtml(rec.primaryProduct.name)}</strong> (Giá niêm yết: ${rec.primaryProduct.priceVnd.toLocaleString('vi-VN')}đ)</li>
          <li><strong>${escapeHtml(rec.secondaryProduct.name)}</strong> (Giá niêm yết: ${rec.secondaryProduct.priceVnd.toLocaleString('vi-VN')}đ)</li>
          <li><strong>${escapeHtml(rec.accessory.name)}</strong> (Quà tặng kèm: ${rec.accessory.priceVnd.toLocaleString('vi-VN')}đ)</li>
        </ul>

        <div style="border-top:1px solid #e5e5ea;padding-top:18px;">
          <div>
            <span class="quiz-price-tag">${rec.comboPriceVnd.toLocaleString('vi-VN')}đ</span>
            <span class="quiz-original-price">${rec.originalTotalVnd.toLocaleString('vi-VN')}đ</span>
            <span class="quiz-savings-badge">Tiết kiệm ${rec.savingsPercent}% (-${rec.savingsVnd.toLocaleString('vi-VN')}đ)</span>
          </div>

          <div style="margin-top:12px;font-size:14px;color:#6e6e73;">
            Mã voucher kích hoạt combo: <strong style="color:#0071e3;background:#eef2ff;padding:3px 8px;border-radius:6px;border:1px solid #c7d2fe;">${rec.discountCode}</strong>
          </div>

          <button class="quiz-btn-buy" id="btn-add-combo" data-slug1="${rec.primaryProduct.slug}" data-slug2="${rec.secondaryProduct.slug}" data-code="${rec.discountCode}" onclick="window.addComboToCart('${rec.primaryProduct.slug}', '${rec.secondaryProduct.slug}', '${rec.discountCode}')">
            🛒 Thêm Trọn Bộ Vào Giỏ Hàng Ngay
          </button>
        </div>
      </div>

      <h4 style="margin:24px 0 12px 0;font-size:15px;color:#1d1d1f;font-weight:700;">Tại sao combo này phù hợp với bạn?</h4>
      <ul style="padding-left:20px;color:#48484a;line-height:1.75;">
        ${(rec.reasons || []).map(r => `<li>${escapeHtml(r)}</li>`).join('')}
      </ul>

      <div style="margin-top:28px;text-align:center;">
        <button class="quiz-restart-btn" id="btn-restart-quiz" onclick="window.restartQuiz()">
          🔄 Làm lại trắc nghiệm
        </button>
      </div>
    `;
  } catch (err) {
    if (rContainer) {
      rContainer.innerHTML = '<p style="color:#d70015;text-align:center;padding:24px;">Lỗi khi tải kết quả đề xuất. Vui lòng thử lại.</p>';
    }
  }
}

function addComboToCart(slug1, slug2, code) {
  try {
    localStorage.setItem('gaeru_applied_voucher', code);
  } catch (e) {}
  alert(`Đã kích hoạt ưu đãi combo và lưu mã voucher ${code}!\nĐang chuyển sang giỏ hàng...`);
  window.location.href = '/cart.html';
}

function restartQuiz() {
  currentStepIndex = 0;
  for (const k of Object.keys(userAnswers)) delete userAnswers[k];
  const rContainer = document.getElementById('quiz-result-container');
  const qContainer = document.getElementById('quiz-question-container');
  if (rContainer) rContainer.style.display = 'none';
  if (qContainer) qContainer.style.display = 'block';
  renderCurrentStep();
}

function escapeHtml(str) {
  return String(str || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Gán toàn cục ngay lập tức
window.selectQuizOption = selectQuizOption;
window.addComboToCart = addComboToCart;
window.restartQuiz = restartQuiz;
window.initQuiz = initQuiz;
window.GAERUQuiz = { initQuiz, selectQuizOption, submitQuiz, addComboToCart, restartQuiz };

// Bắt sự kiện click ủy quyền toàn tài liệu
document.addEventListener('click', (e) => {
  // 1. Chọn phương án
  const optionCard = e.target.closest('.quiz-option-card');
  if (optionCard && optionCard.dataset.questionId && optionCard.dataset.optionId) {
    e.preventDefault();
    selectQuizOption(optionCard.dataset.questionId, optionCard.dataset.optionId);
    return;
  }

  // 2. Mua combo
  const buyBtn = e.target.closest('#btn-add-combo, .quiz-btn-buy');
  if (buyBtn && buyBtn.dataset.code) {
    e.preventDefault();
    addComboToCart(buyBtn.dataset.slug1, buyBtn.dataset.slug2, buyBtn.dataset.code);
    return;
  }

  // 3. Làm lại trắc nghiệm
  const restartBtn = e.target.closest('#btn-restart-quiz, .quiz-restart-btn');
  if (restartBtn) {
    e.preventDefault();
    restartQuiz();
    return;
  }
});

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initQuiz);
} else {
  initQuiz();
}
