'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { parseHTML } = require('linkedom');
const address = require('../vietnam-address');

test('Vietnam Address: 34 provinces collation, Canonical normalization, 2-stage Combobox, and Legacy preservation', async (t) => {
  const jsonPath = path.join(__dirname, '../assets/data/vietnam-addresses.json');
  const dataset = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  address.setData(dataset);

  await t.test('1. 34 provinces are unique, sorted with Vietnamese locale, and canonical normalization is robust', () => {
    assert.equal(address.provinces.length, 34);
    assert.equal(new Set(address.provinces).size, 34);

    // Vietnamese collation
    for (let i = 0; i < address.provinces.length - 1; i++) {
      assert.ok(address.provinces[i].localeCompare(address.provinces[i + 1], 'vi') <= 0);
    }

    // Canonical normalization tests
    assert.equal(address.canonical('TP. Hồ Chí Minh'), 'Hồ Chí Minh');
    assert.equal(address.canonical('thành phố hồ chí minh'), 'Hồ Chí Minh');
    assert.equal(address.canonical('ha noi'), 'Hà Nội');
    assert.equal(address.canonical('Tỉnh Hà Tĩnh'), 'Hà Tĩnh');
    assert.equal(address.canonical('tp da nang'), 'Đà Nẵng');
    assert.equal(address.canonical('tinh ninh binh'), 'Ninh Bình');
    assert.equal(address.canonical('Nam Định'), ''); // Not in 34 provinces -> no hallucination
    assert.equal(address.canonical(''), '');
  });

  await t.test('2. setData validates dataset schema and loads 3,321 wards across 34 provinces', () => {
    // Invalids reject
    assert.throws(() => address.setData({ provinces: [] }), /Danh mục địa chỉ chưa hợp lệ/);
    assert.throws(() => address.setData(null), /Danh mục địa chỉ chưa hợp lệ/);

    const reloaded = address.setData(dataset);
    assert.equal(reloaded.provinces.length, 34);

    let wardCount = 0;
    for (const p of reloaded.provinces) {
      assert.ok(p.code);
      assert.ok(Array.isArray(p.wards));
      wardCount += p.wards.length;
    }
    assert.equal(wardCount, 3321);
  });

  await t.test('3. enhance transforms city inputs into accessible ARIA combobox picker without attribute loss', () => {
    const { document } = parseHTML(`
      <form>
        <label>Tỉnh thành<input name="city" required autocomplete="address-level1"></label>
        <input name="address" value="Số 10 Phố Huế">
      </form>
    `);
    const form = document.querySelector('form');
    address.enhance(document);

    const picker = form.querySelector('.vn-address-picker');
    const proxy = form.querySelector('.vn-address-choice');
    const city = form.querySelector('[name="city"]');

    assert.ok(picker);
    assert.ok(proxy);
    assert.equal(city.hidden, true);
    assert.equal(proxy.required, true);
    assert.equal(proxy.getAttribute('role'), 'combobox');
    assert.equal(proxy.getAttribute('aria-haspopup'), 'dialog');
  });

  await t.test('4. 2-stage navigation workflow: selects province then ward and produces combined address', () => {
    const { document, window } = parseHTML(`
      <form>
        <input name="address" value="Số 123 Đường Láng">
        <label>Tỉnh<input name="city" required></label>
      </form>
    `);
    const form = document.querySelector('form');
    address.enhance(document);

    const city = form.querySelector('[name="city"]');
    const proxy = form.querySelector('.vn-address-choice');
    const panel = form.querySelector('.vn-address-panel');

    let cityVal = '';
    Object.defineProperty(city, 'value', {
      configurable: true,
      get: () => cityVal,
      set: (v) => { cityVal = v; }
    });

    // Open panel
    proxy.dispatchEvent(new window.Event('click', { bubbles: true }));
    assert.equal(panel.hidden, false);

    // Select Hanoi province (code 01)
    const provinceBtn = form.querySelector('[data-address-code="01"]');
    provinceBtn.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }));
    assert.equal(city.value, 'Hà Nội');
    assert.equal(panel.hidden, false); // Stays open for ward selection

    // Validating before choosing ward throws error
    assert.throws(() => address.getAddress(form), /phường \/ xã/);

    // Select ward (code 00004: Phường Ba Đình)
    const wardBtn = form.querySelector('[data-address-code="00004"]');
    wardBtn.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }));
    assert.equal(panel.hidden, true); // Closes on completion
    assert.equal(city.dataset.wardCode, '00004');

    const fullAddr = address.getAddress(form);
    assert.equal(fullAddr, 'Số 123 Đường Láng, Phường Ba Đình');
  });

  await t.test('5. setAddress binds address data and preserves legacy addresses without ward guessing', () => {
    const { document } = parseHTML(`
      <form>
        <input name="address">
        <label>Tỉnh<input name="city"></label>
      </form>
    `);
    const form = document.querySelector('form');
    address.enhance(document);

    const city = form.querySelector('[name="city"]');
    let cityVal = '';
    Object.defineProperty(city, 'value', {
      configurable: true,
      get: () => cityVal,
      set: (v) => { cityVal = v; }
    });

    // 1. Standard structured address
    address.setAddress(form, { address: 'Toà nhà Green, Phường Ba Đình', city: 'Hà Nội' });
    assert.equal(form.querySelector('[name="address"]').value, 'Toà nhà Green');
    assert.equal(city.dataset.wardCode, '00004');
    assert.equal(address.getAddress(form), 'Toà nhà Green, Phường Ba Đình');

    // 2. Unmatched legacy address (preserves exact string without setting ward code)
    address.setAddress(form, { address: 'Xóm cũ thôn ngoại ô ghi trên sổ đỏ', city: 'Hà Nội' });
    assert.equal(address.getAddress(form), 'Xóm cũ thôn ngoại ô ghi trên sổ đỏ');
    assert.equal(city.dataset.wardCode, undefined);
  });
});
