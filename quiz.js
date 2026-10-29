'use strict';

let quizQuestions = [];
let currentStepIndex = 0;
const userAnswers = {};

async function initQuiz() {
  try {
    const res = await fetch('/api/quiz/questions');
    const data = await res.json();
    quizQuestions = data.questions || [];
    renderCurrentStep();
  } catch (err) {
    document.getElementById('quiz-question-container').innerHTML =
      '<p style="color:#f85149;">Không tải được bộ câu hỏi. Vui lòng tải lại trang.</p>';
  }
}

function renderCurrentStep() {
  if (currentStepIndex >= quizQuestions.length) {
    submitQuiz();
    return;
  }

  const q = quizQuestions[currentStepIndex];
  const progressPercent = ((currentStepIndex + 1) / quizQuestions.length) * 100;
  document.getElementById('quiz-progress').style.width = progressPercent + '%';

  const container = document.getElementById('quiz-question-container');
  container.innerHTML = `
    <div class="quiz-step-tag">Bước ${q.step} / ${quizQuestions.length}</div>
    <h2 class="quiz-title">${escapeHtml(q.title)}</h2>
    <p class="quiz-desc">${escapeHtml(q.description)}</p>
    <div class="quiz-options-grid">
      ${q.options.map(opt => `
        <div class="quiz-option-card" onclick="selectQuizOption('${q.id}', '${opt.id}')">
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
  qContainer.style.display = 'none';
  rContainer.style.display = 'block';

  rContainer.innerHTML = '<p style="text-align:center;color:#8b949e;padding:40px;">AI đang phân tích và tìm kiếm combo tối ưu nhất cho bạn...</p>';

  try {
    const res = await fetch('/api/quiz/recommend', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(userAnswers)
    });
    const data = await res.json();
    const rec = data.recommendation;

    rContainer.innerHTML = `
      <div class="quiz-step-tag">GỢI Ý SETUP TỐI ƯU TỪ AI</div>
      <h2 class="quiz-title">${escapeHtml(rec.bundleTitle)}</h2>
      <p class="quiz-desc">${escapeHtml(rec.tagline)}</p>

      <div style="font-size:14px;background:rgba(88,166,255,0.1);border-left:3px solid #58a6ff;padding:10px 14px;border-radius:4px;margin-bottom:18px;">
        💡 <strong>Tư vấn kết nối:</strong> ${escapeHtml(data.connectorAdvice)}
      </div>

      <div class="quiz-recommend-box">
        <h4 style="margin:0 0 12px 0;font-size:16px;">Các thiết bị trong bộ combo:</h4>
        <ul style="padding-left:20px;color:#c9d1d9;margin:0 0 16px 0;line-height:1.8;">
          <li><strong>${escapeHtml(rec.primaryProduct.name)}</strong> (Giá gốc: ${rec.primaryProduct.priceVnd.toLocaleString('vi-VN')}đ)</li>
          <li><strong>${escapeHtml(rec.secondaryProduct.name)}</strong> (Giá gốc: ${rec.secondaryProduct.priceVnd.toLocaleString('vi-VN')}đ)</li>
          <li><strong>${escapeHtml(rec.accessory.name)}</strong> (Quà tặng kèm: ${rec.accessory.priceVnd.toLocaleString('vi-VN')}đ)</li>
        </ul>

        <div style="border-top:1px solid #21262d;padding-top:16px;">
          <div>
            <span class="quiz-price-tag">${rec.comboPriceVnd.toLocaleString('vi-VN')}đ</span>
            <span class="quiz-original-price">${rec.originalTotalVnd.toLocaleString('vi-VN')}đ</span>
            <span class="quiz-savings-badge">Tiết kiệm ${rec.savingsPercent}% (-${rec.savingsVnd.toLocaleString('vi-VN')}đ)</span>
          </div>

          <div style="margin-top:10px;font-size:13px;color:#8b949e;">
            Mã voucher kích hoạt combo: <strong style="color:#58a6ff;background:#161b22;padding:2px 6px;border-radius:4px;">${rec.discountCode}</strong>
          </div>

          <button class="quiz-btn-buy" onclick="addComboToCart('${rec.primaryProduct.slug}', '${rec.secondaryProduct.slug}', '${rec.discountCode}')">
            🛒 Thêm Trọn Bộ Vào Giỏ Hàng Ngay
          </button>
        </div>
      </div>

      <h4 style="margin:20px 0 10px 0;font-size:15px;">Tại sao combo này phù hợp với bạn?</h4>
      <ul style="padding-left:20px;color:#8b949e;line-height:1.7;">
        ${(rec.reasons || []).map(r => `<li>${escapeHtml(r)}</li>`).join('')}
      </ul>

      <div style="margin-top:24px;text-align:center;">
        <button onclick="restartQuiz()" style="background:transparent;border:1px solid #30363d;color:#8b949e;padding:8px 16px;border-radius:6px;cursor:pointer;">
          🔄 Làm lại trắc nghiệm
        </button>
      </div>
    `;
  } catch (err) {
    rContainer.innerHTML = '<p style="color:#f85149;">Lỗi khi tải kết quả đề xuất. Vui lòng thử lại.</p>';
  }
}

function addComboToCart(slug1, slug2, code) {
  // Save discount code to localStorage for checkout
  try {
    localStorage.setItem('gaeru_applied_voucher', code);
  } catch (e) {}
  alert(`Đã thêm combo và áp dụng mã ${code} giảm 15%!\nĐang chuyển sang giỏ hàng...`);
  window.location.href = '/cart.html';
}

function restartQuiz() {
  currentStepIndex = 0;
  for (const k of Object.keys(userAnswers)) delete userAnswers[k];
  document.getElementById('quiz-result-container').style.display = 'none';
  document.getElementById('quiz-question-container').style.display = 'block';
  renderCurrentStep();
}

function escapeHtml(str) {
  return String(str || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

document.addEventListener('DOMContentLoaded', initQuiz);
