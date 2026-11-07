import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addBinding, createCustomer } from '../customers/repo';
import { applyPanelSnapshot } from '../sync/service';
import { addPanel, memoryDb, snap } from '../testUtil';
import { buildPanelDetail, type RouteContext } from './inbounds';

const xray = {
  outbounds: [
    { tag: 'direct', protocol: 'freedom' },
    { tag: 'blocked', protocol: 'blackhole' },
    { tag: 'to-exit', protocol: 'socks', settings: { servers: [{ address: '2.2.2.2', port: 3000, users: [{ user: 'u', pass: 'p' }] }] } },
    { tag: 'sk', protocol: 'socks', settings: { servers: [{ address: 'isp.example.com', port: 10002 }] } },
  ],
  routing: {
    rules: [
      { inboundTag: ['api'], outboundTag: 'api' },
      { type: 'field', inboundTag: ['in-100-tcp'], outboundTag: 'to-exit' },
      { inboundTag: ['in-100-tcp'], domain: ['geosite:google'], outboundTag: 'sk' },
      { user: ['x'], outboundTag: 'sk' },
      { inboundTag: ['in-300-tcp'], outboundTag: 'sk', enabled: false },
      { ip: ['geoip:private'], outboundTag: 'blocked' },
    ],
  },
};

const inbounds = [
  {
    id: 1, remark: 'us-2.2.2.2-a', protocol: 'vless', port: 100, tag: 'in-100-tcp', enable: true,
    streamSettings: JSON.stringify({ network: 'tcp', security: 'reality', realitySettings: { privateKey: 'SECRET-KEY' } }),
  },
  { id: 2, remark: 'hk-own', protocol: 'hysteria', port: 200, tag: 'in-200-tcp', enable: true, streamSettings: JSON.stringify({ network: 'hysteria', security: 'tls' }) },
  { id: 3, remark: '4837', protocol: 'vless', port: 300, tag: 'in-300-tcp', enable: false, streamSettings: '{"network":"tcp","security":"none"}' },
];

const clients = [
  { email: 'zhu', id: 'uuid-SECRET', enable: true, inboundIds: [1], totalGB: 0, expiryTime: 0, traffic: { up: 5, down: 10, lastOnline: 1700000000 } },
  { email: 'x', id: 'uuid-x', enable: false, inboundIds: [3], totalGB: 100, expiryTime: 2_000_000, traffic: { up: 1, down: 2 } },
  { email: 'orphan', password: 'pw-SECRET', enable: true, inboundIds: [], traffic: { up: 0, down: 0 } },
];

const ctx: RouteContext = { panelHosts: new Map([['2.2.2.2', '美国-1']]), socks: [{ name: 'att', host: 'isp.example.com', port: 10002 }] };

test('面板详情:入站去向、分流规则数、client 归属,不含密钥', () => {
  const db = memoryDb();
  const p = addPanel(db, 'relay');
  applyPanelSnapshot(db, p, [snap('zhu', 0, 0)], 0);
  const cid = createCustomer(db, { name: '朱', quota_bytes: 0, expire_at: 0 });
  addBinding(db, cid, p.id, 'zhu', false);

  const d = buildPanelDetail(db, p, { inbounds, clients, xray: { xraySetting: JSON.stringify(xray) } }, ctx, 42);
  const [a, own, shared] = d.inbounds;

  assert.deepEqual(a.route, { kind: 'panel', label: '美国-1', outbound: 'to-exit' });
  assert.equal(a.extra_rules, 1);
  assert.equal(a.transport, 'tcp / reality');
  assert.deepEqual(a.clients.map((c) => [c.email, c.customer?.name, c.up + c.down, c.last_online]), [['zhu', '朱', 15, 1_700_000_000_000]]);

  assert.deepEqual(own.route, { kind: 'direct', label: '本机直出', outbound: 'direct' });
  assert.equal(own.extra_rules, 0);
  assert.equal(own.transport, 'hysteria / tls');

  // 停用的规则不算;按客户分流的规则算在客户所在入站上
  assert.equal(shared.enable, false);
  assert.deepEqual(shared.route.kind, 'direct');
  assert.equal(shared.extra_rules, 1);
  assert.equal(shared.transport, 'tcp');
  assert.deepEqual(shared.clients.map((c) => [c.email, c.customer, c.enable, c.total_bytes]), [['x', null, false, 100]]);

  assert.deepEqual(d.unattached.map((c) => c.email), ['orphan']);
  assert.equal(d.fetched_at, 42);
  assert.doesNotMatch(JSON.stringify(d), /SECRET|uuid-/);
});

test('出站是已登记 SOCKS、找不到出站、负载均衡', () => {
  const db = memoryDb();
  const p = addPanel(db, 'exit');
  const x2 = {
    outbounds: xray.outbounds,
    routing: { rules: [{ inboundTag: ['a'], outboundTag: 'sk' }, { inboundTag: ['b'], outboundTag: 'gone' }, { inboundTag: ['c'], balancerTag: 'lb' }] },
  };
  const ibs = ['a', 'b', 'c'].map((tag, i) => ({ id: i + 1, remark: tag, protocol: 'vless', port: i + 1, tag, enable: true, streamSettings: '' }));
  const d = buildPanelDetail(db, p, { inbounds: ibs, clients: [], xray: x2 }, ctx);
  assert.deepEqual(
    d.inbounds.map((i) => [i.route.kind, i.route.label]),
    [
      ['socks', 'SOCKS att'],
      ['other', '找不到出站 gone'],
      ['other', '负载均衡 lb'],
    ],
  );
});

test('不限入站、不限客户的无条件规则对所有入站生效', () => {
  const db = memoryDb();
  const p = addPanel(db, 'relay2');
  const x3 = {
    outbounds: xray.outbounds,
    routing: { rules: [{ ip: ['geoip:private'], outboundTag: 'blocked' }, { network: 'tcp,udp', outboundTag: 'sk' }, { inboundTag: ['b'], outboundTag: 'to-exit' }] },
  };
  const ibs = ['a', 'b'].map((tag, i) => ({ id: i + 1, remark: tag, protocol: 'vless', port: i + 1, tag, enable: true, streamSettings: '' }));
  const d = buildPanelDetail(db, p, { inbounds: ibs, clients: [], xray: x3 }, ctx);
  assert.deepEqual(d.inbounds.map((i) => i.route.label), ['SOCKS att', 'SOCKS att']);
});
