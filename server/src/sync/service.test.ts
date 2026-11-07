import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addBinding, createCustomer, getCustomer } from '../customers/repo';
import { addPanel, memoryDb, refreshPanel, snap } from '../testUtil';
import { applyPanelSnapshot } from './service';

const H = 3_600_000;

test('多条线路的增量累加到同一客户,未绑定的 client 只记账本', () => {
  const db = memoryDb();
  let a = addPanel(db, 'a');
  let b = addPanel(db, 'b');

  // 首次同步建基线
  applyPanelSnapshot(db, a, [snap('zhu', 100, 1000), snap('other', 5, 5)], 10 * H);
  applyPanelSnapshot(db, b, [snap('zhu', 50, 500)], 10 * H);
  a = refreshPanel(db, a);
  b = refreshPanel(db, b);

  const id = createCustomer(db, { name: 'zhu', quota_bytes: 10_000 }, 10 * H);
  addBinding(db, id, a.id, 'zhu', true, 10 * H);
  addBinding(db, id, b.id, 'zhu', true, 10 * H);
  assert.equal(getCustomer(db, id, 10 * H)!.used, 1650); // 存量:1100 + 550

  applyPanelSnapshot(db, a, [snap('zhu', 110, 1100), snap('other', 9, 9)], 11 * H);
  applyPanelSnapshot(db, b, [snap('zhu', 60, 600)], 11 * H);
  const c = getCustomer(db, id, 11 * H)!;
  assert.equal(c.used, 1650 + 110 + 110);
  assert.equal(c.remaining, 10_000 - c.used);

  const hourly = db.prepare('SELECT customer_id, SUM(up + down) AS bytes FROM traffic_hourly GROUP BY customer_id ORDER BY customer_id').all();
  assert.deepEqual(hourly, [
    { customer_id: 0, bytes: 8 },
    { customer_id: id, bytes: 220 },
  ]);
});

test('计数器回退按重置处理并记录审计', () => {
  const db = memoryDb();
  let a = addPanel(db, 'a');
  applyPanelSnapshot(db, a, [snap('u', 100, 100)], H);
  a = refreshPanel(db, a);
  const id = createCustomer(db, { name: 'u' }, H);
  addBinding(db, id, a.id, 'u', false, H);

  const result = applyPanelSnapshot(db, a, [snap('u', 3, 7)], 2 * H);
  assert.equal(result.resets, 1);
  assert.equal(getCustomer(db, id)!.used, 10);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM counter_resets').get() as any).n, 1);
});

test('面板已同步过之后新出现的 client,首轮读数计入;消失的 client 标记 missing', () => {
  const db = memoryDb();
  let a = addPanel(db, 'a');
  applyPanelSnapshot(db, a, [snap('old', 1, 1)], H);
  a = refreshPanel(db, a);
  const result = applyPanelSnapshot(db, a, [snap('new', 40, 60)], 2 * H);
  assert.equal(result.deltaBytes, 100);
  const old = db.prepare("SELECT missing_since FROM client_counters WHERE email = 'old'").get() as any;
  assert.equal(old.missing_since, 2 * H);
});

test('解绑后的增量不再计入客户', () => {
  const db = memoryDb();
  let a = addPanel(db, 'a');
  applyPanelSnapshot(db, a, [snap('u', 0, 0)], H);
  a = refreshPanel(db, a);
  const id = createCustomer(db, { name: 'u' }, H);
  addBinding(db, id, a.id, 'u', false, H);
  applyPanelSnapshot(db, a, [snap('u', 10, 0)], 2 * H);
  const bindingId = getCustomer(db, id)!.lines[0].binding_id;
  db.prepare('DELETE FROM bindings WHERE id = ?').run(bindingId);
  applyPanelSnapshot(db, a, [snap('u', 30, 0)], 3 * H);
  assert.equal(getCustomer(db, id)!.used, 10);
});
