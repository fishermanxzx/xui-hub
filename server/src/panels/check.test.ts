import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addLine, createCustomer, getLine, updateLineStats } from '../customers/repo';
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
