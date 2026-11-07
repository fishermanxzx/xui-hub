import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addPanel, memoryDb } from '../testUtil';
import {
  KEEP_LATEST,
  listSnapshots,
  loadSnapshot,
  planRestore,
  pruneSnapshots,
  readPanelConfig,
  restorePanel,
  takeSnapshot,
  type PanelRestorer,
} from './snapshots';

const DAY = 86_400_000;

/** 模拟的 3x-ui 面板:新建入站时自己分配 id 和 tag(tag 规则可换,用来验证路由里的 tag 会跟着改) */
function fakePanel(tagOf = (port: number) => `in-${port}-tcp`) {
  const s = {
    inbounds: [] as any[],
    clients: [] as { client: any; inboundIds: number[] }[],
    xray: { outbounds: [{ tag: 'direct', protocol: 'freedom' }], routing: { rules: [] as any[] } } as any,
    testUrl: 'https://t.example/204',
    nextId: 1,
    calls: [] as string[],
  };
  const restorer: PanelRestorer = {
    listInbounds: async () => s.inbounds.map((i) => ({ ...i, up: 5, down: 7, clientStats: [] })),
    exportClients: async () => s.clients.map((e) => ({ client: { ...e.client, updated_at: Date.now() }, inboundIds: [...e.inboundIds] })),
    xraySettings: async () => JSON.stringify({ xraySetting: JSON.stringify(s.xray), outboundTestUrl: s.testUrl, inboundTags: [] }),
    addInbound: async (body: any) => {
      assert.equal(body.id, undefined);
      if (s.inbounds.some((i) => i.port === body.port)) throw new Error('端口已存在');
      s.inbounds.push({ ...body, id: s.nextId++, tag: tagOf(body.port) });
      s.calls.push(`addInbound ${body.remark}`);
    },
    addClient: async (client: any, inboundIds) => {
      s.clients.push({ client, inboundIds: [...inboundIds] });
      s.calls.push(`addClient ${client.email} ${inboundIds}`);
    },
    attachClient: async (email, inboundIds) => {
      s.clients.find((e) => e.client.email === email)!.inboundIds.push(...inboundIds);
      s.calls.push(`attach ${email} ${inboundIds}`);
    },
    updateXray: async (xray: any, testUrl) => {
      s.xray = xray;
      s.testUrl = testUrl;
      s.calls.push('updateXray');
    },
    restartXray: async () => void s.calls.push('restart'),
  };
  return { s, restorer };
}

const inbound = (id: number, port: number, protocol: string, remark: string, stream: unknown = { network: 'tcp', security: 'reality' }) => ({
  id,
  remark,
  port,
  protocol,
  listen: '',
  enable: true,
  tag: `in-${port}-tcp`,
  shareAddr: '203.0.113.9',
  settings: JSON.stringify({ clients: [{ email: 'x' }], decryption: 'none' }),
  streamSettings: JSON.stringify(stream),
  sniffing: '{}',
});

/** 一台配好的中转:两个入站、三个 client、按入站分流的路由 */
function configured() {
  const p = fakePanel();
  p.s.inbounds = [
    inbound(1, 2001, 'vless', 'us-a'),
    inbound(2, 2002, 'hysteria', 'us-d', { network: 'hysteria', security: 'tls', tlsSettings: { certificates: [{ certificateFile: '/root/cert/ip/fullchain.pem', keyFile: '/root/cert/ip/privkey.pem' }] } }),
  ];
  p.s.nextId = 3;
  p.s.clients = [
    { client: { email: 'alice', id: 'u-a', flow: 'xtls-rprx-vision', enable: true }, inboundIds: [1] },
    { client: { email: 'bob', id: 'u-b', auth: 'h2', enable: true }, inboundIds: [1, 2] },
    { client: { email: 'carol', id: 'u-c', enable: false }, inboundIds: [2] },
  ];
  p.s.xray.outbounds.push({ tag: 'to-exit', protocol: 'socks' });
  p.s.xray.routing.rules = [
    { type: 'field', inboundTag: ['api'], outboundTag: 'api' },
    { type: 'field', inboundTag: ['in-2001-tcp', 'in-2002-tcp'], outboundTag: 'to-exit' },
  ];
  return p;
}

