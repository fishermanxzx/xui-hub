import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyPanelSnapshot } from '../sync/service';
import { addPanel, memoryDb, snap } from '../testUtil';
import { enforceCustomers } from './enforce';
import { deleteLines, lineOpForChange, operateLines, type ClientRemover, type PanelWriter } from './panelOps';
import { addBinding, createCustomer, updateCustomer } from './repo';

interface FakeClient {
  email: string;
  enable: boolean;
  expiryTime: number;
  totalGB: number;
  traffic: { up: number; down: number; enable: boolean };
}

/** 模拟 3x-ui:resetTraffic 只清流量,不动启用状态;update 同时改两处 enable */
function fakePanel(clients: FakeClient[], opts: { brokenReset?: boolean; failSecondList?: boolean } = {}) {
  const calls: string[] = [];
  let lists = 0;
  const writer: PanelWriter = {
    async listClients() {
      if (++lists === 2 && opts.failSecondList) throw new Error('连接失败');
      return structuredClone(clients);
    },
    async exportClients() {
      calls.push('export');
      return clients.map((c) => ({
        client: { id: 'uuid-' + c.email, email: c.email, enable: c.enable, expiryTime: c.expiryTime, totalGB: c.totalGB, flow: 'xtls-rprx-vision' },
        inboundIds: [1],
      }));
    },
    async resetClientTraffic(email: string) {
      calls.push('reset ' + email);
      const c = clients.find((x) => x.email === email)!;
      if (!opts.brokenReset) Object.assign(c.traffic, { up: 0, down: 0 });
    },
    async updateClient(email: string, body: any) {
      calls.push('update ' + email + ' ' + JSON.stringify(body));
      const c = clients.find((x) => x.email === email)!;
      c.enable = c.traffic.enable = body.enable;
      c.expiryTime = body.expiryTime;
      c.totalGB = body.totalGB;
    },
  };
  return { writer, calls, clients };
}

const client = (email: string, used: number, extra: Partial<FakeClient> = {}): FakeClient => ({
  email,
  enable: true,
  expiryTime: 0,
  totalGB: 0,
  traffic: { up: used, down: used, enable: true },
  ...extra,
});

function setup() {
  const db = memoryDb();
  const a = addPanel(db, 'a');
  const b = addPanel(db, 'b');
  applyPanelSnapshot(db, a, [snap('u1', 5, 5), snap('u2', 9, 9), snap('gone', 1, 1)], 0);
  applyPanelSnapshot(db, b, [snap('v1', 3, 3)], 0);
  const id = createCustomer(db, { name: 'c' });
  for (const [p, e] of [[a, 'u1'], [a, 'u2'], [a, 'gone'], [b, 'v1']] as const) addBinding(db, id, p.id, e, false);
  return { db, a, b, id };
}

test('清零并启用:各线路面板流量清零,停用的重新启用,面板上残留的到期 / 额度清掉,暂停的面板不动', async () => {
  const { db, b, id } = setup();
  db.prepare('UPDATE panels SET enabled = 0 WHERE id = ?').run(b.id);
  const fa = fakePanel([client('u1', 5, { totalGB: 100 }), client('u2', 9, { expiryTime: 50, traffic: { up: 9, down: 9, enable: false } }), client('u3', 1)]);
  db.prepare("UPDATE bindings SET email = 'u3' WHERE email = 'gone'").run();
  const results = await operateLines(db, id, { resetTraffic: true, enable: true }, (p) => (p.name === 'a' ? fa.writer : assert.fail('暂停的面板不该连接')));

  assert.deepEqual(results, [
    { panel: 'a', email: 'u1', ok: true, actions: ['流量清零', '去掉面板限制'] },
    { panel: 'a', email: 'u2', ok: true, actions: ['流量清零', '启用', '去掉面板限制'] },
    { panel: 'a', email: 'u3', ok: true, actions: ['流量清零'] },
    { panel: 'b', email: 'v1', ok: false, actions: [], error: '面板已暂停,未处理' },
  ]);
  assert.deepEqual(fa.calls, [
    'reset u1',
    'export',
    // 以导出的完整配置为底,只改需要改的字段(flow 等保留)
    'update u1 {"id":"uuid-u1","email":"u1","enable":true,"expiryTime":0,"totalGB":0,"flow":"xtls-rprx-vision"}',
    'reset u2',
    'update u2 {"id":"uuid-u2","email":"u2","enable":true,"expiryTime":0,"totalGB":0,"flow":"xtls-rprx-vision"}',
    'reset u3',
  ]);
  assert.deepEqual(
    db.prepare("SELECT email, enable, expiry_ms, total_bytes FROM client_counters WHERE email IN ('u1', 'u2') ORDER BY email").all(),
    [
      { email: 'u1', enable: 1, expiry_ms: 0, total_bytes: 0 },
      { email: 'u2', enable: 1, expiry_ms: 0, total_bytes: 0 },
    ],
  );
});

