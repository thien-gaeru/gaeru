// src/warranty-spam.js
// GAERU Warranty Spam & Junk Detection System

function detectWarrantySpam(row) {
  if (row.status === 'active') {
    return { isSpam: false, spamReasons: [] };
  }

  const reasons = [];
  const automatic = Boolean(row.automatic);

  // 1. Phone number inspection
  const rawPhone = String(row.contactPhone || row.contact_phone || '').trim();
  const digits = rawPhone.replace(/\D/g, '');
  const phone = digits.startsWith('84') ? '0' + digits.slice(2) : digits;

  if (phone) {
    if (phone.length !== 10 || !/^0(3|5|7|8|9)\d{8}$/.test(phone)) {
      reasons.push('Số điện thoại không đúng chuẩn 10 số di động VN (03, 05, 07, 08, 09)');
    } else if (/^0(.)\1{8}$/.test(phone)) {
      reasons.push('Số điện thoại chứa toàn số lặp nghi vấn ảo');
    } else if (['0123456789', '0987654321', '0123456788', '0999999999', '0888888888'].includes(phone)) {
      reasons.push('Số điện thoại là dãy số thứ tự hoặc số giả định');
    }
  } else if (!automatic) {
    reasons.push('Thiếu số điện thoại liên hệ');
  }

  // 2. Name inspection
  const name = String(row.contactName || row.contact_name || row.customerName || '').trim();
  const lowerName = name.toLowerCase();
  if (name) {
    if (name.length < 2) {
      reasons.push('Tên liên hệ quá ngắn (< 2 ký tự)');
    } else if (/^(test|spam|demo|asdf|fake|aaaa|bbbb|cccc|xxxx|noname|admin|null|undefined)(\s+(test|spam|demo|asdf|fake|aaaa|bbbb|cccc|xxxx|noname|admin|null|undefined))*$/i.test(lowerName)) {
      reasons.push('Họ tên chứa từ khóa thử nghiệm / spam');
    } else if (/^[0-9\W_]+$/.test(name)) {
      reasons.push('Họ tên chỉ gồm số hoặc ký tự đặc biệt');
    } else if (/(.)\1{4,}/.test(lowerName)) {
      reasons.push('Họ tên chứa ký tự lặp vô nghĩa');
    }
  } else if (!automatic) {
    reasons.push('Thiếu họ tên người liên hệ');
  }

  // 3. Order number / serial check
  const orderNum = String(row.orderNumber || row.external_order_number || row.externalOrderNumber || '').trim().toLowerCase();
  if (orderNum && /^(test|demo|123|1234|0000|1111|fake|none|null|asdf)$/i.test(orderNum)) {
    reasons.push('Mã đơn hàng nghi vấn rác / thử nghiệm');
  }
  const serial = String(row.serial || '').trim().toLowerCase();
  if (serial && /^(test|demo|123|1234|0000|1111|fake|none|null|asdf)$/i.test(serial)) {
    reasons.push('Số serial nghi vấn rác / thử nghiệm');
  }

  // 4. Email check
  const email = String(row.contactEmail || row.contact_email || '').trim().toLowerCase();
  if (email) {
    const domain = email.split('@')[1] || '';
    const disposable = ['tempmail.com', '10minutemail.com', 'mailinator.com', 'guerrillamail.com', 'yopmail.com', 'trashmail.com', 'dispostable.com', 'fake.com', 'test.com', 'example.com'];
    if (disposable.includes(domain) || domain.includes('temp') || domain.includes('disposable')) {
      reasons.push('Email hòm thư tạm thời (' + domain + ')');
    } else if (/^(test|spam|fake|asdf)@/.test(email)) {
      reasons.push('Email chứa tiền tố thử nghiệm');
    }
  }

  // 5. Explicit rejection reason or status
  const reason = String(row.reason || '').toLowerCase();
  if (row.status === 'rejected' && (reason.includes('rác') || reason.includes('spam') || reason.includes('ảo') || reason.includes('giả mạo') || reason.includes('không hợp lệ'))) {
    reasons.push('Đã từ chối trước đó do thông tin rác / không hợp lệ');
  }

  // 6. Suspicious claimed date
  const claimed = String(row.claimedPurchaseDate || row.claimed_purchase_date || '').trim();
  if (claimed && (claimed < '2020-01-01' || claimed === '1970-01-01')) {
    reasons.push('Ngày mua khai báo không thực tế (' + claimed + ')');
  }

  return {
    isSpam: reasons.length > 0,
    spamReasons: reasons
  };
}

const SPAM_SQL_PREDICATE = `(
  w.status <> 'active'
  AND (
    w.status = 'rejected'
    OR (w.automatic = false AND (
      w.contact_phone IS NULL OR trim(w.contact_phone) = ''
      OR regexp_replace(w.contact_phone, '[^0-9]', '', 'g') !~ '^(0|84)(3|5|7|8|9)[0-9]{8}$'
      OR regexp_replace(w.contact_phone, '[^0-9]', '', 'g') ~ '^(0000000000|0123456789|0987654321|0999999999|0111111111|0888888888|840000000000)$'
      OR lower(coalesce(w.contact_name, '')) ~* '(test|spam|demo|asdf|fake|aaaa|bbbb|cccc|noname|admin)'
      OR lower(coalesce(w.external_order_number, '')) ~* '^(test|demo|123|1234|0000|1111|fake|none|null)$'
      OR lower(coalesce(w.serial, '')) ~* '^(test|demo|123|1234|0000|1111|fake|none|null)$'
      OR lower(coalesce(w.contact_email, '')) ~* '(tempmail|10minute|mailinator|guerrillamail|yopmail|trashmail|dispostable|fake\\.com|test\\.com|test@|spam@|fake@)'
      OR lower(coalesce(w.reason, '')) ~* '(rác|spam|giả mạo|không hợp lệ|không có thật)'
    ))
  )
)`;

module.exports = { detectWarrantySpam, SPAM_SQL_PREDICATE };
