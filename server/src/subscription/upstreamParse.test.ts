import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseNode, parseNodes } from './nodes';
import { clashToLink, parseUpstreamBody, singboxToLink } from './upstreamParse';

const REALITY = 'vless://u-1@203.0.113.10:443?encryption=none&flow=xtls-rprx-vision&security=reality&sni=www.example.com&fp=chrome&pbk=PUBKEY&sid=ab12&type=tcp#%E7%BE%8E%E5%9B%BD';
const HY2 = 'hysteria2://pw@203.0.113.11:8443/?sni=h.example.com&obfs=salamander&obfs-password=op#hy2';

test('节点链接:明文、标准 base64、URL 安全且不带 = 的 base64 都认;链接原样保留,网址行不算节点', () => {
  const text = `${REALITY}\r\n${HY2}\r\nhttps://t.example.com/notice\r\n`;
  for (const body of [text, Buffer.from(text).toString('base64'), Buffer.from(text).toString('base64url'), Buffer.from(text).toString('base64').replace(/(.{60})/g, '$1\n')]) {
    assert.deepEqual(parseUpstreamBody(body), { links: [REALITY, HY2], skipped: 0 });
  }
  assert.deepEqual(parseUpstreamBody(''), { links: [], skipped: 0 });
  assert.deepEqual(parseUpstreamBody('<html>login</html>'), { links: [], skipped: 0 });
});

test('Clash 配置:各协议换成分享链接,参数都在;认不出的协议计入 skipped', () => {
  const yaml = `mixed-port: 7890
proxies:
  - {name: 美国, type: vless, server: 203.0.113.10, port: 443, uuid: u-1, network: tcp, tls: true, udp: true, flow: xtls-rprx-vision, servername: www.example.com, client-fingerprint: chrome, reality-opts: {public-key: PUBKEY, short-id: ab12}}
  - name: ws
    type: vmess
    server: v.example.com
    port: 443
    uuid: u-2
    alterId: 0
    cipher: auto
    tls: true
    servername: v.example.com
    network: ws
    ws-opts: {path: /ray, headers: {Host: cdn.example.com}}
  - {name: tj, type: trojan, server: t.example.com, port: 443, password: p@ss, sni: t.example.com, network: grpc, grpc-opts: {grpc-service-name: svc}, skip-cert-verify: true}
  - {name: ss, type: ss, server: 203.0.113.12, port: 8388, cipher: aes-128-gcm, password: sspw, plugin: obfs, plugin-opts: {mode: http, host: bing.com}}
  - {name: ss22, type: ss, server: 203.0.113.13, port: 8389, cipher: 2022-blake3-aes-128-gcm, password: 'a+b/c='}
  - {name: hy2, type: hysteria2, server: 203.0.113.11, port: 8443, password: pw, sni: h.example.com, obfs: salamander, obfs-password: op, ports: 20000-30000}
  - {name: tuic, type: tuic, server: 203.0.113.14, port: 443, uuid: u-3, password: tp, alpn: [h3], congestion-controller: bbr, udp-relay-mode: native}
  - {name: wg, type: wireguard, server: 203.0.113.15, port: 51820, private-key: k}
  - {name: ssp, type: ss, server: 203.0.113.16, port: 1, cipher: aes-128-gcm, password: x, plugin: shadow-tls}
proxy-groups:
  - {name: 节点选择, type: select, proxies: [美国]}
`;
  const { links, skipped } = parseUpstreamBody(yaml);
  assert.equal(skipped, 2);
  assert.equal(links.length, 7);
  // 密码里只转义会拆坏链接的字符;ss 一律 base64url(内置 subconverter 只认这种)
  assert.match(links[2], /^trojan:\/\/p%40ss@t\.example\.com:443\?/);
  assert.equal(links[4], `ss://${Buffer.from('2022-blake3-aes-128-gcm:a+b/c=').toString('base64url')}@203.0.113.13:8389#ss22`);
  const [vless, vmess, trojan, ss, ss22, hy2, tuic] = parseNodes(links);
  assert.deepEqual(
    [vless.type, vless.name, vless.server, vless.port],
    ['vless', '美国', '203.0.113.10', 443],
  );
  assert.ok(vless.type === 'vless');
  assert.deepEqual([vless.uuid, vless.security, vless.flow, vless.sni, vless.fingerprint, vless.publicKey, vless.shortId], ['u-1', 'reality', 'xtls-rprx-vision', 'www.example.com', 'chrome', 'PUBKEY', 'ab12']);
  assert.ok(vmess.type === 'vmess');
  assert.deepEqual([vmess.uuid, vmess.tls, vmess.network, vmess.path, vmess.host, vmess.sni], ['u-2', true, 'ws', '/ray', 'cdn.example.com', 'v.example.com']);
  assert.ok(trojan.type === 'trojan');
  assert.deepEqual([trojan.password, trojan.network, trojan.serviceName, trojan.insecure], ['p@ss', 'grpc', 'svc', true]);
  assert.ok(ss.type === 'shadowsocks');
  assert.deepEqual([ss.method, ss.password, ss.plugin, ss.pluginOpts], ['aes-128-gcm', 'sspw', 'obfs-local', { obfs: 'http', 'obfs-host': 'bing.com' }]);
  assert.ok(ss22.type === 'shadowsocks');
  assert.deepEqual([ss22.method, ss22.password], ['2022-blake3-aes-128-gcm', 'a+b/c=']);
  assert.ok(hy2.type === 'hysteria2');
  assert.deepEqual([hy2.password, hy2.sni, hy2.obfs, hy2.obfsPassword], ['pw', 'h.example.com', 'salamander', 'op']);
  assert.match(links[5], /mport=20000-30000/);
  assert.ok(tuic.type === 'tuic');
  assert.deepEqual([tuic.uuid, tuic.password, tuic.alpn, tuic.congestion, tuic.udpRelayMode], ['u-3', 'tp', ['h3'], 'bbr', 'native']);
});

