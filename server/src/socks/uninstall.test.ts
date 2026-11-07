import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addBinding, createCustomer } from '../customers/repo';
import { createPanel, type Panel } from '../panels/repo';
import { applyPanelSnapshot } from '../sync/service';
import { memoryDb, snap } from '../testUtil';
import { createSocks, getSocks } from './repo';
import { planSocksUninstall, uninstallSocks, uninstallStatus, type SocksPanelEditor } from './uninstall';

const SOCKS = { host: '203.0.113.9', port: 1080, username: 'u', password: 'p' };
const socksOut = (tag: string, address = SOCKS.host) => ({ tag, protocol: 'socks', settings: { servers: [{ address, port: SOCKS.port, users: [{ user: 'u', pass: 'p' }] }] } });
const direct = { tag: 'direct', protocol: 'freedom' };
const block = { tag: 'blocked', protocol: 'blackhole' };

/** 内存里的面板:删入站时 client 只解挂(和 3x-ui 一样) */
function fakePanel(inbounds: any[], clients: { email: string; ids: number[] }[], xray: any) {
  const state = { inbounds, clients, xray, restarts: 0 };
  const editor: SocksPanelEditor = {
    listInbounds: async () => state.inbounds,
    exportClients: async () => state.clients.map((c) => ({ client: { email: c.email, id: c.email }, inboundIds: c.ids })),
    xraySettings: async () => JSON.stringify({ xraySetting: JSON.stringify(state.xray), outboundTestUrl: 'https://t.example/204' }),
    deleteClient: async (email) => void (state.clients = state.clients.filter((c) => c.email !== email)),
    deleteInbound: async (id) => {
      state.inbounds = state.inbounds.filter((i) => i.id !== id);
      for (const c of state.clients) c.ids = c.ids.filter((x) => x !== id);
    },
    updateXray: async (x) => void (state.xray = x),
    restartXray: async () => void state.restarts++,
  };
  return { state, editor };
}

function setup() {
  const db = memoryDb();
  const relay = createPanel(db, { name: '中转', base_url: 'https://198.51.100.1:2053/p', token: 't', role: 'relay' }, 0);
  const other = createPanel(db, { name: '落地', base_url: 'https://198.51.100.2:2053/p', token: 't', role: 'exit' }, 0);
  const socksId = createSocks(db, { name: 'isp' }, 0, SOCKS);
  // in-s 整个走 SOCKS;in-d 直出,只有 google 和用户 z 走 SOCKS;封锁规则同时挂两个入站
  const relayPanel = fakePanel(
    [
      { id: 1, tag: 'in-s', remark: 's', protocol: 'vless', port: 1001 },
      { id: 2, tag: 'in-d', remark: 'd', protocol: 'vless', port: 1002 },
    ],
    [
      { email: 'x', ids: [1] },
      { email: 'y', ids: [1, 2] },
      { email: 'z', ids: [2] },
    ],
    {
      outbounds: [direct, socksOut('isp-out'), block],
      routing: {
        rules: [
          { type: 'field', inboundTag: ['in-s', 'in-d'], protocol: ['bittorrent'], outboundTag: 'blocked' },
          { type: 'field', inboundTag: ['in-s'], outboundTag: 'isp-out' },
          { type: 'field', inboundTag: ['in-d'], domain: ['geosite:google'], outboundTag: 'isp-out' },
          { type: 'field', user: ['z'], outboundTag: 'isp-out' },
          { type: 'field', inboundTag: ['in-s'], ip: ['geoip:cn'], outboundTag: 'blocked' },
        ],
      },
    },
  );
  const otherPanel = fakePanel([{ id: 1, tag: 'in-o', remark: 'o', protocol: 'vless', port: 2001 }], [{ email: 'o', ids: [1] }], {
    outbounds: [direct, socksOut('elsewhere', '203.0.113.10')],
    routing: { rules: [{ type: 'field', inboundTag: ['in-o'], outboundTag: 'elsewhere' }] },
  });
  const cx = createCustomer(db, { name: 'cx' });
  const cy = createCustomer(db, { name: 'cy' });
  applyPanelSnapshot(db, relay, [snap('x', 0, 0), snap('y', 0, 0), snap('z', 0, 0)], 0);
  addBinding(db, cx, relay.id, 'x', false);
  addBinding(db, cy, relay.id, 'y', false);
  const editors: Record<string, SocksPanelEditor> = { 中转: relayPanel.editor, 落地: otherPanel.editor };
  return { db, socksId, relayPanel, otherPanel, cx, cy, editorFor: (p: Panel) => editors[p.name] };
}