test('快照:去掉流量和时间戳,内容不变不重复存;client 一变就存;空面板不存', async () => {
  const db = memoryDb();
  const panel = addPanel(db, 'relay');
  const p = configured();
  assert.equal(await takeSnapshot(db, panel, p.restorer, 1000), true);
  assert.equal(await takeSnapshot(db, panel, p.restorer, 2000), false);
  p.s.clients[2].client.enable = true;
  assert.equal(await takeSnapshot(db, panel, p.restorer, 3000), true);
  assert.deepEqual(
    listSnapshots(db, panel.id).map((r) => [r.taken_at, r.inbounds, r.clients]),
    [
      [3000, 2, 3],
      [1000, 2, 3],
    ],
  );
  const data = loadSnapshot(db, panel.id, listSnapshots(db, panel.id)[0].id);
  assert.equal(data.inbounds[0].up, undefined);
  assert.deepEqual(JSON.parse(data.inbounds[0].settings), { clients: [], decryption: 'none' });
  assert.equal(data.clients[0].client.updated_at, undefined);
  assert.equal(data.testUrl, 'https://t.example/204');
  assert.throws(() => loadSnapshot(db, panel.id + 1, listSnapshots(db, panel.id)[0].id), /快照不存在/);

  const empty = addPanel(db, 'fresh');
  assert.equal(await takeSnapshot(db, empty, fakePanel().restorer), false);
});

test('清理:超过保留天数的删掉,但每台面板最近几份不论多旧都留', () => {
  const db = memoryDb();
  const a = addPanel(db, 'a');
  const b = addPanel(db, 'b');
  const insert = db.prepare("INSERT INTO panel_snapshots (panel_id, taken_at, hash, inbounds, clients, data) VALUES (?, ?, 'h', 1, 1, x'00')");
  const now = 100 * DAY;
  for (let i = 0; i < KEEP_LATEST + 3; i++) insert.run(a.id, now - (30 + i) * DAY);
  insert.run(a.id, now - DAY);
  insert.run(b.id, now - 60 * DAY);
  // a:1 份新的 + 13 份旧的 → 留新的和最近 9 份旧的;b 只有 1 份,再旧也留
  assert.equal(pruneSnapshots(db, 7, now), 4);
  assert.equal(listSnapshots(db, a.id).length, KEEP_LATEST);
  assert.equal(listSnapshots(db, b.id).length, 1);
});

test('恢复到重装后的空面板:入站、client、Xray 配置都回来,路由里的入站 tag 跟着新 tag 改', async () => {
  const db = memoryDb();
  const panel = addPanel(db, 'relay');
  const before = configured();
  await takeSnapshot(db, panel, before.restorer, 1000);
  const snapId = listSnapshots(db, panel.id)[0].id;

  // 重装后的面板分配的 tag 换了规则
  const after = fakePanel((port) => `inbound-${port}`);
  const plan = planRestore(loadSnapshot(db, panel.id, snapId), await readPanelConfig(after.restorer));
  assert.deepEqual(
    plan.inbounds.map((i) => [i.remark, i.action]),
    [
      ['us-a', 'add'],
      ['us-d', 'add'],
    ],
  );
  assert.deepEqual(
    plan.clients.map((c) => [c.email, c.action, c.inbounds.join(',')]),
    [
      ['alice', 'add', 'us-a'],
      ['bob', 'add', 'us-a,us-d'],
      ['carol', 'add', 'us-d'],
    ],
  );
  assert.equal(plan.xray.same, false);
  assert.deepEqual(plan.xray.snapshot, { outbounds: 2, rules: 2 });
  assert.match(plan.warnings.join(), /\/root\/cert\/ip\/fullchain\.pem、\/root\/cert\/ip\/privkey\.pem/);

  const steps = await restorePanel(db, panel, snapId, after.restorer, { xray: true }, 2000);
  assert.ok(steps.every((s) => s.ok), JSON.stringify(steps));
  assert.deepEqual(after.s.calls, [
    'addInbound us-a',
    'addInbound us-d',
    'addClient alice 1',
    'addClient bob 1,2',
    'addClient carol 2',
    'updateXray',
    'restart',
  ]);
  assert.equal(after.s.inbounds[0].shareAddr, '203.0.113.9');
  assert.deepEqual(after.s.clients[1].client, { email: 'bob', id: 'u-b', auth: 'h2', enable: true });
  assert.deepEqual(after.s.xray.routing.rules[1].inboundTag, ['inbound-2001', 'inbound-2002']);
  assert.equal(after.s.testUrl, 'https://t.example/204');
  // 恢复前的空面板不存快照;恢复后再读,和快照只差 id / tag
  assert.equal(listSnapshots(db, panel.id).length, 1);
  const again = planRestore(loadSnapshot(db, panel.id, snapId), await readPanelConfig(after.restorer));
  assert.ok(again.inbounds.every((i) => i.action === 'exists'));
  assert.ok(again.clients.every((c) => c.action === 'exists'));
  assert.equal(again.xray.same, true);
});

