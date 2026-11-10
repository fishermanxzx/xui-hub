import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addLine, createCustomer, deleteLine, getCustomer, getLine } from '../customers/repo';
import { addPanel, memoryDb } from '../testUtil';
import { createPanel, deletePanel, getPanel, listPanels, panelUsage, recordCheck, toPanelView, updatePanel } from './repo';

test('面板增删改:地址规范化、名称唯一、token 留空不改、视图不含 token', () => {
  const db = memoryDb();
  const p = createPanel(db, { name: 'a', base_url: 'https://1.2.3.4:2053/path/', token: 't' }, 0);
  assert.equal(p.base_url, 'https://1.2.3.4:2053/path');
  assert.throws(() => createPanel(db, { name: 'a', base_url: 'https://x', token: 't' }), /已存在/);
  assert.throws(() => createPanel(db, { name: 'b', base_url: 'ftp://x', token: 't' }), /http/);
  assert.throws(() => createPanel(db, { name: 'b', base_url: 'https://x' }), /token/);

  assert.equal(updatePanel(db, p.id, { name: 'aa', token: '' }).token, 't');
  assert.equal(updatePanel(db, p.id, { token: 'new' }).token, 'new');
  assert.ok(!('token' in toPanelView(db, getPanel(db, p.id)!)));

  recordCheck(db, p.id, { ok: true, inbounds: 2, clients: 5, panel_version: '3.11.0', xray_version: '26.10.21', xray_state: 'running' }, 100);
  const got = getPanel(db, p.id)!;
  assert.deepEqual([got.check_ok_at, got.inbound_count, got.client_count, got.panel_version, got.xray_version, got.xray_state], [100, 2, 5, '3.11.0', '26.10.21', 'running']);
  // 这次读不到版本:沿用上次的
  recordCheck(db, p.id, { ok: true, inbounds: 2, clients: 5 }, 150);
  assert.equal(getPanel(db, p.id)!.xray_version, '26.10.21');
  recordCheck(db, p.id, { ok: false, error: '连接失败' }, 200);
  const after = getPanel(db, p.id)!;
  assert.deepEqual([after.checked_at, after.check_ok_at, after.check_error, after.client_count, after.panel_version], [200, 150, '连接失败', 5, '3.11.0']);

  deletePanel(db, p.id);
  assert.equal(listPanels(db).length, 0);
  assert.throws(() => deletePanel(db, p.id), /不存在/);
});

test('面板输入校验:名称、地址必填;改名不能撞别的面板,改成自己原来的名字可以', () => {
  const db = memoryDb();
  const a = addPanel(db, 'a');
  const b = addPanel(db, 'b');
  assert.throws(() => createPanel(db, { name: ' ', base_url: 'https://x', token: 't' }), /缺少面板名称/);
  assert.throws(() => createPanel(db, { name: 'c', token: 't' }), /缺少面板地址/);
  assert.equal(listPanels(db).length, 2);

  assert.throws(() => updatePanel(db, 999, { name: 'x' }), /面板不存在/);
  assert.throws(() => updatePanel(db, a.id, { name: ' ' }), /面板名称不能为空/);
  assert.throws(() => updatePanel(db, a.id, { name: 'b' }), /面板名称已存在/);
  assert.equal(updatePanel(db, a.id, { name: 'a', base_url: 'https://new.example:1/' }).base_url, 'https://new.example:1');
  assert.deepEqual([getPanel(db, a.id)!.name, getPanel(db, b.id)!.name], ['a', 'b']);
});

test('删面板:上面有客户线路要先确认;强制删连线路记录一起删;拿它当出口的线路留着,出口变空', () => {
  const db = memoryDb();
  const relay = addPanel(db, 'relay');
  const land = addPanel(db, 'land');
  const cid = createCustomer(db, { name: 'zhang' });
  const base = { customer_id: cid, inbound_id: 1, inbound_remark: 'r', protocol: 'vless' };
  const viaLand = addLine(db, { ...base, kind: 'relay', panel_id: relay.id, email: 'zhang', exit_kind: 'panel', exit_panel_id: land.id, exit_port: 3000, exit_label: '落地 land' });
  const onLand = addLine(db, { ...base, kind: 'direct', panel_id: land.id, email: 'zhang' });

  const usage = (id: number) => {
    const v = toPanelView(db, getPanel(db, id)!);
    return [v.line_count, v.exit_line_count];
  };
  assert.deepEqual([usage(relay.id), usage(land.id)], [[1, 0], [1, 1]]);
  assert.deepEqual(panelUsage(db, 999), { line_count: 0, exit_line_count: 0 });

  assert.throws(() => deletePanel(db, land.id), /还有 1 条客户线路/);
  assert.equal(listPanels(db).length, 2);
  deletePanel(db, land.id, true);
  assert.equal(getLine(db, onLand.id), undefined);
  const left = getLine(db, viaLand.id)!;
  assert.deepEqual([left.exit_kind, left.exit_panel_id, left.exit_panel_name, left.exit_label], ['panel', null, null, '落地 land']);

  assert.throws(() => deletePanel(db, relay.id), /还有 1 条客户线路/);
  deleteLine(db, viaLand.id);
  deletePanel(db, relay.id);
  assert.equal(listPanels(db).length, 0);
  // 客户还在,只是没线路了
  assert.deepEqual(getCustomer(db, cid)!.lines, []);
});