test('停用:只改启用着的线路,面板限制不动,本地记录同步更新', async () => {
  const { db, id } = setup();
  db.prepare("DELETE FROM bindings WHERE email IN ('gone', 'v1')").run();
  const fa = fakePanel([client('u1', 5, { expiryTime: 777 }), client('u2', 9, { enable: false, expiryTime: 1 })]);
  const results = await operateLines(db, id, { enable: false }, () => fa.writer);

  assert.deepEqual(results, [
    { panel: 'a', email: 'u1', ok: true, actions: ['停用'] },
    { panel: 'a', email: 'u2', ok: true, actions: [] },
  ]);
  assert.deepEqual(fa.calls.filter((c) => c.startsWith('update')).length, 1);
  assert.deepEqual(
    db.prepare("SELECT email, enable, expiry_ms FROM client_counters WHERE email IN ('u1', 'u2') ORDER BY email").all(),
    [
      { email: 'u1', enable: 0, expiry_ms: 777 },
      { email: 'u2', enable: 0, expiry_ms: 1 },
    ],
  );
});

test('面板上的限制没清掉时如实报告', async () => {
  const { db, id } = setup();
  db.prepare("DELETE FROM bindings WHERE email IN ('gone', 'v1', 'u2')").run();
  const fa = fakePanel([client('u1', 5, { expiryTime: 9 })]);
  const stuck = { ...fa.writer, updateClient: async () => {} };
  const results = await operateLines(db, id, { enable: true }, () => stuck);
  assert.deepEqual(results.map((r) => [r.ok, r.error]), [[false, '面板上的到期日 / 流量上限没有清掉']]);
});

test('面板没有真的改成功、读回失败都如实报告', async () => {
  const { db, id } = setup();
  db.prepare("DELETE FROM bindings WHERE email IN ('gone', 'v1')").run();

  const broken = fakePanel([client('u1', 5), client('u2', 9)], { brokenReset: true });
  assert.deepEqual(
    (await operateLines(db, id, { resetTraffic: true }, () => broken.writer)).map((r) => r.error),
    ['面板流量没有清零', '面板流量没有清零'],
  );

  const flaky = fakePanel([client('u1', 5), client('u2', 9)], { failSecondList: true });
  const results = await operateLines(db, id, { resetTraffic: true }, () => flaky.writer);
  assert.deepEqual(
    results.map((r) => [r.ok, r.error]),
    [
      [true, '已执行,读回核对失败:连接失败'],
      [true, '已执行,读回核对失败:连接失败'],
    ],
  );
});

test('同步后自动停用:超额客户的启用线路被停用,正常客户不动', async () => {
  const db = memoryDb();
  const a = addPanel(db, 'a');
  applyPanelSnapshot(db, a, [snap('over', 1, 1), snap('ok', 1, 1)], 0);
  const over = createCustomer(db, { name: '超额客户', quota_bytes: 100 });
  const fine = createCustomer(db, { name: '正常客户', quota_bytes: 100 });
  addBinding(db, over, a.id, 'over', false);
  addBinding(db, fine, a.id, 'ok', false);
  db.prepare('UPDATE customers SET used_down = 100 WHERE id = ?').run(over);
  updateCustomer(db, fine, { remark: 'x' });

  const fa = fakePanel([client('over', 50), client('ok', 1)]);
  const logs: string[] = [];
  const out = await enforceCustomers(db, () => fa.writer, Date.now(), (l) => logs.push(l));

  assert.deepEqual(out.map((r) => [r.customer, r.state, r.lines.map((l) => l.actions)]), [['超额客户', 'over_quota', [['停用']]]]);
  assert.equal(fa.clients[0].enable, false);
  assert.equal(fa.clients[1].enable, true);
  assert.deepEqual(logs, ['[自动停用] 客户「超额客户」超额:a · over 停用']);
  // 已停用(本地记录已更新),下一轮不再处理
  assert.deepEqual(await enforceCustomers(db, () => fa.writer, Date.now(), () => {}), []);
});

