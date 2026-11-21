import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DB } from '../db';
import { createSocks } from '../socks/repo';
import { addPanel, memoryDb } from '../testUtil';
import { deletePanel } from '../panels/repo';
import { userinfoHeader } from '../subscription/service';
import {
  addLine,
  adjustUsage,
  createCustomer,
  customerIdBySubToken,
  deleteCustomer,
  deleteLine,
  getCustomer,
  getLine,
  lineByEmail,
  linesOnPanel,
  linesViaSocks,
  listCustomers,
  markLineAuto,
  resetSubToken,
  touchSubFetch,
  updateCustomer,
  updateLineStats,
  zeroLineTraffic,
  type LineInsert,
} from './repo';

const line = (db: DB, customer_id: number, panel_id: number, email: string, over: Partial<LineInsert> = {}) =>
  addLine(db, { customer_id, kind: 'direct', panel_id, inbound_id: 1, inbound_remark: 'r', protocol: 'vless', email, ...over }, 5);

test('客户增改:名称、额度、到期时间的校验;没传的字段不动,留空的额度 / 到期 = 不限', () => {
  const db = memoryDb();
  const id = createCustomer(db, { name: ' 张三 ', remark: ' 月付 ', quota_bytes: '1000' }, 10);
  const c = getCustomer(db, id)!;
  assert.deepEqual([c.name, c.remark, c.quota_bytes, c.expire_at, c.created_at, c.updated_at], ['张三', '月付', 1000, 0, 10, 10]);
  assert.deepEqual([c.lines, c.used_up, c.used_down, c.used, c.state], [[], 0, 0, 0, 'active']);

  assert.throws(() => createCustomer(db, { name: ' ' }), /客户名称不能为空/);
  assert.throws(() => createCustomer(db, {}), /客户名称不能为空/);
  assert.throws(() => createCustomer(db, { name: 'x'.repeat(65) }), /不能超过 64 个字符/);
  assert.throws(() => createCustomer(db, { name: 'a', quota_bytes: -1 }), /额度必须是大于等于 0 的整数/);
  assert.throws(() => createCustomer(db, { name: 'a', quota_bytes: 1.5 }), /额度必须是/);
  assert.throws(() => createCustomer(db, { name: 'a', expire_at: 'abc' }), /到期时间必须是大于等于 0 的整数/);
  assert.equal(listCustomers(db).length, 1);

  updateCustomer(db, id, { remark: '年付' }, 20);
  let got = getCustomer(db, id)!;
  assert.deepEqual([got.name, got.remark, got.quota_bytes, got.updated_at, got.created_at], ['张三', '年付', 1000, 20, 10]);
  updateCustomer(db, id, { name: '张三丰', quota_bytes: '', expire_at: 99 }, 30);
  got = getCustomer(db, id)!;
  assert.deepEqual([got.name, got.remark, got.quota_bytes, got.expire_at], ['张三丰', '年付', 0, 99]);
  assert.throws(() => updateCustomer(db, id, { name: '' }), /客户名称不能为空/);
  assert.throws(() => updateCustomer(db, id, { quota_bytes: 'x' }), /额度必须是/);
  assert.equal(getCustomer(db, id)!.name, '张三丰');
  assert.throws(() => updateCustomer(db, 999, { name: 'x' }), /客户不存在/);
  assert.equal(getCustomer(db, 999), undefined);
});

test('月费:不填 = null,保留两位小数;改别的字段不动它,留空 = 清掉;负数 / 非数字报错', () => {
  const db = memoryDb();
  const a = createCustomer(db, { name: 'a' });
  assert.equal(getCustomer(db, a)!.monthly_fee, null);
  const b = createCustomer(db, { name: 'b', monthly_fee: '29.999' });
  assert.equal(getCustomer(db, b)!.monthly_fee, 30);
  updateCustomer(db, b, { remark: 'x' });
  assert.equal(getCustomer(db, b)!.monthly_fee, 30);
  updateCustomer(db, b, { monthly_fee: 0 });
  assert.equal(getCustomer(db, b)!.monthly_fee, 0);
  updateCustomer(db, b, { monthly_fee: 15.5 });
  assert.equal(listCustomers(db).find((c) => c.id === b)!.monthly_fee, 15.5);
  updateCustomer(db, b, { monthly_fee: '' });
  assert.equal(getCustomer(db, b)!.monthly_fee, null);
  assert.throws(() => createCustomer(db, { name: 'c', monthly_fee: -1 }), /月费要是 0 到 1 亿之间的数字/);
  assert.throws(() => updateCustomer(db, a, { monthly_fee: 'abc' }), /月费要是/);
});

