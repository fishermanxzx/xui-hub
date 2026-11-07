import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPanel, deletePanel, updatePanel } from '../panels/repo';
import { applyPanelSnapshot } from '../sync/service';
import { addPanel, memoryDb, snap } from '../testUtil';
import {
  addBinding,
  createCustomer,
  customerDailyUsage,
  customerIdBySubToken,
  customerState,
  dailyUsageBy,
  deleteCustomer,
  getCustomer,
  overallDailyUsage,
  resetSubToken,
  updateCustomer,
} from './repo';

test('客户状态:停用 > 到期 > 超额', () => {
  const base = { status: 'active' as const, quota_bytes: 100, expire_at: 0, used: 0 };
  assert.equal(customerState(base, 10), 'active');
  assert.equal(customerState({ ...base, used: 100 }, 10), 'over_quota');
  assert.equal(customerState({ ...base, used: 100, expire_at: 5 }, 10), 'expired');
  assert.equal(customerState({ ...base, status: 'disabled', expire_at: 5 }, 10), 'disabled');
});

test('同一 client 不能绑定到两个客户', () => {
  const db = memoryDb();
  const a = addPanel(db, 'a');
  applyPanelSnapshot(db, a, [snap('u', 1, 1)], 0);
  const c1 = createCustomer(db, { name: 'c1' });
  const c2 = createCustomer(db, { name: 'c2' });
  addBinding(db, c1, a.id, 'u', false);
  assert.throws(() => addBinding(db, c2, a.id, 'u', false), /已绑定到客户「c1」/);
  assert.throws(() => addBinding(db, c2, a.id, 'nope', false), /没有同步到/);
});

test('每个客户一个订阅 token,随机且不重复;重置后换新的,旧的失效', () => {
  const db = memoryDb();
  const a = getCustomer(db, createCustomer(db, { name: 'a' }))!;
  const b = getCustomer(db, createCustomer(db, { name: 'b' }))!;
  assert.match(a.sub_token, /^[A-Za-z0-9_-]{24}$/);
  assert.notEqual(a.sub_token, b.sub_token);
  assert.equal(customerIdBySubToken(db, a.sub_token), a.id);

  resetSubToken(db, a.id);
  const after = getCustomer(db, a.id)!;
  assert.notEqual(after.sub_token, a.sub_token);
  assert.equal(customerIdBySubToken(db, a.sub_token), undefined);
  assert.equal(customerIdBySubToken(db, after.sub_token), a.id);
  assert.equal(getCustomer(db, b.id)!.sub_token, b.sub_token, '别人的不动');
  assert.throws(() => resetSubToken(db, 999), /客户不存在/);
});

test('按天汇总流量(UTC+8)', () => {
  const db = memoryDb();
  let a = addPanel(db, 'a');
  applyPanelSnapshot(db, a, [snap('u', 0, 0)], 0);
  const id = createCustomer(db, { name: 'u' });
  addBinding(db, id, a.id, 'u', false);
  a = { ...a, last_sync_ok_at: 0 };
  const day = Date.UTC(2026, 9, 30, 20); // 北京时间 10-31 04:00
  applyPanelSnapshot(db, a, [snap('u', 5, 5)], day);
  const usage = customerDailyUsage(db, id, 2, 480, day);
  assert.deepEqual(usage.days, ['2026-10-30', '2026-10-31']);
  assert.deepEqual(usage.totals, [0, 10]);
  assert.equal(usage.lines[0].panel_name, 'a');
});

test('面板删了,客户的历史流量仍显示原名;新面板不复用它的 id', () => {
  const db = memoryDb();
  let a = addPanel(db, 'a');
  applyPanelSnapshot(db, a, [snap('u', 0, 0)], 0);
  const id = createCustomer(db, { name: 'u' });
  addBinding(db, id, a.id, 'u', false);
  a = { ...a, last_sync_ok_at: 0 };
  const day = Date.UTC(2026, 9, 30, 20);
  applyPanelSnapshot(db, a, [snap('u', 5, 5)], day);
  db.prepare('DELETE FROM bindings WHERE panel_id = ?').run(a.id);
  deletePanel(db, a.id, day);
  assert.equal(customerDailyUsage(db, id, 2, 480, day).lines[0].panel_name, 'a（已删除）');
  assert.ok(addPanel(db, 'b').id > a.id);
});

