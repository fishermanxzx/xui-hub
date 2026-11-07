import assert from 'node:assert/strict';
import { test } from 'node:test';
import { memoryDb } from '../testUtil';
import { createPanel, deletePanel, InputError, updatePanel } from './repo';

test('面板类型必须明确给出,不按名称推断;删除后类型记在 deleted_panels', () => {
  const db = memoryDb();
  const base = { base_url: 'https://198.51.100.1:2053/p', token: 't' };
  assert.throws(() => createPanel(db, { name: '美国中转', ...base }, 0), /类型/);
  const named = createPanel(db, { name: '名字带中转的落地', ...base, role: 'exit' }, 0);
  assert.equal(named.role, 'exit');
  const relay = createPanel(db, { name: '三网-2', ...base, role: 'relay' }, 0);
  deletePanel(db, relay.id, 5);
  assert.deepEqual(db.prepare('SELECT name, role, deleted_at FROM deleted_panels').all(), [{ name: '三网-2', role: 'relay', deleted_at: 5 }]);
});

test('面板到期时间:默认未填(null),可设日期、不限期(0)或清空;其他字段更新时不动它', () => {
  const db = memoryDb();
  const p = createPanel(db, { name: '美国-1', base_url: 'https://198.51.100.1:2053/p', token: 't', role: 'exit' }, 0);
  assert.equal(p.expire_at, null);

  const at = Date.UTC(2026, 10, 27, 15, 59, 59, 999);
  assert.equal(updatePanel(db, p.id, { expire_at: at }).expire_at, at);
  assert.equal(updatePanel(db, p.id, { monthly_cost: 44 }).expire_at, at, '只改月成本时到期时间不变');
  assert.equal(updatePanel(db, p.id, { expire_at: 0 }).expire_at, 0);
  assert.equal(updatePanel(db, p.id, { expire_at: null }).expire_at, null);

  assert.equal(createPanel(db, { name: '美国-2', base_url: 'https://198.51.100.2:2053/p', token: 't', expire_at: at, role: 'exit' }, 0).expire_at, at);
  assert.throws(() => updatePanel(db, p.id, { expire_at: -1 }), InputError);
  assert.throws(() => updatePanel(db, p.id, { expire_at: 1.5 }), InputError);
});
