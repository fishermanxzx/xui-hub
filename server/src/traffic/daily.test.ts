import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addLine, createCustomer, deleteCustomer } from '../customers/repo';
import { addPanel, memoryDb } from '../testUtil';
import { pruneTraffic, recordTraffic, trafficReport, TRAFFIC_KEEP_DAYS } from './daily';

const DAY = 86_400_000;
const T = new Date(2026, 10, 10, 12).getTime();

test('流量统计:第一次见只记起点,之后按天记增量;清零后新值算增量;按客户 / 按面板汇总和展开', () => {
  const db = memoryDb();
  const p1 = addPanel(db, 'p1');
  const p2 = addPanel(db, 'p2');
  const c = { id: createCustomer(db, { name: '小王' }) };
  addLine(db, { customer_id: c.id, kind: 'direct', panel_id: p1.id, inbound_id: 1, inbound_remark: '', protocol: 'vless', email: 'a' });

  // 接入当天:历史用量不算
  recordTraffic(db, p1.id, [{ email: 'a', up: 1000, down: 5000 }, { email: 'stray', up: 7, down: 7 }], T - DAY);
  assert.deepEqual(trafficReport(db, { by: 'panel', days: 7 }, T).rows, []);

  recordTraffic(db, p1.id, [{ email: 'a', up: 1100, down: 5400 }, { email: 'stray', up: 7, down: 7 }], T - DAY + 60_000);
  recordTraffic(db, p1.id, [{ email: 'a', up: 1150, down: 5400 }, { email: 'stray', up: 17, down: 27 }], T);
  // 面板上清零过:累计值变小,新值就是这段用的
  recordTraffic(db, p1.id, [{ email: 'a', up: 10, down: 20 }, { email: 'stray', up: 17, down: 27 }], T + 60_000);
  recordTraffic(db, p2.id, [{ email: 'x', up: 0, down: 0 }], T);
  recordTraffic(db, p2.id, [{ email: 'x', up: 1, down: 2 }], T + 60_000);

  const byCustomer = trafficReport(db, { by: 'customer', days: 3 }, T + 120_000);
  assert.deepEqual(byCustomer.days, ['2026-11-08', '2026-11-09', '2026-11-10']);
  assert.deepEqual(byCustomer.rows, [
    { id: c.id, name: '小王', deleted: false, up: 160, down: 420, daily: [0, 500, 80] },
    { id: 0, name: '没归入客户的客户端', deleted: false, up: 11, down: 22, daily: [0, 0, 33] },
  ]);
  assert.deepEqual(byCustomer.total, { up: [0, 100, 71], down: [0, 400, 42] });

  const byPanel = trafficReport(db, { by: 'panel', days: 3 }, T + 120_000);
  assert.deepEqual(byPanel.rows.map((r) => [r.name, r.up + r.down]), [['p1', 610], ['p2', 3]]);
  assert.deepEqual(trafficReport(db, { by: 'panel', days: 3, id: p1.id }, T + 120_000).rows.map((r) => [r.name, r.up + r.down]), [['a · 小王', 580], ['stray', 30]]);
  assert.deepEqual(trafficReport(db, { by: 'customer', days: 3, id: c.id }, T + 120_000).rows.map((r) => r.name), ['p1 · a']);
  assert.deepEqual(trafficReport(db, { by: 'customer', days: 3, id: 0 }, T + 120_000).rows.map((r) => r.name), ['p1 · stray', 'p2 · x']);
  // 只看今天
  assert.deepEqual(trafficReport(db, { by: 'customer', days: 1 }, T + 120_000).total, { up: [71], down: [42] });

  // 客户删了统计还在;过了保留期的清掉
  deleteCustomer(db, c.id);
  assert.deepEqual(trafficReport(db, { by: 'customer', days: 3 }, T + 120_000).rows[0], { id: c.id, name: `已删除的客户 #${c.id}`, deleted: true, up: 160, down: 420, daily: [0, 500, 80] });
  pruneTraffic(db, T + TRAFFIC_KEEP_DAYS * DAY);
  assert.deepEqual(trafficReport(db, { by: 'panel', days: 365 }, T + 120_000).rows.map((r) => [r.name, r.up + r.down]), [['p1', 110], ['p2', 3]]);
});

test('流量统计:面板上删了又建出同名客户端,从头算,不把新累计值当增量之外的东西', () => {
  const db = memoryDb();
  const p = addPanel(db, 'p1');
  recordTraffic(db, p.id, [{ email: 'a', up: 100, down: 100 }], T);
  recordTraffic(db, p.id, [], T + 1);
  recordTraffic(db, p.id, [{ email: 'a', up: 5, down: 5 }], T + 2);
  recordTraffic(db, p.id, [{ email: 'a', up: 6, down: 5 }], T + 3);
  assert.deepEqual(trafficReport(db, { by: 'panel', days: 1 }, T + 4).total, { up: [1], down: [0] });
});