test('全体客户按天汇总:流量合计、有流量的客户数,未绑定的线路不算', () => {
  const db = memoryDb();
  let a = addPanel(db, 'a');
  applyPanelSnapshot(db, a, [snap('u', 0, 0), snap('v', 0, 0), snap('free', 0, 0)], 0);
  const u = createCustomer(db, { name: 'u' });
  const v = createCustomer(db, { name: 'v' });
  addBinding(db, u, a.id, 'u', false);
  addBinding(db, v, a.id, 'v', false);
  a = { ...a, last_sync_ok_at: 0 };
  const day = Date.UTC(2026, 9, 30, 20); // 北京时间 10-31 04:00
  applyPanelSnapshot(db, a, [snap('u', 5, 5), snap('v', 0, 0), snap('free', 7, 7)], day);
  applyPanelSnapshot(db, a, [snap('u', 5, 5), snap('v', 1, 2), snap('free', 7, 7)], day + 3_600_000);
  const usage = overallDailyUsage(db, 2, 480, day + 3_600_000);
  assert.deepEqual(usage.days, ['2026-10-30', '2026-10-31']);
  assert.deepEqual(usage.bytes, [0, 13]);
  assert.deepEqual(usage.customers, [0, 2]);
});

test('按面板 / 按客户拆开每日流量:按面板含没绑定的 client、列出没流量的面板;按客户只列有流量的', () => {
  const db = memoryDb();
  let a = addPanel(db, 'a');
  const b = addPanel(db, 'b');
  applyPanelSnapshot(db, a, [snap('u', 0, 0), snap('v', 0, 0), snap('free', 0, 0)], 0);
  const u = createCustomer(db, { name: 'u' });
  const v = createCustomer(db, { name: 'v' });
  addBinding(db, u, a.id, 'u', false);
  addBinding(db, v, a.id, 'v', false);
  a = { ...a, last_sync_ok_at: 0 };
  const day = Date.UTC(2026, 9, 30, 15); // 北京时间 10-30 23:00
  applyPanelSnapshot(db, a, [snap('u', 5, 5), snap('v', 0, 0), snap('free', 1, 2)], day);
  applyPanelSnapshot(db, a, [snap('u', 6, 6), snap('v', 0, 0), snap('free', 1, 2)], day + 3_600_000); // 跨到 10-31
  const byPanel = dailyUsageBy(db, 'panel', 2, 480, day + 3_600_000);
  assert.deepEqual(byPanel.days, ['2026-10-30', '2026-10-31']);
  assert.deepEqual(byPanel.series, [
    { id: a.id, values: [13, 2] },
    { id: b.id, values: [0, 0] },
  ]);
  assert.deepEqual(dailyUsageBy(db, 'customer', 2, 480, day + 3_600_000).series, [{ id: u, values: [10, 2] }]);
});

test('每日流量排除面板:总计、按客户不算被排除面板上的流量,按面板不列被排除的面板', () => {
  const db = memoryDb();
  let a = addPanel(db, 'a');
  let b = addPanel(db, 'b');
  applyPanelSnapshot(db, a, [snap('u', 0, 0)], 0);
  applyPanelSnapshot(db, b, [snap('u2', 0, 0), snap('v', 0, 0)], 0);
  const u = createCustomer(db, { name: 'u' });
  const v = createCustomer(db, { name: 'v' });
  addBinding(db, u, a.id, 'u', false);
  addBinding(db, u, b.id, 'u2', false);
  addBinding(db, v, b.id, 'v', false);
  a = { ...a, last_sync_ok_at: 0 };
  b = { ...b, last_sync_ok_at: 0 };
  const day = Date.UTC(2026, 9, 30, 20); // 北京时间 10-31 04:00
  applyPanelSnapshot(db, a, [snap('u', 5, 5)], day);
  applyPanelSnapshot(db, b, [snap('u2', 1, 1), snap('v', 2, 2)], day);
  const now = day + 3_600_000;

  assert.deepEqual(overallDailyUsage(db, 1, 480, now).bytes, [16]);
  const withoutB = overallDailyUsage(db, 1, 480, now, [b.id]);
  assert.deepEqual(withoutB.bytes, [10]);
  assert.deepEqual(withoutB.customers, [1], 'v 只在 b 上有流量,排除 b 后不算有流量的客户');
  assert.deepEqual(dailyUsageBy(db, 'customer', 1, 480, now, [b.id]).series, [{ id: u, values: [10] }]);
  assert.deepEqual(dailyUsageBy(db, 'panel', 1, 480, now, [b.id]).series, [{ id: a.id, values: [10] }]);
  assert.deepEqual(overallDailyUsage(db, 1, 480, now, [a.id, b.id]).bytes, [0]);
});

