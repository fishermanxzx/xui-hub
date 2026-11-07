import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPanel, type Panel } from '../panels/repo';
import { takeSnapshot, type SnapshotReader } from '../panels/snapshots';
import { applyPanelSnapshot } from '../sync/service';
import { memoryDb, snap } from '../testUtil';
import { openDirect, planDirect, type DirectAdmin } from './directLines';
import { addBinding, createCustomer } from './repo';

const reality = (key: string) => ({
  network: 'tcp',
  security: 'reality',
  tcpSettings: { header: { type: 'none' } },
  realitySettings: { target: 'www.sony.com:443', serverNames: ['www.sony.com'], privateKey: key, shortIds: ['ab'], settings: { publicKey: 'pub-' + key, fingerprint: 'chrome', spiderX: '/x' } },
});

type Data = { inbounds: any[]; clients: any[]; xray: any };

function fake(data: Record<string, Data>, certs: Record<string, string> = {}) {
  const restarts: string[] = [];
  const adminFor = (p: Panel): DirectAdmin & SnapshotReader => {
    const d = data[p.name];
    return {
      listInbounds: async () => structuredClone(d.inbounds),
      listClients: async () => structuredClone(d.clients),
      exportClients: async () => d.clients.map((c) => ({ client: { email: c.email, id: c.email }, inboundIds: c.inboundIds })),
      xraySettings: async () => ({ xraySetting: JSON.stringify(d.xray) }),
      addClient: async (client: any, inboundIds: number[]) => void d.clients.push({ ...client, inboundIds }),
      attachClient: async (email: string, inboundIds: number[]) => {
        const c = d.clients.find((x) => x.email === email);
        c.inboundIds = [...new Set([...c.inboundIds, ...inboundIds])];
      },
      panelCert: async () => ({ certFile: certs[p.name] ?? '', keyFile: certs[p.name] ? certs[p.name].replace('fullchain', 'privkey') : '' }),
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

const hy2 = {
  network: 'hysteria',
  security: 'tls',
  tlsSettings: { serverName: '', certificates: [{ certificateFile: '/root/cert/relay/fullchain.pem', keyFile: '/root/cert/relay/privkey.pem' }], alpn: ['h3'] },
  hysteriaSettings: { version: 2, auth: '', udpIdleTimeout: 60 },
  finalmask: { udp: [{ type: 'salamander', settings: { password: 'relay-obfs' } }] },
};

async function setup(landingInbounds: any[], certs: Record<string, string> = { 落地: '/root/cert/ip/fullchain.pem' }) {
  const db = memoryDb();
  const relay = createPanel(db, { name: '中转', base_url: 'https://198.51.100.1:2053/p', token: 't', role: 'relay', ip: '198.51.100.1' }, 0);
  const land = createPanel(db, { name: '落地', base_url: 'https://198.51.100.2:2053/p', token: 't', ip: '198.51.100.2', role: 'exit' }, 0);
  const data: Record<string, Data> = {
    中转: {
      inbounds: [
        { id: 1, remark: 'us-198.51.100.2-a', protocol: 'vless', port: 1001, tag: 'in-L', enable: true, streamSettings: reality('relay-key'), settings: { clients: [], decryption: 'none' } },
        { id: 2, remark: 'hk-hy2', protocol: 'hysteria', port: 1002, tag: 'in-H', enable: false, streamSettings: hy2, settings: { clients: [], version: 2 } },
      ],
      clients: [{ email: 'a1', inboundIds: [1] }],
      xray: {
        outbounds: [{ tag: 'direct', protocol: 'freedom' }, { tag: 'to-L', protocol: 'socks', settings: { servers: [{ address: '198.51.100.2', port: 2000 }] } }],
        routing: { rules: [{ type: 'field', inboundTag: ['in-L'], outboundTag: 'to-L' }] },
      },
    },
    落地: {
      inbounds: [{ id: 1, remark: 'mix', protocol: 'mixed', port: 2000, tag: 'in-mix', enable: true, streamSettings: {}, settings: {} }, ...landingInbounds],
      clients: landingInbounds.length ? [{ email: 'own', inboundIds: [2] }] : [],
      xray: { outbounds: [{ tag: 'direct', protocol: 'freedom' }, { tag: 'blocked', protocol: 'blackhole' }], routing: { rules: [{ type: 'field', ip: ['geoip:private'], outboundTag: 'blocked' }] } },
    },
  };
  const { adminFor, restarts } = fake(data, certs);
  await takeSnapshot(db, relay, adminFor(relay));
  await takeSnapshot(db, land, adminFor(land));
  applyPanelSnapshot(db, relay, [snap('a1', 0, 0)], 0);
  const a = createCustomer(db, { name: 'a' });
  addBinding(db, a, relay.id, 'a1', false);
  createCustomer(db, { name: '无关' });
  if (landingInbounds.length) {
    applyPanelSnapshot(db, land, [snap('own', 0, 0)], 0);
    addBinding(db, createCustomer(db, { name: 'b' }), land.id, 'own', false);
  }
  return { db, relay, land, data, adminFor, restarts, a };
}

test('开直连:落地上没有直出的 vless 就新建(换新密钥,默认出站是直连不重启),给出口经过它的客户开 client', async () => {
  const { db, relay, land, data, adminFor, restarts, a } = await setup([]);
  const plan = await planDirect(db, land.id, adminFor);
  assert.equal(plan.error, undefined);
  assert.equal(plan.inbound, null);
  assert.deepEqual(plan.create, { remark: 'us-198.51.100.2-direct', template: '中转 的 us-198.51.100.2-a', restart: false });
  assert.deepEqual(plan.customers.map((c) => [c.name, c.lines, c.existing, c.attach]), [['a', 1, null, null]]);

  const out = await openDirect(db, land.id, [a], adminFor, 'vless', 1000, async () => true);
  assert.equal(out.created, 'us-198.51.100.2-direct');
  assert.deepEqual(out.results, [{ customer: 'a', email: 'a1', ok: true }]);
  const ib = data.落地.inbounds.find((i) => i.protocol === 'vless')!;
  const r = ib.streamSettings.realitySettings;
  assert.notEqual(r.privateKey, 'relay-key');
  assert.match(r.privateKey, /^[A-Za-z0-9_-]{43}$/);
  assert.match(r.settings.publicKey, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual([r.target, r.serverNames, r.settings.fingerprint], ['www.sony.com:443', ['www.sony.com'], 'chrome']);
  assert.notDeepEqual(r.shortIds, ['ab']);
  assert.deepEqual(restarts, []);
  assert.deepEqual(data.落地.clients.map((c) => [c.email, c.inboundIds, c.flow]), [['a1', [ib.id], 'xtls-rprx-vision']]);
  const bound = db.prepare('SELECT b.email FROM bindings b WHERE b.customer_id = ? AND b.panel_id = ?').all(a, land.id);
  assert.deepEqual(bound, [{ email: 'a1' }]);
  // 再开一次:已有线路,跳过
  assert.deepEqual((await openDirect(db, land.id, [a], adminFor, 'vless', 1000, async () => true)).results, []);
  void relay;
});

test('开直连:落地上已有直出的 vless reality 就复用;已在这台落地上有线路的客户标出来', async () => {
  const own = { id: 2, remark: 'us-own', protocol: 'vless', port: 3000, tag: 'in-own', enable: true, streamSettings: reality('land-key'), settings: { clients: [], decryption: 'none' } };
  const { db, land, data, adminFor, a } = await setup([own]);
  const plan = await planDirect(db, land.id, adminFor);
  assert.deepEqual(plan.inbound, { id: 2, remark: 'us-own', port: 3000, clients: 1 });
  assert.equal(plan.create, null);
  assert.deepEqual(plan.customers.map((c) => [c.name, c.existing]), [['a', null], ['b', 'own']]);
  const out = await openDirect(db, land.id, [a], adminFor, 'vless', 1000, async () => true);
  assert.equal(out.created, null);
  assert.deepEqual(out.results.map((r) => [r.customer, r.ok]), [['a', true]]);
  assert.equal(data.落地.inbounds.length, 2);
  assert.deepEqual(data.落地.clients.at(-1).inboundIds, [2]);
});

test('开直连只用于落地机', async () => {
  const { db, relay, adminFor } = await setup([]);
  await assert.rejects(planDirect(db, relay.id, adminFor), /只用于落地机/);
});

test('开直连 hy2:没有 hy2 入站时照别的面板的 hy2 结构新建,证书换成这台面板的、混淆密码重新生成;已有 vless client 的客户挂过去不另建', async () => {
  const own = { id: 2, remark: 'us-own', protocol: 'vless', port: 3000, tag: 'in-own', enable: true, streamSettings: reality('land-key'), settings: { clients: [], decryption: 'none' } };
  const { db, land, data, adminFor, restarts, a } = await setup([own]);
  const plan = await planDirect(db, land.id, adminFor, 'hy2');
  assert.equal(plan.protocol, 'hysteria');
  assert.deepEqual(plan.create, { remark: 'us-198.51.100.2-direct-hy2', template: '中转 的 hk-hy2', restart: false });
  assert.deepEqual(plan.customers.map((c) => [c.name, c.existing, c.attach]), [['a', null, null], ['b', null, 'own']]);
  const b = plan.customers[1].id;

  const out = await openDirect(db, land.id, [a, b], adminFor, 'hy2', 1000, async () => false);
  assert.equal(out.created, 'us-198.51.100.2-direct-hy2');
  assert.deepEqual(out.results.map((r) => [r.customer, r.email, r.ok, r.attached ?? false]), [['a', 'a1', true, false], ['b', 'own', true, true]]);
  const ib = data.落地.inbounds.find((i) => i.protocol === 'hysteria')!;
  const ss = ib.streamSettings;
  assert.deepEqual(ss.tlsSettings.certificates, [{ certificateFile: '/root/cert/ip/fullchain.pem', keyFile: '/root/cert/ip/privkey.pem', ocspStapling: 3600, oneTimeLoading: false, usage: 'encipherment', buildChain: false }]);
  assert.notEqual(ss.finalmask.udp[0].settings.password, 'relay-obfs');
  assert.equal(ss.tlsSettings.serverName, '198.51.100.2');
  assert.equal(ib.enable, true);
  assert.deepEqual(restarts, []);
  // b 没有新建 client,还是原来那个,多挂了 hy2 入站
  assert.deepEqual(data.落地.clients.find((c) => c.email === 'own').inboundIds, [2, ib.id]);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM bindings WHERE panel_id = ?').get(land.id) as { n: number }).n, 2);
  // 再看计划:两位都已有 hy2
  assert.deepEqual((await planDirect(db, land.id, adminFor, 'hy2')).customers.map((c) => c.existing), ['a1', 'own']);
});

test('开直连 hy2:这台面板没配证书时建不了,说明原因', async () => {
  const { db, land, adminFor } = await setup([], {});
  const plan = await planDirect(db, land.id, adminFor, 'hy2');
  assert.match(plan.error ?? '', /没有配置证书/);
  assert.equal(plan.create, null);
});
