import assert from 'node:assert/strict';
import { test } from 'node:test';
import { needsInboundStats, normalizeClients } from './normalize';

test('v3 client 自带 traffic', () => {
  const clients = [
    {
      id: 11,
      email: 'a',
      uuid: 'uuid-a',
      subId: 'sub-a',
      comment: '30',
      enable: true,
      totalGB: 100,
      expiryTime: 0,
      inboundIds: [15],
      traffic: { up: 1, down: 2, lastOnline: 1_700_000_000, lastSubFetch: 1_700_000_000_000 },
    },
  ];
  assert.equal(needsInboundStats(clients), false);
  const [a] = normalizeClients(clients);
  assert.equal(a.up + a.down, 3);
  assert.equal(a.totalBytes, 100);
  assert.equal(a.lastOnline, 1_700_000_000_000); // 秒转毫秒
  assert.deepEqual(a.inboundIds, [15]);
});

test('缺少 traffic 时用入站 clientStats 兜底,同 email 不累加', () => {
  const clients = [{ email: 'b', password: 'pw', enable: false }];
  const inbounds = [
    { id: 1, clientStats: [{ email: 'b', up: 5, down: 5 }] },
    { id: 2, clientStats: [{ email: 'b', up: 5, down: 5 }] },
  ];
  assert.equal(needsInboundStats(clients), true);
  const [b] = normalizeClients(clients, inbounds);
  assert.equal(b.up + b.down, 10);
  assert.equal(b.enable, false);
});

test('面板自动停用时只改流量记录上的 enable,也算停用', () => {
  const [a, b, c] = normalizeClients([
    { email: 'a', enable: true, traffic: { up: 1, down: 1, enable: false } },
    { email: 'b', enable: false, traffic: { up: 1, down: 1, enable: true } },
    { email: 'c', enable: true, traffic: { up: 1, down: 1, enable: true } },
  ]);
  assert.deepEqual([a.enable, b.enable, c.enable], [false, false, true]);
});