test('订阅 token:每个客户一个,能反查客户;重置后旧的立即失效;记下最近一次拉取', () => {
  const db = memoryDb();
  const a = createCustomer(db, { name: 'a' });
  const b = createCustomer(db, { name: 'b' });
  const tokenA = getCustomer(db, a)!.sub_token;
  const tokenB = getCustomer(db, b)!.sub_token;
  assert.match(tokenA, /^[\w-]{24}$/);
  assert.notEqual(tokenA, tokenB);
  assert.deepEqual([customerIdBySubToken(db, tokenA), customerIdBySubToken(db, tokenB), customerIdBySubToken(db, 'nope')], [a, b, undefined]);

  resetSubToken(db, a, 50);
  const fresh = getCustomer(db, a)!;
  assert.notEqual(fresh.sub_token, tokenA);
  assert.deepEqual([customerIdBySubToken(db, tokenA), customerIdBySubToken(db, fresh.sub_token), fresh.updated_at], [undefined, a, 50]);
  assert.equal(getCustomer(db, b)!.sub_token, tokenB);
  assert.throws(() => resetSubToken(db, 999), /客户不存在/);

  assert.deepEqual([fresh.sub_fetched_at, fresh.sub_fetched_ua], [null, null]);
  touchSubFetch(db, a, 'clash-verge/' + 'x'.repeat(400), 60);
  const fetched = getCustomer(db, a)!;
  assert.deepEqual([fetched.sub_fetched_at, fetched.sub_fetched_ua?.length], [60, 300]);
});

test('线路:用量按客户汇总,列表按名称排(不分大小写)且各归各的;能按面板、email、SOCKS 出口找线路', () => {
  const db = memoryDb();
  const a = addPanel(db, 'a');
  const b = addPanel(db, 'b');
  const socks = createSocks(db, { name: '家宽', address: '1.2.3.4:1080' });
  const carol = createCustomer(db, { name: 'carol' });
  const bob = createCustomer(db, { name: 'Bob' });
  const alice = createCustomer(db, { name: 'alice' });

  const l1 = line(db, alice, a.id, 'alice');
  const l2 = line(db, alice, b.id, 'alice', { kind: 'relay', inbound_id: 2, protocol: 'hysteria', exit_kind: 'socks', exit_socks_id: socks, exit_label: 'SOCKS 家宽' });
  const l3 = line(db, bob, a.id, 'bob', { kind: 'relay', exit_kind: 'panel', exit_panel_id: b.id, exit_port: 3000, exit_label: '落地 b' });
  assert.deepEqual(
    [l1.kind, l1.panel_name, l1.exit_kind, l1.exit_panel_id, l1.exit_socks_id, l1.exit_label, l1.created_at, l1.up, l1.enable, l1.auto_disabled, l1.synced_at],
    ['direct', 'a', null, null, null, '', 5, 0, true, false, null],
  );
  assert.deepEqual([l2.kind, l2.panel_name, l2.protocol, l2.exit_kind, l2.exit_socks_id, l2.exit_socks_name, l2.exit_panel_name, l2.exit_label], ['relay', 'b', 'hysteria', 'socks', socks, '家宽', null, 'SOCKS 家宽']);
  assert.deepEqual([l3.exit_kind, l3.exit_panel_id, l3.exit_panel_name, l3.exit_port, l3.exit_socks_name], ['panel', b.id, 'b', 3000, null]);
  // 同一块面板上 email 不能重复,换一块面板可以
  assert.throws(() => line(db, bob, a.id, 'alice'), /UNIQUE/);

  updateLineStats(db, l1.id, { up: 1, down: 2, enable: true, last_online: 9 }, 50);
  updateLineStats(db, l2.id, { up: 10, down: 20, enable: true, last_online: 0 }, 50);
  updateLineStats(db, l3.id, { up: 100, down: 200, enable: false, last_online: 0 }, 50);
  const summary = () => listCustomers(db).map((c) => [c.name, c.lines.map((l) => l.id), c.used_up, c.used_down, c.used]);
  assert.deepEqual(summary(), [['alice', [l1.id, l2.id], 11, 22, 33], ['Bob', [l3.id], 100, 200, 300], ['carol', [], 0, 0, 0]]);
  // 单查一个客户和列表里的那一项一样
  assert.deepEqual(getCustomer(db, alice), listCustomers(db)[0]);
  assert.deepEqual([getLine(db, l1.id)!.last_online, getLine(db, l1.id)!.synced_at, getLine(db, l3.id)!.enable], [9, 50, false]);

  assert.deepEqual(linesOnPanel(db, a.id).map((l) => l.id), [l1.id, l3.id]);
  assert.deepEqual(linesOnPanel(db, 999), []);
  assert.deepEqual([lineByEmail(db, a.id, 'alice')?.id, lineByEmail(db, b.id, 'alice')?.id, lineByEmail(db, b.id, 'bob')], [l1.id, l2.id, undefined]);
  assert.deepEqual(linesViaSocks(db, socks).map((l) => l.id), [l2.id]);
  assert.deepEqual(linesViaSocks(db, 999), []);

  // 额度和到期跟着用量算状态
  const state = (patch: object) => {
    updateCustomer(db, alice, patch);
    return getCustomer(db, alice)!.state;
  };
  assert.equal(state({ quota_bytes: 34 }), 'active');
  assert.equal(state({ quota_bytes: 33 }), 'over_quota');
  assert.equal(state({ expire_at: 1 }), 'expired');

  // 停用标记和清零只动这一条线路
  markLineAuto(db, l1.id, true, false);
  zeroLineTraffic(db, l1.id);
  const zeroed = getLine(db, l1.id)!;
  assert.deepEqual([zeroed.auto_disabled, zeroed.enable, zeroed.up, zeroed.down], [true, false, 0, 0]);
  markLineAuto(db, l1.id, false, true);
  assert.deepEqual([getLine(db, l1.id)!.auto_disabled, getLine(db, l1.id)!.enable], [false, true]);
  assert.deepEqual(summary()[0], ['alice', [l1.id, l2.id], 10, 20, 30]);
});

