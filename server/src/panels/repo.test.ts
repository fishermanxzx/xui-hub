import assert from 'node:assert/strict';
import { test } from 'node:test';
import { memoryDb } from '../testUtil';
import { createPanel, deletePanel, getPanel, listPanels, recordCheck, toPanelView, updatePanel } from './repo';

test('面板增删改:地址规范化、名称唯一、token 留空不改、视图不含 token', () => {
  const db = memoryDb();
  const p = createPanel(db, { name: 'a', base_url: 'https://1.2.3.4:2053/path/', token: 't' }, 0);
  assert.equal(p.base_url, 'https://1.2.3.4:2053/path');
  assert.throws(() => createPanel(db, { name: 'a', base_url: 'https://x', token: 't' }), /已存在/);
  assert.throws(() => createPanel(db, { name: 'b', base_url: 'ftp://x', token: 't' }), /http/);
  assert.throws(() => createPanel(db, { name: 'b', base_url: 'https://x' }), /token/);

  assert.equal(updatePanel(db, p.id, { name: 'aa', token: '' }).token, 't');
  assert.equal(updatePanel(db, p.id, { token: 'new' }).token, 'new');
  assert.ok(!('token' in toPanelView(getPanel(db, p.id)!)));

  recordCheck(db, p.id, { ok: true, inbounds: 2, clients: 5 }, 100);
  assert.deepEqual([getPanel(db, p.id)!.check_ok_at, getPanel(db, p.id)!.inbound_count, getPanel(db, p.id)!.client_count], [100, 2, 5]);
  recordCheck(db, p.id, { ok: false, error: '连接失败' }, 200);
  const after = getPanel(db, p.id)!;
  assert.deepEqual([after.checked_at, after.check_ok_at, after.check_error, after.client_count], [200, 100, '连接失败', 5]);

  deletePanel(db, p.id);
  assert.equal(listPanels(db).length, 0);
  assert.throws(() => deletePanel(db, p.id), /不存在/);
});
