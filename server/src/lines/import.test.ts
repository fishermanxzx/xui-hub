import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCustomer, getCustomer } from '../customers/repo';
import { addPanel, fakePanels, memoryDb, vlessInbound } from '../testUtil';
import { importClients } from './import';

test('归入客户:面板上已有的客户端记成直连线路并带上流量;已归过的、不存在的、没挂在能挂客户端入站上的各自报错', async () => {
  const db = memoryDb();
  const p = addPanel(db, 'a');
  const c1 = createCustomer(db, { name: 'c1' });
  const c2 = createCustomer(db, { name: 'c2' });
  const panels = fakePanels({
    a: {
      inbounds: [vlessInbound(7, 443), { id: 9, remark: 'mixed', protocol: 'mixed', port: 1080, enable: true }],
      clients: [
        { email: 'zhang', enable: true, inboundIds: [7], traffic: { up: 10, down: 20, lastOnline: 1 } },
        { email: 'li', enable: false, inboundIds: [7] },
        { email: 'sock', enable: true, inboundIds: [9] },
      ],
      xray: {},
      restarts: 0,
    },
  });
  const r = await importClients(db, c1, { panel_id: p.id, emails: ['zhang', 'li', 'ghost', 'sock'] }, panels);
  assert.deepEqual(r.lines.map((l) => [l.email, l.kind, l.inbound_id, l.protocol, l.up + l.down, l.enable]), [['zhang', 'direct', 7, 'vless', 30, true], ['li', 'direct', 7, 'vless', 0, false]]);
  assert.deepEqual(r.failed.map((f) => [f.email, f.error]), [['ghost', '面板上没有这个客户端'], ['sock', '这个客户端没挂在 vless / hy2 / trojan / vmess 入站上']]);
  assert.equal(getCustomer(db, c1)!.used, 30);
  // 别人再归:报已经是谁的
  const again = await importClients(db, c2, { panel_id: p.id, emails: 'zhang' }, panels);
  assert.deepEqual(again.failed, [{ email: 'zhang', error: '已经是客户「c1」的线路' }]);
  await assert.rejects(importClients(db, c2, { panel_id: p.id, emails: [] }, panels), /没有选客户端/);
  await assert.rejects(importClients(db, 999, { panel_id: p.id, emails: ['x'] }, panels), /客户不存在/);
});