test('流量统计:排除面板 = 总量、按面板、按客户都不算它上面的流量(客户在别的面板上的照算);记录不动,不排除就回来', () => {
  const db = memoryDb();
  const p1 = addPanel(db, 'p1');
  const p2 = addPanel(db, 'p2');
  const p3 = addPanel(db, 'p3');
  const c = createCustomer(db, { name: '小李' });
  addLine(db, { customer_id: c, kind: 'direct', panel_id: p1.id, inbound_id: 1, inbound_remark: '', protocol: 'vless', email: 'a1' });
  addLine(db, { customer_id: c, kind: 'direct', panel_id: p2.id, inbound_id: 1, inbound_remark: '', protocol: 'vless', email: 'a2' });
  for (const [p, email] of [[p1, 'a1'], [p2, 'a2'], [p3, 'x']] as const) recordTraffic(db, p.id, [{ email, up: 0, down: 0 }], T);
  recordTraffic(db, p1.id, [{ email: 'a1', up: 10, down: 90 }], T + 1);
  recordTraffic(db, p2.id, [{ email: 'a2', up: 20, down: 180 }], T + 1);
  recordTraffic(db, p3.id, [{ email: 'x', up: 5, down: 5 }], T + 1);

  const all = trafficReport(db, { by: 'customer', days: 1 }, T + 2);
  assert.deepEqual(all.rows.map((r) => [r.name, r.up + r.down]), [['小李', 300], ['没归入客户的客户端', 10]]);

  const ex = { by: 'customer' as const, days: 1, exclude: [p2.id] };
  assert.deepEqual(trafficReport(db, ex, T + 2).rows.map((r) => [r.name, r.up + r.down]), [['小李', 100], ['没归入客户的客户端', 10]]);
  assert.deepEqual(trafficReport(db, ex, T + 2).total, { up: [15], down: [95] });
  assert.deepEqual(trafficReport(db, { ...ex, id: c }, T + 2).rows.map((r) => r.name), ['p1 · a1']);
  assert.deepEqual(trafficReport(db, { by: 'panel', days: 1, exclude: [p2.id, p3.id] }, T + 2).rows.map((r) => [r.name, r.up + r.down]), [['p1', 100]]);
  // 排除了整个都没有的:空
  assert.deepEqual(trafficReport(db, { by: 'panel', days: 1, exclude: [p1.id, p2.id, p3.id] }, T + 2).rows, []);
  // 记录还在
  assert.deepEqual(trafficReport(db, { by: 'panel', days: 1, exclude: [] }, T + 2).rows.map((r) => r.name).sort(), ['p1', 'p2', 'p3']);
});

test('流量统计:只看某几位客户 = 总量、按客户、按面板都只算他们的(0 = 没归入客户的);和排除面板一起用', () => {
  const db = memoryDb();
  const p1 = addPanel(db, 'p1');
  const p2 = addPanel(db, 'p2');
  const a = createCustomer(db, { name: '小李' });
  const b = createCustomer(db, { name: '小张' });
  addLine(db, { customer_id: a, kind: 'direct', panel_id: p1.id, inbound_id: 1, inbound_remark: '', protocol: 'vless', email: 'a1' });
  addLine(db, { customer_id: a, kind: 'direct', panel_id: p2.id, inbound_id: 1, inbound_remark: '', protocol: 'vless', email: 'a2' });
  addLine(db, { customer_id: b, kind: 'direct', panel_id: p1.id, inbound_id: 1, inbound_remark: '', protocol: 'vless', email: 'b1' });
  // 每次同步给的是这块面板上全部客户端
  const use = [[p1, { a1: 100, b1: 1000 }], [p2, { a2: 200, x: 5 }]] as const;
  for (const [p, m] of use) recordTraffic(db, p.id, Object.keys(m).map((email) => ({ email, up: 0, down: 0 })), T);
  for (const [p, m] of use) recordTraffic(db, p.id, Object.entries(m).map(([email, n]) => ({ email, up: 0, down: n })), T + 1);

  const sum = (r: { rows: { name: string; up: number; down: number }[] }) => r.rows.map((x) => [x.name, x.up + x.down]);
  assert.deepEqual(sum(trafficReport(db, { by: 'customer', days: 1, customers: [a] }, T + 2)), [['小李', 300]]);
  assert.deepEqual(trafficReport(db, { by: 'customer', days: 1, customers: [a] }, T + 2).total, { up: [0], down: [300] });
  assert.deepEqual(sum(trafficReport(db, { by: 'customer', days: 1, customers: [a, 0] }, T + 2)), [['小李', 300], ['没归入客户的客户端', 5]]);
  // 按面板:每块面板上只算这几位的
  assert.deepEqual(sum(trafficReport(db, { by: 'panel', days: 1, customers: [a] }, T + 2)), [['p2', 200], ['p1', 100]]);
  assert.deepEqual(sum(trafficReport(db, { by: 'panel', days: 1, customers: [b, 0] }, T + 2)), [['p1', 1000], ['p2', 5]]);
  // 展开面板:只列这几位的客户端
  assert.deepEqual(sum(trafficReport(db, { by: 'panel', days: 1, id: p1.id, customers: [a] }, T + 2)), [['a1 · 小李', 100]]);
  // 和排除面板一起
  assert.deepEqual(sum(trafficReport(db, { by: 'panel', days: 1, customers: [a], exclude: [p2.id] }, T + 2)), [['p1', 100]]);
  // 空 = 全部
  assert.equal(trafficReport(db, { by: 'customer', days: 1, customers: [] }, T + 2).rows.length, 3);
});
