import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addPanel, memoryDb } from '../testUtil';
import { buildPanelDetail } from './inbounds';

const inbounds = [
  { id: 1, remark: 'vless-reality', protocol: 'vless', port: 100, enable: true, streamSettings: JSON.stringify({ network: 'tcp', security: 'reality', realitySettings: { privateKey: 'SECRET-KEY' } }) },
  { id: 2, remark: 'hy2', protocol: 'hysteria', port: 200, enable: true, streamSettings: JSON.stringify({ network: 'hysteria', security: 'tls' }) },
  { id: 3, remark: 'old', protocol: 'vless', port: 300, enable: false, streamSettings: '{"network":"tcp","security":"none"}' },
];

const clients = [
  { email: 'zhu', id: 'uuid-SECRET', enable: true, inboundIds: [1], totalGB: 0, expiryTime: 0, traffic: { up: 5, down: 10, lastOnline: 1700000000 } },
  { email: 'x', id: 'uuid-x', enable: false, inboundIds: [3], totalGB: 100, expiryTime: 2_000_000, traffic: { up: 1, down: 2 } },
  { email: 'orphan', password: 'pw-SECRET', enable: true, inboundIds: [], traffic: { up: 0, down: 0 } },
];

test('面板详情:入站、传输方式、client 归属,不含密钥', () => {
  const db = memoryDb();
  const p = addPanel(db, 'a');
  const d = buildPanelDetail(p, { inbounds, clients }, 42);
  assert.equal(d.fetched_at, 42);
  assert.deepEqual(
    d.inbounds.map((i) => [i.remark, i.protocol, i.port, i.enable, i.transport, i.clients.map((c) => c.email)]),
    [
      ['vless-reality', 'vless', 100, true, 'tcp / reality', ['zhu']],
      ['hy2', 'hysteria', 200, true, 'hysteria / tls', []],
      ['old', 'vless', 300, false, 'tcp', ['x']],
    ],
  );
  assert.deepEqual(d.inbounds[0].clients[0], { email: 'zhu', enable: true, up: 5, down: 10, total_bytes: 0, expiry_ms: 0, last_online: 1_700_000_000_000 });
  assert.deepEqual(d.inbounds[2].clients[0].enable, false);
  assert.deepEqual(d.unattached.map((c) => c.email), ['orphan']);
  assert.ok(!JSON.stringify(d).includes('SECRET'));
});
