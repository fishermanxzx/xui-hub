import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ClientRemover } from '../customers/panelOps';
import { addBinding, createCustomer } from '../customers/repo';
import { applyPanelSnapshot } from '../sync/service';
import { memoryDb, snap } from '../testUtil';
import { createPanel, getPanel } from './repo';
import { takeSnapshot, type SnapshotReader } from './snapshots';
import { planUninstall, uninstallPanel } from './uninstall';

const reader = (inbounds: any[], clients: { email: string; ids: number[] }[], xray: any): SnapshotReader => ({
  listInbounds: async () => inbounds,
  exportClients: async () => clients.map((c) => ({ client: { email: c.email, id: c.email }, inboundIds: c.ids })),
  xraySettings: async () => JSON.stringify({ xraySetting: JSON.stringify(xray) }),
});
const socksOut = (tag: string, address: string, port: number) => ({ tag, protocol: 'socks', settings: { servers: [{ address, port }] } });
const rule = (tag: string, outboundTag: string) => ({ type: 'field', inboundTag: [tag], outboundTag });

test('卸载落地机:删它上面的线路和中转上出口全经过它的线路,只部分经过的不动;落地连不上也照样解绑并移除', async () => {
  const db = memoryDb();
  const relay = createPanel(db, { name: '中转', base_url: 'https://198.51.100.1:2053/p', token: 't', role: 'relay', ip: '198.51.100.1' }, 0);
  const land = createPanel(db, { name: '落地L', base_url: 'https://198.51.100.2:2053/p', token: 't', ip: '198.51.100.2', role: 'exit' }, 0);
  const other = createPanel(db, { name: '落地M', base_url: 'https://198.51.100.3:2053/p', token: 't', ip: '198.51.100.3', role: 'exit' }, 0);

  await takeSnapshot(
    db,
    relay,
    reader(
      [
        { id: 1, port: 1001, protocol: 'vless', tag: 'in-L' },
        { id: 2, port: 1002, protocol: 'vless', tag: 'in-M' },
      ],
      [
        { email: 'via-l', ids: [1] },
        { email: 'via-m', ids: [2] },
        { email: 'both', ids: [1, 2] },
      ],
      {
        outbounds: [{ tag: 'direct', protocol: 'freedom' }, socksOut('to-L', '198.51.100.2', 2000), socksOut('to-M', '198.51.100.3', 2000)],
        routing: { rules: [rule('in-L', 'to-L'), rule('in-M', 'to-M')] },
      },
    ),
  );
  const landXray = { outbounds: [{ tag: 'direct', protocol: 'freedom' }], routing: { rules: [] } };
  await takeSnapshot(db, land, reader([{ id: 1, port: 2000, protocol: 'mixed', tag: 'in-mix' }, { id: 2, port: 3000, protocol: 'vless', tag: 'in-own' }], [{ email: 'own', ids: [2] }], landXray));
  await takeSnapshot(db, other, reader([{ id: 1, port: 2000, protocol: 'mixed', tag: 'in-mix' }], [], landXray));

  applyPanelSnapshot(db, relay, [snap('via-l', 0, 0), snap('via-m', 0, 0), snap('both', 0, 0)], 0);
  applyPanelSnapshot(db, land, [snap('own', 0, 0)], 0);
  const bind = (name: string, panelId: number, email: string) => {
    const id = createCustomer(db, { name });
    addBinding(db, id, panelId, email, false);
    return id;
  };
  bind('a', land.id, 'own');
  bind('b', relay.id, 'via-l');
  const c = bind('c', relay.id, 'via-m');
  const d = bind('d', relay.id, 'both');

  const plan = await planUninstall(db, land.id);
  assert.deepEqual(plan.direct.map((l) => l.customer_name), ['a']);
  assert.deepEqual(plan.through.map((l) => l.customer_name), ['b']);
  assert.deepEqual(plan.partial.map((l) => l.customer_name), ['d']);

  const onRelay = ['via-l', 'via-m', 'both'];
  const removers: Record<string, ClientRemover> = {
    中转: { listClients: async () => onRelay.map((email) => ({ email })), deleteClient: async (e) => void onRelay.splice(onRelay.indexOf(e), 1) },
    落地L: { listClients: async () => Promise.reject(new Error('连接失败')), deleteClient: async () => {} },
  };
  const { results } = await uninstallPanel(db, land.id, (p) => removers[p.name]);
  assert.deepEqual(results, [
    { panel: '落地L', email: 'own', ok: false, error: '连接失败' },
    { panel: '中转', email: 'via-l', ok: true },
  ]);
  assert.deepEqual(onRelay, ['via-m', 'both']);
  assert.equal(getPanel(db, land.id), undefined);
  const left = db.prepare('SELECT customer_id FROM bindings ORDER BY customer_id').all() as { customer_id: number }[];
  assert.deepEqual(left.map((r) => r.customer_id), [c, d]);
});
