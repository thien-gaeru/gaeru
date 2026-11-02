const test=require('node:test'),assert=require('node:assert/strict');
const {anniversary}=require('../src/warranty-api');
test('warranty anniversary preserves calendar months and clamps leap day',()=>{assert.equal(anniversary('2024-02-29'),'2025-02-28');assert.equal(anniversary('2026-10-23'),'2027-10-23');for(const value of ['2025-02-29','2026-02-30','bad',undefined,'0099-01-01'])assert.throws(()=>anniversary(value));});
