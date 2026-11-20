import assert from 'node:assert/strict';
import { test } from 'node:test';
import YAML from 'yaml';
import { applyMihomoTemplate, lowerMode, mihomoTemplateMatcher, noLanAccess, withRealityMlkem, withTrojanFingerprint } from './mihomo';

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

test('替换头部为 Mihomo 模板(照代理商的抄),去掉原头部的端口和 external-controller,proxies 之后一字不改', () => {
  const out = applyMihomoTemplate(BASE);
  assert.ok(out.startsWith('mixed-port: 7890\nallow-lan: false\nmode: rule\nlog-level: silent\nipv6: false\nunified-delay: true\ntcp-concurrent: true\n'));
  assert.ok(out.endsWith(BODY));
  const doc = YAML.parse(out);
  assert.deepEqual([doc.port, doc['socks-port'], doc['external-controller'], doc['mixed-port']], [undefined, undefined, undefined, 7890]);
  // 嗅探、记住所选节点、地理数据
  assert.deepEqual(doc.sniffer, { enable: true, 'parse-pure-ip': true, 'override-destination': false, 'force-dns-mapping': true, sniff: { TLS: { ports: [443] }, HTTP: { ports: [80, 8080, 8443] } } });
  assert.deepEqual([doc['find-process-mode'], doc.profile, doc['geodata-mode'], doc['geo-auto-update']], ['strict', { 'store-selected': true }, true, false]);
  assert.deepEqual(Object.keys(doc['geox-url']), ['geoip', 'geosite', 'mmdb']);
  // DNS:fake-ip;国外 DoH 按规则走代理,国内和局域网域名用国内 DoT,节点域名用国内 DoT
  assert.deepEqual([doc.dns['enhanced-mode'], doc.dns['respect-rules'], doc.dns.ipv6], ['fake-ip', true, false]);
  assert.deepEqual(doc.dns.nameserver, ['https://1.1.1.1/dns-query', 'https://8.8.8.8/dns-query']);
  assert.deepEqual(doc.dns['proxy-server-nameserver'], ['tls://223.5.5.5:853', 'tls://120.53.53.53:853']);
  assert.deepEqual(doc.dns['nameserver-policy'], { 'geosite:cn,private': ['tls://223.5.5.5:853', 'tls://120.53.53.53:853'] });
  assert.equal(doc.dns.fallback, undefined);
  assert.equal(doc.rules.length, 2);
  assert.equal(doc.proxies[0].name, '🇺🇸 us-1');
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

test('不开局域网访问:模板是 allow-lan: false、不写 bind-address;模板关掉时 subconverter 的头部也改', () => {
  const doc = YAML.parse(applyMihomoTemplate(BASE));
  assert.deepEqual([doc['allow-lan'], doc['bind-address']], [false, undefined]);
  // proxies 之后(节点、规则)不动
  const off = noLanAccess(`${BASE}allow-lan: true\n`);
  assert.ok(off.startsWith('port: 7890\nsocks-port: 7891\nallow-lan: false\nmode: Rule\n'));
  assert.ok(off.endsWith(`${BODY}allow-lan: true\n`));
  assert.equal(noLanAccess('no proxies'), 'no proxies');
});

test('开关:默认(空)和 all 全部生效,off 关闭,也可以只给几位客户', () => {
  assert.equal(mihomoTemplateMatcher('')('zhu'), true);
  assert.equal(mihomoTemplateMatcher('ALL')('zhu'), true);
  for (const off of ['off', 'OFF', 'none', 'false', '0']) assert.equal(mihomoTemplateMatcher(off)('zhu'), false, off);
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

test('头部的 mode 改成小写;节点名里碰巧有 mode: 的、proxies 之后的都不动', () => {
  assert.ok(lowerMode(BASE).startsWith('port: 7890\nsocks-port: 7891\nallow-lan: true\nmode: rule\nlog-level: info\n'));
  assert.ok(lowerMode(BASE).endsWith(BODY));
  assert.equal(lowerMode('mode: "Global"\nproxies:\n  - {name: x}\nmode: Rule\n'), 'mode: global\nproxies:\n  - {name: x}\nmode: Rule\n');
  assert.equal(lowerMode('mode: script\nproxies: []\n'), 'mode: script\nproxies: []\n');
});

test('REALITY 节点补上 support-x25519mlkem768;已经写了的、不是 REALITY 的不动', () => {
  const body = [
    'proxies:',
    '  - {name: r, server: 1.2.3.4, port: 443, type: vless, uuid: u, tls: true, flow: xtls-rprx-vision, reality-opts: {public-key: pk, short-id: ab}, servername: www.example.com, client-fingerprint: chrome}',
    '  - {name: r2, server: 1.2.3.4, port: 443, type: vless, uuid: u, reality-opts: {public-key: pk, short-id: ab, support-x25519mlkem768: false}}',
    '  - {name: v, server: 1.2.3.4, port: 443, type: vless, uuid: u, tls: true, servername: a.example.org}',
    'proxy-groups:',
    '  - {name: g, type: select, proxies: [r, r2, v]}',
  ].join('\n');
  const out = withRealityMlkem(body);
  const proxies = YAML.parse(out).proxies;
  assert.deepEqual(proxies[0]['reality-opts'], { 'public-key': 'pk', 'short-id': 'ab', 'support-x25519mlkem768': true });
  assert.equal(proxies[1]['reality-opts']['support-x25519mlkem768'], false);
  assert.equal(proxies[2]['reality-opts'], undefined);
  assert.deepEqual(out.split('\n').slice(2), body.split('\n').slice(2));
  assert.equal(withRealityMlkem(out), out, '重复处理不变');
});