test('Clash:ws 的 httpupgrade、trojan 的 REALITY、没有 server 的项', () => {
  const up = parseNode(clashToLink({ name: 'hu', type: 'vless', server: 'a.example.com', port: 80, uuid: 'u', network: 'ws', 'ws-opts': { path: '/x', 'v2ray-http-upgrade': true } })!)!;
  assert.deepEqual([up.type, up.type === 'vless' && up.network, up.type === 'vless' && up.security], ['vless', 'httpupgrade', 'none']);
  assert.match(clashToLink({ name: 't', type: 'trojan', server: 'b.example.com', port: 443, password: 'p', 'reality-opts': { 'public-key': 'K', 'short-id': '1' } })!, /security=reality&.*pbk=K&sid=1/);
  assert.equal(clashToLink({ name: 'x', type: 'vless', uuid: 'u' }), null);
});

test('sing-box 配置:代理出站换成分享链接;直连 / 分组 / DNS 不算节点,认不出的协议计入 skipped', () => {
  const json = JSON.stringify({
    outbounds: [
      { type: 'selector', tag: '节点选择', outbounds: ['美国'] },
      { type: 'vless', tag: '美国', server: '203.0.113.10', server_port: 443, uuid: 'u-1', flow: 'xtls-rprx-vision', tls: { enabled: true, server_name: 'www.example.com', utls: { enabled: true, fingerprint: 'chrome' }, reality: { enabled: true, public_key: 'PUBKEY', short_id: 'ab12' } } },
      { type: 'hysteria2', tag: 'hy2', server: '203.0.113.11', server_port: 8443, password: 'pw', obfs: { type: 'salamander', password: 'op' }, tls: { enabled: true, server_name: 'h.example.com' } },
      { type: 'shadowsocks', tag: 'ss', server: '203.0.113.12', server_port: 8388, method: 'aes-128-gcm', password: 'sspw', plugin: 'obfs-local', plugin_opts: 'obfs=http;obfs-host=bing.com' },
      { type: 'vmess', tag: 'vm', server: 'v.example.com', server_port: 443, uuid: 'u-2', security: 'auto', tls: { enabled: true }, transport: { type: 'ws', path: '/ray', headers: { Host: 'cdn.example.com' } } },
      { type: 'wireguard', tag: 'wg', server: '203.0.113.15', server_port: 51820 },
      { type: 'direct', tag: 'direct' },
      { type: 'dns', tag: 'dns-out' },
    ],
  });
  const { links, skipped } = parseUpstreamBody(json);
  assert.equal(skipped, 1);
  const [vless, hy2, ss, vmess] = parseNodes(links);
  assert.ok(vless.type === 'vless');
  assert.deepEqual([vless.name, vless.security, vless.flow, vless.sni, vless.fingerprint, vless.publicKey, vless.shortId], ['美国', 'reality', 'xtls-rprx-vision', 'www.example.com', 'chrome', 'PUBKEY', 'ab12']);
  assert.ok(hy2.type === 'hysteria2');
  assert.deepEqual([hy2.obfs, hy2.obfsPassword, hy2.sni], ['salamander', 'op', 'h.example.com']);
  assert.ok(ss.type === 'shadowsocks');
  assert.deepEqual(ss.pluginOpts, { obfs: 'http', 'obfs-host': 'bing.com' });
  assert.ok(vmess.type === 'vmess');
  assert.deepEqual([vmess.network, vmess.path, vmess.host, vmess.tls], ['ws', '/ray', 'cdn.example.com', true]);
  assert.equal(singboxToLink({ type: 'urltest', tag: 'auto' }), undefined);
});

test('ss 链接:SIP002(base64url / 明文)、旧的整段 base64、带插件;认不出的插件不出', () => {
  const user = Buffer.from('aes-256-gcm:pw:with:colon').toString('base64url');
  const a = parseNode(`ss://${user}@203.0.113.1:8388#A`);
  assert.ok(a?.type === 'shadowsocks');
  assert.deepEqual([a.method, a.password, a.server, a.port, a.name], ['aes-256-gcm', 'pw:with:colon', '203.0.113.1', 8388, 'A']);
  const b = parseNode(`ss://${Buffer.from('chacha20-ietf-poly1305:pw@203.0.113.2:443').toString('base64')}#B`);
  assert.ok(b?.type === 'shadowsocks');
  assert.deepEqual([b.method, b.password, b.server, b.port], ['chacha20-ietf-poly1305', 'pw', '203.0.113.2', 443]);
  const c = parseNode(`ss://2022-blake3-aes-128-gcm:${encodeURIComponent('k+e/y=')}@[2001:db8::1]:443/?plugin=${encodeURIComponent('simple-obfs;obfs=tls;obfs-host=x.example.com')}#C`);
  assert.ok(c?.type === 'shadowsocks');
  assert.deepEqual([c.method, c.password, c.server, c.plugin, c.pluginOpts], ['2022-blake3-aes-128-gcm', 'k+e/y=', '2001:db8::1', 'obfs-local', { obfs: 'tls', 'obfs-host': 'x.example.com' }]);
  assert.equal(parseNode(`ss://${user}@203.0.113.1:8388/?plugin=shadow-tls#D`), null);
});
