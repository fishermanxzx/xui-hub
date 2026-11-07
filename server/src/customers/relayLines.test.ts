import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPanel, type Panel } from '../panels/repo';
import { takeSnapshot, type SnapshotReader } from '../panels/snapshots';
import { createSocks } from '../socks/repo';
import { applyPanelSnapshot } from '../sync/service';
import { memoryDb, snap } from '../testUtil';
import type { PanelLineAdmin } from './openLines';
import { openRelayLines, planRelayLines } from './relayLines';
import { addBinding, createCustomer } from './repo';

const reality = (key: string) => ({
  network: 'tcp',
  security: 'reality',
  tcpSettings: { header: { type: 'none' } },
  realitySettings: { target: 'www.sony.com:443', serverNames: ['www.sony.com'], privateKey: key, shortIds: ['ab'], settings: { publicKey: 'pub', fingerprint: 'chrome' } },
});
const vless = (id: number, remark: string, port: number, tag: string, key = 'r1-key') => ({ id, remark, protocol: 'vless', port, tag, enable: true, streamSettings: reality(key), settings: { clients: [], decryption: 'none' } });
type Data = { inbounds: any[]; clients: any[]; xray: any };

function fake(data: Record<string, Data>) {
  const restarts: string[] = [];
  const adminFor = (p: Panel): PanelLineAdmin & SnapshotReader => {
    const d = data[p.name];
    return {
      listInbounds: async () => structuredClone(d.inbounds),
      listClients: async () => structuredClone(d.clients),
      exportClients: async () => d.clients.map((c) => ({ client: { email: c.email, id: c.email }, inboundIds: c.inboundIds })),
      xraySettings: async () => ({ xraySetting: JSON.stringify(d.xray) }),
      addClient: async (client: any, inboundIds: number[]) => void d.clients.push({ ...client, inboundIds }),
      addInbound: async (body: any) => {
        const id = Math.max(0, ...d.inbounds.map((i) => i.id)) + 1;
        d.inbounds.push({ ...structuredClone(body), id, tag: `in-${body.port}-tcp` });
      },
      deleteInbound: async (id: number) => void (d.inbounds = d.inbounds.filter((i) => i.id !== id)),
      updateXray: async (x: any) => void (d.xray = structuredClone(x)),
      restartXray: async () => void restarts.push(p.name),
    };
  };
  return { adminFor, restarts };
}

