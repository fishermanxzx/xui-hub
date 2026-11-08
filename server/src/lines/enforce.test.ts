import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addLine, createCustomer, customerState, getCustomer, updateCustomer, updateLineStats } from '../customers/repo';
import type { Panel } from '../panels/repo';
import { addPanel, memoryDb } from '../testUtil';
import { enforceCustomers } from './enforce';

test('客户状态:到期 > 超额 > 正常;已用 = 各线路流量之和', () => {
  assert.equal(customerState({ quota_bytes: 0, expire_at: 0 }, 1e12, 100), 'active');
  assert.equal(customerState({ quota_bytes: 100, expire_at: 0 }, 100, 100), 'over_quota');
  assert.equal(customerState({ quota_bytes: 100, expire_at: 50 }, 100, 100), 'expired');
  assert.equal(customerState({ quota_bytes: 100, expire_at: 150 }, 10, 100), 'active');
});

test('超额 / 到期停用线路上的客户端,恢复正常后只重新启用本系统停掉的;面板上手动停的不碰', async () => {
  const db = memoryDb();
  const a = addPanel(db, 'a');
  const b = addPanel(db, 'b');
  const cid = createCustomer(db, { name: 'zhu', quota_bytes: 1000 });
  const l1 = addLine(db, { customer_id: cid, kind: 'direct', panel_id: a.id, inbound_id: 1, inbound_remark: 'r', protocol: 'vless', email: 'zhu' });
  const l2 = addLine(db, { customer_id: cid, kind: 'direct', panel_id: b.id, inbound_id: 1, inbound_remark: 'r', protocol: 'vless', email: 'zhu' });
  const l3 = addLine(db, { customer_id: cid, kind: 'direct', panel_id: b.id, inbound_id: 2, inbound_remark: 'h', protocol: 'hysteria', email: 'zhu-2' });
  updateLineStats(db, l1.id, { up: 300, down: 300, enable: true, last_online: 0 });
  updateLineStats(db, l2.id, { up: 200, down: 300, enable: true, last_online: 0 });
  updateLineStats(db, l3.id, { up: 0, down: 0, enable: false, last_online: 0 }); // 面板上本来就停着
  assert.equal(getCustomer(db, cid)!.used, 1100);
  assert.equal(getCustomer(db, cid)!.state, 'over_quota');

  const calls: string[] = [];
  const adminFor = (p: Panel) => ({ setClientsEnabled: async (emails: string[], enable: boolean) => void calls.push(`${p.name}:${enable ? 'on' : 'off'}:${emails.join(',')}`) });
  let results = await enforceCustomers(db, adminFor);
  assert.deepEqual(calls, ['a:off:zhu', 'b:off:zhu']);
  assert.deepEqual(results.map((r) => [r.email, r.action, r.ok]), [['zhu', 'disable', true], ['zhu', 'disable', true]]);
  const after = getCustomer(db, cid)!;
  assert.deepEqual(after.lines.map((l) => [l.enable, l.auto_disabled]), [[false, true], [false, true], [false, false]]);

  // 再跑一轮:没有要做的
  calls.length = 0;
  await enforceCustomers(db, adminFor);
  assert.deepEqual(calls, []);

  // 加额度回到正常:只恢复 l1、l2,l3 是面板上手动停的不动
  updateCustomer(db, cid, { quota_bytes: 5000 });
  results = await enforceCustomers(db, adminFor);
  assert.deepEqual(calls, ['a:on:zhu', 'b:on:zhu']);
  assert.deepEqual(getCustomer(db, cid)!.lines.map((l) => [l.enable, l.auto_disabled]), [[true, false], [true, false], [false, false]]);

  // 到期:面板报错时记下失败,不改本地状态
  updateCustomer(db, cid, { expire_at: 1 });
  const failing = (p: Panel) => ({
    setClientsEnabled: async () => {
      if (p.name === 'a') throw new Error('连接失败');
    },
  });
  results = await enforceCustomers(db, failing);
  assert.deepEqual(results.map((r) => [r.panel, r.ok]), [['a', false], ['b', true]]);
  assert.deepEqual(getCustomer(db, cid)!.lines.map((l) => l.enable), [true, false, false]);
  assert.throws(() => updateCustomer(db, cid, { quota_bytes: -1 }), /额度/);
});
