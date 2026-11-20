const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');

const source = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const commerce = source('commerce.js');
const shippingHelper = commerce.slice(commerce.indexOf('function shippingPresentation('), commerce.indexOf('let cartShippingRequest'));
const nationwide = 'Miễn phí giao hàng toàn quốc.';
const merchantNote = 'Vui lòng gọi trước khi giao.';

async function openDeliveryPanel(shippingRates, shippingNote) {
  const { document, window } = parseHTML('<html><body><details data-delivery-details><div data-delivery-content></div></details></body></html>');
  const context = vm.createContext({
    document, window, Intl, Headers, setTimeout, clearTimeout, MutationObserver: window.MutationObserver,
    fetch: async url => {
      assert.equal(url, '/api/settings/public');
      return new Response(JSON.stringify({ shippingRates, shippingNote }));
    }
  });
  vm.runInContext(source('checkout-flow.js'), context);
  vm.runInContext(shippingHelper, context);
  window.shippingPresentation = context.shippingPresentation;
  vm.runInContext(source('product-services.js'), context);

  const details = document.querySelector('details');
  details.open = true;
  details.dispatchEvent(new window.Event('toggle', { bubbles: true }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(details.dataset.loaded, 'true', details.textContent);
  return details;
}

const cases = [
  { name: 'nationwide free delivery', rates: { 'Toàn quốc': 0 }, note: 'Miễn phí vận chuyển toàn quốc',
    summary: nationwide, selections: [['Toàn quốc', '0 ₫']] },
  { name: 'mixed city rates', rates: { 'Toàn quốc': 20000, 'Hà Nội': 0, 'Đà Nẵng': 35000 }, note: 'Miễn phí vận chuyển toàn quốc',
    summary: 'Phí giao hàng được tính theo tỉnh/thành phố đã chọn.', selections: [['Đà Nẵng', '35.000 ₫'], ['Hà Nội', '0 ₫'], ['Toàn quốc', '20.000 ₫']] },
  { name: 'custom merchant guidance', rates: { 'Toàn quốc': 0 }, note: 'Miễn phí vận chuyển toàn quốc. ' + merchantNote,
    summary: nationwide + ' ' + merchantNote, selections: [['Toàn quốc', '0 ₫']] }
];

for (const scenario of cases) {
  test('product delivery panel handles ' + scenario.name, async () => {
    const panel = await openDeliveryPanel(scenario.rates, scenario.note);
    assert.equal(panel.querySelector('p').textContent, scenario.summary);
    const select = panel.querySelector('[data-delivery-city]');
    const fee = panel.querySelector('[data-delivery-fee]');
    assert.equal(fee.textContent, '');
    for (const [city, amount] of [...scenario.selections, ['', '']]) {
      const option = Array.from(select.options).find(item => item.value === city);
      assert.ok(option, 'Missing option ' + city);
      for (const item of select.options) item.removeAttribute('selected');
      option.setAttribute('selected', '');
      select.dispatchEvent(new panel.ownerDocument.defaultView.Event('change', { bubbles: true }));
      assert.equal(fee.textContent, amount ? 'Phí giao hàng: ' + amount : '');
      const freeClaims = panel.textContent.match(/Miễn phí (?:vận chuyển|giao hàng) toàn quốc/gi) || [];
      assert.equal(freeClaims.length, scenario.summary.includes(nationwide) ? 1 : 0);
      assert.equal(panel.textContent.split(merchantNote).length - 1, scenario.note.includes(merchantNote) ? 1 : 0);
    }
  });
}
