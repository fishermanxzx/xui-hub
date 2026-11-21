import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addLine, createCustomer, getCustomer, getLine, updateLineStats, zeroLineTraffic } from '../customers/repo';
import { createSocks } from '../socks/repo';
import { addPanel, memoryDb, vlessInbound } from '../testUtil';
import { XUIError } from '../xui/client';
import { checkAllPanels, checkPanel, type PanelProbe } from './check';
import { getPanel } from './repo';

const status = (over: Partial<{ panelVersion: string; xrayVersion: string; xrayState: string }> = {}) => ({ panelVersion: '3.0.0', xrayVersion: '25.1.1', xrayState: 'running', xrayError: '', ...over });
const timeout = async () => Promise.reject(new XUIError('连接失败:超时'));

/** 一块读得到的假面板:一个入站 + 给定的 client;closed 记关了几次连接 */
function fakeProbe(clients: any[] = [], over: Partial<PanelProbe> = {}): PanelProbe & { closed: number } {
  const p: PanelProbe & { closed: number } = {
    closed: 0,
    listInbounds: async () => [vlessInbound(1, 443)],
    listClients: async () => clients,
    serverStatus: async () => status(),
    close: async () => void p.closed++,
    ...over,
  };
  return p;
}

const client = (email: string, over: object = {}) => ({ email, enable: true, inboundIds: [1], traffic: { up: 0, down: 0 }, ...over });

test('检查面板:成功记下数量、版本和 Xray 状态并清掉上次的错误;失败只记错误,上次成功的结果留着;用完关连接', async () => {
  const db = memoryDb();
  const a = addPanel(db, 'a');

  const down = fakeProbe([], { listInbounds: timeout });
  const failed = await checkPanel(db, a, down, 100);
  assert.deepEqual([failed.checked_at, failed.check_ok_at, failed.check_error, failed.inbound_count, failed.panel_version], [100, null, '连接失败:超时', null, null]);
  assert.equal(down.closed, 1);

  const up = fakeProbe([client('x'), client('y')]);
  const ok = await checkPanel(db, a, up, 200);
  assert.deepEqual(
    [ok.checked_at, ok.check_ok_at, ok.check_error, ok.inbound_count, ok.client_count, ok.panel_version, ok.xray_version, ok.xray_state],
    [200, 200, null, 1, 2, '3.0.0', '25.1.1', 'running'],
  );
  assert.equal(up.closed, 1);
  assert.deepEqual(ok, getPanel(db, a.id));

  const again = await checkPanel(db, a, fakeProbe([], { listClients: async () => Promise.reject(new Error('boom')) }), 300);
  assert.deepEqual([again.checked_at, again.check_ok_at, again.check_error, again.client_count, again.xray_version], [300, 200, 'boom', 2, '25.1.1']);
});

test('读不到面板版本不算检查失败:沿用上次记的;读到了但 Xray 状态为空记成 unknown', async () => {
  const db = memoryDb();
  const a = addPanel(db, 'a');
  await checkPanel(db, a, fakeProbe(), 100);

  // 状态接口报错
  let p = await checkPanel(db, a, fakeProbe([], { serverStatus: timeout }), 200);
  assert.deepEqual([p.check_ok_at, p.check_error, p.panel_version, p.xray_version, p.xray_state], [200, null, '3.0.0', '25.1.1', 'running']);
  // 探针压根没有状态接口
  p = await checkPanel(db, a, fakeProbe([], { serverStatus: undefined }), 300);
  assert.deepEqual([p.check_ok_at, p.panel_version, p.xray_state], [300, '3.0.0', 'running']);
  // 读到了,但字段是空的
  p = await checkPanel(db, a, fakeProbe([], { serverStatus: async () => status({ panelVersion: '', xrayVersion: '', xrayState: '' }) }), 400);
  assert.deepEqual([p.check_ok_at, p.panel_version, p.xray_version, p.xray_state], [400, '3.0.0', '25.1.1', 'unknown']);
  // Xray 挂了
  p = await checkPanel(db, a, fakeProbe([], { serverStatus: async () => status({ xrayVersion: '25.2.0', xrayState: 'error' }) }), 500);
  assert.deepEqual([p.xray_version, p.xray_state], ['25.2.0', 'error']);
});

test('检查时同步线路:流量、启用状态、最后在线写回;面板上没了的 client 算停用、流量留着;别的面板的线路和检查失败时都不动', async () => {
  const db = memoryDb();
  const a = addPanel(db, 'a');
  const b = addPanel(db, 'b');
  const cid = createCustomer(db, { name: 'zhu' });
  const line = (panel_id: number, email: string) => addLine(db, { customer_id: cid, kind: 'direct', panel_id, inbound_id: 1, inbound_remark: 'r', protocol: 'vless', email });
  const zhu = line(a.id, 'zhu');
  const gone = line(a.id, 'gone');
  const other = line(b.id, 'zhu');
  updateLineStats(db, gone.id, { up: 7, down: 8, enable: true, last_online: 55 }, 1);

  await checkPanel(db, a, fakeProbe([client('zhu', { enable: false, traffic: { up: 5, down: 10, lastOnline: 1_700_000_000 } }), client('别人')]), 500);
  const stats = (id: number) => {
    const l = getLine(db, id)!;
    return [l.up, l.down, l.enable, l.last_online, l.synced_at];
  };
  assert.deepEqual(stats(zhu.id), [5, 10, false, 1_700_000_000_000, 500]);
  assert.deepEqual(stats(gone.id), [7, 8, false, 55, 500]);
  assert.deepEqual(stats(other.id), [0, 0, true, 0, null]);

  await checkPanel(db, a, fakeProbe([], { listClients: timeout }), 600);
  assert.deepEqual(stats(zhu.id), [5, 10, false, 1_700_000_000_000, 500]);
});

