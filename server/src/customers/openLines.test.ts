import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPanel, type Panel } from '../panels/repo';
import { createSocks } from '../socks/repo';
import { applyPanelSnapshot } from '../sync/service';
import { memoryDb, snap } from '../testUtil';
import { openLines, planLines, type PanelLineAdmin } from './openLines';
import { addBinding, createCustomer } from './repo';

const reality = JSON.stringify({ network: 'tcp', security: 'reality' });
const toExit = { tag: 'to-exit', protocol: 'socks', settings: { servers: [{ address: '2.2.2.2', port: 3000 }] } };

function fakePanels() {
  const data: Record<string, { inbounds: any[]; clients: any[]; xray: any }> = {
    r1: {
      inbounds: [
        { id: 1, remark: 'shared', protocol: 'vless', port: 10, tag: 't0', enable: true, streamSettings: reality },
        { id: 2, remark: 'us-2.2.2.2-a', protocol: 'vless', port: 11, tag: 't1', enable: true, streamSettings: reality },
        { id: 3, remark: 'own', protocol: 'hysteria', port: 12, tag: 't2', enable: true, streamSettings: '{"network":"hysteria","security":"tls"}' },
        { id: 4, remark: 'socks', protocol: 'mixed', port: 13, tag: 't3', enable: true, streamSettings: '' },
      ],
      // r1 上已经有别人用 zhu 这个 email
      clients: [{ email: 'zhu', inboundIds: [3], enable: true }],
      xray: {
        outbounds: [{ tag: 'direct', protocol: 'freedom' }, toExit],
        routing: { rules: [{ inboundTag: ['t0', 't1'], outboundTag: 'to-exit' }] },
      },
    },
    r2: {
      inbounds: [{ id: 1, remark: 'x', protocol: 'vless', port: 20, tag: 'x', enable: true, streamSettings: reality }],
      clients: [{ email: 'zhu', inboundIds: [1], enable: true }],
      xray: { outbounds: [{ tag: 'direct', protocol: 'freedom' }, toExit], routing: { rules: [{ inboundTag: ['x'], outboundTag: 'to-exit' }] } },
    },
  };
  const added: { panel: string; client: any; inboundIds: number[] }[] = [];
  const restarts: string[] = [];
  const adminFor = (p: Panel): PanelLineAdmin => ({
    listInbounds: async () => structuredClone(data[p.name].inbounds),
    listClients: async () => structuredClone(data[p.name].clients),
    exportClients: async () => data[p.name].clients.map((c) => ({ client: { email: c.email }, inboundIds: c.inboundIds })),
    xraySettings: async () => ({ xraySetting: JSON.stringify(data[p.name].xray) }),
    addClient: async (client: any, inboundIds: number[]) => {
      added.push({ panel: p.name, client, inboundIds });
      data[p.name].clients.push({ ...client, inboundIds });
    },
    addInbound: async (body: any) => {
      const id = Math.max(0, ...data[p.name].inbounds.map((ib) => ib.id)) + 1;
      data[p.name].inbounds.push({ ...structuredClone(body), id, tag: `in-${body.port}-tcp` });
    },
    deleteInbound: async (id: number) => void (data[p.name].inbounds = data[p.name].inbounds.filter((ib) => ib.id !== id)),
    updateXray: async (xray: any) => void (data[p.name].xray = structuredClone(xray)),
    restartXray: async () => void restarts.push(p.name),
  });
  return { data, added, restarts, adminFor };
}

function setup() {
  const db = memoryDb();
  const r1 = createPanel(db, { name: 'r1', base_url: 'https://10.0.0.1:2053/p', token: 't', ip: '10.0.0.1', role: 'relay' }, 0);
  const r2 = createPanel(db, { name: 'r2', base_url: 'https://10.0.0.2:2053/p', token: 't', ip: '10.0.0.2', role: 'relay' }, 0);
  createPanel(db, { name: '落地A', base_url: 'https://2.2.2.2:2053/p', token: 't', ip: '2.2.2.2', role: 'exit' }, 0);
  applyPanelSnapshot(db, r2, [snap('zhu', 0, 0)], 0);
  const id = createCustomer(db, { name: '朱' });
  addBinding(db, id, r2.id, 'zhu', false);
  return { db, id, r1, r2 };
}

