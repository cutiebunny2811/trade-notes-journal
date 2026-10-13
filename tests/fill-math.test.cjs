const assert = require('node:assert/strict');
const { summarize } = require('../dist/fill-math.js');

const at = (action, quantity, unitPrice, day, commission = 0, multiplier = 1) => ({
  action, quantity, unitPrice, commission, multiplier, otherFees: 0,
  executedAt: `2026-10-${String(day).padStart(2, '0')}T10:00:00Z`
});

const stock = { direction: 'LONG' };
let result = summarize(stock, [at('buy', 10, 10, 1, 1), at('buy', 5, 12, 2, 1), at('sell', 5, 15, 3, 0.5)]);
assert.equal(result.steps[0].label, 'ซื้อไม้ 1');
assert.equal(result.steps[1].label, 'ซื้อไม้ 2');
assert.equal(result.steps[2].label, 'ขายบางส่วน 1');
assert.equal(result.openQuantity, 10);
assert.equal(result.averageEntry, 10.8);
assert.equal(result.realizedPl, 20.5);
assert.equal(result.status, 'pending');
assert.equal(result.pl, null);

result = summarize(stock, [at('buy', 10, 10, 1, 1), at('buy', 5, 12, 2, 1), at('sell', 5, 15, 3, 0.5), at('sell', 10, 14, 4, 1)]);
assert.equal(result.status, 'closed');
assert.equal(result.pl, 51.5);
assert.equal(result.steps[3].label, 'ขายปิดครบ');

result = summarize(stock, [at('sell', 10, 14, 4), at('buy', 10, 10, 1)]);
assert.equal(result.pl, 40);
assert.equal(result.steps[0].label, 'ซื้อไม้ 1');

result = summarize({ direction: 'SHORT' }, [at('sell', 10, 20, 1, 1), at('buy', 10, 18, 2, 1)]);
assert.equal(result.pl, 18);
assert.equal(result.steps[1].label, 'ซื้อคืนปิดครบ');

result = summarize(stock, [at('buy', 1, 2, 1, 1, 100), at('sell', 1, 3, 2, 1, 100)]);
assert.equal(result.pl, 98);

assert.throws(() => summarize(stock, [at('buy', 2, 10, 1), at('sell', 3, 12, 2)]), /มากกว่าจำนวนที่ถือ/);
assert.throws(() => summarize(stock, [at('buy', 1, 10, 1), at('sell', 1, 12, 2), at('buy', 1, 11, 3)]), /สร้างรายการเทรดใหม่/);
assert.throws(() => summarize(stock, [at('buy', -1, 10, 1)]), /ไม่ถูกต้อง/);

console.log('fill-math: 8 scenarios passed');
