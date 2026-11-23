import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCustomer, deleteCustomer } from './repo';
import { memoryDb } from '../testUtil';
import { addMonths, deletePayment, insertPayment, lastPayments, listPayments, renewedExpire, renewSpan, validAmount, validNote, validPaidAt } from './payments';

const DAY = 86_400_000;
const at = (y: number, m: number, d: number) => new Date(y, m - 1, d, 23, 59, 59, 999).getTime();

test('加自然月:日子不变,那个月没有这天取月底;跨年', () => {
  assert.equal(addMonths(at(2026, 11, 22), 1), at(2026, 12, 22));
  assert.equal(addMonths(at(2026, 11, 22), 3), at(2027, 2, 22));
  assert.equal(addMonths(at(2027, 1, 31), 1), at(2027, 2, 28));
  assert.equal(addMonths(at(2028, 1, 31), 1), at(2028, 2, 29));
  assert.equal(addMonths(at(2026, 8, 31), 1), at(2026, 9, 30));
  assert.equal(addMonths(at(2026, 1, 15), 12), at(2027, 1, 15));
});

test('续多久:在到期日上加,已到期 / 不限期的从现在起算;months、days 给一个', () => {
  const now = at(2026, 11, 23) - 12 * 3600_000;
  assert.equal(renewedExpire(at(2026, 12, 1), { months: 1, days: 0 }, now), at(2027, 1, 1));
  assert.equal(renewedExpire(at(2026, 12, 1), { months: 0, days: 30 }, now), at(2026, 12, 1) + 30 * DAY);
  assert.equal(renewedExpire(at(2026, 11, 1), { months: 0, days: 30 }, now), now + 30 * DAY);
  assert.equal(renewedExpire(0, { months: 1, days: 0 }, now), addMonths(now, 1));
  assert.deepEqual(renewSpan({ months: 3 }), { months: 3, days: 0 });
  assert.deepEqual(renewSpan({ days: '30' }), { months: 0, days: 30 });
  assert.deepEqual(renewSpan({ months: 1, days: 0 }), { months: 1, days: 0 });
  for (const bad of [{}, { months: 1, days: 30 }, { months: 0 }, { months: 0, days: 0 }, { months: 121 }, { months: 1.5 }, { days: 0 }, { days: 3651 }]) assert.throws(() => renewSpan(bad), /months|days/, JSON.stringify(bad));
});

test('金额 / 日期 / 备注的校验', () => {
  assert.equal(validAmount(''), null);
  assert.equal(validAmount(null), null);
  assert.equal(validAmount('99.999'), 100);
  assert.equal(validAmount(-20), -20);
  for (const bad of ['abc', 2e8, Infinity]) assert.throws(() => validAmount(bad), /金额/);
  assert.equal(validPaidAt(undefined, 123), 123);
  assert.equal(validPaidAt(456, 123), 456);
  for (const bad of [0, -1, 1.5, 'x']) assert.throws(() => validPaidAt(bad), /收款日期/);
  assert.equal(validNote('  支付宝 '), '支付宝');
  assert.throws(() => validNote('x'.repeat(201)), /200/);
  assert.throws(() => validNote(5), /文字/);
});

test('记录:新的在前、按客户 / 日期筛;客户删了记录还在,显示记的时候的名字;最近一笔收款(退款、没记钱的不算)', () => {
  const db = memoryDb();
  const a = createCustomer(db, { name: '小王' });
  const b = createCustomer(db, { name: '小李' });
  const base = { expire_before: 0, expire_after: 0, note: '' };
  const p1 = insertPayment(db, { ...base, customer_id: a, customer_name: '小王', amount: 30, paid_at: 1000, months: 1 });
  insertPayment(db, { ...base, customer_id: a, customer_name: '小王', amount: null, paid_at: 3000, days: 7 });
  insertPayment(db, { ...base, customer_id: b, customer_name: '小李', amount: 90, paid_at: 2000, months: 3 });
  insertPayment(db, { ...base, customer_id: b, customer_name: '小李', amount: -5, paid_at: 2500 });
  assert.deepEqual(listPayments(db).map((p) => p.paid_at), [3000, 2500, 2000, 1000]);
  assert.deepEqual(listPayments(db, { customer_id: a }).map((p) => p.amount), [null, 30]);
  assert.deepEqual(listPayments(db, { from: 1000, to: 2500 }).map((p) => p.paid_at), [2000, 1000]);
  assert.deepEqual([...lastPayments(db)].sort(), [[a, { amount: 30, paid_at: 1000 }], [b, { amount: 90, paid_at: 2000 }]]);
  assert.equal(p1.months, 1);

  db.prepare('UPDATE customers SET name = ? WHERE id = ?').run('老王', a);
  assert.equal(listPayments(db, { customer_id: a })[0].customer_name, '老王');
  deleteCustomer(db, b);
  const gone = listPayments(db, { customer_id: b })[0];
  assert.deepEqual([gone.customer_name, gone.customer_deleted], ['小李', true]);

  deletePayment(db, p1.id);
  assert.equal(listPayments(db).length, 3);
  assert.throws(() => deletePayment(db, p1.id), /不存在/);
});
