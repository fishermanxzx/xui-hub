import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Panel } from '../panels/repo';
import { decodeJson } from '../xui/json';
import { addPanel, memoryDb } from '../testUtil';
import { createClient, emailFor, protocolOf, type ClientAdmin } from './create';

const reality = (key: string) => ({
  network: 'tcp',
  security: 'reality',
  tcpSettings: { header: { type: 'none' } },
  realitySettings: { target: 'www.example.com:443', serverNames: ['www.example.com'], privateKey: key, shortIds: ['ab'], settings: { publicKey: 'pub-' + key, fingerprint: 'chrome', spiderX: '/x' } },
});
const hy2 = {
  network: 'hysteria',
  security: 'tls',
  tlsSettings: { serverName: '', certificates: [{ certificateFile: '/root/cert/other/fullchain.pem', keyFile: '/root/cert/other/privkey.pem' }], alpn: ['h3'] },
  hysteriaSettings: { version: 2, auth: '', udpIdleTimeout: 60 },
  finalmask: { udp: [{ type: 'salamander', settings: { password: 'other-obfs' } }] },
};
const inbound = (id: number, protocol: string, port: number, stream: any, remark = `${protocol}-${port}`) => ({
  id,
  remark,
  protocol,
  port,
  enable: true,
  tag: `in-${port}`,
  settings: JSON.stringify({ clients: [], decryption: 'none' }),
  streamSettings: JSON.stringify(stream),
});

type Data = { inbounds: any[]; clients: any[]; cert?: string };

function fake(data: Record<string, Data>) {
  const adminFor = (p: Panel): ClientAdmin => {
    const d = data[p.name];
    return {
      listInbounds: async () => structuredClone(d.inbounds),
      listClients: async () => structuredClone(d.clients),
      clientLinks: async (email) => d.clients.filter((c) => c.email === email).flatMap((c) => c.inboundIds.map((id: number) => `${d.inbounds.find((i) => i.id === id)?.protocol}://${c.id}@host:${id}#${email}`)),
      addClient: async (client: any, inboundIds) => void d.clients.push({ ...client, inboundIds }),
      addInbound: async (body: any) => void d.inbounds.push({ ...structuredClone(body), id: Math.max(0, ...d.inbounds.map((i) => i.id)) + 1, tag: `in-${body.port}` }),
      deleteInbound: async (id) => void (d.inbounds = d.inbounds.filter((i) => i.id !== id)),
      panelCert: async () => ({ certFile: d.cert ?? '', keyFile: d.cert ? d.cert.replace('fullchain', 'privkey') : '' }),
    };
  };
  return adminFor;
}

test('协议与名称:只认 vless / hy2;名称去掉特殊字符,重名加后缀', () => {
  assert.equal(protocolOf(undefined), 'vless');
  assert.equal(protocolOf('hy2'), 'hysteria');
  assert.equal(protocolOf('hysteria2'), 'hysteria');
  assert.throws(() => protocolOf('vmess'), /vless 或 hy2/);
  assert.equal(emailFor(' 张 三/a ', new Set()), '张-三-a');
  assert.equal(emailFor('zhu', new Set(['zhu', 'zhu-2'])), 'zhu-3');
  assert.throws(() => emailFor('  ', new Set()), /名称/);
});

test('复用已有入站:vless 优先 reality、client 多的;建好的 client 带 vision flow,返回分享链接', async () => {
  const db = memoryDb();
  const p = addPanel(db, 'a');
  const data: Record<string, Data> = {
    a: {
      inbounds: [inbound(1, 'vless', 100, { network: 'ws', security: 'none' }), inbound(2, 'vless', 200, reality('k2')), inbound(3, 'vless', 300, reality('k3'))],
      clients: [{ email: 'zhu', id: 'u1', inboundIds: [3] }],
    },
  };
  const out = await createClient(p, fake(data)(p), { name: 'zhu', protocol: 'vless' });
  assert.deepEqual([out.email, out.protocol, out.inbound.id, out.inbound.created], ['zhu-2', 'vless', 3, false]);
  assert.deepEqual(out.links, [`vless://${data.a.clients[1].id}@host:3#zhu-2`]);
  const c = data.a.clients[1];
  assert.equal(c.flow, 'xtls-rprx-vision');
  assert.equal(c.enable, true);
  assert.equal(c.totalGB, 0);
});

