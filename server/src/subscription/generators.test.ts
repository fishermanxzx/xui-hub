import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildLoon, buildQuantumultX } from './apple';
import { parseNode, parseNodes } from './nodes';
import { buildSingbox, singboxLegacyDns } from './singbox';

const VLESS = 'vless://11111111-2222-3333-4444-555555555555@1.2.3.4:443?type=tcp&encryption=none&security=reality&pbk=PUBKEY&fp=chrome&sni=www.sony.com&sid=ab12&spx=%2F&flow=xtls-rprx-vision&support-x25519mlkem768=1#us-1.2.3.4';
const VLESS_NOFLOW = 'vless://u2@5.6.7.8:8443?type=tcp&security=reality&pbk=PK2&fp=safari&sni=a.com&sid=cd#hk';
const HY2 = 'hysteria2://p%40ss@9.9.9.9:13344?security=tls&sni=bing.com&alpn=h3&fp=chrome&obfs=salamander&obfs-password=OBFS#us-9.9.9.9';

test('解析 vless reality 与 hysteria2 链接', () => {
  assert.deepEqual(parseNode(VLESS), {
    type: 'vless', name: 'us-1.2.3.4', server: '1.2.3.4', port: 443, uuid: '11111111-2222-3333-4444-555555555555',
    flow: 'xtls-rprx-vision', network: 'tcp', security: 'reality', sni: 'www.sony.com', fingerprint: 'chrome', publicKey: 'PUBKEY', shortId: 'ab12',
    alpn: [], insecure: false, path: undefined, host: undefined, serviceName: undefined,
  });
  assert.deepEqual(parseNode(HY2), {
    type: 'hysteria2', name: 'us-9.9.9.9', server: '9.9.9.9', port: 13344, password: 'p@ss', sni: 'bing.com', alpn: ['h3'],
    obfs: 'salamander', obfsPassword: 'OBFS', insecure: false,
  });
  assert.equal(parseNode(VLESS_NOFLOW)!.type === 'vless' && (parseNode(VLESS_NOFLOW) as any).flow, undefined);
  assert.equal(parseNode('ss://abc@1.1.1.1:1#x'), null);
  assert.equal(parseNode('not a link'), null);
});

