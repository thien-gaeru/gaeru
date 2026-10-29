'use strict';
const { Router } = require('express');

const QUIZ_QUESTIONS = [
  {
    step: 1,
    id: 'device',
    title: 'Bạn đang sử dụng thiết bị ghi hình nào?',
    description: 'Chúng tôi sẽ chọn loại chân cắm và tải trọng phù hợp nhất cho thiết bị của bạn.',
    options: [
      { id: 'iphone_lightning', label: 'iPhone (Cổng Lightning - từ iPhone 14 trở về trước)', icon: '📱' },
      { id: 'iphone_typec', label: 'iPhone 15/16 Series (Cổng Type-C)', icon: '⚡' },
      { id: 'android', label: 'Điện thoại Android (Samsung, Xiaomi, Oppo...)', icon: '🤖' },
      { id: 'camera', label: 'Máy ảnh Mirrorless / Compact / Action Cam', icon: '📷' }
    ]
  },
  {
    step: 2,
    id: 'scenario',
    title: 'Nhu cầu quay chụp chính của bạn là gì?',
    description: 'Mỗi môi trường đòi hỏi công nghệ chống rung và khả năng lọc ồn khác nhau.',
    options: [
      { id: 'livestream', label: 'Livestream bán hàng / Ngồi phòng cố định', icon: '🎙️' },
      { id: 'vlog_outdoor', label: 'Vlog du lịch / Quay ngoài trời nhiều gió & di chuyển', icon: '🏃' },
      { id: 'interview', label: 'Phỏng vấn 2 người / Podcast / Giảng dạy', icon: '👥' },
      { id: 'daily_tiktok', label: 'Quay video ngắn TikTok / Reels nhanh gọn hàng ngày', icon: '✨' }
    ]
  },
  {
    step: 3,
    id: 'budget',
    title: 'Mức ngân sách dự kiến của bạn?',
    description: 'GAERU luôn có combo tối ưu nhất trong từng phân khúc đầu tư.',
    options: [
      { id: 'entry', label: 'Tiết kiệm: Dưới 1.500.000đ', icon: '🥉' },
      { id: 'medium', label: 'Tiêu chuẩn: 1.500.000đ - 3.500.000đ', icon: '🥈' },
      { id: 'pro', label: 'Chuyên nghiệp: Trên 3.500.000đ', icon: '🥇' }
    ]
  }
];

