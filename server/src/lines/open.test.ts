import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCustomer, getCustomer, linesOf } from '../customers/repo';
import type { Panel } from '../panels/repo';
import { createSocks } from '../socks/repo';
import { decodeJson } from '../xui/json';
import { addPanel, memoryDb } from '../testUtil';
import { openLine, removeLine, type LineAdmin } from './open';

const reality = { network: 'tcp', security: 'reality', realitySettings: { target: 'x:443', serverNames: ['x'], privateKey: 'k', shortIds: ['ab'], settings: { publicKey: 'pub' } } };
type Data = { inbounds: any[]; clients: any[]; xray: any; cert?: string; restarts: number };

function fake(data: Record<string, Data>) {
  return (p: Panel): LineAdmin => {
    const d = data[p.name];
    return {
      listInbounds: async () => structuredClone(d.inbounds),
      listClients: async () => structuredClone(d.clients),
      clientLinks: async (email) => d.clients.filter((c) => c.email === email).map((c) => `vless://${c.id}@${new URL(p.base_url).hostname}#${email}`),
      addClient: async (client: any, inboundIds) => void d.clients.push({ ...client, inboundIds }),
      deleteClient: async (email) => void (d.clients = d.clients.filter((c) => c.email !== email)),
      addInbound: async (body: any) => void d.inbounds.push({ ...structuredClone(body), id: d.inbounds.length + 1, tag: `in-${body.port}` }),
      deleteInbound: async (id) => void (d.inbounds = d.inbounds.filter((i) => i.id !== id)),
      panelCert: async () => ({ certFile: d.cert ?? '', keyFile: d.cert ?? '' }),
      xraySettings: async () => ({ xraySetting: JSON.stringify(d.xray) }),
      updateXray: async (x: any) => void (d.xray = structuredClone(x)),
      restartXray: async () => void d.restarts++,
    };
  };
}

test('直连:在面板上挂已有入站或新建入站,建 client 并记录线路;删线路删掉 client', async () => {
  const db = memoryDb();
  const a = addPanel(db, 'a', 'https://1.1.1.1:2053/p');
  const data: Record<string, Data> = { a: { inbounds: [{ id: 7, remark: 'r', protocol: 'vless', port: 443, enable: true, tag: 'in-443', streamSettings: reality }], clients: [], xray: {}, restarts: 0 } };
  const adminFor = fake(data);
  const cid = createCustomer(db, { name: '张三' });
  const out = await openLine(db, cid, { kind: 'direct', panel_id: a.id, inbound: { id: 7 } }, adminFor);
  assert.deepEqual([out.line.kind, out.line.panel_name, out.line.inbound_id, out.line.email, out.line.exit_kind, out.created], ['direct', 'a', 7, '张三', null, { inbound: null, exit_inbound: null }]);
  assert.deepEqual(out.links, [`vless://${data.a.clients[0].id}@1.1.1.1#张三`]);
  // 第二条:新建 hy2 入站(有证书)
  data.a.cert = '/root/cert/a.pem';
  const hy2 = await openLine(db, cid, { kind: 'direct', panel_id: a.id, inbound: { protocol: 'hy2' } }, adminFor);
  assert.deepEqual([hy2.line.protocol, hy2.line.email, hy2.created.inbound], ['hysteria', '张三-2', 'hy2']);
  assert.equal(getCustomer(db, cid)!.lines.length, 2);
  await assert.rejects(openLine(db, cid, { kind: 'direct', panel_id: a.id, inbound: { id: 99 } }, adminFor), /没有这个入站/);
  await assert.rejects(openLine(db, cid, { kind: 'x', panel_id: a.id }, adminFor), /线路类型/);

  await removeLine(db, out.line, adminFor);
  assert.equal(data.a.clients.some((c) => c.email === '张三'), false);
  await removeLine(db, out.line, adminFor); // 面板上已经没有也不报错
});

