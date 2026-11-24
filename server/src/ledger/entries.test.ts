import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCustomer, deleteCustomer } from '../customers/repo';
import { deletePanel } from '../panels/repo';
import { createSocks, deleteSocks } from '../socks/repo';
import { addPanel, memoryDb } from '../testUtil';
import { deleteEntry, getEntry, insertEntry, listEntries, validEntry } from './entries';

const none = { customer_id: null, panel_id: null, socks_id: null };
/** 没关联时 getEntry 多出来的字段 */
const noLinks = { customer_id: null, customer_name: '', customer_deleted: false, panel_id: null, panel_name: '', panel_deleted: false, socks_id: null, socks_name: '', socks_deleted: false };

test('收入 / 支出的校验:kind、正数金额必填;日期不给 = 现在;类别最多 20 字', () => {
  assert.deepEqual(validEntry({ kind: 'expense', amount: '12.345', category: ' 服务器 ', note: ' 年付 ' }, 1000), { kind: 'expense', amount: 12.35, at: 1000, category: '服务器', note: '年付', ...none });
  assert.deepEqual(validEntry({ kind: 'income', amount: 5, at: 2000 }, 1000), { kind: 'income', amount: 5, at: 2000, category: '', note: '', ...none });
  for (const bad of [{ amount: 5 }, { kind: 'refund', amount: 5 }]) assert.throws(() => validEntry(bad), /kind/, JSON.stringify(bad));
  for (const amount of [undefined, '', 0, -3, 0.001, 'abc', 2e8, Infinity]) assert.throws(() => validEntry({ kind: 'income', amount }), /金额/, String(amount));
  for (const at of [0, -1, 1.5, 'x']) assert.throws(() => validEntry({ kind: 'income', amount: 1, at }), /日期/);
  assert.throws(() => validEntry({ kind: 'income', amount: 1, category: 3 }), /类别/);
  assert.throws(() => validEntry({ kind: 'income', amount: 1, category: '一'.repeat(21) }), /类别最多 20/);
  assert.throws(() => validEntry({ kind: 'income', amount: 1, note: 'x'.repeat(201) }), /备注/);
});

test('记、查、删:新的在前,按日期区间筛;删不存在的报错;库里不许别的 kind', () => {
  const db = memoryDb();
  const a = insertEntry(db, { kind: 'expense', amount: 300, at: 100, category: '服务器', note: '' }, 1);
  const b = insertEntry(db, { kind: 'income', amount: 50, at: 300, category: '', note: '介绍费' }, 2);
  const c = insertEntry(db, { kind: 'expense', amount: 9.9, at: 200, category: '域名', note: '' }, 3);
  assert.deepEqual(getEntry(db, a.id), { id: a.id, kind: 'expense', amount: 300, at: 100, category: '服务器', note: '', ...noLinks, created_at: 1 });
  assert.deepEqual(listEntries(db).map((e) => e.id), [b.id, c.id, a.id]);
  assert.deepEqual(listEntries(db, { from: 150, to: 300 }).map((e) => e.id), [c.id]);
  deleteEntry(db, c.id);
  assert.equal(getEntry(db, c.id), undefined);
  assert.throws(() => deleteEntry(db, c.id), /不存在/);
  assert.throws(() => db.prepare("INSERT INTO ledger_entries (kind, amount, at, created_at) VALUES ('other', 1, 1, 1)").run(), /CHECK/);
});

test('关联:面板或 SOCKS 二选一(收入支出都行),客户只有收入能关联;都可以不填', () => {
  const ok = validEntry({ kind: 'income', amount: 1, customer_id: '3', panel_id: 2, socks_id: '' });
  assert.deepEqual([ok.customer_id, ok.panel_id, ok.socks_id], [3, 2, null]);
  assert.equal(validEntry({ kind: 'expense', amount: 1, socks_id: 4, customer_id: null }).socks_id, 4);
  assert.throws(() => validEntry({ kind: 'expense', amount: 1, customer_id: 1 }), /只有收入能关联客户/);
  assert.throws(() => validEntry({ kind: 'income', amount: 1, panel_id: 1, socks_id: 1 }), /只能关联一个/);
  for (const bad of [0, -1, 1.5, 'x']) assert.throws(() => validEntry({ kind: 'income', amount: 1, panel_id: bad }), /panel_id/, String(bad));
});

test('关联的客户 / 面板 / SOCKS:要存在;显示现在的名字,删了显示记的时候的名字;按客户筛', () => {
  const db = memoryDb();
  const p = addPanel(db, 'hk');
  const s = createSocks(db, { name: 'isp', address: '1.2.3.4:1080' });
  const c = createCustomer(db, { name: '小王' });
  const base = { amount: 10, at: 100, category: '', note: '' };
  assert.throws(() => insertEntry(db, { ...base, kind: 'expense', panel_id: 99 }), /面板不存在/);
  assert.throws(() => insertEntry(db, { ...base, kind: 'expense', socks_id: 99 }), /SOCKS 不存在/);
  assert.throws(() => insertEntry(db, { ...base, kind: 'income', customer_id: 99 }), /客户不存在/);
  const a = insertEntry(db, { ...base, kind: 'expense', panel_id: p.id });
  const b = insertEntry(db, { ...base, kind: 'expense', socks_id: s });
  const i = insertEntry(db, { ...base, kind: 'income', customer_id: c, panel_id: p.id });
  assert.deepEqual([a.panel_name, a.panel_deleted, b.socks_name, i.customer_name, i.panel_name], ['hk', false, 'isp', '小王', 'hk']);
  assert.deepEqual(listEntries(db, { customer_id: c }).map((e) => e.id), [i.id]);
  // 改了名字跟着变
  db.prepare("UPDATE customers SET name = '老王' WHERE id = ?").run(c);
  assert.equal(getEntry(db, i.id)!.customer_name, '老王');
  // 删了:记录还在,显示记的时候的名字,标上删了
  deletePanel(db, p.id, true);
  deleteSocks(db, s);
  deleteCustomer(db, c);
  const [x, y, z] = [getEntry(db, a.id)!, getEntry(db, b.id)!, getEntry(db, i.id)!];
  assert.deepEqual([x.panel_name, x.panel_deleted, y.socks_name, y.socks_deleted, z.customer_name, z.customer_deleted, z.panel_deleted], ['hk', true, 'isp', true, '小王', true, true]);
  // 新建的 SOCKS 不会顶上删掉的 id,记录不会串到它头上
  const s2 = createSocks(db, { name: 'isp2', address: '1.2.3.4:1081' });
  assert.notEqual(s2, s);
  assert.equal(getEntry(db, b.id)!.socks_deleted, true);
});
