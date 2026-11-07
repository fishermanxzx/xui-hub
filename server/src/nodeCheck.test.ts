import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addBinding, createCustomer } from './customers/repo';
import { linkToOutbound, checkNodes, pickRunner } from './nodeCheck';
import { createPanel } from './panels/repo';
import { applyPanelSnapshot } from './sync/service';
import { memoryDb, snap } from './testUtil';

test('链接转 Xray 出站:vless reality、hy2(salamander,SNI 照原样)、trojan;不支持的返回 null', () => {
  assert.deepEqual(
    linkToOutbound('vless://uuid-1@1.2.3.4:443?type=tcp&security=reality&pbk=PK&fp=chrome&sni=www.sony.com&sid=ab&spx=%2Fx&flow=xtls-rprx-vision#us-1', 't0'),
    {
      tag: 't0',
      protocol: 'vless',
      settings: { address: '1.2.3.4', port: 443, id: 'uuid-1', flow: 'xtls-rprx-vision', encryption: 'none' },
      streamSettings: {
        network: 'tcp',
        security: 'reality',
        tcpSettings: { header: { type: 'none' } },
        realitySettings: { serverName: 'www.sony.com', fingerprint: 'chrome', publicKey: 'PK', shortId: 'ab', spiderX: '/x' },
      },
    },
  );
  const hy = linkToOutbound('hysteria2://p%40ss@a.example.org:443?security=tls&sni=&alpn=h3&obfs=salamander&obfs-password=OB#hy', 't1');
  assert.deepEqual(hy.settings, { address: 'a.example.org', port: 443, version: 2 });
  assert.equal(hy.streamSettings.hysteriaSettings.auth, 'p@ss');
  assert.equal(hy.streamSettings.tlsSettings.serverName, '');
  assert.deepEqual(hy.streamSettings.finalmask, { udp: [{ type: 'salamander', settings: { password: 'OB' } }] });
  const tj = linkToOutbound('trojan://pw@b.example.org:8443?security=tls&sni=b.example.org&type=tcp#t', 't2');
  assert.deepEqual(tj.settings, { servers: [{ address: 'b.example.org', port: 8443, password: 'pw' }] });
  assert.equal(linkToOutbound('ss://abc@1.1.1.1:1#x', 't3'), null);
  assert.equal(linkToOutbound('not a link', 't4'), null);
});

test('逐个客户、逐个节点交给测试面板,记下失败原因和出口 IP;链接取不到的列出来', async () => {
  const db = memoryDb();
  const relay = createPanel(db, { name: '中转', base_url: 'https://198.51.100.1:2053/p', token: 't', role: 'relay', ip: '198.51.100.1' }, 0);
  const land = createPanel(db, { name: '落地', base_url: 'https://198.51.100.2:2053/p', token: 't', ip: '198.51.100.2', role: 'exit' }, 0);
  applyPanelSnapshot(db, relay, [snap('a1', 0, 0), snap('b1', 0, 0)], 0);
  applyPanelSnapshot(db, land, [snap('b2', 0, 0)], 0);
  const a = createCustomer(db, { name: 'a' });
  const b = createCustomer(db, { name: 'b' });
  addBinding(db, a, relay.id, 'a1', false);
  addBinding(db, b, relay.id, 'b1', false);
  addBinding(db, b, land.id, 'b2', false);

  const links: Record<string, string[]> = {
    a1: ['vless://u@198.51.100.1:1001?type=tcp&security=reality&pbk=K&sni=x#a-node'],
    b1: ['vless://u@198.51.100.1:1002?type=tcp&security=reality&pbk=K&sni=x#b-node', 'hysteria2://p@198.51.100.1:1003?sni=#b-hy'],
  };
  const fetcher = async (_p: unknown, email: string) => {
    if (!links[email]) throw new Error('连接失败');
    return links[email];
  };
  const seen: number[] = [];
  const tester = async (obs: any[]) => {
    seen.push(obs.length);
    return obs.map((o) => (o.protocol === 'hysteria' ? { success: false, error: 'connection reset' } : { success: true, delay: 5, egress: { ipv4: '203.0.113.9' } }));
  };
  const report = await checkNodes(db, { runner: '落地', tester, fetcher, batch: 2 });
  assert.equal(report.customers, 2);
  assert.deepEqual(
    report.results.map((r) => [r.customer, r.name, r.protocol, r.ok, r.egress ?? null, r.error ?? null]),
    [
      ['a', 'a-node', 'vless', true, '203.0.113.9', null],
      ['b', 'b-node', 'vless', true, '203.0.113.9', null],
      ['b', 'b-hy', 'hysteria', false, null, 'connection reset'],
    ],
  );
  assert.deepEqual(seen, [2, 1]);
  assert.deepEqual(report.skipped, ['b @ 落地:b2 取不到链接(连接失败)']);
  // 只测一位客户
  assert.equal((await checkNodes(db, { runner: '落地', tester, fetcher, customer: 'a' })).results.length, 1);
  await assert.rejects(checkNodes(db, { runner: '落地', tester, fetcher, customer: '没有这人' }), /找不到客户/);
  // 默认在第一台启用的落地上跑
  assert.equal(pickRunner(db).name, '落地');
  assert.equal(pickRunner(db, '中转').name, '中转');
});
