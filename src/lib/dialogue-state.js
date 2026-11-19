'use strict';

/**
 * Multi-Turn Dialogue State Tracker for GAERU Customer AI.
 *
 * Extracts persistent conversational slots across up to 10 recent turns + thread context:
 *  - activeProduct & lastDiscussedProduct (persisted across short natural Vietnamese follow-ups)
 *  - pendingBuyIntent & shouldCarryoverBuyIntent (carries purchase intent across turns like
 *    "tôi muốn mua ngay" -> "mic m3" -> "iphone 15")
 *  - pendingAiSlot ('product' | 'device' | 'variant' | 'order_code' | null)
 *  - inferredPorts (latest device/connector port mentioned by the customer)
 *  - micCount ('1 mic' | '2 mic' | null), standType ('de ban' | '2m1' | null), useCase
 */

const {
  normalizeSearchSpace,
  expandQueryVi,
  hasAnyBoundaryTerm,
  resolveMentionedProducts
} = require('./ai-nlu');
const { inferDevicePortsFromText } = require('./phone-compatibility');

const BUY_NEGATION_RE = /(?:^|[^a-z0-9])(?:chua|khong|dung|thoi|huy|bo|ngung)\s+(?:\w+\s+){0,2}(?:chot|mua|dat|lay|len don|dat hang)(?=$|[^a-z0-9])/i;

function isGlobalNonProductTurn(space) {
  if (!space) return false;
  return hasAnyBoundaryTerm(space, [
    'hoa don vat', 'hoa don do', 'hoa don dien tu', 'xuat hoa don', 'xuat vat', 'ma so thue', 'gtgt',
    'hotline', 'so dien thoai shop', 'so dien thoai cua shop', 'sdt shop', 'so hotline',
    'shop o dau', 'cua hang o dau', 'dia chi shop', 'dia chi cua hang', 'showroom', 'gio lam viec',
    'don cua minh', 'don cua toi', 'don hang cua minh', 'don hang cua toi', 'tra cuu don', 'kiem tra don',
    'bang gia tat ca', 'tat ca san pham', 'shop ban gi', 'co nhung san pham nao',
    'giup gi', 'giup duoc gi', 'ban giup gi', 'ban lam duoc gi', 'ho tro gi', 'ho tro duoc gi', 'ban la ai'
  ]);
}

function isPureInformationalQuestion(space) {
  if (!space) return false;
  return hasAnyBoundaryTerm(space, [
    'bao nhieu tieng', 'may tieng', 'may gio', 'thoi luong', 'pin', 'hop sac',
    'khoang cach', 'bao xa', 'may met', 'tam thu',
    'bao hanh', 'doi tra', 'hoan tien', 'dong kiem', 'hoa don', 'vat',
    'phi ship', 'freeship', 'giao hang', 'van chuyen', 'may ngay',
    'huong dan', 'cach dung', 'cach su dung', 'cach bat', 'den bao', 'nhap nhay',
    'so sanh', 'khac nhau', 'khac gi',
    'cong dung', 'chuc nang', 'tinh nang', 'tac dung', 'uu diem', 'co gi hay',
    'chong nuoc', 'di mua', 'trong hop', 'phu kien', 'trong luong', 'kich thuoc',
    'khong nhan', 'mat tieng', 'bi re', 'tieng vang', 'reverb', 'echo', 'otg', 'go loi usb',
    'hotline', 'dia chi', 'cua hang', 'shopee', 'tiktok shop', 'gaeru xu', 'voucher', 'ma giam gia',
    'tra loi sai', 'lap lai', 'khong dung y', 'giup gi', 'ho tro gi', 'la gi', 'gioi thieu', 'review'
  ]);
}

function messageHasCustomerBuyIntent(rawText) {
  const raw = String(rawText || '').trim();
  if (!raw) return false;
  // Avoid Vietnamese homonyms "mưa" / "mùa"
  if (/(?:^|[^\p{L}])m(?:ưa|ùa)(?=$|[^\p{L}])/iu.test(raw) && !/(?:^|[^\p{L}])mua(?=$|[^\p{L}])/iu.test(raw)) {
    return false;
  }
  const s = normalizeSearchSpace(expandQueryVi(raw));
  if (!s || BUY_NEGATION_RE.test(s) || hasAnyBoundaryTerm(s, ['chua can mua', 'tham khao truoc', 'suy nghi them', 'hoi truoc', 'chi hoi'])) {
    return false;
  }
  return hasAnyBoundaryTerm(s, [
    'mua ngay', 'muon mua', 'can mua', 'dat mua', 'dat hang', 'dat ngay', 'mua hang',
    'chot don', 'chot mua', 'chot lay', 'chot luon', 'len don', 'mua luon', 'lay luon',
    'nut mua', 'nut mua dau', 'nut dat', 'link mua', 'link dat', 'gui link mua', 'cho xin link', 'cho minh link',
    'mua o dau', 'dat o dau', 'mua cho nao', 'dat cho nao', 'bam mua dau', 'mua the nao', 'cach mua'
  ]) || /^(?:mua|dat|chot|lay|mua di|dat di|mua nhe|mua nha)$/.test(s);
}