test('重名节点加序号', () => {
  assert.deepEqual(parseNodes([VLESS, VLESS, HY2]).map((n) => n.name), ['us-1.2.3.4', 'us-1.2.3.4 2', 'us-9.9.9.9']);
  // 加的序号撞上已有名字时继续往后找
  const named = (name: string) => VLESS.replace(/#.*$/, '#' + encodeURIComponent(name));
  assert.deepEqual(parseNodes([named('a'), named('a 2'), named('a')]).map((n) => n.name), ['a', 'a 2', 'a 3']);
});

test('按 UA 里的 sing-box 版本决定 DNS 写法', () => {
  assert.equal(singboxLegacyDns('SFA/1.11.0 (sing-box 1.11.0)'), true);
  assert.equal(singboxLegacyDns('SFI/1.11.0 (Version 1.11.0 (310); sing-box 1.11.0)'), true);
  assert.equal(singboxLegacyDns('SFA/1.12.4 (sing-box 1.12.4)'), false);
  assert.equal(singboxLegacyDns('HiddifyNext/2.5.7 (android) like ClashMeta'), false);
});

test('sing-box:结构与节点字段', () => {
  const nodes = parseNodes([VLESS, VLESS_NOFLOW, HY2]);
  const cfg = buildSingbox(nodes, { legacyDns: false, insecure: true }) as any;
  assert.deepEqual(cfg.dns.servers, [{ type: 'udp', tag: 'remote', server: '1.1.1.1' }, { type: 'udp', tag: 'cn', server: '119.29.29.29' }]);
  assert.deepEqual(cfg.route.default_domain_resolver, { server: 'remote' });
  const [direct, select, auto, v1, v2, hy] = cfg.outbounds;
  assert.deepEqual(direct, { tag: 'DIRECT', type: 'direct', domain_resolver: { server: 'cn' } });
  assert.deepEqual(select.outbounds, ['自动选择', 'us-1.2.3.4', 'hk', 'us-9.9.9.9']);
  assert.deepEqual(auto.outbounds, ['us-1.2.3.4', 'hk', 'us-9.9.9.9']);
  assert.deepEqual(v1, {
    type: 'vless', tag: 'us-1.2.3.4', server: '1.2.3.4', server_port: 443, uuid: '11111111-2222-3333-4444-555555555555', packet_encoding: 'xudp',
    flow: 'xtls-rprx-vision',
    tls: { enabled: true, insecure: false, utls: { enabled: true, fingerprint: 'chrome' }, server_name: 'www.sony.com', reality: { enabled: true, public_key: 'PUBKEY', short_id: 'ab12' } },
  });
  assert.equal(v2.flow, undefined);
  assert.deepEqual(hy, {
    type: 'hysteria2', tag: 'us-9.9.9.9', server: '9.9.9.9', server_port: 13344, password: 'p@ss', obfs: { type: 'salamander', password: 'OBFS' },
    tls: { enabled: true, insecure: true, server_name: 'bing.com', alpn: ['h3'] },
  });

  const legacy = buildSingbox(nodes, { legacyDns: true, insecure: true }) as any;
  assert.deepEqual(legacy.dns.servers, [{ tag: 'remote', address: '1.1.1.1' }, { tag: 'cn', address: '119.29.29.29' }]);
  assert.equal(legacy.route.default_domain_resolver, undefined);
  assert.deepEqual(legacy.outbounds[0], { tag: 'DIRECT', type: 'direct' });
});

test('Quantumult X:base64,CRLF,vless 带 reality 参数,跳过 hysteria2,不刻意开 UDP', () => {
  const text = Buffer.from(buildQuantumultX(parseNodes([VLESS, HY2])), 'base64').toString();
  assert.equal(
    text,
    'vless=1.2.3.4:443,method=none,password=11111111-2222-3333-4444-555555555555,obfs=over-tls,reality-base64-pubkey=PUBKEY,reality-hex-shortid=ab12,obfs-host=www.sony.com,vless-flow=xtls-rprx-vision,fast-open=true,tag=us-1.2.3.4\r\n',
  );
  assert.equal(buildQuantumultX(parseNodes([HY2])), '');
});

test('Loon:CRLF,vless reality 与 hysteria2 混淆,不刻意开 UDP', () => {
  assert.equal(
    buildLoon(parseNodes([VLESS, HY2]), { insecure: true }),
    'us-1.2.3.4=VLESS,1.2.3.4,443,11111111-2222-3333-4444-555555555555,alterId=0,flow=xtls-rprx-vision,over-tls=true,skip-cert-verify=false,sni=www.sony.com,public-key=PUBKEY,short-id=ab12,transport=tcp\r\n' +
      'us-9.9.9.9=Hysteria2,9.9.9.9,13344,p@ss,sni=bing.com,skip-cert-verify=true,salamander-password=OBFS\r\n',
  );
});

const TROJAN = 'trojan://pass%2Fword@test.example.org:443?type=tcp&security=tls&sni=test.example.org&fp=chrome&alpn=h2%2Chttp%2F1.1#us-trojan';
const TROJAN_WS = 'trojan://pw@cdn.example.org:443?type=ws&security=tls&sni=a.example.org&host=b.example.org&path=%2Fws&fp=safari&allowInsecure=0#ws-node';

test('trojan:解析 tcp / ws,其他安全层和不支持的传输跳过', () => {
  assert.deepEqual(parseNode(TROJAN), {
    type: 'trojan', name: 'us-trojan', server: 'test.example.org', port: 443, password: 'pass/word', network: 'tcp',
    sni: 'test.example.org', alpn: ['h2', 'http/1.1'], fingerprint: 'chrome', insecure: false, path: undefined, host: undefined, serviceName: undefined,
  });
  const ws = parseNode(TROJAN_WS) as any;
  assert.deepEqual([ws.network, ws.sni, ws.host, ws.path, ws.fingerprint], ['ws', 'a.example.org', 'b.example.org', '/ws', 'safari']);
  assert.equal(parseNode(TROJAN.replace('security=tls', 'security=reality')), null);
  assert.equal(parseNode(TROJAN.replace('type=tcp', 'type=kcp')), null);
});

test('trojan:sing-box、Quantumult X、Loon 输出', () => {
  const nodes = parseNodes([TROJAN, TROJAN_WS]);
  const outs = (buildSingbox(nodes, { legacyDns: false, insecure: false }).outbounds as any[]).filter((o) => o.type === 'trojan');
  assert.deepEqual(outs[0], {
    type: 'trojan', tag: 'us-trojan', server: 'test.example.org', server_port: 443, password: 'pass/word',
    tls: { enabled: true, insecure: false, server_name: 'test.example.org', alpn: ['h2', 'http/1.1'], utls: { enabled: true, fingerprint: 'chrome' } },
  });
  assert.deepEqual(outs[1].transport, { type: 'ws', path: '/ws', headers: { Host: 'b.example.org' } });

  const qx = Buffer.from(buildQuantumultX(nodes), 'base64').toString('utf8').split('\r\n');
  assert.equal(qx[0], 'trojan=test.example.org:443,password=pass/word,over-tls=true,tls-host=test.example.org,tls-verification=true,fast-open=false,udp-relay=false,tag=us-trojan');
  assert.equal(qx[1], 'trojan=cdn.example.org:443,password=pw,obfs=wss,obfs-host=b.example.org,obfs-uri=/ws,tls-verification=true,fast-open=false,udp-relay=false,tag=ws-node');

  const loon = buildLoon(nodes, { insecure: false }).split('\r\n');
  assert.equal(loon[0], 'us-trojan=trojan,test.example.org,443,"pass/word",transport=tcp,sni=test.example.org,skip-cert-verify=false');
  assert.equal(loon[1], 'ws-node=trojan,cdn.example.org,443,"pw",transport=ws,path=/ws,host=b.example.org,sni=a.example.org,skip-cert-verify=false');
});

const VLESS_WS = 'vless://u-ws@cdn.example.org:443?type=ws&encryption=none&path=%2Fray&host=h.example.org&security=tls&fp=chrome&alpn=h2%2Chttp%2F1.1&sni=s.example.org&allowInsecure=1#ws-tls';
const VLESS_WS_PLAIN = 'vless://u-plain@5.5.5.5:8080?type=ws&encryption=none&path=%2Fp&security=none#ws-plain';
const VLESS_GRPC = 'vless://u-grpc@6.6.6.6:2053?type=grpc&serviceName=svc&mode=gun&security=reality&pbk=PK&fp=chrome&sni=a.com&sid=ef#grpc';
const VLESS_HTTPUPGRADE = 'vless://u-hu@7.7.7.7:80?type=httpupgrade&path=%2Fup&host=h.example.org&security=none#hu';
const vmess = (obj: Record<string, unknown>) => 'vmess://' + Buffer.from(JSON.stringify({ v: '2', id: 'vm-uuid', ...obj })).toString('base64');
const VMESS_WS = vmess({ ps: 'vm-ws', add: 'cdn.example.org', port: 443, net: 'ws', type: 'none', path: '/vm', host: 'h.example.org', tls: 'tls', sni: 's.example.org', fp: 'chrome', alpn: 'h2', scy: 'auto' });
const VMESS_TCP = vmess({ ps: 'vm-tcp', add: '8.8.4.4', port: '10086', net: 'tcp', type: 'none', tls: 'none', scy: 'none', aid: 2 });
const VMESS_GRPC = vmess({ ps: 'vm-grpc', add: '8.8.4.4', port: 2083, net: 'grpc', type: 'gun', path: 'svc', tls: 'tls', allowInsecure: true });

test('vless:解析 ws / grpc / httpupgrade 的传输参数,写不出来的传输跳过', () => {
  const pick = (link: string) => {
    const { network, security, path, host, serviceName, sni, alpn, insecure } = parseNode(link) as any;
    return { network, security, path, host, serviceName, sni, alpn, insecure };
  };
  assert.deepEqual(pick(VLESS_WS), { network: 'ws', security: 'tls', path: '/ray', host: 'h.example.org', serviceName: undefined, sni: 's.example.org', alpn: ['h2', 'http/1.1'], insecure: true });
  assert.deepEqual(pick(VLESS_GRPC), { network: 'grpc', security: 'reality', path: undefined, host: undefined, serviceName: 'svc', sni: 'a.com', alpn: [], insecure: false });
  assert.equal(pick(VLESS_HTTPUPGRADE).network, 'httpupgrade');
  for (const bad of ['type=xhttp', 'type=kcp', 'type=tcp&headerType=http']) assert.equal(parseNode(VLESS_WS_PLAIN.replace('type=ws', bad)), null, bad);
  assert.equal(parseNode(VLESS_WS.replace('security=tls', 'security=xtls')), null);
});

test('vmess:解析 base64 JSON,grpc 的服务名在 path 里,坏链接和写不出来的传输跳过', () => {
  assert.deepEqual(parseNode(VMESS_WS), {
    type: 'vmess', name: 'vm-ws', server: 'cdn.example.org', port: 443, uuid: 'vm-uuid', alterId: 0, cipher: 'auto', tls: true,
    network: 'ws', path: '/vm', host: 'h.example.org', serviceName: undefined, sni: 's.example.org', alpn: ['h2'], fingerprint: 'chrome', insecure: false,
  });
  const tcp = parseNode(VMESS_TCP) as any;
  assert.deepEqual([tcp.port, tcp.alterId, tcp.cipher, tcp.tls, tcp.network], [10086, 2, 'none', false, 'tcp']);
  const grpc = parseNode(VMESS_GRPC) as any;
  assert.deepEqual([grpc.network, grpc.serviceName, grpc.path, grpc.insecure], ['grpc', 'svc', undefined, true]);
  assert.equal(parseNode(vmess({ add: '1.1.1.1', port: 443 }))!.name, '1.1.1.1:443');
  assert.equal(parseNode('vmess://不是 base64'), null);
  assert.equal(parseNode(vmess({ add: '1.1.1.1', port: 0 })), null);
  assert.equal(parseNode(vmess({ add: '1.1.1.1', port: 443, id: '' })), null);
  assert.equal(parseNode(vmess({ add: '1.1.1.1', port: 443, net: 'kcp' })), null);
  assert.equal(parseNode(vmess({ add: '1.1.1.1', port: 443, net: 'tcp', type: 'http' })), null);
});

test('vless 传输与 vmess:sing-box 输出', () => {
  const nodes = parseNodes([VLESS_WS, VLESS_WS_PLAIN, VLESS_GRPC, VLESS_HTTPUPGRADE, VMESS_WS, VMESS_TCP, VMESS_GRPC]);
  const out = (insecure: boolean) => (buildSingbox(nodes, { legacyDns: false, insecure }).outbounds as any[]).slice(3);
  const [ws, plain, grpc, hu, vmWs, vmTcp, vmGrpc] = out(false);
  assert.deepEqual(ws, {
    type: 'vless', tag: 'ws-tls', server: 'cdn.example.org', server_port: 443, uuid: 'u-ws', packet_encoding: 'xudp',
    tls: { enabled: true, insecure: true, server_name: 's.example.org', alpn: ['h2', 'http/1.1'], utls: { enabled: true, fingerprint: 'chrome' } },
    transport: { type: 'ws', path: '/ray', headers: { Host: 'h.example.org' } },
  });
  assert.deepEqual(plain, { type: 'vless', tag: 'ws-plain', server: '5.5.5.5', server_port: 8080, uuid: 'u-plain', packet_encoding: 'xudp', transport: { type: 'ws', path: '/p' } });
  assert.deepEqual(grpc.transport, { type: 'grpc', service_name: 'svc' });
  assert.deepEqual(grpc.tls.reality, { enabled: true, public_key: 'PK', short_id: 'ef' });
  assert.deepEqual(hu.transport, { type: 'httpupgrade', path: '/up', host: 'h.example.org' });
  assert.deepEqual(vmWs, {
    type: 'vmess', tag: 'vm-ws', server: 'cdn.example.org', server_port: 443, uuid: 'vm-uuid', security: 'auto', alter_id: 0,
    tls: { enabled: true, insecure: false, server_name: 's.example.org', alpn: ['h2'], utls: { enabled: true, fingerprint: 'chrome' } },
    transport: { type: 'ws', path: '/vm', headers: { Host: 'h.example.org' } },
  });
  assert.deepEqual(vmTcp, { type: 'vmess', tag: 'vm-tcp', server: '8.8.4.4', server_port: 10086, uuid: 'vm-uuid', security: 'none', alter_id: 2 });
  assert.deepEqual([vmGrpc.tls.insecure, vmGrpc.transport], [true, { type: 'grpc', service_name: 'svc' }]);
  // 全局的跳过校验管 vmess,不管 vless(vless 只看链接自己带的)
  const [, , grpcInsecure, , vmWsInsecure] = out(true);
  assert.deepEqual([grpcInsecure.tls.insecure, vmWsInsecure.tls.insecure], [false, true]);
});

test('vless 传输与 vmess:Quantumult X、Loon 只写 tcp / ws,grpc 和 httpupgrade 跳过', () => {
  const nodes = parseNodes([VLESS_WS, VLESS_WS_PLAIN, VLESS_GRPC, VLESS_HTTPUPGRADE, VMESS_WS, VMESS_TCP, VMESS_GRPC]);
  assert.deepEqual(Buffer.from(buildQuantumultX(nodes), 'base64').toString('utf8').split('\r\n'), [
    'vless=cdn.example.org:443,method=none,password=u-ws,obfs=wss,obfs-host=h.example.org,obfs-uri=/ray,tls-verification=false,fast-open=true,tag=ws-tls',
    'vless=5.5.5.5:8080,method=none,password=u-plain,obfs=ws,obfs-host=5.5.5.5,obfs-uri=/p,fast-open=true,tag=ws-plain',
    'vmess=cdn.example.org:443,method=aes-128-gcm,password=vm-uuid,obfs=wss,obfs-host=h.example.org,obfs-uri=/vm,tls-verification=true,fast-open=false,udp-relay=false,tag=vm-ws',
    'vmess=8.8.4.4:10086,method=none,password=vm-uuid,aead=false,fast-open=false,udp-relay=false,tag=vm-tcp',
    '',
  ]);
  assert.deepEqual(buildLoon(nodes, { insecure: false }).split('\r\n'), [
    'ws-tls=VLESS,cdn.example.org,443,u-ws,alterId=0,over-tls=true,skip-cert-verify=true,sni=s.example.org,transport=ws,path=/ray,host=h.example.org',
    'ws-plain=VLESS,5.5.5.5,8080,u-plain,alterId=0,transport=ws,path=/p,host=5.5.5.5',
    'vm-ws=vmess,cdn.example.org,443,aes-128-gcm,"vm-uuid",transport=ws,path=/vm,host=h.example.org,alterId=0,over-tls=true,sni=s.example.org,skip-cert-verify=false',
    'vm-tcp=vmess,8.8.4.4,10086,none,"vm-uuid",transport=tcp,alterId=2,over-tls=false',
    '',
  ]);
});