async function setup() {
  const db = memoryDb();
  const r1 = createPanel(db, { name: 'r1', base_url: 'https://10.0.0.1:2053/p', token: 't', role: 'relay', ip: '10.0.0.1' }, 0);
  const r2 = createPanel(db, { name: 'r2', base_url: 'https://10.0.0.2:2053/p', token: 't', role: 'relay', ip: '10.0.0.2' }, 0);
  const L = createPanel(db, { name: 'L', base_url: 'https://198.51.100.2:2053/p', token: 't', ip: '198.51.100.2', role: 'exit' }, 0);
  const M = createPanel(db, { name: 'M', base_url: 'https://198.51.100.3:2053/p', token: 't', ip: '198.51.100.3', role: 'exit' }, 0);
  createSocks(db, { name: 'isp' }, 0, { host: '9.9.9.9', port: 8022, username: 'su', password: 'sp' });
  const data: Record<string, Data> = {
    r1: {
      inbounds: [vless(1, 'us-198.51.100.2-a', 1001, 'in-L'), vless(2, 'us-9.9.9.9-a', 1002, 'in-S'), vless(3, 'us-10.0.0.1-a', 1003, 'in-D'), vless(4, 'us-198.51.100.3-a', 1004, 'in-M')],
      clients: [
        { email: 'a1', inboundIds: [1] },
        { email: 'a2', inboundIds: [2] },
        { email: 'b1', inboundIds: [3] },
        { email: 'd1', inboundIds: [4] },
      ],
      xray: {
        outbounds: [
          { tag: 'direct', protocol: 'freedom' },
          { tag: 'to-L', protocol: 'socks', settings: { servers: [{ address: '198.51.100.2', port: 2000, users: [{ user: 'u', pass: 'p' }] }] } },
          { tag: 'to-S', protocol: 'socks', settings: { servers: [{ address: '9.9.9.9', port: 8022, users: [{ user: 'su', pass: 'sp' }] }] } },
          { tag: 'to-M', protocol: 'socks', settings: { servers: [{ address: '198.51.100.3', port: 2000 }] } },
        ],
        routing: { rules: [{ type: 'field', inboundTag: ['in-L'], outboundTag: 'to-L' }, { type: 'field', inboundTag: ['in-S'], outboundTag: 'to-S' }, { type: 'field', inboundTag: ['in-M'], outboundTag: 'to-M' }] },
      },
    },
    // 新加的中转:什么入站都没有
    r2: { inbounds: [], clients: [], xray: { outbounds: [{ tag: 'direct', protocol: 'freedom' }, { tag: 'blocked', protocol: 'blackhole' }], routing: { rules: [{ type: 'field', ip: ['geoip:private'], outboundTag: 'blocked' }] } } },
    L: {
      inbounds: [{ id: 1, remark: 'mix', protocol: 'mixed', port: 2000, tag: 'in-mix', enable: true, streamSettings: {}, settings: { auth: 'password', accounts: [{ user: 'u', pass: 'p' }] } }, vless(2, 'us-198.51.100.2-direct', 3000, 'in-dir', 'L-key')],
      clients: [{ email: 'c1', inboundIds: [2] }],
      xray: { outbounds: [{ tag: 'direct', protocol: 'freedom' }], routing: { rules: [] } },
    },
    // M 上没有给中转用的 mixed 入站
    M: { inbounds: [vless(1, 'x', 3000, 'in-x', 'M-key')], clients: [], xray: { outbounds: [{ tag: 'direct', protocol: 'freedom' }], routing: { rules: [] } } },
  };
  const { adminFor, restarts } = fake(data);
  for (const p of [r1, L, M]) await takeSnapshot(db, p, adminFor(p));
  applyPanelSnapshot(db, r1, [snap('a1', 0, 0), snap('a2', 0, 0), snap('b1', 0, 0), snap('d1', 0, 0)], 0);
  applyPanelSnapshot(db, L, [snap('c1', 0, 0)], 0);
  const a = createCustomer(db, { name: 'a' });
  addBinding(db, a, r1.id, 'a1', false);
  addBinding(db, a, r1.id, 'a2', false);
  const b = createCustomer(db, { name: 'b' });
  addBinding(db, b, r1.id, 'b1', false);
  const c = createCustomer(db, { name: 'c' });
  addBinding(db, c, L.id, 'c1', false);
  const d = createCustomer(db, { name: 'd' });
  addBinding(db, d, r1.id, 'd1', false);
  return { db, r2, data, adminFor, restarts, a, b, c, d };
}

test('中转批量开线路:按客户在用的落地 / SOCKS 规划;本机直出的不复制,落地直连算那台落地;落地没有 mixed 入站的开不了', async () => {
  const { db, r2, adminFor } = await setup();
  const plan = await planRelayLines(db, r2.id, adminFor);
  assert.equal(plan.template, 'r1 的 us-198.51.100.2-a');
  assert.deepEqual(
    plan.customers.map((c) => [c.name, c.exits.map((e) => [e.key, e.status, e.inbound ?? e.reason])]),
    [
      ['a', [['panel:L', 'create', 'us-198.51.100.2-b'], ['socks:SOCKS isp', 'create', 'us-9.9.9.9-b']]],
      ['c', [['panel:L', 'create', 'us-198.51.100.2-b']]],
      ['d', [['panel:M', 'unsupported', '这台落地上没有给中转用的 mixed / socks 入站']]],
    ],
  );
});