function detectPendingAiSlot(lastAiText) {
  const s = normalizeSearchSpace(expandQueryVi(lastAiText || ''));
  if (!s) return null;
  if (hasAnyBoundaryTerm(s, ['ma don hang', 'dang gr', 'dang gae'])) return 'order_code';
  if (hasAnyBoundaryTerm(s, ['cac thiet bi gaeru san hang de ban dat mua ngay', 'ban dang can tu van mau nao', 'ban chon mau nao'])) return 'product';
  if (hasAnyBoundaryTerm(s, ['de dat mua dung phien ban', 'ban cho minh biet them thiet bi dang dung', 'ban nhan ten may dang dung', 'ban dang dung thiet bi nao', 'ban dang dung may nao'])) return 'device';
  if (hasAnyBoundaryTerm(s, ['1 mic hay 2 mic', 'de ban hay chan 2m1', 'chon dung phan loai'])) return 'variant';
  return null;
}

function aiPromptedForPurchaseSlot(lastAiText) {
  const raw = String(lastAiText || '');
  const s = normalizeSearchSpace(expandQueryVi(raw));
  if (!s) return false;
  return hasAnyBoundaryTerm(s, [
    'cac thiet bi gaeru san hang de ban dat mua ngay',
    'de dat mua dung phien ban',
    'ban chon dung phan loai ben duoi de dat mua ngay',
    'ban nhan ten may dang dung de minh chot'
  ]);
}

function aiAlreadySentDirectCheckout(lastAiText) {
  return /\/thanh-toan\?variant=/.test(String(lastAiText || ''));
}

function extractLatestCustomerPorts(space, history = []) {
  // 1. Check current turn first; if customer explicitly names a device/port now, use it
  const currentPorts = inferDevicePortsFromText(space, []);
  if (currentPorts && currentPorts.size > 0) {
    return currentPorts;
  }
  // 2. Scan up to 10 recent customer turns from newest to oldest so a later device overrides an earlier one
  if (Array.isArray(history) && history.length) {
    const recentCust = history.slice(-10).reverse().filter(m => m && (!m.sender || m.sender === 'customer'));
    for (const msg of recentCust) {
      const mSpace = normalizeSearchSpace(expandQueryVi(msg.body || msg.content || ''));
      if (!mSpace) continue;
      const ports = inferDevicePortsFromText(mSpace, []);
      if (ports && ports.size > 0) {
        return ports;
      }
    }
  }
  return new Set();
}

function extractMicCount(space, history = []) {
  const detect = (s) => {
    if (!s) return null;
    if (hasAnyBoundaryTerm(s, ['2 mic', '2 micro', 'ban 2', 'hai mic', 'bo doi', '2 nguoi', 'hai nguoi', 'cap doi', 'phong van'])) return '2 mic';
    if (hasAnyBoundaryTerm(s, ['1 mic', '1 micro', 'ban 1', 'mot mic', 'bo don', '1 nguoi', 'mot minh'])) return '1 mic';
    return null;
  };
  const now = detect(space);
  if (now) return now;
  if (Array.isArray(history) && history.length) {
    const recentCust = history.slice(-8).reverse().filter(m => m && (!m.sender || m.sender === 'customer'));
    for (const msg of recentCust) {
      const hit = detect(normalizeSearchSpace(expandQueryVi(msg.body || msg.content || '')));
      if (hit) return hit;
    }
  }
  return null;
}

function extractStandType(space, history = []) {
  const detect = (s) => {
    if (!s) return null;
    if (hasAnyBoundaryTerm(s, ['2m1', '2.1m', 'chan 2m1', 'chan cao', 'chan dung', 'kem chan'])) return '2m1';
    if (hasAnyBoundaryTerm(s, ['de ban', 'ban de ban', 'khong chan'])) return 'de ban';
    return null;
  };
  const now = detect(space);
  if (now) return now;
  if (Array.isArray(history) && history.length) {
    const recentCust = history.slice(-8).reverse().filter(m => m && (!m.sender || m.sender === 'customer'));
    for (const msg of recentCust) {
      const hit = detect(normalizeSearchSpace(expandQueryVi(msg.body || msg.content || '')));
      if (hit) return hit;
    }
  }
  return null;
}

function extractUseCase(space, history = []) {
  const detect = (s) => {
    if (!s) return null;
    if (hasAnyBoundaryTerm(s, ['livestream', 'live stream', 'ban hang live', 'phat truc tiep'])) return 'livestream';
    if (hasAnyBoundaryTerm(s, ['ngoai troi', 'ngoai canh', 'gio to', 'duong pho'])) return 'outdoor';
    if (hasAnyBoundaryTerm(s, ['phong van', '2 nguoi', 'hai nguoi', 'cap doi'])) return 'interview';
    if (hasAnyBoundaryTerm(s, ['day hoc', 'giang day', 'hop online', 'zoom', 'google meet'])) return 'teaching';
    if (hasAnyBoundaryTerm(s, ['vlog', 'tiktok', 'youtube', 'quay video', 'tu quay'])) return 'vlog';
    return null;
  };
  const now = detect(space);
  if (now) return now;
  if (Array.isArray(history) && history.length) {
    const recentCust = history.slice(-6).reverse().filter(m => m && (!m.sender || m.sender === 'customer'));
    for (const msg of recentCust) {
      const hit = detect(normalizeSearchSpace(expandQueryVi(msg.body || msg.content || '')));
      if (hit) return hit;
    }
  }
  return null;
}