test('检查全部面板:一块连不上不影响别的,结果按名称排,连接都关掉', async () => {
  const db = memoryDb();
  for (const name of ['b', 'c', 'a']) addPanel(db, name);
  const probes: Record<string, ReturnType<typeof fakeProbe>> = {
    a: fakeProbe([client('x')]),
    b: fakeProbe([], { listInbounds: timeout }),
    c: fakeProbe(),
  };
  const out = await checkAllPanels(db, (p) => probes[p.name]);
  assert.deepEqual(out.map((p) => [p.name, p.check_error, p.client_count]), [['a', null, 1], ['b', '连接失败:超时', null], ['c', null, 0]]);
  assert.deepEqual(Object.values(probes).map((p) => p.closed), [1, 1, 1]);
});

test('同步时读面板的 Xray 路由,记下每条线路实际的出口;读不到 Xray 配置不算失败、留着上次的;面板上没有线路时不读', async () => {
  const db = memoryDb();
  const a = addPanel(db, 'a');
  let reads = 0;
  const xray = {
    outbounds: [{ tag: 'direct', protocol: 'freedom' }, { tag: 'us', protocol: 'socks', settings: { servers: [{ address: '198.51.100.9', port: 1080 }] } }],
    routing: { rules: [{ inboundTag: ['in-443'], user: ['zhang'], domain: ['geosite:netflix'], outboundTag: 'us' }] },
  };
  const probe = (over: Partial<PanelProbe> = {}) => fakeProbe([client('zhang')], { xraySettings: async () => (reads++, { xraySetting: JSON.stringify(xray) }), ...over });
  await checkPanel(db, a, probe(), 100);
  assert.equal(reads, 0);

  const sockId = createSocks(db, { name: '美国', address: '198.51.100.9:1080' });
  const id = createCustomer(db, { name: '张三' });
  const line = addLine(db, { customer_id: id, kind: 'direct', panel_id: a.id, inbound_id: 1, inbound_remark: 'v1', protocol: 'vless', email: 'zhang' });
  assert.equal(getLine(db, line.id)!.routes, null);
  await checkPanel(db, a, probe(), 200);
  assert.equal(reads, 1);
  const got = getLine(db, line.id)!;
  assert.equal(got.routes_at, 200);
  assert.deepEqual(got.routes, [
    { when: { domain: ['geosite:netflix'] }, to: { kind: 'socks', tag: 'us', address: '198.51.100.9:1080', socks_id: sockId }, fallback: false },
    { when: {}, to: { kind: 'direct', tag: 'direct' }, fallback: true },
  ]);

  const ok = await checkPanel(db, a, probe({ xraySettings: timeout }), 300);
  assert.equal(ok.check_error, null);
  assert.equal(getLine(db, line.id)!.routes_at, 200);
});

test('同步线路:面板上的计数变小了(在面板上清零、删了重建同名客户端)就把旧计数结转到客户身上;在 xui-hub 里清零之前读到的计数不写回', async () => {
  const db = memoryDb();
  const a = addPanel(db, 'a');
  const cid = createCustomer(db, { name: 'zhu' });
  const l = addLine(db, { customer_id: cid, kind: 'direct', panel_id: a.id, inbound_id: 1, inbound_remark: 'r', protocol: 'vless', email: 'zhu' });
  const usage = () => {
    const c = getCustomer(db, cid)!;
    return [c.actual_up, c.actual_down, c.carried_up, c.carried_down];
  };
  const sync = (up: number, down: number, at: number) => checkPanel(db, a, fakeProbe([client('zhu', { traffic: { up, down } })]), at);

  await sync(100, 1000, 10);
  assert.deepEqual(usage(), [100, 1000, 0, 0]);
  // 面板上清零 / 重建:计数从 0 开始,旧的 100 / 1000 结转
  await sync(3, 7, 20);
  assert.deepEqual(usage(), [103, 1007, 100, 1000]);
  await sync(5, 9, 30);
  assert.deepEqual(usage(), [105, 1009, 100, 1000]);

  // 在 xui-hub 里清零(t=45);t=40 开始的那次同步读到的是清零前的计数:不写回、不结转
  zeroLineTraffic(db, l.id, 45);
  await sync(5, 9, 40);
  assert.deepEqual([getLine(db, l.id)!.up, getLine(db, l.id)!.down], [0, 0]);
  // 清零之后开始的同步照常
  await sync(1, 2, 50);
  assert.deepEqual([getLine(db, l.id)!.up, getLine(db, l.id)!.down], [1, 2]);
  assert.deepEqual(usage().slice(2), [100, 1000]);
});