test('中转:落地上新建 socks 入站,中转上新建入站并路由到它,再建 client;出口也可以是 SOCKS', async () => {
  const db = memoryDb();
  const relay = addPanel(db, 'relay', 'https://1.1.1.1:2053/p');
  const landing = addPanel(db, 'landing', 'https://2.2.2.2:2053/p');
  const data: Record<string, Data> = {
    relay: {
      // 中转上已有一个 reality 入站:选「新建入站」时不能复用它(否则它上面的客户端会跟着改出口)
      inbounds: [{ id: 5, remark: 'existing', protocol: 'vless', port: 500, enable: true, tag: 'in-500', streamSettings: reality }],
      clients: [],
      xray: { outbounds: [{ tag: 'direct', protocol: 'freedom' }], routing: { rules: [{ type: 'field', outboundTag: 'direct' }] } },
      restarts: 0,
    },
    landing: { inbounds: [{ id: 1, remark: 'vr', protocol: 'vless', port: 443, enable: true, tag: 'in-443', streamSettings: reality }], clients: [], xray: {}, restarts: 0 },
  };
  const adminFor = fake(data);
  const cid = createCustomer(db, { name: 'li' });
  const out = await openLine(db, cid, { kind: 'relay', panel_id: relay.id, inbound: { protocol: 'vless' }, exit: { kind: 'panel', panel_id: landing.id } }, adminFor);
  assert.deepEqual([out.line.kind, out.line.panel_name, out.line.exit_kind, out.line.exit_panel_name, out.created.inbound, out.created.exit_inbound], ['relay', 'relay', 'panel', 'landing', 'vless-reality', 'relay-socks']);
  assert.equal(data.relay.inbounds.length, 2, '新建了入站而不是复用 existing');
  assert.equal(out.line.inbound_id, data.relay.inbounds[1].id);
  const mixed = data.landing.inbounds[1];
  assert.equal(mixed.protocol, 'mixed');
  assert.equal(out.line.exit_port, Number(mixed.port));
  // 中转的 Xray:多了指向落地 socks 入站的出站,规则在兜底规则前面,重启过一次
  const acc = decodeJson(mixed.settings).accounts[0];
  const outs = data.relay.xray.outbounds;
  assert.deepEqual(outs[1].settings.servers[0], { address: '2.2.2.2', port: Number(mixed.port), users: [{ user: acc.user, pass: acc.pass }] });
  assert.deepEqual(data.relay.xray.routing.rules.map((r: any) => [r.inboundTag ?? null, r.outboundTag]), [[[`in-${data.relay.inbounds[1].port}`], outs[1].tag], [null, 'direct']]);
  assert.equal(data.relay.restarts, 1);
  assert.equal(data.relay.clients[0].email, 'li');
  assert.match(out.links[0], /^vless:\/\/.+@1\.1\.1\.1#li$/);

  // 第二位客户用 SOCKS 出口,复用中转上已有的 vless 入站(同一入站共用出口:规则被换成新出口)
  const sid = createSocks(db, { name: 'isp', address: 'socks5://u:p@isp.example.com:1080' });
  const c2 = createCustomer(db, { name: 'wang' });
  const two = await openLine(db, c2, { kind: 'relay', panel_id: relay.id, inbound: { id: data.relay.inbounds[1].id }, exit: { kind: 'socks', socks_id: sid } }, adminFor);
  assert.deepEqual([two.line.exit_kind, two.line.exit_socks_name, two.line.exit_label, two.created], ['socks', 'isp', 'SOCKS isp', { inbound: null, exit_inbound: null }]);
  assert.equal(data.relay.xray.outbounds.length, 3);
  assert.deepEqual(data.relay.xray.routing.rules[0], { type: 'field', inboundTag: [`in-${data.relay.inbounds[1].port}`], outboundTag: 'socks-isp.example.com-1080' });
  assert.equal(data.relay.restarts, 2);
  assert.equal(linesOf(db, c2).length, 1);

  await assert.rejects(openLine(db, cid, { kind: 'relay', panel_id: relay.id, inbound: { protocol: 'vless' } }, adminFor), /出口/);
});
