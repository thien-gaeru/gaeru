const test = require("node:test");
const assert = require("node:assert/strict");
const { range, receiptSchema, supplierPaymentSchema, expenseSchema } = require("../src/finance-api");

test("report windows reject invalid calendar dates, reversed and unbounded ranges", () => {
  assert.deepEqual(range({ from: "2026-10-01", to: "2026-10-23" }), ["2026-10-01", "2026-10-23"]);
  assert.deepEqual(range({}, new Date("2026-10-22T18:00:00Z")), ["2026-09-24", "2026-10-23"]);
  for (const input of [
    { from: "2026-02-31", to: "2026-03-01" },
    { from: "2026-10-23", to: "2026-10-01" },
    { from: "2024-01-01", to: "2026-01-01" },
    { from: "invalid", to: "2026-10-23" }
  ]) assert.throws(() => range(input), /khoảng báo cáo/);
});

test("financial requests require bounded whole VND, references and a stable request key", () => {
  const base = { amountVnd: 100000, method: "bank_transfer", requestKey: "qa-finance-unique", reference: "BANK-TEST" };
  const receipt = { ...base, orderId: "11111111-1111-4111-8111-111111111111" };
  assert.equal(receiptSchema.safeParse(receipt).success, true);
  for (const amountVnd of [0, -1, 1.5, 2_000_000_001]) assert.equal(receiptSchema.safeParse({ ...receipt, amountVnd }).success, false);
  assert.equal(supplierPaymentSchema.safeParse({ ...base, supplierId: receipt.orderId }).success, true);
  assert.equal(expenseSchema.safeParse({ ...base, category: "operations", payee: "Test supplier" }).success, true);
  assert.equal(expenseSchema.safeParse({ ...base, category: "unknown", payee: "Test" }).success, false);
  assert.equal(receiptSchema.safeParse({ ...receipt, requestKey: "" }).success, false);
});