test('改资料时同步到面板的操作:只管启停,到期日不写到面板', () => {
  const c = (state: string) => ({ state });
  assert.equal(lineOpForChange(c('active'), c('active')), null);
  assert.deepEqual(lineOpForChange(c('active'), c('disabled')), { enable: false });
  assert.deepEqual(lineOpForChange(c('disabled'), c('active')), { enable: true });
  // 加额度、延期让客户回到正常
  assert.deepEqual(lineOpForChange(c('over_quota'), c('active')), { enable: true });
  assert.deepEqual(lineOpForChange(c('expired'), c('active')), { enable: true });
  // 不正常之间变化不动,线路本来就该是停用的
  assert.equal(lineOpForChange(c('disabled'), c('expired')), null);
});

test('同步后:正常客户线路上的面板限制清掉;面板上已找不到的线路不再处理', async () => {
  const db = memoryDb();
  const a = addPanel(db, 'a');
  applyPanelSnapshot(db, a, [snap('lim', 1, 1, { expiryMs: 99, totalBytes: 5 }), snap('gone', 1, 1)], 0);
  const fine = createCustomer(db, { name: '正常客户' });
  const expired = createCustomer(db, { name: '到期客户', expire_at: 1 });
  addBinding(db, fine, a.id, 'lim', false);
  addBinding(db, expired, a.id, 'gone', false);
  // 'gone' 从面板上消失了(启用状态还是 1)
  applyPanelSnapshot(db, a, [snap('lim', 1, 1, { expiryMs: 99, totalBytes: 5 })], 1);

  const fa = fakePanel([client('lim', 1, { expiryTime: 99, totalGB: 5 })]);
  const logs: string[] = [];
  const out = await enforceCustomers(db, () => fa.writer, Date.now(), (l) => logs.push(l));

  assert.deepEqual(out.map((r) => [r.customer, r.state, r.lines.map((l) => l.actions)]), [['正常客户', 'active', [['去掉面板限制']]]]);
  assert.deepEqual([fa.clients[0].enable, fa.clients[0].expiryTime, fa.clients[0].totalGB], [true, 0, 0]);
  assert.deepEqual(logs, ['[去掉面板限制] 客户「正常客户」正常:a · lim 去掉面板限制']);
  // 本地记录已更新,下一轮不再处理
  assert.deepEqual(await enforceCustomers(db, () => fa.writer, Date.now(), () => {}), []);
});

test('删除客户前删掉各面板上的 client:删完读回核对,面板上已没有的算成功,删了还在的报错', async () => {
  const { db, id } = setup();
  const onA = ['u1', 'u2'];
  const removerA: ClientRemover = {
    listClients: async () => onA.map((email) => ({ email })),
    deleteClient: async (email) => void onA.splice(onA.indexOf(email), 1),
  };
  // b 上的删除接口返回成功但实际没删
  const removerB: ClientRemover = { listClients: async () => [{ email: 'v1' }], deleteClient: async () => {} };
  const results = await deleteLines(db, id, (p) => (p.name === 'a' ? removerA : removerB));
  assert.deepEqual(results, [
    { panel: 'a', email: 'u1', ok: true },
    { panel: 'a', email: 'u2', ok: true },
    { panel: 'a', email: 'gone', ok: true, missing: true },
    { panel: 'b', email: 'v1', ok: false, error: '删除后面板上还在' },
  ]);
  assert.deepEqual(onA, []);
});