const PRESET_COMBOS = {
  vlog_outdoor_medium: {
    bundleTitle: 'Combo Creator Ngoài Trời Toàn Diện',
    tagline: 'Chống rung mượt mà 3 trục + Thu âm lọc gió khoảng cách 20m',
    primaryProduct: { slug: 'k9', name: 'Micro Thu Âm Không Dây K9', priceVnd: 450000 },
    secondaryProduct: { slug: 'g1-ultra', name: 'Gimbal Chống Rung GAERU G1 Ultra', priceVnd: 1850000 },
    accessory: { name: 'Bông lọc gió lông cừu Deadcat cao cấp', priceVnd: 80000 },
    originalTotalVnd: 2380000,
    comboPriceVnd: 2023000,
    savingsVnd: 357000,
    savingsPercent: 15,
    discountCode: 'SETUP15',
    reasons: [
      'Gimbal 3 trục ổn định ngay cả khi vừa đi bộ vừa nói chuyện.',
      'Mic không dây cắm là nhận, tự động lọc ồn AI khi quay nơi đông người.',
      'Tặng kèm bông lọc gió chuyên dụng cho môi trường gió to.'
    ]
  },
  livestream_entry: {
    bundleTitle: 'Combo Livestream Bán Hàng Cơ Bản',
    tagline: 'Âm thanh trong trẻo, chân đế vững chắc, bắt sóng liên tục 6-8 tiếng',
    primaryProduct: { slug: 'k9', name: 'Micro Thu Âm Cài Áo Không Dây K9', priceVnd: 450000 },
    secondaryProduct: { slug: 'm3', name: 'Chân Tripod Để Bàn GAERU M3', priceVnd: 350000 },
    accessory: { name: 'Kẹp điện thoại xoay 360 độ ngàm kim loại', priceVnd: 90000 },
    originalTotalVnd: 890000,
    comboPriceVnd: 756000,
    savingsVnd: 134000,
    savingsPercent: 15,
    discountCode: 'SETUP15',
    reasons: [
      'Bắt giọng nói ấm và rõ ràng, không bị méo tiếng khi nói to.',
      'Chân đế để bàn nhỏ gọn không chiếm diện tích quầy live.',
      'Pin bền bỉ cho các phiên livestream kéo dài.'
    ]
  },
  interview_pro: {
    bundleTitle: 'Combo Phỏng Vấn & Podcast Chuyên Nghiệp (2 Người)',
    tagline: 'Hệ thống 2 mic phát độc lập + Gimbal tracking theo khuôn mặt AI',
    primaryProduct: { slug: 'k9', name: 'Bộ Micro Đôi K9 Dual (2 Mic 1 Thu)', priceVnd: 690000 },
    secondaryProduct: { slug: 'g1-ultra', name: 'Gimbal GAERU G1 Ultra AI Tracking', priceVnd: 1850000 },
    accessory: { name: 'Hộp sạc di động kiêm dock lưu trữ 1000mAh', priceVnd: 250000 },
    originalTotalVnd: 2790000,
    comboPriceVnd: 2371000,
    savingsVnd: 419000,
    savingsPercent: 15,
    discountCode: 'SETUP15',
    reasons: [
      '2 người nói cùng lúc không bị đè âm lượng, cân bằng dải tần tự động.',
      'Cảm biến AI tự động xoay gimbal theo người nói chính.',
      'Thời lượng pin lên tới 18 giờ với hộp sạc thông minh.'
    ]
  },
  default_combo: {
    bundleTitle: 'Combo Sáng Tạo Nội Dung Đa Năng GAERU',
    tagline: 'Thiết bị cần thiết nhất cho mọi nhà sáng tạo nội dung video ngắn',
    primaryProduct: { slug: 'k9', name: 'Micro Thu Âm Không Dây K9 Đa Năng', priceVnd: 450000 },
    secondaryProduct: { slug: 'p01', name: 'Gậy Chụp Hình Gimbal P01 Tự Xoay', priceVnd: 650000 },
    accessory: { name: 'Cáp sạc Type-C bọc dù siêu bền', priceVnd: 60000 },
    originalTotalVnd: 1160000,
    comboPriceVnd: 986000,
    savingsVnd: 174000,
    savingsPercent: 15,
    discountCode: 'SETUP15',
    reasons: [
      'Gọn nhẹ, nhét vừa túi xách, sẵn sàng quay bất kỳ lúc nào.',
      'Tương thích hoàn hảo với thiết bị bạn đã chọn.',
      'Mức giá ưu đãi tiết kiệm 15% khi mua trọn bộ.'
    ]
  }
};

function evaluateQuizAnswers(answers = {}) {
  const { device = 'iphone_typec', scenario = 'daily_tiktok', budget = 'medium' } = answers;

  let key = 'default_combo';
  if (scenario === 'vlog_outdoor' && (budget === 'medium' || budget === 'pro')) {
    key = 'vlog_outdoor_medium';
  } else if (scenario === 'livestream' && budget === 'entry') {
    key = 'livestream_entry';
  } else if (scenario === 'interview' || budget === 'pro') {
    key = 'interview_pro';
  }

  const selected = PRESET_COMBOS[key] || PRESET_COMBOS.default_combo;

  // Format device connector advisory
  let connectorAdvice = 'Cổng kết nối Type-C tiêu chuẩn';
  if (device === 'iphone_lightning') connectorAdvice = 'Đã chọn phiên bản cổng Lightning chứng nhận MFi cho iPhone';
  if (device === 'camera') connectorAdvice = 'Đã chọn phiên bản ngàm Cold-shoe và jack TRS 3.5mm cho máy ảnh';

  return {
    quizAnswers: { device, scenario, budget },
    connectorAdvice,
    recommendation: selected
  };
}

function createQuizRouter() {
  const router = Router();

  router.get('/quiz/questions', (_req, res) => {
    res.json({ questions: QUIZ_QUESTIONS });
  });

  router.post('/quiz/recommend', (req, res) => {
    const answers = req.body || {};
    const result = evaluateQuizAnswers(answers);
    res.json(result);
  });

  return router;
}

module.exports = {
  QUIZ_QUESTIONS,
  PRESET_COMBOS,
  evaluateQuizAnswers,
  createQuizRouter
};