function findLastSingleProductInHistory(history = [], catalog = []) {
  if (!Array.isArray(history) || !history.length) return null;
  const recent = [...history].slice(-10).reverse();
  for (const msg of recent) {
    const body = String(msg?.body || msg?.content || '').trim();
    if (!body) continue;
    const res = resolveMentionedProducts(body, catalog, { history: [] });
    if (res.source === 'question' && res.items.length === 1) {
      return { ...res.items[0], source: 'history' };
    }
  }
  return null;
}

function extractDialogueState({ question, history = [], thread = null, catalog = [] } = {}) {
  const raw = String(question || '').trim();
  const expanded = expandQueryVi(raw);
  const space = normalizeSearchSpace(expanded);
  const hist = Array.isArray(history) ? history : [];

  const mentioned = resolveMentionedProducts(raw, catalog, { thread, history: hist });
  const globalNonProd = mentioned.source !== 'question' && isGlobalNonProductTurn(space);
  const lastDiscussedProduct = mentioned.items[0]
    ? { ...mentioned.items[0], source: mentioned.source }
    : findLastSingleProductInHistory(hist, catalog);
  const activeProduct = globalNonProd
    ? null
    : (mentioned.items[0] ? { ...mentioned.items[0], source: mentioned.source } : null);

  const lastAiMsg = [...hist].reverse().find(m => m && (m.sender === 'ai' || m.sender === 'admin'));
  const lastAiAnswer = String(lastAiMsg?.body || lastAiMsg?.content || '');
  const recentCustomerMsgs = hist.filter(m => m && (!m.sender || m.sender === 'customer')).slice(-2);
  const lastCustomerQuestion = String(recentCustomerMsgs[recentCustomerMsgs.length - 1]?.body || recentCustomerMsgs[recentCustomerMsgs.length - 1]?.content || '');

  const pendingAiSlot = detectPendingAiSlot(lastAiAnswer);
  const recentCustomerWantedToBuy = recentCustomerMsgs.some(m => messageHasCustomerBuyIntent(m?.body || m?.content || ''));
  const aiWaitingForBuyDetails = aiPromptedForPurchaseSlot(lastAiAnswer);
  const alreadyClosedLastTurn = aiAlreadySentDirectCheckout(lastAiAnswer) && !aiWaitingForBuyDetails;

  // Pending buy intent is active when customer recently asked to buy (and wasn't already given a final 1-click checkout)
  // OR when AI's immediately preceding turn asked for product/device/variant to place the order.
  const pendingBuyIntent = Boolean(aiWaitingForBuyDetails || (recentCustomerWantedToBuy && !alreadyClosedLastTurn));

  const inferredPorts = extractLatestCustomerPorts(space, hist);
  const currentTurnPorts = inferDevicePortsFromText(space, []);
  const micCount = extractMicCount(space, hist);
  const standType = extractStandType(space, hist);
  const useCase = extractUseCase(space, hist);

  const negatedNow = BUY_NEGATION_RE.test(space) ||
    hasAnyBoundaryTerm(space, ['chua can mua', 'tham khao truoc', 'suy nghi them', 'hoi truoc', 'chi hoi']);
  const pureInfoNow = isPureInformationalQuestion(space);

  // Determine whether current turn is answering a pending purchase slot (e.g. "tôi muốn mua ngay" -> "mic m3" -> "iphone 15")
  const suppliedProductForPendingBuy = mentioned.source === 'question' && mentioned.items.length === 1;
  const suppliedDeviceOrVariantForPendingBuy = Boolean(activeProduct) && (
    (currentTurnPorts && currentTurnPorts.size > 0) ||
    hasAnyBoundaryTerm(space, ['1 mic', '2 mic', '1 micro', '2 micro', 'type c', 'lightning', 'micro usb', 'usb a', 'de ban', '2m1', 'ban nay', 'ban do', 'cai nay', 'bo nay'])
  );

  const shouldCarryoverBuyIntent = Boolean(
    pendingBuyIntent &&
    !negatedNow &&
    !pureInfoNow &&
    (suppliedProductForPendingBuy || suppliedDeviceOrVariantForPendingBuy)
  );

  return {
    mentioned,
    activeProduct,
    lastDiscussedProduct,
    isGlobalNonProduct: globalNonProd,
    pendingBuyIntent,
    shouldCarryoverBuyIntent,
    pendingAiSlot,
    inferredPorts,
    micCount,
    standType,
    useCase,
    lastCustomerQuestion,
    lastAiAnswer,
    turnCount: hist.length
  };
}

module.exports = {
  extractDialogueState,
  isGlobalNonProductTurn,
  isPureInformationalQuestion,
  messageHasCustomerBuyIntent,
  detectPendingAiSlot,
  extractLatestCustomerPorts
};
