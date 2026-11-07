import assert from 'node:assert/strict';
import { test } from 'node:test';
import { memoryDb } from '../testUtil';
import { exitKey, lineExits } from './exits';
import { createPanel } from './repo';
import { takeSnapshot, type SnapshotReader } from './snapshots';

const reader = (inbounds: any[], clients: { email: string; ids: number[] }[], xray: any): SnapshotReader => ({
  listInbounds: async () => inbounds,
  exportClients: async () => clients.map((c) => ({ client: { email: c.email, id: c.email }, inboundIds: c.ids })),
  xraySettings: async () => JSON.stringify({ xraySetting: JSON.stringify(xray) }),
});
const socksOut = (tag: string, address: string, port: number) => ({ tag, protocol: 'socks', settings: { servers: [{ address, port }] } });
const rule = (tag: string, outboundTag: string) => ({ type: 'field', inboundTag: [tag], outboundTag });

test('落地 IP:直出、经自己的落地面板、落地再走 SOCKS、登记的 SOCKS;封锁的不算', async () => {
  const db = memoryDb();
  // 面板地址用 IP,测试不做 DNS
  const relay = createPanel(db, { name: '中转', base_url: 'https://198.51.100.1:2053/p', token: 't', role: 'relay', ip: '198.51.100.1' }, 0);
  const land = createPanel(db, { name: '落地', base_url: 'https://198.51.100.2:2053/p', token: 't', ip: '198.51.100.2', role: 'exit' }, 0);
  db.prepare("INSERT INTO socks_proxies (name, host, port, created_at, updated_at, check_ip) VALUES ('买的', '203.0.113.9', 1080, 0, 0, '203.0.113.99')").run();

  await takeSnapshot(
    db,
    relay,
    reader(
      [
        { id: 1, port: 1001, protocol: 'vless', tag: 'in-A' },
        { id: 2, port: 1002, protocol: 'vless', tag: 'in-B' },
        { id: 3, port: 1003, protocol: 'vless', tag: 'in-C' },
        { id: 4, port: 1004, protocol: 'vless', tag: 'in-D' },
        { id: 5, port: 1005, protocol: 'vless', tag: 'in-E' },
      ],
      [
        { email: 'u', ids: [1] },
        { email: 'v', ids: [2, 3] },
        { email: 'w', ids: [4] },
        { email: 'x', ids: [5] },
      ],
      {
        outbounds: [
          { tag: 'direct', protocol: 'freedom' },
          { tag: 'block', protocol: 'blackhole' },
          socksOut('to-land', '198.51.100.2', 2000),
          socksOut('to-land-socks', '198.51.100.2', 3000),
          socksOut('to-bought', '203.0.113.9', 1080),
        ],
        routing: { rules: [rule('in-A', 'to-land'), rule('in-B', 'direct'), rule('in-C', 'to-bought'), rule('in-D', 'block'), rule('in-E', 'to-land-socks')] },
      },
    ),
  );
  await takeSnapshot(
    db,
    land,
    reader(
      [
        { id: 1, port: 2000, protocol: 'mixed', tag: 'in-mix' },
        { id: 2, port: 3000, protocol: 'mixed', tag: 'in-mix2' },
        { id: 3, port: 4000, protocol: 'vless', tag: 'in-own' },
      ],
      [{ email: 'own', ids: [3] }],
      {
        outbounds: [{ tag: 'direct', protocol: 'freedom' }, socksOut('to-bought', '203.0.113.9', 1080)],
        routing: { rules: [rule('in-mix', 'direct'), rule('in-mix2', 'to-bought')] },
      },
    ),
  );

  const exits = await lineExits(db);
  assert.deepEqual(exits.get(exitKey(relay.id, 'u')), [{ ip: '198.51.100.2', via: '经 落地', through: [land.id] }]);
  assert.deepEqual(exits.get(exitKey(relay.id, 'v')), [
    { ip: '198.51.100.1', via: '本机直出', through: [] },
    { ip: '203.0.113.99', via: 'SOCKS 买的', through: [] },
  ]);
  assert.equal(exits.get(exitKey(relay.id, 'w')), undefined);
  // 中转 → 落地 → SOCKS:出口是 SOCKS,途经落地
  assert.deepEqual(exits.get(exitKey(relay.id, 'x')), [{ ip: '203.0.113.99', via: 'SOCKS 买的', through: [land.id] }]);
  assert.deepEqual(exits.get(exitKey(land.id, 'own')), [{ ip: '198.51.100.2', via: '本机直出', through: [] }]);
  // 快照没变时直接用缓存
  assert.equal(await lineExits(db), exits);
});