test('没有入站时新建:照其他面板的 reality 入站复制并换密钥,其他面板读不到就用内置模板;探测端口失败回滚', async () => {
  const db = memoryDb();
  const a = addPanel(db, 'a', 'https://1.2.3.4:2053/p');
  const b = addPanel(db, 'b');
  const data: Record<string, Data> = {
    a: { inbounds: [], clients: [] },
    b: { inbounds: [inbound(7, 'vless', 443, reality('b-key'), 'b-reality')], clients: [] },
  };
  const adminFor = fake(data);
  const probed: [string, number][] = [];
  const out = await createClient(a, adminFor(a), { name: 'li', protocol: 'vless' }, { otherPanels: [a, b], adminFor, probe: async (h, port) => (probed.push([h, port]), true) });
  assert.equal(out.inbound.created, true);
  assert.equal(out.inbound.remark, 'vless-reality');
  const created = data.a.inbounds[0];
  const stream = decodeJson(created.streamSettings);
  assert.equal(stream.realitySettings.serverNames[0], 'www.example.com', '伪装设置照抄');
  assert.notEqual(stream.realitySettings.privateKey, 'b-key', '密钥换新');
  assert.equal(stream.realitySettings.shortIds.length, 8);
  assert.deepEqual(decodeJson(created.settings).clients, []);
  assert.ok(created.port >= 20000 && created.port < 60000);
  assert.deepEqual(probed, [['1.2.3.4', created.port]]);
  assert.equal(data.a.clients.length, 1);

  // 没有其他面板:内置模板
  const c = addPanel(db, 'c');
  data.c = { inbounds: [], clients: [] };
  const builtin = await createClient(c, adminFor(c), { name: 'w' }, { otherPanels: [c], adminFor });
  assert.equal(builtin.inbound.created, true);
  assert.equal(decodeJson(data.c.inbounds[0].streamSettings).realitySettings.serverNames[0], 'www.microsoft.com');

  // 端口探测失败:删掉刚建的入站并报错
  const d = addPanel(db, 'd');
  data.d = { inbounds: [], clients: [] };
  await assert.rejects(createClient(d, adminFor(d), { name: 'w' }, { otherPanels: [d], adminFor, probe: async () => false }), /连不上/);
  assert.equal(data.d.inbounds.length, 0);
  assert.equal(data.d.clients.length, 0);
});

test('hy2:照其他面板的 hy2 入站建,证书换成本面板的、混淆密码重新生成;没证书或没模板时报错', async () => {
  const db = memoryDb();
  const a = addPanel(db, 'a', 'https://a.example.com:2053/p');
  const b = addPanel(db, 'b');
  const data: Record<string, Data> = {
    a: { inbounds: [], clients: [], cert: '/root/cert/a/fullchain.pem' },
    b: { inbounds: [inbound(7, 'hysteria', 443, hy2, 'b-hy2')], clients: [] },
  };
  const adminFor = fake(data);
  const out = await createClient(a, adminFor(a), { name: 'li', protocol: 'hy2' }, { otherPanels: [a, b], adminFor });
  assert.deepEqual([out.protocol, out.inbound.created, out.inbound.remark], ['hysteria', true, 'hy2']);
  const stream = decodeJson(data.a.inbounds[0].streamSettings);
  assert.equal(stream.tlsSettings.serverName, 'a.example.com');
  assert.equal(stream.tlsSettings.certificates[0].certificateFile, '/root/cert/a/fullchain.pem');
  assert.equal(stream.tlsSettings.certificates[0].keyFile, '/root/cert/a/privkey.pem');
  assert.notEqual(stream.finalmask.udp[0].settings.password, 'other-obfs');
  assert.equal(data.a.clients[0].flow, '');
  // 第二个 hy2 客户端复用刚建的入站
  const again = await createClient(a, adminFor(a), { name: 'li', protocol: 'hy2' }, { otherPanels: [a, b], adminFor });
  assert.deepEqual([again.email, again.inbound.created], ['li-2', false]);

  const noCert = addPanel(db, 'nocert');
  data.nocert = { inbounds: [], clients: [] };
  await assert.rejects(createClient(noCert, adminFor(noCert), { name: 'x', protocol: 'hy2' }, { otherPanels: [noCert, b], adminFor }), /证书/);
  await assert.rejects(createClient(noCert, adminFor(noCert), { name: 'x', protocol: 'hy2' }, { otherPanels: [noCert], adminFor }), /没有 hy2 入站/);
});
