import assert from 'node:assert/strict';
import { test } from 'node:test';
import YAML from 'yaml';
import { applyMihomoTemplate, mihomoTemplateMatcher, withTrojanFingerprint } from './mihomo';

const BODY = [
  'proxies:',
  '  - {name: 🇺🇸 us-1, server: 1.1.1.1, port: 443, type: vless, uuid: x}',
  'proxy-groups:',
  '  - name: 🚀 节点选择',
  '    type: select',
  '    proxies:',
  '      - 🇺🇸 us-1',
  'rules:',
  '  - DOMAIN-SUFFIX,google.com,🚀 节点选择',
  '  - MATCH,🚀 节点选择',
  '',
].join('\n');
const BASE = 'port: 7890\nsocks-port: 7891\nallow-lan: true\nmode: Rule\nlog-level: info\nexternal-controller: 127.0.0.1:9090\n' + BODY;

test('替换头部为 Mihomo 模板,去掉 port/socks-port,proxies 之后一字不改', () => {
  const out = applyMihomoTemplate(BASE);
  assert.ok(out.startsWith('tcp-concurrent: true\nunified-delay: true\nmixed-port: 7890\nallow-lan: true\nbind-address: \'*\'\nmode: rule\n'));
  assert.ok(out.endsWith(BODY));
  const doc = YAML.parse(out);
  assert.equal(doc.port, undefined);
  assert.equal(doc['socks-port'], undefined);
  assert.equal(doc['mixed-port'], 7890);
  assert.equal(doc.dns['enhanced-mode'], 'fake-ip');
  assert.equal(doc.dns['respect-rules'], true);
  assert.deepEqual(doc.dns.fallback, ['https://dns.google/dns-query', 'tls://1.1.1.1:853']);
  assert.deepEqual(doc.dns['fallback-filter'].geosite, ['gfw']);
  assert.equal(doc.rules.length, 2);
  assert.equal(doc.proxies[0].name, '🇺🇸 us-1');
});

test('Stash 用自己的模板:没有 Mihomo 专有项,DNS 走 DoH', () => {
  const doc = YAML.parse(applyMihomoTemplate(BASE, { stash: true }));
  assert.equal(doc['tcp-concurrent'], undefined);
  assert.equal(doc['unified-delay'], undefined);
  assert.equal(doc['mixed-port'], 7890);
  assert.deepEqual(doc.dns.nameserver, ['https://doh.pub/dns-query', 'https://dns.alidns.com/dns-query']);
  assert.equal(doc.dns['fake-ip-filter'], undefined);
});

test('原头部里模板没覆盖的项保留', () => {
  const doc = YAML.parse(applyMihomoTemplate('port: 7890\nhosts:\n  router.lan: 192.168.1.1\n' + BODY));
  assert.deepEqual(doc.hosts, { 'router.lan': '192.168.1.1' });
  assert.equal(doc.port, undefined);
});

test('不是 Clash 配置时原样返回', () => {
  assert.equal(applyMihomoTemplate('not: [valid\nproxies:\n'), 'not: [valid\nproxies:\n');
  assert.equal(applyMihomoTemplate('no proxies here'), 'no proxies here');
});

test('灰度开关', () => {
  assert.equal(mihomoTemplateMatcher('')('zhu'), false);
  assert.equal(mihomoTemplateMatcher('ALL')('zhu'), true);
  const some = mihomoTemplateMatcher('李四, zhu');
  assert.equal(some('zhu'), true);
  assert.equal(some('李四'), true);
  assert.equal(some('wxllll'), false);
});

test('trojan 节点没写 client-fingerprint 的补上 chrome,其他节点、已写的和空行都不动', () => {
  const body = [
    'proxies:',
    '  - {name: t1, server: a.example.org, port: 443, type: trojan, password: p, sni: a.example.org}',
    '',
    '  - {name: t2, server: b.example.org, port: 443, type: trojan, password: p, client-fingerprint: safari}',
    '  - {name: t3, server: c.example.org, port: 443, type: trojan, password: p, network: ws, ws-opts: {path: /ws, headers: {Host: c.example.org}}}',
    '  - {name: v, server: 1.2.3.4, port: 443, type: vless, uuid: u}',
    'proxy-groups:',
  ].join('\n');
  assert.equal(
    withTrojanFingerprint(body),
    [
      'proxies:',
      '  - {name: t1, server: a.example.org, port: 443, type: trojan, password: p, sni: a.example.org, client-fingerprint: chrome}',
      '',
      '  - {name: t2, server: b.example.org, port: 443, type: trojan, password: p, client-fingerprint: safari}',
      '  - {name: t3, server: c.example.org, port: 443, type: trojan, password: p, network: ws, ws-opts: {path: /ws, headers: {Host: c.example.org}}, client-fingerprint: chrome}',
      '  - {name: v, server: 1.2.3.4, port: 443, type: vless, uuid: u}',
      'proxy-groups:',
    ].join('\n'),
  );
  assert.equal(YAML.parse(withTrojanFingerprint(body)).proxies[0]['client-fingerprint'], 'chrome');
});
