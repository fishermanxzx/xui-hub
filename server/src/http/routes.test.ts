import assert from 'node:assert/strict';
import { test } from 'node:test';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { getCustomer } from '../customers/repo';
import type { DB } from '../db';
import { listOpLog } from '../oplog/log';
import { getPanel, type Panel } from '../panels/repo';
import { getSocks } from '../socks/repo';
import { recordTraffic } from '../traffic/daily';
import type { UpstreamFetcher } from '../subscription/upstream';
import { addPanel, fakePanels, memoryDb, relayXray, vlessInbound, type FakePanel } from '../testUtil';
import { XUIError } from '../xui/client';
import { apiRouter } from './routes';

/** 起一个只挂 /api 的服务;call 返回状态码、响应体和这次下发的 cookie */
async function serve(db: DB, data: Record<string, FakePanel> = {}, adminPassword = '', subBaseUrl = '', fetchUpstream?: UpstreamFetcher, clientFor = fakePanels(data)) {
  const app = express();
  app.use(express.json());
  app.use('/api', apiRouter({ db, adminPassword, clientFor, subBaseUrl, subLogDays: 7, fetchUpstream }));
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
  return { call, base, close: () => new Promise((r) => server.close(r)) };
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

    // 标签:逗号 / 空格分开的字符串或数组都行,去空白和重复;不传 = 不改
    assert.deepEqual(hk.body.tags, []);
    assert.deepEqual((await call('PATCH', `/panels/${hk.body.id}`, { tags: ' 美国, 便宜 美国,,' })).body.tags, ['美国', '便宜']);
    assert.deepEqual((await call('PATCH', `/panels/${hk.body.id}`, { monthly_cost: 3 })).body.tags, ['美国', '便宜']);
    assert.deepEqual((await call('GET', '/panels')).body.find((p: any) => p.id === hk.body.id).tags, ['美国', '便宜']);
    assert.deepEqual((await call('PATCH', `/panels/${hk.body.id}`, { tags: ['a', 'a', ' b '] })).body.tags, ['a', 'b']);
    assert.match((await call('PATCH', `/panels/${hk.body.id}`, { tags: ['x'.repeat(21)] })).body.error, /20/);
    assert.match((await call('PATCH', `/panels/${hk.body.id}`, { tags: Array.from({ length: 21 }, (_, i) => `t${i}`) })).body.error, /20/);
    assert.equal((await call('PATCH', `/panels/${hk.body.id}`, { tags: 5 })).status, 400);
    assert.deepEqual((await call('PATCH', `/panels/${hk.body.id}`, { tags: [] })).body.tags, []);

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
    assert.deepEqual([opened.body.line.email, opened.body.line.panel_name, opened.body.created], ['李四', 'hk', { inbound: null }]);
    assert.match(opened.body.links[0], /^vless:\/\/.+@1\.1\.1\.1#李四$/);
    const lid = opened.body.line.id;
    assert.deepEqual((await call('GET', `/customers/${c.id}/lines/${lid}/links`)).body, { links: opened.body.links });
    assert.deepEqual((await call('GET', `/panels/${hk.id}/clients/${encodeURIComponent('李四')}/links`)).body, { links: opened.body.links });
    assert.deepEqual((await call('GET', '/panels')).body.map((p: any) => [p.name, p.line_count]), [['hk', 1]]);

    // 自定义节点名:分享链接跟着换;空 = 恢复面板的;别的客户的线路改不了;太长的不收
    const renamed = await call('PATCH', `/customers/${c.id}/lines/${lid}`, { node_name: ' 香港 01 ' });
    assert.equal(renamed.body.node_name, '香港 01');
    assert.match((await call('GET', `/customers/${c.id}/lines/${lid}/links`)).body.links[0], /#%E9%A6%99%E6%B8%AF%2001$/);
    assert.equal((await call('PATCH', `/customers/${c.id + 99}/lines/${lid}`, { node_name: 'x' })).status, 400);
    assert.match((await call('PATCH', `/customers/${c.id}/lines/${lid}`, { node_name: 'a'.repeat(65) })).body.error, /64/);
    assert.equal((await call('PATCH', `/customers/${c.id}/lines/${lid}`, { node_name: '' })).body.node_name, '');
    assert.deepEqual((await call('GET', `/customers/${c.id}/lines/${lid}/links`)).body, { links: opened.body.links });

    // 面板上流量超了额度:同步后停用
    data.hk.clients[0].traffic = { up: 600, down: 600 };
    assert.deepEqual((await call('POST', '/sync')).body, { ops: [{ customer_id: c.id, customer: '李四', panel: 'hk', email: '李四', action: 'disable', ok: true }] });
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
    assert.deepEqual([patched.state, patched.ops], ['expired', [{ customer_id: c.id, customer: '李四', panel: 'hk', email: '李四', action: 'disable', ok: false, error: '面板报错' }]]);
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

    // 重启:面板和 Xray 各重启一次,回来的是检查后的面板;面板重启报错就不往下重启 Xray
    const restarted = await call('POST', `/panels/${a.id}/restart`);
    assert.deepEqual([restarted.status, restarted.body.xray_state, data.a.panelRestarts, data.a.restarts], [200, 'running', 1, 1]);
    data.a.fail = { ...data.a.fail, restartPanel: '面板重启后没有恢复应答' };
    const stuck = await call('POST', `/panels/${a.id}/restart`);
    assert.deepEqual([stuck.status, /没有恢复应答/.test(stuck.body.error), data.a.restarts], [500, true, 1]);
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

test('外部订阅:保存时新填的马上取一次(取不到也照样保存),没变的不重取;「重新取」不管多久前取过都取', async () => {
  const db = memoryDb();
  const calls: string[] = [];
  let up = true;
  const fetchUpstream: UpstreamFetcher = async (url) => {
    calls.push(url);
    if (!up) throw new Error('fetch failed');
    return { status: 200, body: 'vless://u@203.0.113.1:443?security=reality&pbk=K#a\nvless://u@203.0.113.2:443?security=reality&pbk=K#b', userinfo: null };
  };
  const { call, close } = await serve(db, {}, '', '', fetchUpstream);
  try {
    const A = 'https://sub.example.com/a';
    const B = 'https://sub.example.com/b';
    const made = await call('POST', '/customers', { name: '小王', upstreams: [A], upstream_mode: 'replace' });
    assert.equal(made.status, 200);
    assert.deepEqual([made.body.upstream_mode, made.body.upstream_userinfo, made.body.upstreams.map((u: any) => [u.url, u.nodes, u.error])], ['replace', false, [[A, 2, '']]]);
    assert.deepEqual(calls, [A]);

    up = false;
    const edited = await call('PATCH', `/customers/${made.body.id}`, { upstreams: `${A}\n${B}`, upstream_userinfo: true });
    assert.equal(edited.status, 200);
    assert.deepEqual(edited.body.upstreams.map((u: any) => [u.url, u.nodes, !!u.error]), [[A, 2, false], [B, 0, true]]);
    assert.equal(edited.body.upstream_userinfo, true);
    assert.deepEqual(calls, [A, B]);

    up = true;
    const fresh = await call('POST', `/customers/${made.body.id}/upstreams/refresh`);
    assert.deepEqual(fresh.body.upstreams.map((u: any) => [u.nodes, u.error]), [[2, ''], [2, '']]);
    assert.equal(calls.length, 4);

    assert.equal((await call('PATCH', `/customers/${made.body.id}`, { upstreams: ['sub.example.com/x'] })).status, 400);
    assert.equal((await call('POST', '/customers/999/upstreams/refresh')).status, 400);
  } finally {
    await close();
  }
});

test('面板上手配、点名这条线路的规则:能列出来;只点名他的能删、能接管(按原来的顺序存进出口规则);重启失败改回去;多人共用的删不了', async () => {
  const db = memoryDb();
  const relay = addPanel(db, 'relay', 'https://1.1.1.1:2053/p');
  const data = { relay: relayPanel() };
  const { call, close } = await serve(db, data);
  try {
    const s = (await call('POST', '/socks', { name: 'us', address: 'socks5://u:p@isp.example.com:1080' })).body;
    const c = (await call('POST', '/customers', { name: 'zhang' })).body;
    const line = (await call('POST', `/customers/${c.id}/lines`, { kind: 'direct', panel_id: relay.id, inbound: { id: 5 } })).body.line;
    const base = `/customers/${c.id}/lines/${line.id}/panel-rules`;
    await call('PUT', `/customers/${c.id}/lines/${line.id}/rules`, { rules: [{ domain: ['ads.com'], to: { kind: 'block' } }] });
    // 面板上手配的(迁移前写的那种,没有 ruleTag):一条排在 xui-hub 写的前面,一条指向没登记的代理,一条多人共用
    const x = data.relay.xray;
    x.outbounds.push({ tag: 'old-socks', protocol: 'socks', settings: { servers: [{ address: 'isp.example.com', port: 1080, users: [{ user: 'u', pass: 'p' }] }] } });
    x.outbounds.push({ tag: 'socks-gone.example.com-1', protocol: 'socks', settings: { servers: [{ address: 'gone.example.com', port: 1 }] } });
    const at = x.routing.rules.findIndex((r: any) => r.ruleTag);
    x.routing.rules.splice(at, 0, { type: 'field', inboundTag: ['in-500'], user: [line.email], domain: ['geosite:google'], outboundTag: 'old-socks' }, { type: 'field', user: [line.email], domain: ['junk.com'], outboundTag: 'socks-gone.example.com-1' });
    x.routing.rules.unshift({ type: 'field', inboundTag: ['in-500'], user: [line.email, 'li'], domain: ['shared.com'], outboundTag: 'direct' });

    const listed = (await call('GET', base)).body;
    assert.deepEqual(
      listed.map((r: any) => [r.when.domain[0], r.own, r.takeover?.to ?? null]),
      [
        ['shared.com', false, null],
        ['geosite:google', true, { kind: 'socks', socks_id: s.id }],
        ['junk.com', true, null],
      ],
    );
    const key = (d: string) => listed.find((r: any) => r.when.domain[0] === d).key;
    const restarts = data.relay.restarts;

    // 多人共用的、对不上的 key:不动面板
    assert.match((await call('DELETE', `${base}/${key('shared.com')}`)).body.error, /不能在这里删/);
    assert.match((await call('POST', `${base}/${key('junk.com')}/adopt`)).body.error, /不能接管.*没在 SOCKS 页登记/);
    assert.match((await call('DELETE', `${base}/0123456789abcdef`)).body.error, /没有这条规则了/);
    assert.equal((await call('DELETE', `${base}/zz`)).status, 400);
    assert.equal(data.relay.restarts, restarts);

    // 重启失败:改回原来的配置,规则还在
    data.relay.fail = { restartXray: 'boom' };
    assert.notEqual((await call('DELETE', `${base}/${key('junk.com')}`)).status, 200);
    delete data.relay.fail;
    assert.ok(data.relay.xray.routing.rules.some((r: any) => r.domain?.[0] === 'junk.com'));

    // 删:规则去掉,没人用的出站一起删
    const del = await call('DELETE', `${base}/${key('junk.com')}`);
    assert.equal(del.status, 200);
    assert.ok(!data.relay.xray.routing.rules.some((r: any) => r.domain?.[0] === 'junk.com'));
    assert.ok(!data.relay.xray.outbounds.some((o: any) => o.tag === 'socks-gone.example.com-1'));

    // 接管:排在 xui-hub 写的那条前面,存进出口规则也排第一;复用原来的出站;实际出口里手配的那跳变成 xui-hub 管的
    const adopted = await call('POST', `${base}/${key('geosite:google')}/adopt`);
    assert.equal(adopted.status, 200);
    assert.deepEqual(adopted.body.line.rules.map((r: any) => [r.domain[0], r.to.kind]), [['geosite:google', 'socks'], ['ads.com', 'block']]);
    const tagged = data.relay.xray.routing.rules.filter((r: any) => r.user?.[0] === line.email && r.user.length === 1);
    assert.deepEqual(tagged.map((r: any) => [r.ruleTag, r.domain[0], r.outboundTag]), [
      [`xui-hub:in-500:${line.email}:1`, 'geosite:google', 'old-socks'],
      [`xui-hub:in-500:${line.email}:2`, 'ads.com', 'blocked'],
    ]);
    assert.deepEqual(adopted.body.line.routes.map((h: any) => [h.when.domain?.[0] ?? 'rest', h.origin ?? null]), [
      ['shared.com', 'shared'],
      ['geosite:google', 'xui'],
      ['ads.com', 'xui'],
      ['rest', null],
    ]);
    assert.deepEqual((await call('GET', base)).body.map((r: any) => r.when.domain[0]), ['shared.com']);
    assert.match(listOpLog(db).rows[0].summary, /^接管「zhang」线路 .+ 在面板上手配的规则:geosite:google → SOCKS「us」$/);
    assert.match(listOpLog(db).rows[1].summary, /^删除「zhang」线路 .+ 在面板上手配的规则:junk\.com → 出站「socks-gone\.example\.com-1」$/);
  } finally {
    await close();
  }
});

test('出口规则:写到面板并重启、存下规则和实际出口;不合法不动面板;改 SOCKS 地址跟着改;被规则用着的 SOCKS 删不了;删线路一起去掉', async () => {
  const db = memoryDb();
  const relay = addPanel(db, 'relay', 'https://1.1.1.1:2053/p');
  const data = { relay: relayPanel() };
  const { call, close } = await serve(db, data);
  try {
    const s = (await call('POST', '/socks', { name: 'us', address: 'socks5://u:p@isp.example.com:1080' })).body;
    const c = (await call('POST', '/customers', { name: 'zhang' })).body;
    const line = (await call('POST', `/customers/${c.id}/lines`, { kind: 'direct', panel_id: relay.id, inbound: { id: 5 } })).body.line;
    const restarts = data.relay.restarts;

    assert.equal((await call('PUT', `/customers/${c.id}/lines/${line.id}/rules`, { rules: [{ to: { kind: 'direct' } }] })).status, 400);
    assert.equal(data.relay.restarts, restarts);

    const rules = [
      { domain: ['geosite:netflix', 'netflix.com'], to: { kind: 'socks', socks_id: s.id } },
      { domain: ['geosite:category-ads-all'], to: { kind: 'block' } },
    ];
    const saved = await call('PUT', `/customers/${c.id}/lines/${line.id}/rules`, { rules });
    assert.equal(saved.status, 200);
    assert.equal(data.relay.restarts, restarts + 1);
    assert.deepEqual(saved.body.rules.map((r: any) => [r.domain, r.to]), [[['geosite:netflix', 'netflix.com'], { kind: 'socks', socks_id: s.id }], [['geosite:category-ads-all'], { kind: 'block' }]]);
    assert.deepEqual(saved.body.routes.map((h: any) => [h.when.domain ?? 'rest', h.to.kind, h.to.socks_id ?? null]), [
      [['geosite:netflix', 'netflix.com'], 'socks', s.id],
      [['geosite:category-ads-all'], 'block', null],
      ['rest', 'direct', null],
    ]);
    const tagged = data.relay.xray.routing.rules.filter((r: any) => r.ruleTag);
    assert.deepEqual(tagged.map((r: any) => [r.ruleTag, r.user, r.outboundTag]), [
      ['xui-hub:in-500:zhang:1', ['zhang'], 'socks-isp.example.com-1080'],
      ['xui-hub:in-500:zhang:2', ['zhang'], 'blocked'],
    ]);
    assert.equal((await call('GET', '/socks')).body[0].used_by, 1);

    // 改 SOCKS 地址:规则跟着指到新地址
    assert.equal((await call('PATCH', `/socks/${s.id}`, { address: 'socks5://u:p@new.example.com:2080' })).status, 200);
    assert.equal(data.relay.xray.routing.rules.find((r: any) => r.ruleTag === 'xui-hub:in-500:zhang:1').outboundTag, 'socks-new.example.com-2080');
    assert.ok(!data.relay.xray.outbounds.some((o: any) => o.tag === 'socks-isp.example.com-1080'));
    assert.match((await call('DELETE', `/socks/${s.id}`)).body.error, /还有 1 条线路在用/);

    // 去掉规则:面板上的也去掉
    const cleared = await call('PUT', `/customers/${c.id}/lines/${line.id}/rules`, { rules: [] });
    assert.deepEqual([cleared.body.rules, data.relay.xray.routing.rules.filter((r: any) => r.ruleTag).length], [[], 0]);
    assert.ok(!data.relay.xray.outbounds.some((o: any) => o.tag === 'socks-new.example.com-2080'));

    // 删线路:本系统写的规则一起去掉
    await call('PUT', `/customers/${c.id}/lines/${line.id}/rules`, { rules: [{ ip: ['geoip:cn'], to: { kind: 'direct' } }] });
    assert.equal(data.relay.xray.routing.rules.filter((r: any) => r.ruleTag).length, 1);
    await call('DELETE', `/customers/${c.id}/lines/${line.id}`);
    assert.equal(data.relay.xray.routing.rules.filter((r: any) => r.ruleTag).length, 0);
    assert.deepEqual((await call('DELETE', `/socks/${s.id}`)).body, { ok: true });
  } finally {
    await close();
  }
});

const GEO: NonNullable<FakePanel['geo']> = {
  'geosite.dat': {
    kind: 'site',
    categories: [
      { code: 'netflix', entries: 2, attributes: [], items: [{ kind: 'domain', value: 'netflix.com' }, { kind: 'domain', value: 'fast.com' }] },
      { code: 'cn', entries: 1, attributes: ['ads'], items: [{ kind: 'domain', value: 'baidu.com' }] },
    ],
  },
  'geoip.dat': { kind: 'ip', categories: [{ code: 'cn', entries: 1, attributes: [], items: [{ kind: 'cidr', value: '1.0.1.0/24' }] }] },
};

test('geo 库:按面板的库浏览分类、条目和核对写法;写错的分类保存前就拦下、不动面板;面板太老(没有 geo 接口)时说不支持、规则照旧能存', async () => {
  const db = memoryDb();
  const relay = addPanel(db, 'relay', 'https://1.1.1.1:2053/p');
  const old = addPanel(db, 'old', 'https://2.2.2.2:2053/p');
  const data: Record<string, FakePanel> = { relay: { ...relayPanel(), geo: GEO }, old: relayPanel() };
  const { call, close } = await serve(db, data);
  try {
    const files = await call('GET', `/panels/${relay.id}/geodata/files`);
    assert.deepEqual([files.body.supported, files.body.files.map((f: any) => [f.name, f.kind, f.categories])], [true, [['geosite.dat', 'site', 2], ['geoip.dat', 'ip', 1]]]);
    const cats = await call('GET', `/panels/${relay.id}/geodata/categories?file=geosite.dat`);
    assert.deepEqual(cats.body, { supported: true, items: [{ code: 'netflix', entries: 2, attributes: [] }, { code: 'cn', entries: 1, attributes: ['ads'] }] });
    const entries = await call('GET', `/panels/${relay.id}/geodata/entries?file=geosite.dat&code=netflix&q=fast&limit=1`);
    assert.deepEqual(entries.body, { supported: true, total: 1, items: [{ kind: 'domain', value: 'fast.com' }] });
    for (const bad of ['../x.dat', 'geosite.txt', '']) assert.equal((await call('GET', `/panels/${relay.id}/geodata/categories?file=${encodeURIComponent(bad)}`)).status, 400, bad);
    assert.equal((await call('GET', `/panels/${relay.id}/geodata/entries?file=geosite.dat&code=netflix&limit=501`)).status, 400);
    assert.equal((await call('GET', `/panels/${relay.id}/geodata/entries?file=geosite.dat&code=a%20b`)).status, 400);

    // 核对:只把要查库的写法发给面板,普通域名不发
    const checked = await call('POST', `/panels/${relay.id}/geodata/validate`, { kind: 'site', tokens: ['geosite:netfix', 'geosite:netflix', 'netflix.com', 'geoip:cn', 'geosite:cn@nope'] });
    assert.deepEqual(checked.body, {
      supported: true,
      issues: [
        { token: 'geosite:netfix', reason: 'categoryMissing', file: 'geosite.dat', code: 'netfix' },
        { token: 'geoip:cn', reason: 'wrongKind' },
        { token: 'geosite:cn@nope', reason: 'attributeMissing', file: 'geosite.dat', code: 'nope' },
      ],
    });
    assert.deepEqual(data.relay.geoChecks!.at(-1)!.tokens, ['geosite:netfix', 'geosite:netflix', 'geoip:cn', 'geosite:cn@nope']);
    assert.equal((await call('POST', `/panels/${relay.id}/geodata/validate`, { kind: 'x', tokens: [] })).status, 400);

    // 面板太老:浏览和核对都说不支持
    assert.deepEqual((await call('GET', `/panels/${old.id}/geodata/files`)).body, { supported: false });
    assert.deepEqual((await call('POST', `/panels/${old.id}/geodata/validate`, { kind: 'ip', tokens: ['geoip:cn'] })).body, { supported: false, issues: [] });

    const c = (await call('POST', '/customers', { name: 'zhang' })).body;
    const line = (await call('POST', `/customers/${c.id}/lines`, { kind: 'direct', panel_id: relay.id, inbound: { id: 5 } })).body.line;
    const restarts = data.relay.restarts;
    const put = (rules: unknown[], l = line) => call('PUT', `/customers/${c.id}/lines/${l.id}/rules`, { rules });
    // 分类写错、geoip 填进域名:Xray 起不来,保存前拦下,面板不动
    const typo = await put([{ domain: ['geosite:netflix'], to: { kind: 'block' } }, { domain: ['geosite:netfix'], to: { kind: 'block' } }]);
    assert.equal(typo.status, 400);
    assert.match(typo.body.error, /第 2 条规则的域名「geosite:netfix」:面板的 geosite\.dat 里没有「netfix」这个分类/);
    assert.match((await put([{ domain: ['geoip:cn'], to: { kind: 'direct' } }])).body.error, /geoip 是 IP 库,要填在 IP 里/);
    assert.match((await put([{ ip: ['ext:geoip_IR.dat:ir'], to: { kind: 'direct' } }])).body.error, /IP「ext:geoip_IR\.dat:ir」:面板上没有 geoip_IR\.dat 这个库/);
    assert.equal(data.relay.restarts, restarts);
    // 属性不存在:Xray 能起来,照存
    assert.equal((await put([{ domain: ['geosite:cn@nope'], ip: ['geoip:cn', '10.0.0.0/8'], to: { kind: 'direct' } }])).status, 200);
    assert.equal(data.relay.restarts, restarts + 1);
    // 开线路时带写错的规则:什么都不建
    const before = data.relay.clients.length;
    const opened = await call('POST', `/customers/${c.id}/lines`, { kind: 'direct', panel_id: relay.id, inbound: { id: 5 }, rules: [{ domain: ['geosite:netfix'], to: { kind: 'block' } }] });
    assert.equal(opened.status, 400);
    assert.equal(data.relay.clients.length, before);

    // 太老的面板:不核对,照旧写
    const oldLine = (await call('POST', `/customers/${c.id}/lines`, { kind: 'direct', panel_id: old.id, inbound: { id: 5 } })).body.line;
    assert.equal((await put([{ domain: ['geosite:whatever'], to: { kind: 'block' } }], oldLine)).status, 200);
  } finally {
    await close();
  }
});

test('客户已用:面板倍率算进额度;删线路后它的流量留在已用里;调整已用超了额度马上停用;改面板倍率前能预览谁会超额', async () => {
  const db = memoryDb();
  const hk = addPanel(db, 'hk', 'https://1.1.1.1:2053/p');
  const data = { hk: panel() };
  const { call, close } = await serve(db, data);
  try {
    assert.equal((await call('PATCH', `/panels/${hk.id}`, { traffic_ratio: 2 })).body.traffic_ratio, 2);
    assert.equal((await call('GET', '/panels')).body[0].traffic_ratio, 2);
    const c = (await call('POST', '/customers', { name: '王五', quota_bytes: 3000, traffic_ratio: 5 })).body;
    // 客户上没有倍率了,传了也不认
    assert.equal(c.traffic_ratio, undefined);
    const first = (await call('POST', `/customers/${c.id}/lines`, { kind: 'direct', panel_id: hk.id, inbound: { id: 7 } })).body.line.id;
    data.hk.clients[0].traffic = { up: 100, down: 900 };
    await call('POST', '/sync');
    let v = (await call('GET', '/customers')).body[0];
    assert.deepEqual([v.actual_used, v.used, v.lines[0].panel_ratio, v.lines[0].used_down, v.state], [1000, 2000, 2, 1800, 'active']);

    // 预览:改成 3 会超额(3000 ≥ 3000),改成 1.5 不会;只算不改
    const preview = (await call('GET', `/panels/${hk.id}/ratio-preview?ratio=3`)).body;
    assert.deepEqual(preview, { ratio_before: 2, ratio: 3, over_after: 1, customers: [{ id: c.id, name: '王五', quota_bytes: 3000, used_before: 2000, used_after: 3000, over_before: false, over_after: true }] });
    assert.equal((await call('GET', `/panels/${hk.id}/ratio-preview?ratio=1.5`)).body.over_after, 0);
    assert.match((await call('GET', `/panels/${hk.id}/ratio-preview?ratio=0`)).body.error, /流量倍率/);
    assert.equal((await call('GET', '/customers')).body[0].used, 2000);
    // 真改成 3:当场超额,线路马上停用;改回 2 马上恢复
    const up = (await call('PATCH', `/panels/${hk.id}`, { traffic_ratio: 3 })).body;
    assert.deepEqual([up.traffic_ratio, up.ops.map((o: any) => [o.action, o.ok])], [3, [['disable', true]]]);
    assert.deepEqual([(await call('GET', '/customers')).body[0].used, (await call('GET', '/customers')).body[0].state], [3000, 'over_quota']);
    const down = (await call('PATCH', `/panels/${hk.id}`, { traffic_ratio: 2 })).body;
    assert.deepEqual([down.ops.map((o: any) => o.action), (await call('GET', '/customers')).body[0].state], [['enable'], 'active']);
    // 没改倍率的修改不去动客户端
    assert.deepEqual((await call('PATCH', `/panels/${hk.id}`, { tags: ['x'] })).body.ops, []);

    // 删线路:流量留在已用里,计费的按删时的倍率 2 折好
    assert.deepEqual((await call('DELETE', `/customers/${c.id}/lines/${first}`)).body, { ok: true });
    v = (await call('GET', '/customers')).body[0];
    assert.deepEqual([v.lines.length, v.actual_used, v.used, v.carried_down, v.carried_used_down], [0, 1000, 2000, 900, 1800]);

    // 再开一条,调整已用:加 600 计费(不乘倍率),到 2600;再加 400 到 3000 超了额度 → 新线路马上停用
    await call('POST', `/customers/${c.id}/lines`, { kind: 'direct', panel_id: hk.id, inbound: { id: 7 } });
    const adj = (await call('POST', `/customers/${c.id}/adjust-usage`, { down: 600 })).body;
    assert.deepEqual([adj.actual_used, adj.used, adj.state, adj.ops.map((o: any) => o.action)], [1600, 2600, 'active', []]);
    const over = (await call('POST', `/customers/${c.id}/adjust-usage`, { down: 400 })).body;
    assert.deepEqual([over.used, over.state, over.ops.map((o: any) => [o.action, o.ok])], [3000, 'over_quota', [['disable', true]]]);
    assert.equal((await call('POST', `/customers/${c.id}/adjust-usage`, { down: -99999 })).status, 400);

    // 面板倍率调回 1:已经结转的不变(1800 + 1000),新线路上没流量,还是超额;调整减掉 500 才恢复
    const back = (await call('PATCH', `/panels/${hk.id}`, { traffic_ratio: 1 })).body;
    assert.equal(back.traffic_ratio, 1);
    assert.deepEqual([(await call('GET', '/customers')).body[0].used, (await call('GET', '/customers')).body[0].state], [3000, 'over_quota']);
    const fixed = (await call('POST', `/customers/${c.id}/adjust-usage`, { down: -500 })).body;
    assert.deepEqual([fixed.used, fixed.state, fixed.ops.map((o: any) => o.action)], [2500, 'active', ['enable']]);
    assert.match((await call('PATCH', `/panels/${hk.id}`, { traffic_ratio: 0 })).body.error, /流量倍率/);
  } finally {
    await close();
  }
});

test('流量统计接口:exclude=面板 id 逗号分隔,这些面板的流量不算;customers=只算这些客户的;写错报 400', async () => {
  const db = memoryDb();
  const p1 = addPanel(db, 'p1');
  const p2 = addPanel(db, 'p2');
  const now = Date.now();
  for (const p of [p1, p2]) recordTraffic(db, p.id, [{ email: 'a', up: 0, down: 0 }], now - 2);
  recordTraffic(db, p1.id, [{ email: 'a', up: 1, down: 2 }], now - 1);
  recordTraffic(db, p2.id, [{ email: 'a', up: 10, down: 20 }], now - 1);
  const { call, close } = await serve(db);
  try {
    const names = async (q: string) => ((await call('GET', `/traffic?by=panel&days=1${q}`)).body.rows as { name: string }[]).map((r) => r.name).sort();
    assert.deepEqual(await names(''), ['p1', 'p2']);
    assert.deepEqual(await names('&exclude='), ['p1', 'p2']);
    assert.deepEqual(await names(`&exclude=${p2.id}`), ['p1']);
    assert.deepEqual(await names(`&exclude=${p1.id},${p2.id}`), []);
    assert.deepEqual((await call('GET', `/traffic?by=customer&days=1&exclude=${p2.id}`)).body.total, { up: [1], down: [2] });
    for (const bad of ['abc', '1,x', '-1', '1.5']) assert.equal((await call('GET', `/traffic?exclude=${bad}`)).status, 400, bad);
    // customers=:只算这些客户的,0 = 没归入客户的
    assert.deepEqual((await call('GET', '/traffic?by=panel&days=1&customers=0')).body.total, { up: [11], down: [22] });
    assert.deepEqual((await call('GET', '/traffic?by=panel&days=1&customers=999')).body.rows, []);
    for (const bad of ['abc', '1,x', '-1', '1.5']) assert.equal((await call('GET', `/traffic?customers=${bad}`)).status, 400, bad);
  } finally {
    await close();
  }
});

test('批量删线路:同一块面板只重启一次 Xray,删成了的删记录、流量留在客户已用里;面板连不上的留着记录带原因,force 只删记录', async () => {
  const db = memoryDb();
  const a = addPanel(db, 'a');
  const data = { a: relayPanel() };
  const { call, close } = await serve(db, data);
  try {
    const sid = (await call('POST', '/socks', { name: 'land', address: 'socks5://u:p@2.2.2.2:3000' })).body.id;
    const ids: number[] = [];
    const lines: number[] = [];
    for (const name of ['li', 'wang', 'zhao']) {
      const c = (await call('POST', '/customers', { name })).body;
      ids.push(c.id);
      const exit = name === 'zhao' ? {} : { exit: { kind: 'socks', socks_id: sid } };
      lines.push((await call('POST', `/customers/${c.id}/lines`, { panel_id: a.id, inbound: { id: 5 }, ...exit })).body.line.id);
    }
    data.a.clients.find((c) => c.email === 'li')!.traffic = { up: 10, down: 20 };
    await call('POST', '/sync');
    const restarts = data.a.restarts;

    // 删 li、zhao:Xray 只重启一次,li 的规则去掉、wang 的留着
    const r = (await call('POST', '/lines/batch-delete', { line_ids: [lines[0], lines[2]] })).body;
    assert.deepEqual(r, { deleted: [lines[0], lines[2]], missing: [], failed: [] });
    assert.equal(data.a.restarts, restarts + 1);
    assert.deepEqual(emails(data.a), ['wang']);
    assert.deepEqual(data.a.xray.routing.rules.filter((x: any) => x.user).map((x: any) => x.user[0]), ['wang']);
    const li = getCustomer(db, ids[0])!;
    assert.deepEqual([li.lines.length, li.actual_up, li.actual_down], [0, 10, 20]);

    // 面板连不上:留着记录,带原因;force 只删记录
    data.a.fail = { listClients: new XUIError('连接失败:超时') };
    const bad = (await call('POST', '/lines/batch-delete', { line_ids: [lines[1]] })).body;
    assert.deepEqual([bad.deleted, bad.failed.map((f: any) => [f.id, f.error])], [[], [[lines[1], '连接失败:超时']]]);
    assert.equal(getCustomer(db, ids[1])!.lines.length, 1);
    assert.deepEqual((await call('POST', '/lines/batch-delete', { line_ids: [lines[1]], force: true })).body, { deleted: [lines[1]], missing: [], failed: [] });
    assert.equal(getCustomer(db, ids[1])!.lines.length, 0);

    // 已经不在的跳过(放在 missing 里),不连累同一批的其它线路
    data.a.fail = {};
    const more = (await call('POST', `/customers/${ids[1]}/lines`, { panel_id: a.id, inbound: { id: 5 } })).body.line.id;
    assert.ok(more > lines[2], '线路 id 不复用');
    assert.deepEqual((await call('POST', '/lines/batch-delete', { line_ids: [lines[1], more, lines[0]] })).body, { deleted: [more], missing: [lines[1], lines[0]], failed: [] });
    assert.match(listOpLog(db).rows[0].summary, /2 条已经不在了,跳过$/);
    assert.deepEqual((await call('POST', '/lines/batch-delete', { line_ids: [more] })).body, { deleted: [], missing: [more], failed: [] });

    // 参数不对
    for (const body of [{}, { line_ids: [] }, { line_ids: ['x'] }, { line_ids: [0] }]) assert.equal((await call('POST', '/lines/batch-delete', body)).status, 400, JSON.stringify(body));
  } finally {
    await close();
  }
});

test('线路原地换出口:单条换 SOCKS、整位客户换直出;UUID 不变、不删线路;同一块面板只重启一次;条件规则和手配规则不碰;已经是这个出口不重启', async () => {
  const db = memoryDb();
  const a = addPanel(db, 'a');
  const b = addPanel(db, 'b');
  const data = { a: relayPanel(), b: relayPanel() };
  const { call, close } = await serve(db, data);
  try {
    const s1 = (await call('POST', '/socks', { name: 'isp1', address: 'socks5://u:p@isp1.example.com:1080' })).body.id;
    const s2 = (await call('POST', '/socks', { name: 'isp2', address: 'socks5://u2:p2@isp2.example.com:2080' })).body.id;
    const c = (await call('POST', '/customers', { name: 'zhang' })).body;
    const open = async (panel_id: number, exit?: number) => (await call('POST', `/customers/${c.id}/lines`, { panel_id, inbound: { id: 5 }, ...(exit ? { exit: { kind: 'socks', socks_id: exit } } : {}) })).body.line;
    const l1 = await open(a.id);
    const l2 = await open(a.id, s1);
    const l3 = await open(b.id, s1);
    // l2 带一条出口规则;面板 a 上还有一条手配的、点名 l2 的带条件规则
    await call('PUT', `/customers/${c.id}/lines/${l2.id}/rules`, { rules: [{ domain: ['ads.example.com'], to: { kind: 'block' } }] });
    data.a.xray.routing.rules.unshift({ type: 'field', inboundTag: ['in-500'], user: [l2.email], port: '25', outboundTag: 'direct' });
    const uuids = () => [...data.a.clients, ...data.b.clients].map((x) => `${x.email}:${x.id}`).sort();
    const before = uuids();
    const restarts = () => [data.a.restarts, data.b.restarts];
    const r0 = restarts();
    const userRule = (d: FakePanel, email: string) => d.xray.routing.rules.find((r: any) => r.user?.[0] === email && !r.ruleTag && Object.keys(r).length === 4);
    const outOf = (d: FakePanel, tag: string) => d.xray.outbounds.find((o: any) => o.tag === tag);

    // 单条:直出 → SOCKS isp2
    const one = await call('PUT', `/customers/${c.id}/lines/${l1.id}/exit`, { exit: { kind: 'socks', socks_id: s2 } });
    assert.equal(one.status, 200);
    assert.deepEqual([one.body.kind, one.body.exit_kind, one.body.exit_socks_id, one.body.exit_label], ['relay', 'socks', s2, 'SOCKS isp2']);
    assert.equal(outOf(data.a, userRule(data.a, l1.email).outboundTag).settings.servers[0].address, 'isp2.example.com');
    // 实际出口马上刷新
    assert.deepEqual(one.body.routes.map((h: any) => [h.to.kind, h.to.socks_id ?? null]), [['socks', s2]]);
    assert.deepEqual(restarts(), [r0[0] + 1, r0[1]]);

    // 整位客户:全部换成直出。面板 a、b 各重启一次;l2 的出口规则和手配规则还在;没人用的 socks 出站删掉
    const all = await call('POST', '/lines/batch-exit', { customer_id: c.id, exit: { kind: 'direct' } });
    assert.deepEqual([all.body.changed.sort(), all.body.failed], [[l1.id, l2.id, l3.id], []]);
    assert.deepEqual(restarts(), [r0[0] + 2, r0[1] + 1]);
    for (const [d, e] of [[data.a, l1.email], [data.a, l2.email], [data.b, l3.email]] as const) assert.equal(userRule(d, e), undefined, e);
    assert.ok(data.a.xray.routing.rules.some((r: any) => r.ruleTag && r.user?.[0] === l2.email && r.domain?.[0] === 'ads.example.com'));
    assert.ok(data.a.xray.routing.rules.some((r: any) => r.port === '25' && r.user?.[0] === l2.email));
    assert.deepEqual([data.a.xray.outbounds.filter((o: any) => o.protocol === 'socks').length, data.b.xray.outbounds.filter((o: any) => o.protocol === 'socks').length], [0, 0]);
    const lines = getCustomer(db, c.id)!.lines;
    assert.deepEqual(lines.map((l) => [l.kind, l.exit_socks_id, l.exit_label]), [['direct', null, ''], ['direct', null, ''], ['direct', null, '']]);
    // 不删线路、UUID 不变
    assert.deepEqual([lines.length, uuids()], [3, before]);

    // 已经是直出:不写、不重启
    await call('POST', '/lines/batch-exit', { line_ids: [l1.id, l3.id], exit: { kind: 'direct' } });
    assert.deepEqual(restarts(), [r0[0] + 2, r0[1] + 1]);

    // 写错的:出口不对、SOCKS 不存在、线路不是这位客户的、啥都没给
    const other = (await call('POST', '/customers', { name: 'li' })).body;
    for (const [path, body] of [
      [`/customers/${c.id}/lines/${l1.id}/exit`, { exit: { kind: 'panel', panel_id: b.id } }],
      [`/customers/${c.id}/lines/${l1.id}/exit`, { exit: { kind: 'socks', socks_id: 999 } }],
      ['/lines/batch-exit', { customer_id: other.id, line_ids: [l1.id], exit: { kind: 'direct' } }],
      ['/lines/batch-exit', { exit: { kind: 'direct' } }],
      ['/lines/batch-exit', { customer_id: other.id, exit: { kind: 'direct' } }],
    ] as const)
      assert.equal((await call(path.endsWith('/exit') ? 'PUT' : 'POST', path, body)).status, 400, JSON.stringify(body));
  } finally {
    await close();
  }
});

test('批量换出口:哪块面板没成,只有那块上的线路不改记录、带原因,其余照常;单条没成回 502', async () => {
  const db = memoryDb();
  const a = addPanel(db, 'a');
  const b = addPanel(db, 'b');
  const data = { a: relayPanel(), b: relayPanel() };
  const { call, close } = await serve(db, data);
  try {
    const s1 = (await call('POST', '/socks', { name: 'isp1', address: 'socks5://isp1.example.com:1080' })).body.id;
    const c = (await call('POST', '/customers', { name: 'zhang' })).body;
    const la = (await call('POST', `/customers/${c.id}/lines`, { panel_id: a.id, inbound: { id: 5 } })).body.line;
    const lb = (await call('POST', `/customers/${c.id}/lines`, { panel_id: b.id, inbound: { id: 5 } })).body.line;
    data.b.fail = { updateXray: new XUIError('连接失败:超时') };
    const r = await call('POST', '/lines/batch-exit', { line_ids: [la.id, lb.id], exit: { kind: 'socks', socks_id: s1 } });
    assert.deepEqual(r.body.changed, [la.id]);
    assert.deepEqual(r.body.failed, [{ id: lb.id, line: `b 上的 ${lb.email}`, error: '连接失败:超时' }]);
    const [ka, kb] = getCustomer(db, c.id)!.lines;
    assert.deepEqual([ka.kind, ka.exit_socks_id, kb.kind, kb.exit_socks_id], ['relay', s1, 'direct', null]);
    assert.equal((await call('PUT', `/customers/${c.id}/lines/${lb.id}/exit`, { exit: { kind: 'socks', socks_id: s1 } })).status, 502);

    // 写进去了,但 Xray 没起来:面板改回原来的配置,记录不动
    data.b.fail = { restartXray: new XUIError('Xray 没有恢复运行') };
    const originalB = JSON.stringify(data.b.xray);
    const down = await call('PUT', `/customers/${c.id}/lines/${lb.id}/exit`, { exit: { kind: 'socks', socks_id: s1 } });
    assert.deepEqual([down.status, down.body.error], [502, 'Xray 没有恢复运行']);
    assert.equal(JSON.stringify(data.b.xray), originalB);
    assert.equal(getCustomer(db, c.id)!.lines[1].kind, 'direct');

    // 写进去了但读回来不对(面板没存上):不改记录
    delete data.b.fail;
    const fake = fakePanels(data);
    const { call: call2, close: close2 } = await serve(db, data, '', '', undefined, (p) => {
      const client = fake(p);
      return p.name === 'b' ? { ...client, updateXray: async () => {} } : client;
    });
    try {
      const bad = await call2('PUT', `/customers/${c.id}/lines/${lb.id}/exit`, { exit: { kind: 'socks', socks_id: s1 } });
      assert.deepEqual([bad.status, /读回来/.test(bad.body.error)], [502, true]);
      assert.equal(getCustomer(db, c.id)!.lines[1].kind, 'direct');
    } finally {
      await close2();
    }
  } finally {
    await close();
  }
});

test('面板的节点名:改面板节点名不动线路记录;一键改名把这块面板上线路各自设的清掉、跟着面板的;没填节点名不让一键改', async () => {
  const db = memoryDb();
  const a = addPanel(db, 'a');
  const b = addPanel(db, 'b');
  const data = { a: relayPanel(), b: relayPanel() };
  const { call, close } = await serve(db, data);
  try {
    const c = (await call('POST', '/customers', { name: 'zhang' })).body;
    const l1 = (await call('POST', `/customers/${c.id}/lines`, { panel_id: a.id, inbound: { id: 5 }, node_name: '专线' })).body.line;
    const l2 = (await call('POST', `/customers/${c.id}/lines`, { panel_id: a.id, inbound: { id: 5 } })).body.line;
    const l3 = (await call('POST', `/customers/${c.id}/lines`, { panel_id: b.id, inbound: { id: 5 }, node_name: '别的面板' })).body.line;
    assert.equal((await call('POST', `/panels/${a.id}/line-names`)).status, 400);

    const p = (await call('PATCH', `/panels/${a.id}`, { node_name: ' 香港 01 ' })).body;
    assert.equal(p.node_name, '香港 01');
    // 线路记录不动;没设节点名的线路在链接里用面板的
    const lines = () => getCustomer(db, c.id)!.lines.map((l) => [l.node_name, l.panel_node_name]);
    assert.deepEqual(lines(), [['专线', '香港 01'], ['', '香港 01'], ['别的面板', '']]);
    const links = (await call('GET', `/customers/${c.id}/lines/${l2.id}/links`)).body.links;
    assert.match(links[0], /#%E9%A6%99%E6%B8%AF%2001$/);
    // 开线路时没给节点名:返回的链接也用面板的
    const l4 = (await call('POST', `/customers/${c.id}/lines`, { panel_id: a.id, inbound: { id: 5 } })).body;
    assert.match(l4.links[0], /#%E9%A6%99%E6%B8%AF%2001$/);

    // 一键改名:只清面板 a 上的,别的面板不动;面板上的客户端、UUID、Xray 都不动
    const before = JSON.stringify([data.a.clients, data.a.xray, data.a.restarts]);
    const r = (await call('POST', `/panels/${a.id}/line-names`)).body;
    assert.equal(r.changed, 1);
    assert.deepEqual(lines(), [['', '香港 01'], ['', '香港 01'], ['别的面板', ''], ['', '香港 01']]);
    assert.equal(JSON.stringify([data.a.clients, data.a.xray, data.a.restarts]), before);
    void l1;
    void l3;
    // 节点名太长 / 有换行不让存
    assert.equal((await call('PATCH', `/panels/${a.id}`, { node_name: 'x'.repeat(65) })).status, 400);
    assert.equal((await call('PATCH', `/panels/${a.id}`, { node_name: 'a\nb' })).status, 400);
    // 清空:回到面板生成的名字
    assert.equal((await call('PATCH', `/panels/${a.id}`, { node_name: '' })).body.node_name, '');
  } finally {
    await close();
  }
});

test('连接中途断开(浏览器 / 代理那侧先断):线路照样开好,做完时补记一条操作日志并注明', async () => {
  const db = memoryDb();
  const data = { a: panel() };
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let begin!: () => void;
  const begun = new Promise<void>((r) => (begin = r));
  const fake = fakePanels(data);
  // 往面板加客户端时卡住,等测试先把连接断掉
  const clientFor = (p: Panel) => {
    const c = fake(p);
    return {
      ...c,
      addClient: async (...args: Parameters<typeof c.addClient>) => {
        begin();
        await gate;
        return c.addClient(...args);
      },
    };
  };
  const { call, base, close } = await serve(db, data, '', '', undefined, clientFor);
  const wait = async (ok: () => boolean) => {
    for (let i = 0; i < 100 && !ok(); i++) await new Promise((r) => setTimeout(r, 20));
    assert.ok(ok());
  };
  try {
    const pid = (await call('POST', '/panels', { name: 'a', base_url: 'https://a.example.com', token: 't' })).body.id;
    const c = (await call('POST', '/customers', { name: 'li' })).body;
    const before = listOpLog(db).rows.length;
    const ac = new AbortController();
    const open = (signal?: AbortSignal) =>
      fetch(`${base}/customers/${c.id}/lines`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'drop-1' }, body: JSON.stringify({ panel_id: pid, inbound: { id: 7 } }), signal });
    const req = open(ac.signal).catch((e) => e);
    // 浏览器在连接断了之后自己重发同一个请求:不再开一条,等第一次做完拿它的结果
    const retry = (async () => {
      await begun;
      await new Promise((r) => setTimeout(r, 30));
      const r = await open();
      return [r.status, await r.json()] as const;
    })();
    await begun;
    ac.abort();
    assert.equal((await req).name, 'AbortError');
    await new Promise((r) => setTimeout(r, 50));
    release();
    await wait(() => listOpLog(db).rows.length > before);
    const row = listOpLog(db).rows[0];
    assert.deepEqual([row.ok, row.customer_id], [true, c.id]);
    assert.ok(row.summary.startsWith('给「li」开线路:') && row.summary.endsWith('(连接中途断开,页面没收到结果)'), row.summary);
    assert.equal(getCustomer(db, c.id)!.lines.length, 1);
    assert.deepEqual(emails(data.a), ['li']);
    const [status, body] = await retry;
    assert.deepEqual([status, body.line.id, body.line.email], [200, getCustomer(db, c.id)!.lines[0].id, 'li']);
    assert.equal(listOpLog(db).rows.filter((r) => r.summary.startsWith('给「li」开线路')).length, 1);

    // 正常的请求不带这句
    await call('PATCH', `/customers/${c.id}`, { remark: 'x' });
    assert.ok(!listOpLog(db).rows[0].summary.includes('连接中途断开'));
  } finally {
    await close();
  }
});

test('同一个请求重发(同一个 Idempotency-Key)只做一次:同时来的和之后来的都拿第一次的结果;换个 key 照常做', async () => {
  const db = memoryDb();
  const data = { a: panel() };
  const { call, base, close } = await serve(db, data);
  try {
    const pid = (await call('POST', '/panels', { name: 'a', base_url: 'https://a.example.com', token: 't' })).body.id;
    const c = (await call('POST', '/customers', { name: 'li' })).body;
    const send = async (key: string, path = `/customers/${c.id}/lines`, body: unknown = { panel_id: pid, inbound: { id: 7 } }) => {
      const r = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(body) });
      return [r.status, await r.json()] as const;
    };
    const [a, b] = await Promise.all([send('k1'), send('k1')]);
    assert.equal(a[0], 200);
    assert.deepEqual(b, a);
    assert.deepEqual(await send('k1'), a);
    assert.equal(getCustomer(db, c.id)!.lines.length, 1);
    assert.equal(listOpLog(db).rows.filter((r) => r.summary.startsWith('给「li」开线路')).length, 1);
    assert.equal((await send('k2'))[0], 200);
    assert.equal(getCustomer(db, c.id)!.lines.length, 2);
    // 没成的也一样:重发拿同一个错误,不再试
    const bad = await send('k3', `/customers/${c.id}/lines`, { panel_id: pid, inbound: { id: 99 } });
    assert.equal(bad[0], 400);
    assert.deepEqual(await send('k3', `/customers/${c.id}/lines`, { panel_id: pid, inbound: { id: 99 } }), bad);
    // 续费重发不会记两笔收款
    await Promise.all([send('r1', `/customers/${c.id}/renew`, { months: 1, amount: 30 }), send('r1', `/customers/${c.id}/renew`, { months: 1, amount: 30 })]);
    assert.equal((await call('GET', `/customers/${c.id}/payments`)).body.length, 1);
  } finally {
    await close();
  }
});

test('重新启用停着的线路:面板上手动停的能启用,读一遍面板核对;客户超额时不让启用;面板上已经没这个客户端时报错;操作日志记一条', async () => {
  const db = memoryDb();
  const hk = addPanel(db, 'hk', 'https://1.1.1.1:2053/p');
  const data = { hk: panel() };
  const { call, close } = await serve(db, data);
  try {
    const c = (await call('POST', '/customers', { name: '赵六', quota_bytes: 1000 })).body;
    const l1 = (await call('POST', `/customers/${c.id}/lines`, { kind: 'direct', panel_id: hk.id, inbound: { id: 7 } })).body.line;
    const l2 = (await call('POST', `/customers/${c.id}/lines`, { kind: 'direct', panel_id: hk.id, inbound: { id: 7 } })).body.line;
    // 在面板上手动停掉第一个客户端,同步后线路显示「面板上已停用」
    data.hk.clients.find((x: any) => x.email === l1.email).enable = false;
    await call('POST', '/sync');
    let v = getCustomer(db, c.id)!;
    assert.deepEqual(v.lines.map((l) => [l.enable, l.auto_disabled]), [[false, false], [true, false]]);

    // 启用:面板上的客户端启用了,线路也是
    const on = await call('POST', `/customers/${c.id}/lines/${l1.id}/enable`);
    assert.equal(on.status, 200);
    assert.deepEqual([on.body.id, on.body.enable, on.body.auto_disabled], [l1.id, true, false]);
    assert.equal(data.hk.clients.find((x: any) => x.email === l1.email).enable, true);
    assert.equal(listOpLog(db).rows[0].summary, `在面板上重新启用「赵六」的线路 hk · ${l1.email}`);
    // 已经启用着:直接返回,不记日志
    const again = await call('POST', `/customers/${c.id}/lines/${l1.id}/enable`);
    assert.deepEqual([again.status, again.body.enable], [200, true]);
    assert.equal(listOpLog(db).rows[0].summary, `在面板上重新启用「赵六」的线路 hk · ${l1.email}`);

    // 面板上已经没有这个客户端:启用不报错,但读一遍面板后还是停着,报错
    data.hk.clients = data.hk.clients.filter((x: any) => x.email !== l2.email);
    await call('POST', '/sync');
    const gone = await call('POST', `/customers/${c.id}/lines/${l2.id}/enable`);
    assert.equal(gone.status, 400);
    assert.match(gone.body.error, /没启用成功.*已经没有/);
    assert.equal(getCustomer(db, c.id)!.lines.find((l) => l.id === l2.id)!.enable, false);

    // 客户超额:不让启用
    data.hk.clients.find((x: any) => x.email === l1.email).traffic = { up: 0, down: 2000 };
    await call('POST', '/sync');
    v = getCustomer(db, c.id)!;
    assert.equal(v.state, 'over_quota');
    const over = await call('POST', `/customers/${c.id}/lines/${l1.id}/enable`);
    assert.equal(over.status, 400);
    assert.match(over.body.error, /已超额/);
    // 别的客户的线路 id:不存在
    const other = (await call('POST', '/customers', { name: '别人' })).body;
    assert.equal((await call('POST', `/customers/${other.id}/lines/${l1.id}/enable`)).status, 400);
  } finally {
    await close();
  }
});

test('自己记的收入 / 支出:记一笔、按日期区间查、删;金额不对 / kind 不对报 400;客户的收款不混进来', async () => {
  const db = memoryDb();
  const { call, close } = await serve(db);
  try {
    const a = await call('POST', '/ledger', { kind: 'expense', amount: 300, at: 1_000, category: '服务器', note: '年付' });
    assert.deepEqual([a.status, a.body.kind, a.body.amount, a.body.at, a.body.category, a.body.note], [200, 'expense', 300, 1_000, '服务器', '年付']);
    const b = (await call('POST', '/ledger', { kind: 'income', amount: '20.5', at: 3_000 })).body;
    for (const bad of [{ kind: 'expense', amount: -1 }, { kind: 'x', amount: 1 }, { kind: 'income' }]) assert.equal((await call('POST', '/ledger', bad)).status, 400, JSON.stringify(bad));
    const c = (await call('POST', '/customers', { name: 'li' })).body;
    await call('POST', `/customers/${c.id}/payments`, { amount: 30 });

    assert.deepEqual((await call('GET', '/ledger')).body.map((e: any) => [e.kind, e.amount]), [['income', 20.5], ['expense', 300]]);
    assert.deepEqual((await call('GET', '/ledger?from=2000&to=4000')).body.map((e: any) => e.id), [b.id]);
    assert.equal((await call('GET', '/ledger?from=abc')).status, 400);
    assert.equal((await call('GET', '/payments')).body.length, 1);

    assert.equal((await call('DELETE', `/ledger/${a.body.id}`)).status, 200);
    assert.equal((await call('DELETE', `/ledger/${a.body.id}`)).status, 400);
    assert.deepEqual((await call('GET', '/ledger')).body.map((e: any) => e.id), [b.id]);

    // 关联:收入关联客户 + 面板;支出关联 SOCKS;不存在的 / 支出关联客户 / 面板和 SOCKS 都给报 400;按客户查
    const p = addPanel(db, 'hk');
    const s = (await call('POST', '/socks', { name: 'isp', address: '1.2.3.4:1080' })).body;
    const linked = await call('POST', '/ledger', { kind: 'income', amount: 8, customer_id: c.id, panel_id: p.id });
    assert.deepEqual([linked.status, linked.body.customer_name, linked.body.panel_name, linked.body.socks_id], [200, 'li', 'hk', null]);
    assert.equal((await call('POST', '/ledger', { kind: 'expense', amount: 8, socks_id: s.id })).body.socks_name, 'isp');
    for (const bad of [{ kind: 'expense', amount: 1, customer_id: c.id }, { kind: 'income', amount: 1, panel_id: p.id, socks_id: s.id }, { kind: 'income', amount: 1, customer_id: 999 }]) {
      assert.equal((await call('POST', '/ledger', bad)).status, 400, JSON.stringify(bad));
    }
    assert.deepEqual((await call('GET', `/ledger?customer_id=${c.id}`)).body.map((e: any) => e.id), [linked.body.id]);
    assert.equal((await call('GET', '/ledger?customer_id=x')).status, 400);
  } finally {
    await close();
  }
});

test('卸载面板:POST /panels/:id/uninstall;连得上删客户端、连不上只删记录、删不完报 502 且什么都不删;操作日志写清楚', async () => {
  const db = memoryDb();
  const data: Record<string, FakePanel> = { a: panel(), b: panel(), c: panel() };
  const { call, close } = await serve(db, data);
  const summaries = () => listOpLog(db).rows.map((r) => r.summary);
  try {
    const cid = (await call('POST', '/customers', { name: 'zhang' })).body.id;
    const ids: Record<string, number> = {};
    for (const name of ['a', 'b', 'c']) {
      ids[name] = addPanel(db, name).id;
      assert.equal((await call('POST', `/customers/${cid}/lines`, { panel_id: ids[name], inbound: { id: 7 } })).status, 200);
    }
    assert.deepEqual((await call('GET', '/panels')).body.map((p: any) => [p.name, p.line_count, p.customer_count]), [['a', 1, 1], ['b', 1, 1], ['c', 1, 1]]);

    const a = await call('POST', `/panels/${ids.a}/uninstall`, {});
    assert.deepEqual([a.status, a.body.remote, a.body.lines, a.body.customers, a.body.clients_deleted], [200, 'deleted', 1, 1, 1]);
    assert.deepEqual(emails(data.a), []);
    assert.equal(summaries()[0], '卸载面板「a」:从 1 位客户名下删了 1 条线路,面板上删了 1 个客户端');

    data.b.fail = { listClients: '连接超时' };
    const b = await call('POST', `/panels/${ids.b}/uninstall`, {});
    assert.deepEqual([b.status, b.body.remote], [200, 'unreachable']);
    assert.equal(emails(data.b).length, 1);
    assert.equal(summaries()[0], '卸载面板「b」:从 1 位客户名下删了 1 条线路,面板连不上,只删了记录(连接超时)');

    data.c.fail = { deleteClient: '面板返回 500' };
    const c = await call('POST', `/panels/${ids.c}/uninstall`, {});
    assert.equal(c.status, 502);
    assert.match(c.body.error, /没删完/);
    assert.deepEqual((await call('GET', '/panels')).body.map((p: any) => p.name), ['c']);
    const [last] = listOpLog(db).rows;
    assert.deepEqual([last.summary, last.ok], ['卸载面板「c」', false]);
    const forced = await call('POST', `/panels/${ids.c}/uninstall`, { force: true });
    assert.deepEqual([forced.status, forced.body.remote], [200, 'skipped']);
    assert.equal(summaries()[0], '卸载面板「c」:从 1 位客户名下删了 1 条线路,只删记录,没动面板上的客户端');
    assert.deepEqual((await call('GET', '/panels')).body, []);
    assert.deepEqual(getCustomer(db, cid)!.lines, []);
  } finally {
    await close();
  }
});