test('只补缺的:同端口同协议算已有(改了名也算),已有 client 补挂缺的入站、不覆盖;不勾 Xray 就不动', async () => {
  const db = memoryDb();
  const panel = addPanel(db, 'relay');
  const before = configured();
  await takeSnapshot(db, panel, before.restorer, 1000);
  const snapId = listSnapshots(db, panel.id)[0].id;

  const cur = fakePanel();
  cur.s.inbounds = [inbound(7, 2001, 'vless', 'renamed'), inbound(9, 2002, 'hysteria', 'us-d')];
  cur.s.nextId = 10;
  cur.s.clients = [{ client: { email: 'bob', id: 'u-b2' }, inboundIds: [9] }];
  const plan = planRestore(loadSnapshot(db, panel.id, snapId), await readPanelConfig(cur.restorer));
  assert.deepEqual(
    plan.inbounds.map((i) => [i.remark, i.action, i.note]),
    [
      ['us-a', 'exists', '面板上叫「renamed」'],
      ['us-d', 'exists', undefined],
    ],
  );
  assert.deepEqual(
    plan.clients.map((c) => [c.email, c.action, c.inbounds.join(',')]),
    [
      ['alice', 'add', 'us-a'],
      ['bob', 'attach', 'us-a'],
      ['carol', 'add', 'us-d'],
    ],
  );
  assert.deepEqual(plan.warnings, []);

  const steps = await restorePanel(db, panel, snapId, cur.restorer, { xray: false }, 2000);
  assert.ok(steps.every((s) => s.ok));
  assert.deepEqual(cur.s.calls, ['addClient alice 7', 'attach bob 7', 'addClient carol 9']);
  // 现有的 bob 不被覆盖;恢复前先存了一份现状
  assert.equal(cur.s.clients[0].client.id, 'u-b2');
  assert.equal(listSnapshots(db, panel.id).length, 2);
});

test('同一端口上是别的协议:当作不同的入站去建,面板拒绝就报错,挂在它上面的新 client 也报错,其余照做', async () => {
  const db = memoryDb();
  const panel = addPanel(db, 'relay');
  await takeSnapshot(db, panel, configured().restorer, 1000);
  const after = fakePanel();
  after.s.inbounds = [inbound(1, 2002, 'vmess', 'other')];
  after.s.nextId = 2;
  const snapId = listSnapshots(db, panel.id)[0].id;
  const plan = planRestore(loadSnapshot(db, panel.id, snapId), await readPanelConfig(after.restorer));
  assert.deepEqual(
    plan.inbounds.map((i) => [i.remark, i.action]),
    [
      ['us-a', 'add'],
      ['us-d', 'add'],
    ],
  );
  const steps = await restorePanel(db, panel, snapId, after.restorer, { xray: true }, 2000);
  assert.deepEqual(
    steps.filter((s) => !s.ok).map((s) => [s.what, s.error]),
    [
      ['新建入站「us-d」', '端口已存在'],
      ['新建 client carol', '它的入站没建起来'],
    ],
  );
  assert.deepEqual(
    after.s.clients.map((e) => [e.client.email, e.inboundIds.join(',')]),
    [
      ['alice', '2'],
      ['bob', '2'],
    ],
  );
  assert.deepEqual(after.s.calls.slice(-2), ['updateXray', 'restart']);
});

test('Xray 配置读坏了(没有出站)不存快照、不出恢复计划', async () => {
  const db = memoryDb();
  const panel = addPanel(db, 'relay');
  const p = configured();
  p.s.xray = {};
  await assert.rejects(takeSnapshot(db, panel, p.restorer), /Xray 配置不完整/);
  await assert.rejects(readPanelConfig(p.restorer), /Xray 配置不完整/);
  assert.equal(listSnapshots(db, panel.id).length, 0);
});

test('同一台面板不能同时恢复两次', async () => {
  const db = memoryDb();
  const panel = addPanel(db, 'relay');
  await takeSnapshot(db, panel, configured().restorer, 1000);
  const snapId = listSnapshots(db, panel.id)[0].id;
  const after = fakePanel();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const add = after.restorer.addInbound;
  after.restorer.addInbound = async (body) => {
    await gate;
    await add(body);
  };
  const first = restorePanel(db, panel, snapId, after.restorer, { xray: false });
  await new Promise((r) => setTimeout(r, 10));
  await assert.rejects(restorePanel(db, panel, snapId, after.restorer, { xray: false }), /正在恢复/);
  release();
  assert.ok((await first).every((s) => s.ok));
  // 做完就能再恢复(这次没有要补的)
  assert.deepEqual(await restorePanel(db, panel, snapId, after.restorer, { xray: false }), []);
});