test('卸载 SOCKS:主去向是它的入站连同只挂在上面的 client 删掉并解绑;只分流部分流量的只删规则;删完从系统移除', async () => {
  const { db, socksId, relayPanel, otherPanel, cx, cy, editorFor } = setup();

  const plan = await planSocksUninstall(db, socksId, editorFor);
  assert.equal(plan.errors.length, 0);
  assert.equal(plan.panels.length, 1);
  const p = plan.panels[0];
  assert.equal(p.panel, '中转');
  assert.deepEqual(p.outbounds, ['isp-out']);
  assert.equal(p.rules, 3);
  assert.deepEqual(p.inbounds.map((i) => i.port), [1001]);
  assert.deepEqual(p.clients, [{ email: 'x', customer: { id: cx, name: 'cx' } }]);
  assert.equal(p.blocked, undefined);

  const res = await uninstallSocks(db, socksId, editorFor);
  assert.equal(res.removed, true, JSON.stringify(res));
  assert.equal(res.panels.length, 1);
  assert.ok(res.panels[0].ok);
  assert.equal(getSocks(db, socksId), undefined);

  const s = relayPanel.state;
  assert.deepEqual(s.inbounds.map((i) => i.tag), ['in-d']);
  assert.deepEqual(s.clients, [
    { email: 'y', ids: [2] },
    { email: 'z', ids: [2] },
  ]);
  assert.deepEqual(s.xray.outbounds.map((o: any) => o.tag), ['direct', 'blocked']);
  // 指向 SOCKS 的 3 条删掉;封锁规则去掉 in-s;只挂 in-s 的封锁规则整条删掉(不能变成对所有入站生效)
  assert.deepEqual(s.xray.routing.rules, [{ type: 'field', inboundTag: ['in-d'], protocol: ['bittorrent'], outboundTag: 'blocked' }]);
  assert.equal(s.restarts, 1);
  assert.equal(otherPanel.state.restarts, 0);

  const left = db.prepare('SELECT customer_id, email FROM bindings').all();
  assert.deepEqual(left, [{ customer_id: cy, email: 'y' }]);
  const snaps = db.prepare('SELECT COUNT(*) AS n FROM panel_snapshots').get() as { n: number };
  assert.ok(snaps.n >= 1);
});

test('卸载 SOCKS:是默认出站的面板不动;有面板没处理好或连不上就保留登记', async () => {
  const { db, socksId, relayPanel, editorFor } = setup();
  relayPanel.state.xray.outbounds = [socksOut('isp-out'), direct, block];
  const before = JSON.stringify(relayPanel.state);

  const plan = await planSocksUninstall(db, socksId, editorFor);
  assert.match(plan.panels[0].blocked ?? '', /默认出站/);
  const res = await uninstallSocks(db, socksId, editorFor);
  assert.equal(res.removed, false);
  assert.equal(res.panels[0].ok, false);
  assert.equal(JSON.stringify(relayPanel.state), before);
  assert.ok(getSocks(db, socksId));

  // 恢复成正常顺序,但另一台连不上:能改的照改,登记保留
  relayPanel.state.xray.outbounds = [direct, socksOut('isp-out'), block];
  const down = (p: Panel) => (p.name === '落地' ? { ...editorFor(p), listInbounds: () => Promise.reject(new Error('连接失败')) } : editorFor(p));
  const res2 = await uninstallSocks(db, socksId, down);
  assert.deepEqual(res2.errors, [{ panel: '落地', error: '连接失败' }]);
  assert.ok(res2.panels[0].ok);
  assert.equal(res2.removed, false);
  assert.ok(getSocks(db, socksId));
});

test('卸载 SOCKS:做完后重发的请求和查进度都拿到刚才的结果,不报「不存在」', async () => {
  const { db, socksId, relayPanel, editorFor } = setup();
  const first = await uninstallSocks(db, socksId, editorFor);
  assert.equal(first.removed, true);
  const restarts = relayPanel.state.restarts;
  assert.deepEqual(await uninstallSocks(db, socksId, editorFor), first);
  assert.equal(relayPanel.state.restarts, restarts);
  assert.deepEqual(uninstallStatus(socksId), { running: false, result: first });
  await assert.rejects(uninstallSocks(db, socksId + 100, editorFor), /SOCKS 不存在/);
});
