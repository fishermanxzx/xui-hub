import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCustomer, getCustomer } from '../customers/repo';
import { addPanel, memoryDb } from '../testUtil';
import { pruneHistory } from './retention';

const DAY = 86_400_000;

test('只删超过保留天数的流量记录和回退记录,客户已用量不变', () => {
  const db = memoryDb();
  const p = addPanel(db, 'a');
  const id = createCustomer(db, { name: 'zhu', quota_bytes: 0, expire_at: 0 });
  db.prepare('UPDATE customers SET used_up = 5, used_down = 7 WHERE id = ?').run(id);
  const now = 100 * DAY;
  const hourly = db.prepare('INSERT INTO traffic_hourly (hour, panel_id, email, customer_id, up, down) VALUES (?, ?, ?, ?, 1, 1)');
  for (const hour of [now - 61 * DAY, now - 60 * DAY - 1, now - 60 * DAY, now - DAY]) hourly.run(hour, p.id, 'zhu', id);
  const reset = db.prepare('INSERT INTO counter_resets (panel_id, email, at, prev_up, prev_down, cur_up, cur_down) VALUES (?, ?, ?, 0, 0, 0, 0)');
  for (const at of [now - 70 * DAY, now - 10 * DAY]) reset.run(p.id, 'zhu', at);

  assert.deepEqual(pruneHistory(db, 60, now), { hourly: 2, resets: 1 });
  const left = (db.prepare('SELECT hour FROM traffic_hourly ORDER BY hour').all() as any[]).map((r) => r.hour);
  assert.deepEqual(left, [now - 60 * DAY, now - DAY]);
  assert.equal((db.prepare('SELECT COUNT(*) n FROM counter_resets').get() as any).n, 1);
  const c = getCustomer(db, id)!;
  assert.deepEqual([c.used_up, c.used_down], [5, 7]);
  assert.deepEqual(pruneHistory(db, 60, now), { hourly: 0, resets: 0 });
});