test('中转批量开线路:缺的入站一次建好(换新密钥),补出站和规则后只重启一次,给勾选的客户逐条开 client 并绑定;再开一次都已有', async () => {
  const { db, r2, data, adminFor, restarts, a, c } = await setup();
  const out = await openRelayLines(db, r2.id, [a, c], adminFor, 1000, async () => true);
  assert.deepEqual(out.created.sort(), ['us-198.51.100.2-b', 'us-9.9.9.9-b']);
  assert.deepEqual(
    out.results.map((r) => [r.customer, r.exit, r.inbound, r.email, r.ok]),
    [
      ['a', 'L', 'us-198.51.100.2-b', 'a1', true],
      ['a', 'SOCKS isp', 'us-9.9.9.9-b', 'a1-2', true],
      ['c', 'L', 'us-198.51.100.2-b', 'c1', true],
    ],
  );
  assert.deepEqual(restarts, ['r2']);
  const d = data.r2;
  assert.equal(d.inbounds.length, 2);
  for (const ib of d.inbounds) assert.notEqual(ib.streamSettings.realitySettings.privateKey, 'r1-key');
  const toL = d.xray.outbounds.find((o: any) => o.settings?.servers?.[0]?.address === '198.51.100.2');
  assert.deepEqual(toL.settings.servers[0], { address: '198.51.100.2', port: 2000, users: [{ user: 'u', pass: 'p' }] });
  assert.equal(d.xray.routing.rules.length, 3);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM bindings WHERE panel_id = ?').get(r2.id) as { n: number }).n, 3);
  // 空中转改之前没有配置可存,不留快照(有入站的中转会先存一份)
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM panel_snapshots WHERE panel_id = ?').get(r2.id) as { n: number }).n, 0);

  const again = await planRelayLines(db, r2.id, adminFor);
  assert.deepEqual(again.customers.find((x) => x.name === 'a')!.exits.map((e) => [e.status, e.inbound]), [['existing', 'a1'], ['existing', 'a1-2']]);
  assert.deepEqual((await openRelayLines(db, r2.id, [a, c], adminFor, 1000, async () => true)).results, []);
});

test('中转批量开线路:Xray 配置保存失败时删掉刚建的入站,相关线路都报这个原因', async () => {
  const { db, r2, data, adminFor, a } = await setup();
  const failing = (p: Panel) => ({ ...adminFor(p), updateXray: async () => Promise.reject(new Error('保存失败')) });
  const out = await openRelayLines(db, r2.id, [a], failing, 1000, async () => true);
  assert.deepEqual(out.results.map((r) => [r.ok, r.error]), [[false, '保存失败'], [false, '保存失败']]);
  assert.equal(data.r2.inbounds.length, 0);
});

test('批量开线路只用于中转', async () => {
  const { db, adminFor } = await setup();
  const land = (db.prepare("SELECT id FROM panels WHERE name = 'L'").get() as { id: number }).id;
  await assert.rejects(planRelayLines(db, land, adminFor), /只用于中转/);
});

test('新中转入站名的后缀避开别的中转在用的,暂停同步的中转(按快照)也算', async () => {
  const { db, r2, adminFor } = await setup();
  const r3 = createPanel(db, { name: 'r3', base_url: 'https://10.0.0.3:2053/p', token: 't', role: 'relay', ip: '10.0.0.3' }, 0);
  const paused: SnapshotReader = {
    listInbounds: async () => [vless(1, 'us-1.1.1.1-b', 1001, 'in-1')],
    exportClients: async () => [],
    xraySettings: async () => ({ xraySetting: JSON.stringify({ outbounds: [{ tag: 'direct', protocol: 'freedom' }] }) }),
  };
  await takeSnapshot(db, r3, paused);
  db.prepare('UPDATE panels SET enabled = 0 WHERE id = ?').run(r3.id);
  const plan = await planRelayLines(db, r2.id, adminFor);
  assert.deepEqual(plan.customers.find((c) => c.name === 'c')!.exits.map((e) => e.inbound), ['us-198.51.100.2-c']);
});
