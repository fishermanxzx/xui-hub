import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCustomer } from '../customers/repo';
import { memoryDb } from '../testUtil';
import { clientIp, recordSubFetch, subClientCounts } from './fetchLog';

test('按客户统计近几天用了几个客户端(不同 UA)和几个 IP,只算时间窗口内的', () => {
  const db = memoryDb();
  const a = createCustomer(db, { name: 'a' });
  const b = createCustomer(db, { name: 'b' });
  const fetch = (customer_id: number, at: number, ua: string, ip: string) => recordSubFetch(db, { at, customer_id, target: 'clash', status: 200, ua, ip });
  fetch(a, 100, 'clash-verge/v2.5.8', '1.1.1.1');
  fetch(a, 200, 'clash-verge/v2.5.8', '1.1.1.2');
  fetch(a, 300, 'Shadowrocket/2701 CFNetwork/3826 Darwin/24.6.0 iPhone17,5', '1.1.1.1');
  fetch(a, 10, 'Stash/3.6.5', '9.9.9.9');
  fetch(b, 150, '', '2.2.2.2');

  const counts = subClientCounts(db, 50);
  assert.deepEqual(counts.get(a), { clients: 2, ips: 2 });
  assert.deepEqual(counts.get(b), { clients: 1, ips: 1 });
  assert.equal(counts.size, 2);
});

test('客户端 IP:CF-Connecting-IP 只在经 Cloudflare 来的时候认(本机 / 内网的隧道、反向代理,或 Cloudflare 回源地址);公网直连的不认', () => {
  const req = (peer: string, cf?: string, ip = peer) => ({ socket: { remoteAddress: peer }, ip, get: (h: string) => (h.toLowerCase() === 'cf-connecting-ip' ? cf : undefined) }) as any;
  // 公网直连:头是客户端自己填的
  assert.equal(clientIp(req('198.51.100.9', '192.0.2.1')), '198.51.100.9');
  assert.equal(clientIp(req('::ffff:198.51.100.9', '192.0.2.1')), '198.51.100.9');
  // Cloudflare 隧道(cloudflared 在本机 / Docker 内网)、Cloudflare 回源地址:认
  assert.equal(clientIp(req('127.0.0.1', '192.0.2.1')), '192.0.2.1');
  assert.equal(clientIp(req('::ffff:172.18.0.3', '192.0.2.1')), '192.0.2.1');
  assert.equal(clientIp(req('162.158.1.2', '2001:db8::5')), '2001:db8::5');
  assert.equal(clientIp(req('2606:4700::1', '192.0.2.1')), '192.0.2.1');
  // 本机反向代理把 Cloudflare 的回源地址放进 X-Forwarded-For(req.ip):认
  assert.equal(clientIp(req('203.0.113.50', '192.0.2.1', '104.16.0.9')), '192.0.2.1');
  // 头写得不像 IP:不认
  assert.equal(clientIp(req('127.0.0.1', 'nope')), '127.0.0.1');
  assert.equal(clientIp(req('127.0.0.1')), '127.0.0.1');
});
