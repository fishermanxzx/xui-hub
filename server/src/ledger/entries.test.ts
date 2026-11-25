import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCustomer, deleteCustomer } from '../customers/repo';
import { deletePanel } from '../panels/repo';
import { createSocks, deleteSocks } from '../socks/repo';
import { addPanel, memoryDb } from '../testUtil';
import { deleteEntry, getEntry, insertEntry, listEntries, updateEntry, validEntry } from './entries';

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

test('改一笔:只给要改的字段;日期不给不变;改成支出去掉客户,换关联去掉另一个;原来关联的删了、没改它就留着', () => {
  const db = memoryDb();
  const p = addPanel(db, 'hk');
  const p2 = addPanel(db, 'jp');
  const s = createSocks(db, { name: 'isp', address: '1.2.3.4:1080' });
  const c = createCustomer(db, { name: '小王' });
  const e = insertEntry(db, { kind: 'income', amount: 10, at: 100, category: '安装费', note: '', customer_id: c, panel_id: p.id }, 1);

  let u = updateEntry(db, e.id, { amount: '12.5', note: ' 补差价 ' });
  assert.deepEqual([u.kind, u.amount, u.at, u.category, u.note, u.customer_id, u.panel_id, u.created_at], ['income', 12.5, 100, '安装费', '补差价', c, p.id, 1]);
  u = updateEntry(db, e.id, { at: 500, category: '' });
  assert.deepEqual([u.at, u.category], [500, '']);
  // 关联 SOCKS:原来的面板去掉;两个都给 → 报错
  u = updateEntry(db, e.id, { socks_id: s });
  assert.deepEqual([u.panel_id, u.panel_name, u.socks_id, u.socks_name], [null, '', s, 'isp']);
  assert.throws(() => updateEntry(db, e.id, { panel_id: p2.id, socks_id: s }), /只能关联一个/);
  u = updateEntry(db, e.id, { panel_id: p2.id });
  assert.deepEqual([u.panel_id, u.panel_name, u.socks_id], [p2.id, 'jp', null]);
  // 改成支出:客户自动去掉;明说了客户 → 报错
  assert.throws(() => updateEntry(db, e.id, { kind: 'expense', customer_id: c }), /只有收入能关联客户/);
  u = updateEntry(db, e.id, { kind: 'expense' });
  assert.deepEqual([u.kind, u.customer_id, u.customer_name], ['expense', null, '']);
  // 原来关联的面板删了:改别的照样留着(记的时候的名字);换成不存在的报错;取消关联可以
  deletePanel(db, p2.id, true);
  u = updateEntry(db, e.id, { note: '' });
  assert.deepEqual([u.panel_id, u.panel_name, u.panel_deleted], [p2.id, 'jp', true]);
  assert.throws(() => updateEntry(db, e.id, { panel_id: 999 }), /面板不存在/);
  u = updateEntry(db, e.id, { panel_id: null });
  assert.equal(u.panel_id, null);
  // 校验和记一笔一样;不存在的报错
  assert.throws(() => updateEntry(db, e.id, { amount: 0 }), /金额/);
  assert.throws(() => updateEntry(db, e.id, { kind: 'refund' }), /kind/);
  assert.throws(() => updateEntry(db, 999, { amount: 1 }), /不存在/);
  assert.deepEqual(listEntries(db).map((x) => x.id), [e.id]);
});