test('每日流量里经中转的流量:按面板登记的类型算(不看名称),已删除的面板按删除时的类型;排除的面板不算', () => {
  const db = memoryDb();
  let relay = createPanel(db, { name: '美国中转', base_url: 'https://198.51.100.1:2053/p', token: 't', role: 'relay' }, 0);
  let gone = createPanel(db, { name: '三网-2', base_url: 'https://198.51.100.2:2053/p', token: 't', role: 'relay' }, 0);
  let exit = createPanel(db, { name: '名字带中转的落地', base_url: 'https://198.51.100.3:2053/p', token: 't', role: 'exit' }, 0);
  for (const p of [relay, gone, exit]) applyPanelSnapshot(db, p, [snap('u-' + p.id, 0, 0)], 0);
  const u = createCustomer(db, { name: 'u' });
  for (const p of [relay, gone, exit]) addBinding(db, u, p.id, 'u-' + p.id, false);
  [relay, gone, exit] = [relay, gone, exit].map((p) => ({ ...p, last_sync_ok_at: 0 }));
  const day = Date.UTC(2026, 9, 30, 20); // 北京时间 10-31 04:00
  applyPanelSnapshot(db, relay, [snap('u-' + relay.id, 1, 1)], day);
  applyPanelSnapshot(db, gone, [snap('u-' + gone.id, 2, 2)], day);
  applyPanelSnapshot(db, exit, [snap('u-' + exit.id, 4, 4)], day);
  // 删面板要先解绑线路,这里直接删掉,只留名字,和线上删除后的样子一样
  db.prepare('DELETE FROM bindings WHERE panel_id = ?').run(gone.id);
  deletePanel(db, gone.id, day);
  const now = day + 3_600_000;

  const all = overallDailyUsage(db, 1, 480, now);
  assert.deepEqual(all.bytes, [14]);
  assert.deepEqual(all.relay, [6], '在用的中转 2 + 已删除的中转「三网-2」4;名字带中转的落地不算');
  assert.deepEqual(overallDailyUsage(db, 1, 480, now, [relay.id]).relay, [4]);
});

test('面板改类型:以前的流量仍按当时的类型统计,之后的按新类型', () => {
  const db = memoryDb();
  let x = createPanel(db, { name: 'X', base_url: 'https://198.51.100.1:2053/p', token: 't', role: 'exit' }, 0);
  applyPanelSnapshot(db, x, [snap('u', 0, 0)], 0);
  const u = createCustomer(db, { name: 'u' });
  addBinding(db, u, x.id, 'u', false);
  x = { ...x, last_sync_ok_at: 0 };
  const day1 = Date.UTC(2026, 9, 30, 4); // 北京时间 10-30 12:00
  applyPanelSnapshot(db, x, [snap('u', 5, 5)], day1); // 当落地时用了 10

  // 落地改成中转,之后又用了 4
  x = { ...updatePanel(db, x.id, { role: 'relay' }), last_sync_ok_at: day1 };
  const day2 = day1 + 86_400_000;
  applyPanelSnapshot(db, x, [snap('u', 7, 7)], day2);

  const usage = overallDailyUsage(db, 2, 480, day2 + 3_600_000);
  assert.deepEqual(usage.bytes, [10, 4]);
  assert.deepEqual(usage.relay, [0, 4], '改类型前那天还算直连落地');
});

test('删除客户:连同线路绑定一起删', () => {
  const db = memoryDb();
  const a = addPanel(db, 'a');
  applyPanelSnapshot(db, a, [snap('u', 0, 0)], 0);
  const id = createCustomer(db, { name: 'zhu' });
  addBinding(db, id, a.id, 'u', false);
  deleteCustomer(db, id);
  assert.equal(getCustomer(db, id), undefined);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM bindings').get() as { n: number }).n, 0);
  assert.throws(() => deleteCustomer(db, id), /客户不存在/);
});
