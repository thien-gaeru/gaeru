const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT_DIR = path.resolve(__dirname, '..');

test('Legal page complies with Decree 52/2013/ND-CP & Decree 85/2021/ND-CP mandatory seller disclosure', () => {
  const html = fs.readFileSync(path.join(ROOT_DIR, 'legal.html'), 'utf8');
  assert.ok(html.includes('HỘ KINH DOANH GAERU'), 'Must disclose registered business name in Vietnamese');
  assert.ok(html.includes('8836293843-002'), 'Must disclose business registration and tax code');
  assert.ok(html.includes('Thôn 2, Xã Rạng Đông'), 'Must disclose registered address');
  assert.ok(html.includes('082 919 1080'), 'Must disclose official contact hotline');
  assert.ok(html.includes('business@gaeru.com'), 'Must disclose official support email');
  assert.ok(html.includes('Nghị định 52/2013/NĐ-CP'), 'Must cite Decree 52/2013/ND-CP');
  assert.ok(html.includes('Nghị định 85/2021/NĐ-CP'), 'Must cite Decree 85/2021/ND-CP');
  assert.ok(html.includes('online.gov.vn'), 'Must cite Ministry of Industry and Trade portal');
  assert.ok(!html.includes('chưa hoàn tất thủ tục pháp lý áp dụng đối với việc vận hành website bán hàng trực tuyến'), 'Outdated temporary legal disclaimers must be removed');
});

test('Terms of service enforce clear electronic contract formation process under Article 31-43 of Decree 52', () => {
  const html = fs.readFileSync(path.join(ROOT_DIR, 'terms.html'), 'utf8');
  assert.ok(html.includes('Quy trình giao kết hợp đồng mua bán điện tử'), 'Must define contract formation process');
  assert.ok(html.includes('Rà soát và xác nhận đơn hàng'), 'Must enforce order review step before placement');
  assert.ok(html.includes('Quyền và nghĩa vụ của bên bán'), 'Must specify seller obligations');
  assert.ok(html.includes('Quyền và nghĩa vụ của bên mua'), 'Must specify buyer rights and obligations');
  assert.ok(html.includes('Chính sách hủy đơn hàng'), 'Must define order cancellation policy');
  assert.ok(html.includes('giải quyết khiếu nại và tranh chấp'), 'Must define dispute resolution under VN law');
  assert.ok(!html.includes('Checkout trực tuyến hiện đang tạm khóa'), 'Must not display checkout lock text');
});

test('Delivery and returns policy satisfies Decree 85/2021/ND-CP co-inspection and logistics liability requirements', () => {
  const html = fs.readFileSync(path.join(ROOT_DIR, 'delivery-returns.html'), 'utf8');
  assert.ok(html.includes('đồng kiểm khi nhận hàng') || html.includes('Đồng kiểm khi nhận'), 'Must offer co-inspection upon receipt');
  assert.ok(html.includes('Phân định trách nhiệm của GAERU và đơn vị logistics'), 'Must define logistics responsibility breakdown');
  assert.ok(html.includes('Đổi trả hàng') || html.includes('đổi mới 1:1'), 'Must define exchange conditions');
  assert.ok(html.includes('Chính sách hoàn tiền'), 'Must define refund policy and timeframe');
  assert.ok(html.includes('12 tháng'), 'Must state 12-month warranty');
});

test('Payment policy transparently discloses authorized VN payment methods and security standards', () => {
  const html = fs.readFileSync(path.join(ROOT_DIR, 'payment.html'), 'utf8');
  assert.ok(html.includes('COD'), 'Must support COD');
  assert.ok(html.includes('VietQR'), 'Must support automated VietQR bank transfer');
  assert.ok(html.includes('VNPAY'), 'Must support VNPAY');
  assert.ok(html.includes('PCI-DSS') || html.includes('TLS 1.3'), 'Must declare payment data security standards');
});

test('Privacy policy complies with Decree 13/2023/ND-CP Personal Data Protection', () => {
  const html = fs.readFileSync(path.join(ROOT_DIR, 'privacy.html'), 'utf8');
  assert.ok(html.includes('Nghị định số 13/2023/NĐ-CP') || html.includes('Nghị định 13/2023/NĐ-CP'), 'Must cite Decree 13/2023/ND-CP');
  assert.ok(html.includes('Mục đích thu thập'), 'Must specify collection purposes');
  assert.ok(html.includes('Phạm vi dữ liệu'), 'Must specify data scope');
  assert.ok(html.includes('Thời gian lưu trữ dữ liệu'), 'Must specify retention period');
  assert.ok(html.includes('Quyền của chủ thể dữ liệu'), 'Must state data subject rights');
  assert.ok(html.includes('Quyền được biết') && html.includes('Quyền truy cập'), 'Must detail specific rights');
});

test('Complaints policy satisfies Consumer Rights Protection Law standards', () => {
  const html = fs.readFileSync(path.join(ROOT_DIR, 'complaints.html'), 'utf8');
  assert.ok(html.includes('Luật Bảo vệ quyền lợi người tiêu dùng'), 'Must cite Consumer Protection Law');
  assert.ok(html.includes('Các kênh tiếp nhận khiếu nại'), 'Must specify intake channels');
  assert.ok(html.includes('Quy trình') && html.includes('giải quyết khiếu nại'), 'Must outline resolution process');
});

test('Store footer shell contains registered business info under Article 29 of Decree 52', () => {
  const js = fs.readFileSync(path.join(ROOT_DIR, 'store-shell.js'), 'utf8');
  assert.ok(js.includes('8836293843-002'), 'Footer must contain business registration and tax code');
  assert.ok(js.includes('Thôn 2, Xã Rạng Đông'), 'Footer must contain registered address');
  assert.ok(js.includes('Nghị định 52/2013/NĐ-CP'), 'Footer must state Decree 52 compliance');
});