test('删除:删线路只删这一条;删客户连它的线路一起删,别的客户不受影响;删不存在的报错', () => {
  const db = memoryDb();
  const a = addPanel(db, 'a');
  const zhang = createCustomer(db, { name: '张三' });
  const li = createCustomer(db, { name: '李四' });
  const l1 = line(db, zhang, a.id, 'z1');
  const l2 = line(db, zhang, a.id, 'z2');
  const l3 = line(db, li, a.id, 'li');

  deleteLine(db, l1.id);
  assert.deepEqual(getCustomer(db, zhang)!.lines.map((l) => l.id), [l2.id]);
  assert.throws(() => deleteLine(db, l1.id), /线路不存在/);

  deleteCustomer(db, zhang);
  assert.deepEqual([getCustomer(db, zhang), getLine(db, l2.id)], [undefined, undefined]);
  assert.deepEqual(linesOnPanel(db, a.id).map((l) => l.id), [l3.id]);
  assert.throws(() => deleteCustomer(db, zhang), /客户不存在/);
  // 删掉的 email 可以再用
  assert.equal(line(db, li, a.id, 'z2').email, 'z2');
});

test('流量倍率:默认 1;计费用量 = 实际 × 倍率,订阅头和超额都按它;实际流量另给;校验 0.01 到 100,保留两位', () => {
  const db = memoryDb();
  const p = addPanel(db, 'p');
  const c = createCustomer(db, { name: 'a', quota_bytes: 1000 });
  const l = line(db, c, p.id, 'a');
  updateLineStats(db, l.id, { up: 100, down: 300, enable: true, last_online: 0 });
  let v = getCustomer(db, c)!;
  assert.deepEqual([v.traffic_ratio, v.used_up, v.used_down, v.used, v.actual_used, v.state], [1, 100, 300, 400, 400, 'active']);

  updateCustomer(db, c, { traffic_ratio: 2.5 });
  v = getCustomer(db, c)!;
  assert.deepEqual([v.traffic_ratio, v.used_up, v.used_down, v.used, v.actual_up, v.actual_down, v.actual_used, v.state], [2.5, 250, 750, 1000, 100, 300, 400, 'over_quota']);
  assert.equal(userinfoHeader(v), `upload=250; download=750; total=1000; expire=0`);
  // 线路上记的还是实际的
  assert.deepEqual([v.lines[0].up, v.lines[0].down], [100, 300]);
  // 改别的不动倍率;留空 = 1
  updateCustomer(db, c, { remark: 'x' });
  assert.equal(getCustomer(db, c)!.traffic_ratio, 2.5);
  updateCustomer(db, c, { traffic_ratio: '' });
  assert.equal(getCustomer(db, c)!.traffic_ratio, 1);
  assert.equal(getCustomer(db, createCustomer(db, { name: 'b', traffic_ratio: '1.234' }))!.traffic_ratio, 1.23);
  assert.equal(getCustomer(db, createCustomer(db, { name: 'd', traffic_ratio: 0.5 }))!.traffic_ratio, 0.5);
  for (const bad of [0, -1, 101, 'abc', 0.001]) assert.throws(() => updateCustomer(db, c, { traffic_ratio: bad }), /流量倍率要是 0.01 到 100/, String(bad));
});