test('开通计划:按出口分组,优先名字带出口 IP 的入站,标出客户已有的线路', async () => {
  const { db, id } = setup();
  const { adminFor } = fakePanels();
  const plan = await planLines(db, id, adminFor);
  assert.deepEqual(plan.errors, []);
  assert.deepEqual(
    plan.exits.map((e) => [e.key, e.label, e.relays.map((r) => [r.panel_name, r.inbound?.remark ?? null, r.existing?.email ?? null])]),
    [
      ['panel:落地A', '落地A', [['r1', 'us-2.2.2.2-a', null], ['r2', 'x', 'zhu']]],
      ['direct', '各中转本机直出', [['r1', 'own', null], ['r2', null, null]]],
    ],
  );
});

test('开通:只在没有线路的中转上新建,email 撞名加序号,不设限制,建完绑定', async () => {
  const { db, id, r1, r2 } = setup();
  const { adminFor, added } = fakePanels();
  const results = await openLines(db, id, 'panel:落地A', [r1.id, r2.id], adminFor, 1000);

  assert.deepEqual(results, [{ panel: 'r1', inbound: 'us-2.2.2.2-a', email: 'zhu-2', ok: true }]);
  assert.equal(added.length, 1);
  const { client, inboundIds } = added[0];
  assert.deepEqual(inboundIds, [2]);
  assert.deepEqual([client.email, client.flow, client.expiryTime, client.totalGB, client.enable], ['zhu-2', 'xtls-rprx-vision', 0, 0, true]);
  assert.match(client.id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(
    db.prepare('SELECT p.name, b.email FROM bindings b JOIN panels p ON p.id = b.panel_id WHERE b.customer_id = ? ORDER BY p.name').all(id),
    [
      { name: 'r1', email: 'zhu-2' },
      { name: 'r2', email: 'zhu' },
    ],
  );
  // 再开一次:都已有线路,什么也不做
  assert.deepEqual(await openLines(db, id, 'panel:落地A', [r1.id, r2.id], adminFor), []);
});

test('客户不正常时新建的线路是停用的;hysteria 不加 vision 流控', async () => {
  const { db, id, r1 } = setup();
  db.prepare('UPDATE customers SET status = ? WHERE id = ?').run('disabled', id);
  const { adminFor, added } = fakePanels();
  const [r] = await openLines(db, id, 'direct', [r1.id], adminFor);
  assert.equal(r.ok, true);
  assert.deepEqual([added[0].client.enable, added[0].client.flow, added[0].inboundIds], [false, '', [3]]);
});

test('本系统里已绑定、面板上已删的 email 也不复用,免得新建后绑不上', async () => {
  const { db, id, r2 } = setup();
  const { adminFor, data } = fakePanels();
  // r2 上的 zhu 在面板上被删了,本系统的绑定还在
  data.r2.clients = [];
  const [r] = await openLines(db, id, 'panel:落地A', [r2.id], adminFor);
  assert.deepEqual([r.ok, r.email], [true, 'zhu-2']);
});

test('中转上没有通往出口的入站:登记过的 SOCKS 也列出来,照同类入站新建入站、补出站和规则、重启后开 client', async () => {
  const { db, id, r1, r2 } = setup();
  createSocks(db, { name: 'isp' }, 0, { host: '9.9.9.9', port: 8022, username: 'u', password: 'p' });
  db.prepare("UPDATE socks_proxies SET check_ip = '9.9.9.10', check_loc = 'US'").run();
  const { adminFor, added, data, restarts } = fakePanels();
  data.r1.inbounds[1].remark = 'us-2.2.2.2-a';
  // r1 的规则后面还有一条封锁规则,新规则要加在它后面
  data.r1.xray.routing.rules.push({ ip: ['geoip:private'], outboundTag: 'blocked' });
  data.r1.xray.outbounds.push({ tag: 'blocked', protocol: 'blackhole' });

  const plan = await planLines(db, id, adminFor);
  const sk = plan.exits.find((e) => e.key === 'socks:SOCKS isp')!;
  assert.deepEqual(
    sk.relays.map((r) => [r.panel_name, r.inbound, r.create]),
    [
      ['r1', null, { remark: 'us-9.9.9.10-a', protocol: 'vless', template: 'shared' }],
      ['r2', null, { remark: 'us-9.9.9.10-b', protocol: 'vless', template: 'x' }],
    ],
  );
  // 已有入站的出口排前面
  assert.equal(plan.exits.at(-1)!.key, 'socks:SOCKS isp');

  const probed: number[] = [];
  const results = await openLines(db, id, 'socks:SOCKS isp', [r1.id], adminFor, 1000, async (_h, port) => (probed.push(port), true));
  assert.deepEqual(results.map((r) => [r.panel, r.inbound, r.email, r.ok, r.created]), [['r1', 'us-9.9.9.10-a', 'zhu-2', true, true]]);
  const ib = data.r1.inbounds.find((i) => i.remark === 'us-9.9.9.10-a')!;
  assert.ok(ib.port >= 20000 && ib.port < 60000 && ![10, 11, 12, 13].includes(ib.port));
  assert.deepEqual([ib.protocol, ib.streamSettings, ib.enable], ['vless', reality, true]);
  assert.deepEqual(probed, [ib.port]);
  const out = data.r1.xray.outbounds.at(-1);
  assert.deepEqual(out, { tag: 'socks-9.9.9.9-8022', protocol: 'socks', settings: { servers: [{ address: '9.9.9.9', port: 8022, users: [{ user: 'u', pass: 'p' }] }] } });
  assert.deepEqual(data.r1.xray.routing.rules.at(-1), { type: 'field', inboundTag: [ib.tag], outboundTag: 'socks-9.9.9.9-8022' });
  assert.deepEqual(restarts, ['r1']);
  assert.deepEqual(added.map((a) => [a.panel, a.client.email, a.inboundIds]), [['r1', 'zhu-2', [ib.id]]]);
  // 改之前存了快照
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM panel_snapshots WHERE panel_id = ?').get(r1.id) as { n: number }).n, 1);
  // 再开一次:已有线路,跳过
  assert.deepEqual(await openLines(db, id, 'socks:SOCKS isp', [r1.id, r2.id].slice(0, 1), adminFor), []);
});

test('新建入站:中转上已有指向同一 SOCKS(账号一致)的出站就复用;端口连不上报错,入站留着但不开 client', async () => {
  const { db, id, r1 } = setup();
  createSocks(db, { name: 'isp' }, 0, { host: '9.9.9.9', port: 8022, username: 'u', password: 'p' });
  const { adminFor, added, data } = fakePanels();
  data.r1.xray.outbounds.push({ tag: 'old-isp', protocol: 'socks', settings: { servers: [{ address: '9.9.9.9', port: 8022, users: [{ user: 'u', pass: 'p' }] }] } });
  const [r] = await openLines(db, id, 'socks:SOCKS isp', [r1.id], adminFor, 1000, async () => false);
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /端口连不上/);
  assert.equal(data.r1.xray.outbounds.filter((o: any) => o.protocol === 'socks').length, 2);
  assert.equal(data.r1.xray.routing.rules.at(-1).outboundTag, 'old-isp');
  assert.equal(added.length, 0);
});

test('新建入站:Xray 配置保存失败时删掉刚建的入站,面板回到原样', async () => {
  const { db, id, r1 } = setup();
  createSocks(db, { name: 'isp' }, 0, { host: '9.9.9.9', port: 8022, username: 'u', password: 'p' });
  const { adminFor, data } = fakePanels();
  const before = data.r1.inbounds.length;
  const failing = (p: Panel) => ({ ...adminFor(p), updateXray: async () => Promise.reject(new Error('保存失败')) });
  const [r] = await openLines(db, id, 'socks:SOCKS isp', [r1.id], failing, 1000, async () => true);
  assert.deepEqual([r.ok, r.error], [false, '保存失败']);
  assert.equal(data.r1.inbounds.length, before);
});
