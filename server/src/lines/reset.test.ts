import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addLine, adjustUsage, createCustomer, customersDueReset, deleteLine, getCustomer, nextResetAt, periodStart, resetPeriodStart, updateCustomer, updateLineStats } from '../customers/repo';
import { alreadyNotified, markNotified } from '../notify/events';
import type { Panel } from '../panels/repo';
import { addPanel, memoryDb } from '../testUtil';
import { resetCustomerUsage, runMonthlyResets } from './reset';
import { syncLines } from '../panels/check';
import { normalizeClients } from '../xui/normalize';

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
  // a 清了;b 在面板上没清成,本期照样从 0 算(上期的计数从结转里减掉);通知里写清零前的用量
  assert.deepEqual([c.used, c.last_reset_at, r.used], [0, day(2026, 3, 10), 300]);
  assert.equal(alreadyNotified(db, `quota:${cid}:0:0`), false);
  // b 接着用了 20:本期算 20
  updateLineStats(db, l2.id, { up: 60, down: 60, enable: true, last_online: 0 });
  assert.equal(getCustomer(db, cid)!.used, 20);
  // 后来在面板上被清零了(计数变小,同步时旧计数结转回来):本期还是只算清零之后用的
  syncLines(db, b.id, normalizeClients([{ email: 'c', traffic: { up: 3, down: 2 } }]), Date.now() + 1000);
  assert.equal(getCustomer(db, cid)!.used, 25);
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

test('有到期时间的客户,重置日跟着到期日走:每月到期日那一刻重置;月末到期的小月取月末;续费改了到期日后跟着变,改完不会马上清', async () => {
  const at = (y: number, m: number, d: number) => new Date(y, m - 1, d, 23, 59, 59, 999).getTime();
  const c = { reset_day: 1, expire_at: at(2026, 5, 15) };
  assert.equal(resetPeriodStart(c, day(2026, 3, 15)), at(2026, 2, 15));
  assert.equal(resetPeriodStart(c, day(2026, 3, 16)), at(2026, 3, 15));
  assert.equal(nextResetAt(c, day(2026, 3, 16)), at(2026, 4, 15));
  // 到期后没续费,周期照旧往后排
  assert.equal(resetPeriodStart(c, day(2026, 7, 1)), at(2026, 6, 15));
  // 31 号到期:2 月取 28 号,4 月取 30 号
  const eom = { reset_day: 1, expire_at: at(2026, 5, 31) };
  assert.deepEqual([resetPeriodStart(eom, day(2026, 3, 5)), nextResetAt(eom, day(2026, 3, 5)), nextResetAt(eom, day(2026, 4, 5))], [at(2026, 2, 28), at(2026, 3, 31), at(2026, 4, 30)]);
  assert.deepEqual([nextResetAt({ reset_day: 0, expire_at: at(2026, 5, 15) }), nextResetAt({ reset_day: 10, expire_at: 0 }, day(2026, 3, 10))], [0, day(2026, 4, 10, 0)]);

  const db = memoryDb();
  const a = addPanel(db, 'a');
  const cid = createCustomer(db, { name: 'c', reset_day: 1, expire_at: at(2026, 3, 15) }, day(2026, 3, 1));
  addLine(db, { customer_id: cid, kind: 'direct', panel_id: a.id, inbound_id: 1, inbound_remark: 'r', protocol: 'vless', email: 'c' });
  const adminFor = () => ({ resetClientTraffic: async () => {} });
  assert.equal(getCustomer(db, cid)!.next_reset_at > 0, true);
  assert.deepEqual(await runMonthlyResets(db, adminFor, day(2026, 3, 15)), []);
  assert.equal((await runMonthlyResets(db, adminFor, day(2026, 3, 16, 0))).length, 1);
  // 3 月 20 号中午续费,到期日变成 4 月 20 号:改完不会马上清;之后按新的日子走(每月 20 号到期那一刻)
  updateCustomer(db, cid, { expire_at: at(2026, 4, 20) }, day(2026, 3, 20));
  assert.deepEqual(await runMonthlyResets(db, adminFor, day(2026, 3, 20, 13)), []);
  assert.equal((await runMonthlyResets(db, adminFor, day(2026, 3, 21, 0))).length, 1);
  assert.deepEqual(await runMonthlyResets(db, adminFor, day(2026, 4, 20)), []);
  assert.equal((await runMonthlyResets(db, adminFor, day(2026, 4, 21, 0))).length, 1);
});

test('清零:结转的流量(删掉的线路、手动调整的)一起清零', async () => {
  const db = memoryDb();
  const p = addPanel(db, 'p');
  const cid = createCustomer(db, { name: 'c' });
  const keep = addLine(db, { customer_id: cid, kind: 'direct', panel_id: p.id, inbound_id: 1, inbound_remark: 'r', protocol: 'vless', email: 'c' });
  const gone = addLine(db, { customer_id: cid, kind: 'direct', panel_id: p.id, inbound_id: 1, inbound_remark: 'r', protocol: 'vless', email: 'c2' });
  updateLineStats(db, keep.id, { up: 1, down: 2, enable: true, last_online: 0 });
  updateLineStats(db, gone.id, { up: 30, down: 40, enable: true, last_online: 0 });
  deleteLine(db, gone.id);
  adjustUsage(db, cid, { down: 500 });
  assert.equal(getCustomer(db, cid)!.actual_used, 573);
  assert.deepEqual(await resetCustomerUsage(db, getCustomer(db, cid)!, () => ({ resetClientTraffic: async () => {} })), []);
  const v = getCustomer(db, cid)!;
  assert.deepEqual([v.actual_used, v.carried_up, v.carried_down, v.lines[0].up], [0, 0, 0, 0]);
});
