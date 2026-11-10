import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCustomer, getCustomer, linesOf } from '../customers/repo';
import { createSocks, parseSocksAddress } from '../socks/repo';
import { decodeJson } from '../xui/json';
import { addPanel, fakePanels, memoryDb, reality, relayXray, vlessInbound, type FakePanel } from '../testUtil';
import { XUIError } from '../xui/client';
import { openLine, removeLine, removeLines, repointSocksLines } from './open';

test('直连:在面板上挂已有入站或新建入站,建 client 并记录线路;删线路删掉 client', async () => {
  const db = memoryDb();
  const a = addPanel(db, 'a', 'https://1.1.1.1:2053/p');
  const data: Record<string, FakePanel> = { a: { inbounds: [{ id: 7, remark: 'r', protocol: 'vless', port: 443, enable: true, tag: 'in-443', streamSettings: reality }], clients: [], xray: {}, restarts: 0 } };
  const adminFor = fakePanels(data);
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

test('中转:落地上新建 socks 入站,中转上复用 / 新建入站并按客户端路由,再建 client;出口也可以是 SOCKS;删线路去掉规则', async () => {
  const db = memoryDb();
  const relay = addPanel(db, 'relay', 'https://1.1.1.1:2053/p');
  const landing = addPanel(db, 'landing', 'https://2.2.2.2:2053/p');
  const data: Record<string, FakePanel> = {
    relay: {
      // 中转上已有一个 reality 入站,上面有一个直连客户端 direct-guy:中转客户端挂上同一个入站,各走各的出口
      inbounds: [{ id: 5, remark: 'existing', protocol: 'vless', port: 500, enable: true, tag: 'in-500', streamSettings: reality }],
      clients: [{ email: 'direct-guy', id: 'dg', inboundIds: [5] }],
      xray: { outbounds: [{ tag: 'direct', protocol: 'freedom' }], routing: { rules: [{ type: 'field', outboundTag: 'direct' }] } },
      restarts: 0,
    },
    landing: { inbounds: [{ id: 1, remark: 'vr', protocol: 'vless', port: 443, enable: true, tag: 'in-443', streamSettings: reality }], clients: [], xray: {}, restarts: 0 },
  };
  const adminFor = fakePanels(data);
  const cid = createCustomer(db, { name: 'li' });
  const out = await openLine(db, cid, { kind: 'relay', panel_id: relay.id, inbound: { protocol: 'vless' }, exit: { kind: 'panel', panel_id: landing.id } }, adminFor);
  assert.deepEqual([out.line.kind, out.line.panel_name, out.line.exit_kind, out.line.exit_panel_name, out.created.inbound, out.created.exit_inbound], ['relay', 'relay', 'panel', 'landing', null, 'relay-socks']);
  assert.equal(data.relay.inbounds.length, 1, '复用了已有的 reality 入站');
  assert.equal(out.line.inbound_id, 5);
  const mixed = data.landing.inbounds[1];
  assert.equal(mixed.protocol, 'mixed');
  assert.equal(out.line.exit_port, Number(mixed.port));
  // 中转的 Xray:多了指向落地 socks 入站的出站,规则只管 li 这个客户端、在兜底规则前面,重启过一次
  const acc = decodeJson(mixed.settings).accounts[0];
  const outs = data.relay.xray.outbounds;
  assert.deepEqual(outs[1].settings.servers[0], { address: '2.2.2.2', port: Number(mixed.port), users: [{ user: acc.user, pass: acc.pass }] });
  assert.deepEqual(data.relay.xray.routing.rules.map((r: any) => [r.inboundTag ?? null, r.user ?? null, r.outboundTag]), [[['in-500'], ['li'], outs[1].tag], [null, null, 'direct']]);
  assert.equal(data.relay.restarts, 1);
  assert.equal(data.relay.clients[1].email, 'li');
  assert.match(out.links[0], /^vless:\/\/.+@1\.1\.1\.1#li$/);

  // 第二位客户用 SOCKS 出口,同一个入站:多一条 wang 的规则,li 的不动
  const sid = createSocks(db, { name: 'isp', address: 'socks5://u:p@isp.example.com:1080' });
  const c2 = createCustomer(db, { name: 'wang' });
  const two = await openLine(db, c2, { kind: 'relay', panel_id: relay.id, inbound: { id: 5 }, exit: { kind: 'socks', socks_id: sid } }, adminFor);
  assert.deepEqual([two.line.exit_kind, two.line.exit_socks_name, two.line.exit_label, two.created], ['socks', 'isp', 'SOCKS isp', { inbound: null, exit_inbound: null }]);
  assert.equal(data.relay.xray.outbounds.length, 3);
  // 新规则插在兜底规则前,所以在 li 之后
  assert.deepEqual(data.relay.xray.routing.rules.map((r: any) => [r.user ?? null, r.outboundTag]), [[['li'], outs[1].tag], [['wang'], 'socks-isp.example.com-1080'], [null, 'direct']]);
  assert.equal(data.relay.restarts, 2);
  assert.equal(linesOf(db, c2).length, 1);

  // 删掉 li 的线路:client 没了,他的规则和没人用了的出站没了,wang 的还在;入站不动
  await removeLine(db, out.line, adminFor);
  assert.equal(data.relay.clients.some((c) => c.email === 'li'), false);
  assert.deepEqual(data.relay.xray.routing.rules.map((r: any) => r.user ?? null), [['wang'], null]);
  assert.deepEqual(data.relay.xray.outbounds.map((o: any) => o.tag), ['direct', 'socks-isp.example.com-1080']);
  assert.equal(data.relay.restarts, 3);
  assert.equal(data.landing.inbounds.length, 2);
  // 再删一遍:面板上什么都不用改,不重启
  await removeLine(db, out.line, adminFor);
  assert.equal(data.relay.restarts, 3);

  await assert.rejects(openLine(db, cid, { kind: 'relay', panel_id: relay.id, inbound: { protocol: 'vless' } }, adminFor), /出口/);
});

test('中转:第二条线路接着用落地上的 relay-socks 和中转上的出站;同时开的两条排队执行,规则都在', async () => {
  const db = memoryDb();
  const relay = addPanel(db, 'relay', 'https://1.1.1.1:2053/p');
  const landing = addPanel(db, 'landing', 'https://2.2.2.2:2053/p');
  const data: Record<string, FakePanel> = {
    relay: { inbounds: [vlessInbound(5, 500)], clients: [], xray: relayXray(), restarts: 0, slow: 5 },
    landing: { inbounds: [vlessInbound(1, 443)], clients: [], xray: {}, restarts: 0 },
  };
  const adminFor = fakePanels(data);
  const input = { kind: 'relay', panel_id: relay.id, inbound: { id: 5 }, exit: { kind: 'panel', panel_id: landing.id } };
  const [a, b] = await Promise.all([
    openLine(db, createCustomer(db, { name: 'li' }), input, adminFor),
    openLine(db, createCustomer(db, { name: 'wang' }), input, adminFor),
  ]);
  assert.deepEqual([a.created.exit_inbound, b.created.exit_inbound], ['relay-socks', null]);
  assert.equal(data.landing.inbounds.length, 2, '落地上只建了一个 socks 入站');
  assert.equal(data.relay.xray.outbounds.length, 2, '两条线路共用一个出站');
  assert.deepEqual(data.relay.xray.routing.rules.map((r: any) => r.user ?? null), [['li'], ['wang'], null]);
  assert.deepEqual([a.line.exit_port, data.relay.clients.length], [b.line.exit_port, 2]);
});

test('开线路中途失败:撤掉这次建的 client、规则、出站和入站,不留记录', async () => {
  const db = memoryDb();
  const relay = addPanel(db, 'relay', 'https://1.1.1.1:2053/p');
  const landing = addPanel(db, 'landing', 'https://2.2.2.2:2053/p');
  const data: Record<string, FakePanel> = {
    relay: { inbounds: [], clients: [], xray: relayXray(), restarts: 0, fail: { clientLinks: '面板报错' } },
    landing: { inbounds: [vlessInbound(1, 443)], clients: [], xray: {}, restarts: 0 },
  };
  const adminFor = fakePanels(data);
  const cid = createCustomer(db, { name: 'li' });
  const input = { kind: 'relay', panel_id: relay.id, inbound: { protocol: 'vless' }, exit: { kind: 'panel', panel_id: landing.id } };
  // client 已经建上了,取链接时才报错
  await assert.rejects(openLine(db, cid, input, adminFor), /面板报错/);
  assert.deepEqual([data.relay.clients, data.relay.inbounds, data.relay.xray, data.landing.inbounds.length], [[], [], relayXray(), 1]);
  assert.equal(data.relay.restarts, 2, '加规则、撤规则各重启一次');
  assert.equal(linesOf(db, cid).length, 0);
  // 用已有的入站时,撤的时候不删它
  data.relay.inbounds = [vlessInbound(5, 500)];
  data.landing.inbounds.push({ id: 2, remark: 'relay-socks', protocol: 'mixed', port: 3000, enable: true, settings: { accounts: [{ user: 'a', pass: 'b' }] } });
  await assert.rejects(openLine(db, cid, input, adminFor), /面板报错/);
  assert.deepEqual([data.relay.inbounds.length, data.landing.inbounds.length, data.relay.xray], [1, 2, relayXray()]);
  // 面板好了以后重开:正常,email 还是原来那个
  data.relay.fail = {};
  const ok = await openLine(db, cid, input, adminFor);
  assert.deepEqual([ok.line.email, ok.created], ['li', { inbound: null, exit_inbound: null }]);
});

test('中转选的入站没有 tag:直接拒绝,落地上什么都不建', async () => {
  const db = memoryDb();
  const relay = addPanel(db, 'relay', 'https://1.1.1.1:2053/p');
  const landing = addPanel(db, 'landing', 'https://2.2.2.2:2053/p');
  const data: Record<string, FakePanel> = {
    relay: { inbounds: [{ ...vlessInbound(5, 500), tag: '' }], clients: [], xray: relayXray(), restarts: 0 },
    landing: { inbounds: [], clients: [], xray: {}, restarts: 0 },
  };
  const cid = createCustomer(db, { name: 'li' });
  await assert.rejects(openLine(db, cid, { kind: 'relay', panel_id: relay.id, inbound: { id: 5 }, exit: { kind: 'panel', panel_id: landing.id } }, fakePanels(data)), /没有 tag/);
  assert.deepEqual([data.landing.inbounds.length, data.relay.clients.length, data.relay.restarts], [0, 0, 0]);
});

test('面板上的 client 被人删了、本地线路还在:再开线路时 email 避开它', async () => {
  const db = memoryDb();
  const a = addPanel(db, 'a', 'https://1.1.1.1:2053/p');
  const data: Record<string, FakePanel> = { a: { inbounds: [vlessInbound(7, 443)], clients: [], xray: {}, restarts: 0 } };
  const cid = createCustomer(db, { name: 'li' });
  const input = { kind: 'direct', panel_id: a.id, inbound: { id: 7 } };
  await openLine(db, cid, input, fakePanels(data));
  data.a.clients = [];
  const again = await openLine(db, cid, input, fakePanels(data));
  assert.equal(again.line.email, 'li-2');
  assert.deepEqual(linesOf(db, cid).map((l) => l.email), ['li', 'li-2']);
});

test('removeLines:同一块面板上的一起删、Xray 只重启一次;某块面板失败不影响别的,原因带回来', async () => {
  const db = memoryDb();
  const relay = addPanel(db, 'relay', 'https://1.1.1.1:2053/p');
  const a = addPanel(db, 'a', 'https://3.3.3.3:2053/p');
  const sid = createSocks(db, { name: 'isp', address: 'socks5://u:p@isp.example.com:1080' });
  const data: Record<string, FakePanel> = {
    relay: { inbounds: [vlessInbound(5, 500)], clients: [{ email: 'keep', id: 'k', inboundIds: [5] }], xray: relayXray(), restarts: 0 },
    a: { inbounds: [vlessInbound(7, 443)], clients: [], xray: {}, restarts: 0 },
  };
  const adminFor = fakePanels(data);
  const cid = createCustomer(db, { name: 'li' });
  const relayInput = { kind: 'relay', panel_id: relay.id, inbound: { id: 5 }, exit: { kind: 'socks', socks_id: sid } };
  await openLine(db, cid, relayInput, adminFor);
  await openLine(db, cid, relayInput, adminFor);
  await openLine(db, cid, { kind: 'direct', panel_id: a.id, inbound: { id: 7 } }, adminFor);
  assert.equal(data.relay.restarts, 2);

  data.a.fail = { deleteClient: '面板连不上' };
  const lines = linesOf(db, cid);
  const failed = await removeLines(db, lines, adminFor);
  assert.deepEqual(failed.map((f) => [f.line.panel_name, f.line.email, (f.error as Error).message]), [['a', 'li', '面板连不上']]);
  assert.deepEqual(data.relay.clients.map((c) => c.email), ['keep']);
  assert.deepEqual(data.relay.xray, relayXray());
  assert.equal(data.relay.restarts, 3);
  await assert.rejects(removeLine(db, lines[2], adminFor), /面板连不上/);
});

test('SOCKS 换地址:走它的线路在各中转上改指到新出站、每块面板只重启一次;有面板没改成就报错,重试时改好的不再重启', async () => {
  const db = memoryDb();
  const r1 = addPanel(db, 'r1', 'https://1.1.1.1:2053/p');
  const r2 = addPanel(db, 'r2', 'https://2.2.2.2:2053/p');
  const isp = createSocks(db, { name: 'isp', address: 'socks5://u:p@isp.example.com:1080' });
  const other = createSocks(db, { name: 'other', address: 'other.example.com:1080' });
  const idle = createSocks(db, { name: 'idle', address: 'idle.example.com:1080' });
  const data: Record<string, FakePanel> = {
    r1: { inbounds: [vlessInbound(5, 500)], clients: [], xray: relayXray(), restarts: 0 },
    r2: { inbounds: [vlessInbound(6, 600)], clients: [], xray: relayXray(), restarts: 0 },
  };
  const adminFor = fakePanels(data);
  const li = createCustomer(db, { name: 'li' });
  const wang = createCustomer(db, { name: 'wang' });
  const via = (panel_id: number, inboundId: number, socks_id: number) => ({ kind: 'relay', panel_id, inbound: { id: inboundId }, exit: { kind: 'socks', socks_id } });
  await openLine(db, li, via(r1.id, 5, isp), adminFor);
  await openLine(db, wang, via(r1.id, 5, isp), adminFor);
  await openLine(db, wang, via(r1.id, 5, other), adminFor);
  await openLine(db, li, via(r2.id, 6, isp), adminFor);
  assert.deepEqual([data.r1.restarts, data.r2.restarts], [3, 1]);
  const rules = (name: string) => data[name].xray.routing.rules.map((r: any) => [r.user?.[0] ?? null, r.outboundTag]);
  const tags = (name: string) => data[name].xray.outbounds.map((o: any) => o.tag);

  // 没有线路在用的 SOCKS:什么都不动
  await repointSocksLines(db, idle, parseSocksAddress('idle2.example.com:1080'), adminFor);
  assert.deepEqual([data.r1.restarts, data.r2.restarts], [3, 1]);

  await repointSocksLines(db, isp, parseSocksAddress('socks5://u2:p2@new.example.com:2080'), adminFor);
  // 旧出站没人用了删掉,走别的 SOCKS 的 wang-2 不动
  assert.deepEqual(tags('r1'), ['direct', 'socks-other.example.com-1080', 'socks-new.example.com-2080']);
  assert.deepEqual(rules('r1'), [['wang-2', 'socks-other.example.com-1080'], ['li', 'socks-new.example.com-2080'], ['wang', 'socks-new.example.com-2080'], [null, 'direct']]);
  assert.deepEqual(data.r1.xray.outbounds[2].settings.servers[0], { address: 'new.example.com', port: 2080, users: [{ user: 'u2', pass: 'p2' }] });
  assert.deepEqual([tags('r2'), rules('r2')], [['direct', 'socks-new.example.com-2080'], [['li', 'socks-new.example.com-2080'], [null, 'direct']]]);
  assert.deepEqual([data.r1.restarts, data.r2.restarts], [4, 2]);

  // r2 写不进去:报错里点名 r2;r1 已经改好,r2 还是原样
  data.r2.fail = { updateXray: '面板报错' };
  const third = parseSocksAddress('third.example.com:3080');
  await assert.rejects(repointSocksLines(db, isp, third, adminFor), (e: unknown) => e instanceof XUIError && /r2\(面板报错\)/.test(e.message) && /没有保存/.test(e.message) && !e.message.includes('r1'));
  assert.deepEqual([tags('r1').at(-1), tags('r2').at(-1)], ['socks-third.example.com-3080', 'socks-new.example.com-2080']);
  assert.deepEqual([data.r1.restarts, data.r2.restarts], [5, 2]);
  // 面板好了再来一次:r1 不用再改也不重启,r2 补上
  data.r2.fail = {};
  await repointSocksLines(db, isp, third, adminFor);
  assert.deepEqual([tags('r2'), rules('r2')], [['direct', 'socks-third.example.com-3080'], [['li', 'socks-third.example.com-3080'], [null, 'direct']]]);
  assert.deepEqual([data.r1.restarts, data.r2.restarts], [5, 3]);
});
