'use strict';

/**
 * Fixture mẫu dùng trong các kịch bản test đơn hàng, khách hàng, sản phẩm
 */
function createOrderFixture(overrides = {}) {
  const timestamp = Date.now();
  return {
    order_number: `TEST-ORD-${timestamp}`,
    customer_name: 'Khách hàng thử nghiệm',
    email: 'tester@example.test',
    phone: '0901234567',
    address: '123 Đường Thử Nghiệm, Phường 1',
    city: 'Hà Nội',
    payment_method: 'cod',
    subtotal_vnd: 250000,
    shipping_fee_vnd: 30000,
    total_vnd: 280000,
    status: 'pending',
    payment_status: 'pending',
    ...overrides
  };
}

function createProductFixture(overrides = {}) {
  const id = Math.random().toString(36).slice(2, 8);
  return {
    slug: `test-product-${id}`,
    name: `Sản phẩm thử nghiệm ${id}`,
    category: 'test',
    descriptor: 'Phiên bản mẫu',
    description: 'Mô tả thử nghiệm chi tiết',
    imageUrl: '/assets/products/sample.webp',
    imageAlt: 'Hình ảnh mẫu',
    active: true,
    sortOrder: 10,
    ...overrides
  };
}

function createAdminFixture(overrides = {}) {
  return {
    username: 'test_admin',
    role: 'admin',
    source: 'bootstrap',
    permissions: ['*'],
    ...overrides
  };
}

module.exports = {
  createOrderFixture,
  createProductFixture,
  createAdminFixture
};
