import assert from 'node:assert/strict';
import { test } from 'node:test';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { getCustomer } from '../customers/repo';
import type { DB } from '../db';
import { getPanel } from '../panels/repo';
import { getSocks } from '../socks/repo';
import { addPanel, fakePanels, memoryDb, relayXray, vlessInbound, type FakePanel } from '../testUtil';
import { XUIError } from '../xui/client';
import { apiRouter } from './routes';

/** 起一个只挂 /api 的服务;call 返回状态码、响应体和这次下发的 cookie */
async function serve(db: DB, data: Record<string, FakePanel> = {}, adminPassword = '', subBaseUrl = '') {
  const app = express();
  app.use(express.json());
  app.use('/api', apiRouter({ db, adminPassword, clientFor: fakePanels(data), subBaseUrl, subLogDays: 7 }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const call = async (method: string, path: string, body?: unknown, cookie?: string) => {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (cookie) headers.Cookie = cookie;
    const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const setCookie = res.headers.get('set-cookie') ?? '';
    return { status: res.status, body: (await res.json()) as any, setCookie, cookie: setCookie.split(';')[0] };
  };
  return { call, close: () => new Promise((r) => server.close(r)) };
}

const panel = (over: Partial<FakePanel> = {}): FakePanel => ({ inbounds: [vlessInbound(7, 443)], clients: [], xray: {}, restarts: 0, ...over });
const relayPanel = (): FakePanel => ({ inbounds: [vlessInbound(5, 500)], clients: [], xray: relayXray(), restarts: 0 });
const emails = (p: FakePanel) => p.clients.map((c) => c.email);

test('登录:没登录进不了接口;退出后所有设备的会话一起失效,没登录的人点退出不影响别人', async () => {
  const { call, close } = await serve(memoryDb(), {}, 'pw');
  try {
    assert.deepEqual((await call('GET', '/session')).body, { auth_required: true, logged_in: false });
    const blocked = await call('GET', '/panels');
    assert.deepEqual([blocked.status, blocked.body], [401, { error: '未登录' }]);
    const wrong = await call('POST', '/login', { password: 'nope' });
    assert.deepEqual([wrong.status, wrong.body, wrong.setCookie], [401, { error: '密码错误' }, '']);
    assert.equal((await call('POST', '/login', {})).status, 401);

    const first = await call('POST', '/login', { password: 'pw' });
    assert.deepEqual([first.status, first.body], [200, { ok: true }]);
    assert.match(first.setCookie, /^xuihub_session=[^;]+; Path=\/; HttpOnly; SameSite=Strict; Max-Age=604800$/);
    const second = (await call('POST', '/login', { password: 'pw' })).cookie; // 另一台设备
    assert.deepEqual((await call('GET', '/session', undefined, first.cookie)).body, { auth_required: true, logged_in: true });
    assert.deepEqual((await call('GET', '/panels', undefined, first.cookie)).body, []);
    // 乱写的 cookie 不算登录
    assert.equal((await call('GET', '/panels', undefined, 'xuihub_session=123.abc')).status, 401);
    assert.equal((await call('GET', '/panels', undefined, 'xuihub_session=%E0%A4%A')).status, 401);

    // 没登录的人点退出:别人的会话还在
    assert.deepEqual((await call('POST', '/logout')).body, { ok: true });
    assert.equal((await call('GET', '/panels', undefined, second)).status, 200);

    const out = await call('POST', '/logout', undefined, first.cookie);
    assert.match(out.setCookie, /^xuihub_session=; .*Max-Age=0$/);
    assert.deepEqual([(await call('GET', '/panels', undefined, first.cookie)).status, (await call('GET', '/panels', undefined, second)).status], [401, 401]);
    // 重新登录照常
    const again = (await call('POST', '/login', { password: 'pw' })).cookie;
    assert.equal((await call('GET', '/panels', undefined, again)).status, 200);
  } finally {
    await close();
  }
});

test('会话跟着密码走:重启后还有效,改了密码旧会话全部失效', async () => {
  const db = memoryDb();
  let app = await serve(db, {}, 'old');
  const cookie = (await app.call('POST', '/login', { password: 'old' })).cookie;
  await app.close();

  app = await serve(db, {}, 'old'); // 重启,密码没变
  assert.equal((await app.call('GET', '/panels', undefined, cookie)).status, 200);
  await app.close();

  app = await serve(db, {}, 'new');
  try {
    assert.equal((await app.call('GET', '/panels', undefined, cookie)).status, 401);
    assert.equal((await app.call('POST', '/login', { password: 'old' })).status, 401);
    const fresh = (await app.call('POST', '/login', { password: 'new' })).cookie;
    assert.equal((await app.call('GET', '/panels', undefined, fresh)).status, 200);
  } finally {
    await app.close();
  }
});

test('没设密码:不用登录', async () => {
  const { call, close } = await serve(memoryDb());
  try {
    assert.deepEqual((await call('GET', '/session')).body, { auth_required: false, logged_in: true });
    assert.deepEqual((await call('GET', '/panels')).body, []);
    const login = await call('POST', '/login', { password: 'x' });
    assert.deepEqual([login.status, login.body, login.setCookie], [200, { ok: true }, '']);
    assert.deepEqual((await call('POST', '/logout')).body, { ok: true });
  } finally {
    await close();
  }
});

test('登录限流:连错 10 次后,密码对了也要等', async () => {
  const { call, close } = await serve(memoryDb(), {}, 'pw');
  try {
    for (let i = 0; i < 10; i++) assert.equal((await call('POST', '/login', { password: `bad-${i}` })).status, 401);
    const locked = await call('POST', '/login', { password: 'pw' });
    assert.deepEqual([locked.status, locked.setCookie], [429, '']);
    assert.match(locked.body.error, /尝试次数过多/);
  } finally {
    await close();
  }
});

test('接入面板:保存后马上检查;连不上也存下来并带上错误;接口不返回 token', async () => {
  const db = memoryDb();
  const data = { hk: panel(), down: panel({ fail: { listInbounds: '连接失败:超时' } }) };
  const { call, close } = await serve(db, data);
  try {
    const hk = await call('POST', '/panels', { name: 'hk', base_url: 'https://hk.example.com:2053/p/', token: 'secret-token' });
    assert.equal(hk.status, 200);
    assert.deepEqual(
      [hk.body.base_url, hk.body.check_error, hk.body.inbound_count, hk.body.client_count, hk.body.panel_version, hk.body.xray_version, hk.body.xray_state, hk.body.line_count],
      ['https://hk.example.com:2053/p', null, 1, 0, '3.0.0', '25.1.1', 'running', 0],
    );
    assert.equal(typeof hk.body.check_ok_at, 'number');
    assert.ok(!JSON.stringify(hk.body).includes('secret-token'));

    const down = await call('POST', '/panels', { name: 'down', base_url: 'https://down.example.com:2053', token: 't' });
    assert.deepEqual([down.status, down.body.check_error, down.body.check_ok_at], [200, '连接失败:超时', null]);
    const dup = await call('POST', '/panels', { name: 'hk', base_url: 'https://x.example.com', token: 't' });
    assert.deepEqual([dup.status, dup.body], [400, { error: '面板名称已存在:hk' }]);
    assert.equal((await call('POST', '/panels', { name: 'bad', base_url: 'ftp://x', token: 't' })).status, 400);

    // 面板修好了:单查、全查都更新状态;全查按名称排
    data.down.fail = {};
    assert.equal((await call('POST', `/panels/${down.body.id}/check`)).body.check_error, null);
    data.hk.fail = { listClients: new XUIError('鉴权失败(401):检查 token / webBasePath') };
    const all = await call('POST', '/panels/check');
    assert.deepEqual(all.body.map((p: any) => [p.name, p.check_error]), [['down', null], ['hk', '鉴权失败(401):检查 token / webBasePath']]);
    data.hk.fail = {};

    // 改地址后也马上检查;token 留空 = 不改
    const patched = await call('PATCH', `/panels/${hk.body.id}`, { base_url: 'https://hk2.example.com:2053', token: '' });
    assert.deepEqual([patched.body.base_url, patched.body.check_error], ['https://hk2.example.com:2053', null]);
    assert.equal(getPanel(db, hk.body.id)!.token, 'secret-token');

    const detail = await call('GET', `/panels/${hk.body.id}/inbounds`);
    assert.deepEqual(detail.body.inbounds.map((i: any) => [i.id, i.protocol, i.accepts_clients]), [[7, 'vless', true]]);
    assert.ok(!JSON.stringify(detail.body).includes('privateKey'));
  } finally {
    await close();
  }
});

test('客户全流程:建客户、开线路、取链接、超额停用、清零恢复、到期再停、删线路', async () => {
  const db = memoryDb();
  const hk = addPanel(db, 'hk', 'https://1.1.1.1:2053/p');
  const data = { hk: panel() };
  const { call, close } = await serve(db, data);
  try {
    const c = (await call('POST', '/customers', { name: '李四', quota_bytes: 1000 })).body;
    assert.deepEqual([c.name, c.state, c.used, c.lines, c.sub_url, c.sub_clients, c.sub_ips], ['李四', 'active', 0, [], null, 0, 0]);
    assert.equal((await call('POST', '/customers', {})).body.error, '客户名称不能为空');

    const opened = await call('POST', `/customers/${c.id}/lines`, { kind: 'direct', panel_id: hk.id, inbound: { id: 7 } });
    assert.equal(opened.status, 200);
    assert.deepEqual([opened.body.line.email, opened.body.line.panel_name, opened.body.created], ['李四', 'hk', { inbound: null, exit_inbound: null }]);
    assert.match(opened.body.links[0], /^vless:\/\/.+@1\.1\.1\.1#李四$/);
    const lid = opened.body.line.id;
    assert.deepEqual((await call('GET', `/customers/${c.id}/lines/${lid}/links`)).body, { links: opened.body.links });
    assert.deepEqual((await call('GET', `/panels/${hk.id}/clients/${encodeURIComponent('李四')}/links`)).body, { links: opened.body.links });
    assert.deepEqual((await call('GET', '/panels')).body.map((p: any) => [p.name, p.line_count]), [['hk', 1]]);

    // 面板上流量超了额度:同步后停用
    data.hk.clients[0].traffic = { up: 600, down: 600 };
    assert.deepEqual((await call('POST', '/sync')).body, { ops: [{ customer: '李四', panel: 'hk', email: '李四', action: 'disable', ok: true }] });
    assert.equal(data.hk.clients[0].enable, false);
    let listed = (await call('GET', '/customers')).body[0];
    assert.deepEqual([listed.state, listed.used, listed.lines[0].enable, listed.lines[0].auto_disabled], ['over_quota', 1200, false, true]);
    assert.deepEqual((await call('POST', '/sync')).body, { ops: [] });

    // 清零已用:面板上流量归零,停掉的恢复
    const reset = (await call('POST', `/customers/${c.id}/reset-usage`)).body;
    assert.deepEqual([reset.state, reset.used, reset.failed, reset.ops.map((o: any) => [o.action, o.ok])], ['active', 0, [], [['enable', true]]]);
    assert.deepEqual([data.hk.clients[0].enable, data.hk.clients[0].traffic], [true, { up: 0, down: 0 }]);

    // 改成已到期:马上停;面板报错时结果里带上
    data.hk.fail = { setClientsEnabled: '面板报错' };
    let patched = (await call('PATCH', `/customers/${c.id}`, { expire_at: 1 })).body;
    assert.deepEqual([patched.state, patched.ops], ['expired', [{ customer: '李四', panel: 'hk', email: '李四', action: 'disable', ok: false, error: '面板报错' }]]);
    data.hk.fail = {};
    patched = (await call('PATCH', `/customers/${c.id}`, { remark: '续费中' })).body;
    assert.deepEqual([patched.remark, patched.ops.map((o: any) => [o.action, o.ok]), data.hk.clients[0].enable], ['续费中', [['disable', true]], false]);

    // 重置订阅链接;拉取记录
    const token = (await call('POST', `/customers/${c.id}/sub-token`)).body.sub_token;
    assert.notEqual(token, c.sub_token);
    assert.deepEqual((await call('GET', `/customers/${c.id}/sub-fetches`)).body, { days: 7, rows: [] });

    // 删线路:面板上的 client 一起删
    assert.deepEqual((await call('DELETE', `/customers/${c.id}/lines/${lid}`)).body, { ok: true });
    assert.deepEqual([emails(data.hk), getCustomer(db, c.id)!.lines], [[], []]);
    assert.equal((await call('DELETE', `/customers/${c.id}/lines/${lid}`)).body.error, '线路不存在');
  } finally {
    await close();
  }
});

test('订阅地址:设了 SUB_BASE_URL 就拼好返回', async () => {
  const db = memoryDb();
  const { call, close } = await serve(db, {}, '', 'https://hub.example.com');
  try {
    const c = (await call('POST', '/customers', { name: 'li' })).body;
    assert.equal(c.sub_url, `https://hub.example.com/sub/${c.sub_token}`);
    assert.equal((await call('GET', '/customers')).body[0].sub_url, c.sub_url);
  } finally {
    await close();
  }
});

test('删面板:上面还有客户线路就拦下,带 force 才连线路记录一起删', async () => {
  const db = memoryDb();
  const a = addPanel(db, 'a');
  const { call, close } = await serve(db, { a: panel() });
  try {
    const c = (await call('POST', '/customers', { name: 'li' })).body;
    await call('POST', `/customers/${c.id}/lines`, { kind: 'direct', panel_id: a.id, inbound: { id: 7 } });
    const refused = await call('DELETE', `/panels/${a.id}`);
    assert.equal(refused.status, 400);
    assert.match(refused.body.error, /还有 1 条客户线路/);
    assert.equal(getCustomer(db, c.id)!.lines.length, 1);

    assert.deepEqual((await call('DELETE', `/panels/${a.id}?force=1`)).body, { ok: true });
    assert.deepEqual((await call('GET', '/panels')).body, []);
    assert.deepEqual((await call('GET', '/customers')).body.map((x: any) => [x.name, x.lines]), [['li', []]]);
    const gone = await call('DELETE', `/panels/${a.id}?force=1`);
    assert.deepEqual([gone.status, gone.body], [400, { error: '面板不存在' }]);
  } finally {
    await close();
  }
});

test('面板卡片上删 client:是客户线路的,出口规则和线路记录一起删;面板连不上时什么都不删', async () => {
  const db = memoryDb();
  const relay = addPanel(db, 'relay', 'https://1.1.1.1:2053/p');
  const data = { relay: relayPanel() };
  data.relay.clients.push({ id: 'manual-id', email: 'manual', enable: true, inboundIds: [5] });
  const { call, close } = await serve(db, data);
  try {
    const sid = (await call('POST', '/socks', { name: 'isp', address: 'socks5://u:p@isp.example.com:1080' })).body.id;
    const c = (await call('POST', '/customers', { name: '张三' })).body;
    const opened = await call('POST', `/customers/${c.id}/lines`, { kind: 'relay', panel_id: relay.id, inbound: { id: 5 }, exit: { kind: 'socks', socks_id: sid } });
    assert.equal(opened.status, 200);
    assert.deepEqual([emails(data.relay), data.relay.xray.outbounds.length, data.relay.xray.routing.rules.length], [['manual', '张三'], 2, 2]);
    const path = `/panels/${relay.id}/clients/${encodeURIComponent('张三')}`;

    data.relay.fail = { listClients: new XUIError('连接失败:超时') };
    const failed = await call('DELETE', path);
    assert.deepEqual([failed.status, failed.body], [502, { error: '连接失败:超时' }]);
    assert.equal(getCustomer(db, c.id)!.lines.length, 1);

    data.relay.fail = {};
    assert.deepEqual((await call('DELETE', path)).body, { ok: true, line_removed: true });
    assert.deepEqual([emails(data.relay), data.relay.xray, getCustomer(db, c.id)!.lines], [['manual'], relayXray(), []]);
    assert.equal((await call('GET', '/socks')).body[0].used_by, 0);

    // 手动建的 client:只删面板上的
    assert.deepEqual((await call('DELETE', `/panels/${relay.id}/clients/manual`)).body, { ok: true, line_removed: false });
    assert.deepEqual(emails(data.relay), []);
  } finally {
    await close();
  }
});

test('面板卡片上建 client:名字里的空格和特殊字符换成 -,避开线路已占用的 email', async () => {
  const db = memoryDb();
  const a = addPanel(db, 'a', 'https://1.1.1.1:2053/p');
  const data = { a: panel() };
  const { call, close } = await serve(db, data);
  try {
    const c = (await call('POST', '/customers', { name: 'li' })).body;
    await call('POST', `/customers/${c.id}/lines`, { kind: 'direct', panel_id: a.id, inbound: { id: 7 } });
    data.a.clients = []; // 面板上的 client 被人删了,本地还记着这条线路
    const made = await call('POST', `/panels/${a.id}/clients`, { inbound_id: 7, name: 'li' });
    assert.deepEqual([made.status, made.body.email, made.body.protocol, made.body.inbound], [200, 'li-2', 'vless', { id: 7, remark: 'v7', port: 443, created: false }]);
    assert.equal((await call('POST', `/panels/${a.id}/clients`, { inbound_id: 7, name: '王 五/x' })).body.email, '王-五-x');
    const missing = await call('POST', `/panels/${a.id}/clients`, { inbound_id: 99, name: 'x' });
    assert.deepEqual([missing.status, missing.body], [400, { error: '面板上没有这个入站' }]);
    assert.deepEqual(emails(data.a), ['li-2', '王-五-x']);
  } finally {
    await close();
  }
});

test('删线路:面板连不上时报错并留着记录,带 force 只删记录;别的客户的线路删不了', async () => {
  const db = memoryDb();
  const a = addPanel(db, 'a');
  const data = { a: panel() };
  const { call, close } = await serve(db, data);
  try {
    const li = (await call('POST', '/customers', { name: 'li' })).body;
    const wang = (await call('POST', '/customers', { name: 'wang' })).body;
    const input = { kind: 'direct', panel_id: a.id, inbound: { id: 7 } };
    const l1 = (await call('POST', `/customers/${li.id}/lines`, input)).body.line.id;
    const l2 = (await call('POST', `/customers/${wang.id}/lines`, input)).body.line.id;

    data.a.fail = { listClients: new XUIError('连接失败:超时') };
    const failed = await call('DELETE', `/customers/${li.id}/lines/${l1}`);
    assert.deepEqual([failed.status, failed.body], [502, { error: '连接失败:超时' }]);
    assert.equal(getCustomer(db, li.id)!.lines.length, 1);
    const other = await call('DELETE', `/customers/${li.id}/lines/${l2}?force=1`);
    assert.deepEqual([other.status, other.body], [400, { error: '线路不存在' }]);

    assert.deepEqual((await call('DELETE', `/customers/${li.id}/lines/${l1}?force=1`)).body, { ok: true });
    assert.deepEqual([getCustomer(db, li.id)!.lines.length, getCustomer(db, wang.id)!.lines.length], [0, 1]);
    assert.deepEqual(emails(data.a), ['li', 'wang'], '面板上的 client 没动');
  } finally {
    await close();
  }
});

test('删客户:各面板上的 client 一起删;有面板删不掉的照样删记录,结果里列出来', async () => {
  const db = memoryDb();
  const a = addPanel(db, 'a');
  const b = addPanel(db, 'b');
  const data = { a: panel(), b: panel() };
  const { call, close } = await serve(db, data);
  try {
    const c = (await call('POST', '/customers', { name: 'li' })).body;
    for (const p of [a, b]) await call('POST', `/customers/${c.id}/lines`, { kind: 'direct', panel_id: p.id, inbound: { id: 7 } });
    assert.deepEqual([emails(data.a), emails(data.b)], [['li'], ['li']]);

    data.b.fail = { listClients: '面板连不上' };
    assert.deepEqual((await call('DELETE', `/customers/${c.id}`)).body, { failed: [{ line: 'b 上的 li', error: '面板连不上' }] });
    assert.deepEqual([(await call('GET', '/customers')).body, emails(data.a), emails(data.b)], [[], [], ['li']]);
    const gone = await call('DELETE', `/customers/${c.id}`);
    assert.deepEqual([gone.status, gone.body], [400, { error: '客户不存在' }]);
  } finally {
    await close();
  }
});

test('改 SOCKS:换地址先改各中转的出口,没改成不保存;只改备注不动面板;还在用的删不了', async () => {
  const db = memoryDb();
  const relay = addPanel(db, 'relay', 'https://1.1.1.1:2053/p');
  const data = { relay: relayPanel() };
  const { call, close } = await serve(db, data);
  try {
    const s = (await call('POST', '/socks', { name: 'isp', address: 'socks5://u:p@isp.example.com:1080' })).body;
    assert.deepEqual([s.host, s.port, s.username, s.has_password, s.used_by, 'password' in s], ['isp.example.com', 1080, 'u', true, 0, false]);
    const c = (await call('POST', '/customers', { name: 'li' })).body;
    const lid = (await call('POST', `/customers/${c.id}/lines`, { kind: 'relay', panel_id: relay.id, inbound: { id: 5 }, exit: { kind: 'socks', socks_id: s.id } })).body.line.id;
    assert.equal(data.relay.restarts, 1);

    const noted = await call('PATCH', `/socks/${s.id}`, { remark: '月付' });
    assert.deepEqual([noted.status, noted.body.remark, noted.body.used_by, data.relay.restarts], [200, '月付', 1, 1]);

    const address = 'socks5://u2:p2@new.example.com:2080';
    data.relay.fail = { updateXray: '面板报错' };
    const failed = await call('PATCH', `/socks/${s.id}`, { address });
    assert.equal(failed.status, 502);
    assert.match(failed.body.error, /relay\(面板报错\)/);
    assert.match(failed.body.error, /没有保存/);
    assert.equal(getSocks(db, s.id)!.host, 'isp.example.com');

    data.relay.fail = {};
    const moved = await call('PATCH', `/socks/${s.id}`, { address });
    assert.deepEqual([moved.status, moved.body.host, moved.body.port, moved.body.username, moved.body.remark, 'password' in moved.body], [200, 'new.example.com', 2080, 'u2', '月付', false]);
    assert.deepEqual(data.relay.xray.outbounds.map((o: any) => o.tag), ['direct', 'socks-new.example.com-2080']);
    assert.deepEqual(data.relay.xray.routing.rules.map((r: any) => [r.user ?? null, r.outboundTag]), [[['li'], 'socks-new.example.com-2080'], [null, 'direct']]);
    assert.equal(data.relay.restarts, 2);
    assert.equal(getSocks(db, s.id)!.password, 'p2');

    const refused = await call('DELETE', `/socks/${s.id}`);
    assert.equal(refused.status, 400);
    assert.match(refused.body.error, /还有 1 条线路在用/);
    await call('DELETE', `/customers/${c.id}/lines/${lid}`);
    assert.deepEqual((await call('DELETE', `/socks/${s.id}`)).body, { ok: true });
    assert.deepEqual((await call('GET', '/socks')).body, []);
    assert.deepEqual((await call('PATCH', `/socks/${s.id}`, { remark: 'x' })).body, { error: 'SOCKS 不存在' });
  } finally {
    await close();
  }
});

test('版本信息:面板不报可升级信息、取不到 Xray 版本列表时照样返回;升级面板拿到 runId,成功后刷新版本记录', async () => {
  const db = memoryDb();
  const a = addPanel(db, 'a');
  const data = { a: panel() };
  const { call, close } = await serve(db, data);
  try {
    assert.deepEqual((await call('GET', `/panels/${a.id}/versions`)).body, {
      panel: { current: '3.0.0', latest: null, update_available: false, channel: null },
      xray: { current: '25.1.1', state: 'running', error: '', available: ['v25.1.1'] },
    });
    data.a.update = { channel: 'stable', current: '3.0.0', latest: '3.1.0', available: true };
    data.a.fail = { xrayVersions: '取不到' };
    const v = (await call('GET', `/panels/${a.id}/versions`)).body;
    assert.deepEqual([v.panel, v.xray.available], [{ current: '3.0.0', latest: '3.1.0', update_available: true, channel: 'stable' }, []]);

    const bad = await call('POST', `/panels/${a.id}/xray/latest`);
    assert.deepEqual([bad.status, bad.body], [400, { error: '版本号不合法' }]);

    assert.deepEqual((await call('POST', `/panels/${a.id}/update`)).body, { run_id: 'run-1' });
    assert.equal(getPanel(db, a.id)!.panel_version, null);
    assert.deepEqual((await call('GET', `/panels/${a.id}/update-status`)).body, { runId: 'run-1', state: 'success', exitCode: 0 });
    assert.equal(getPanel(db, a.id)!.panel_version, '3.0.0');
  } finally {
    await close();
  }
});

test('报错分类:输入不对 400,面板那头的问题 502,其余 500 并打日志', async (t) => {
  const db = memoryDb();
  const a = addPanel(db, 'a');
  const data = { a: panel() };
  const { call, close } = await serve(db, data);
  const logged = t.mock.method(console, 'error', () => {});
  try {
    const status = async (method: string, path: string, body?: unknown) => {
      const res = await call(method, path, body);
      return [res.status, res.body.error];
    };
    assert.deepEqual(await status('GET', '/panels/abc/inbounds'), [400, '无效的 id']);
    assert.deepEqual(await status('GET', '/panels/0/inbounds'), [400, '无效的 id']);
    assert.deepEqual(await status('GET', '/panels/99/inbounds'), [400, '面板不存在']);
    assert.deepEqual(await status('PATCH', '/panels/99', { name: 'x' }), [400, '面板不存在']);
    assert.deepEqual(await status('PATCH', '/customers/99', { remark: 'x' }), [400, '客户不存在']);
    assert.deepEqual(await status('POST', '/customers/99/sub-token'), [400, '客户不存在']);
    assert.deepEqual(await status('POST', '/customers/99/lines', { kind: 'direct', panel_id: a.id }), [400, '客户不存在']);
    assert.deepEqual(await status('POST', '/socks', { name: 'x', address: 'http://1.1.1.1:80' }), [400, '只支持 socks5 代理']);
    assert.equal(logged.mock.callCount(), 0);

    data.a.fail = { clientLinks: new XUIError('鉴权失败(401):检查 token / webBasePath') };
    assert.deepEqual(await status('GET', `/panels/${a.id}/clients/x/links`), [502, '鉴权失败(401):检查 token / webBasePath']);
    assert.equal(logged.mock.callCount(), 0);

    data.a.fail = { clientLinks: '意料之外' };
    assert.deepEqual(await status('GET', `/panels/${a.id}/clients/x/links`), [500, '意料之外']);
    assert.equal(logged.mock.callCount(), 1);
  } finally {
    await close();
  }
});
