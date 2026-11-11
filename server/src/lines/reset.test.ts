import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addLine, createCustomer, customersDueReset, getCustomer, periodStart, updateCustomer, updateLineStats } from '../customers/repo';
import { alreadyNotified, markNotified } from '../notify/events';
import type { Panel } from '../panels/repo';
import { addPanel, memoryDb } from '../testUtil';
import { resetCustomerUsage, runMonthlyResets } from './reset';

const day = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h).getTime();

test('本期起点:当月清零日 0 点;还没到就是上个月的;1 月往前是去年 12 月', () => {
  assert.equal(periodStart(5, day(2026, 3, 10)), day(2026, 3, 5, 0));
  assert.equal(periodStart(5, day(2026, 3, 5, 0)), day(2026, 3, 5, 0));
  assert.equal(periodStart(5, day(2026, 3, 4)), day(2026, 2, 5, 0));
  assert.equal(periodStart(28, day(2026, 1, 3)), day(2025, 12, 28, 0));
});

test('按月清零:到了日子清一次,清过这期不再清;服务停了几期只清一次;客户端清零失败的照样记为已清;清零后「流量用到 90%」能再提醒', async () => {
  const db = memoryDb();
  const a = addPanel(db, 'a');
  const b = addPanel(db, 'b');
  const cid = createCustomer(db, { name: 'c', reset_day: 10 }, day(2026, 3, 1));
  const l1 = addLine(db, { customer_id: cid, kind: 'direct', panel_id: a.id, inbound_id: 1, inbound_remark: 'r', protocol: 'vless', email: 'c' });
  const l2 = addLine(db, { customer_id: cid, kind: 'direct', panel_id: b.id, inbound_id: 1, inbound_remark: 'r', protocol: 'vless', email: 'c' });
  updateLineStats(db, l1.id, { up: 100, down: 100, enable: true, last_online: 0 });
  updateLineStats(db, l2.id, { up: 50, down: 50, enable: true, last_online: 0 });
  markNotified(db, `quota:${cid}:0:0`);
  const calls: string[] = [];
  const adminFor = (p: Panel) => ({
    resetClientTraffic: async (email: string) => {
      calls.push(`${p.name}:${email}`);
      if (p.name === 'b') throw new Error('boom');
    },
  });

  // 3 月 9 号:还没到
  assert.deepEqual(await runMonthlyResets(db, adminFor, day(2026, 3, 9)), []);
  // 3 月 10 号:清
  const [r] = await runMonthlyResets(db, adminFor, day(2026, 3, 10));
  assert.deepEqual(calls, ['a:c', 'b:c']);
  assert.deepEqual(r.failed, [{ line: 'b 上的 c', error: 'boom' }]);
  const c = getCustomer(db, cid)!;
  assert.deepEqual([c.used, c.last_reset_at], [100, day(2026, 3, 10)]); // a 清了,b 没清成保留
  assert.equal(alreadyNotified(db, `quota:${cid}:0:0`), false);
  // 同一期再跑:不清
  calls.length = 0;
  assert.deepEqual(await runMonthlyResets(db, adminFor, day(2026, 3, 25)), []);
  assert.deepEqual(customersDueReset(db, day(2026, 4, 9)), []);
  // 停了两个月再起来:只清一次
  const two = await runMonthlyResets(db, adminFor, day(2026, 6, 1));
  assert.deepEqual([two.length, calls], [1, ['a:c', 'b:c']]);
  // 改清零日:从改的时候起算,下一个清零日才清
  updateCustomer(db, cid, { reset_day: 15 }, day(2026, 7, 20));
  assert.deepEqual(await runMonthlyResets(db, adminFor, day(2026, 7, 21)), []);
  assert.equal((await runMonthlyResets(db, adminFor, day(2026, 8, 15))).length, 1);
  // 关掉清零日
  updateCustomer(db, cid, { reset_day: 0 });
  assert.deepEqual(await runMonthlyResets(db, adminFor, day(2026, 9, 15)), []);
  assert.throws(() => updateCustomer(db, cid, { reset_day: 31 }), /1 到 28/);
});

test('手动清零:走同一段逻辑,返回没清成的线路', async () => {
  const db = memoryDb();
  const a = addPanel(db, 'a');
  const cid = createCustomer(db, { name: 'c' });
  const l = addLine(db, { customer_id: cid, kind: 'direct', panel_id: a.id, inbound_id: 1, inbound_remark: 'r', protocol: 'vless', email: 'c' });
  updateLineStats(db, l.id, { up: 5, down: 5, enable: true, last_online: 0 });
  const failed = await resetCustomerUsage(db, getCustomer(db, cid)!, () => ({ resetClientTraffic: async () => {} }));
  assert.deepEqual([failed, getCustomer(db, cid)!.used], [[], 0]);
});