test('删线路 / 强制删面板:线路本期用掉的流量结转到客户身上,已用不变;线路计数在面板上清零也照样结转', () => {
  const db = memoryDb();
  const p1 = addPanel(db, 'p1');
  const p2 = addPanel(db, 'p2');
  const c = createCustomer(db, { name: 'a', quota_bytes: 10_000, traffic_ratio: 2 });
  const other = createCustomer(db, { name: 'b' });
  const l1 = line(db, c, p1.id, 'a1');
  const l2 = line(db, c, p2.id, 'a2');
  const l3 = line(db, c, p2.id, 'a3');
  const lo = line(db, other, p2.id, 'b');
  updateLineStats(db, l1.id, { up: 10, down: 100, enable: true, last_online: 0 });
  updateLineStats(db, l2.id, { up: 20, down: 200, enable: true, last_online: 0 });
  updateLineStats(db, l3.id, { up: 1, down: 2, enable: true, last_online: 0 });
  updateLineStats(db, lo.id, { up: 5, down: 5, enable: true, last_online: 0 });
  const usage = (id: number) => {
    const v = getCustomer(db, id)!;
    return [v.actual_up, v.actual_down, v.used, v.carried_up, v.carried_down, v.lines.length];
  };
  assert.deepEqual(usage(c), [31, 302, 666, 0, 0, 3]);

  deleteLine(db, l1.id);
  assert.deepEqual(usage(c), [31, 302, 666, 10, 100, 2]);
  assert.throws(() => deleteLine(db, l1.id), /线路不存在/);

  // 强制删面板:上面的线路都结转,别的客户也一样
  deletePanel(db, p2.id, true);
  assert.deepEqual(usage(c), [31, 302, 666, 31, 302, 0]);
  assert.deepEqual(usage(other), [5, 5, 10, 5, 5, 0]);
});

test('调整本期已用:记进结转(实际流量,倍率另乘);可以减,调完不能小于 0;都是 0 报错', () => {
  const db = memoryDb();
  const p = addPanel(db, 'p');
  const c = createCustomer(db, { name: 'a', traffic_ratio: 1.5 });
  const l = line(db, c, p.id, 'a');
  updateLineStats(db, l.id, { up: 10, down: 100, enable: true, last_online: 0 });
  adjustUsage(db, c, { down: 1000 });
  let v = getCustomer(db, c)!;
  assert.deepEqual([v.carried_up, v.carried_down, v.actual_down, v.used_down], [0, 1000, 1100, 1650]);
  adjustUsage(db, c, { up: '5', down: -1050 });
  v = getCustomer(db, c)!;
  assert.deepEqual([v.carried_up, v.carried_down, v.actual_up, v.actual_down], [5, -50, 15, 50]);
  assert.throws(() => adjustUsage(db, c, { down: -51 }), /调整后的已用不能小于 0/);
  assert.throws(() => adjustUsage(db, c, { up: 0, down: '' }), /至少填一个/);
  assert.throws(() => adjustUsage(db, c, { down: 1.5 }), /要是整数/);
  assert.throws(() => adjustUsage(db, 999, { down: 1 }), /客户不存在/);
});
