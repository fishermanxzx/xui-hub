import assert from 'node:assert/strict';
import { test } from 'node:test';
import { memoryDb } from '../testUtil';
import { deleteEntry, getEntry, insertEntry, listEntries, validEntry } from './entries';

test('收入 / 支出的校验:kind、正数金额必填;日期不给 = 现在;类别最多 20 字', () => {
  assert.deepEqual(validEntry({ kind: 'expense', amount: '12.345', category: ' 服务器 ', note: ' 年付 ' }, 1000), { kind: 'expense', amount: 12.35, at: 1000, category: '服务器', note: '年付' });
  assert.deepEqual(validEntry({ kind: 'income', amount: 5, at: 2000 }, 1000), { kind: 'income', amount: 5, at: 2000, category: '', note: '' });
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
  assert.deepEqual(getEntry(db, a.id), { id: a.id, kind: 'expense', amount: 300, at: 100, category: '服务器', note: '', created_at: 1 });
  assert.deepEqual(listEntries(db).map((e) => e.id), [b.id, c.id, a.id]);
  assert.deepEqual(listEntries(db, { from: 150, to: 300 }).map((e) => e.id), [c.id]);
  deleteEntry(db, c.id);
  assert.equal(getEntry(db, c.id), undefined);
  assert.throws(() => deleteEntry(db, c.id), /不存在/);
  assert.throws(() => db.prepare("INSERT INTO ledger_entries (kind, amount, at, created_at) VALUES ('other', 1, 1, 1)").run(), /CHECK/);
});
