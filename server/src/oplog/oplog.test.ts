import assert from 'node:assert/strict';
import { test } from 'node:test';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { DB } from '../db';
import { apiRouter } from '../http/routes';
import { addPanel, fakePanels, memoryDb, relayXray, vlessInbound, type FakePanel } from '../testUtil';
import { addOpLog, decodeActor, encodeActor, listOpLog, pruneOpLog, OPLOG_KEEP_DAYS } from './log';

async function serve(db: DB, adminPassword = 'pw') {
  const app = express();
  app.set('trust proxy', ['loopback']);
  app.use(express.json());
  app.use('/api', apiRouter({ db, adminPassword, clientFor: fakePanels({}), subBaseUrl: '', subLogDays: 7 }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(base + path, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = res.headers.get('set-cookie');
    if (set && path === '/login') cookie = set.split(';')[0];
    return { status: res.status, body: (await res.json()) as any };
  };
  return { call, close: () => new Promise((r) => server.close(r)) };
}

const summaries = (db: DB) => listOpLog(db).rows.map((r) => r.summary);

test('操作日志:登录、客户的新建 / 修改(只写改了的,前后对比)/ 续费 / 删除;查看和没改动的保存不记;没成的记原因', async () => {
  const db = memoryDb();
  const { call, close } = await serve(db);
  try {
    assert.equal((await call('POST', '/login', { password: 'nope' })).status, 401);
    await call('POST', '/login', { password: 'pw' });
    const [ok, bad] = listOpLog(db).rows;
    assert.deepEqual([ok.summary, ok.ok, ok.actor, ok.ip], ['登录', true, '后台', '127.0.0.1']);
    assert.deepEqual([bad.summary, bad.ok, bad.error], ['登录', false, '密码错误']);

    const c = (await call('POST', '/customers', { name: '张三', quota_bytes: 100 * 1024 ** 3, monthly_fee: 30 })).body;
    assert.equal(listOpLog(db).rows[0].summary, '新建客户「张三」:额度 100 GB;月费 30');
    assert.equal(listOpLog(db).rows[0].customer_id, c.id);

    // 查看不记;表单原样再存一次(什么都没改)不记
    await call('GET', '/customers');
    await call('PATCH', `/customers/${c.id}`, { name: '张三', quota_bytes: c.quota_bytes, monthly_fee: 30, upstreams: [], sub_links: [] });
    assert.equal(listOpLog(db).rows.length, 3);

    await call('PATCH', `/customers/${c.id}`, { quota_bytes: 200 * 1024 ** 3, monthly_fee: null, remark: '老客户', traffic_ratio: 1.5 });
    assert.equal(summaries(db)[0], '修改客户「张三」:备注改成「老客户」;额度 100 GB → 200 GB;月费 30 → 没填;流量倍率 ×1 → ×1.5');

    await call('POST', `/customers/${c.id}/renew`, { months: 1, amount: 30, note: '微信' });
    assert.match(summaries(db)[0], /^给「张三」续费 1 个月:到期 不限期 → \d{4}-\d{2}-\d{2};收款 30;备注「微信」$/);
    await call('POST', `/customers/${c.id}/payments`, { amount: -5 });
    assert.equal(summaries(db)[0], '给「张三」记一笔退款 -5');
    const pay = (await call('GET', `/customers/${c.id}/payments`)).body[0];
    await call('DELETE', `/payments/${pay.id}`);
    assert.match(summaries(db)[0], /^删除「张三」\d{4}-\d{2}-\d{2} 的一笔记录\(金额 -5,只记收款;到期日不变\)$/);
    await call('POST', `/customers/${c.id}/adjust-usage`, { down: 2 * 1024 ** 3 });
    assert.equal(summaries(db)[0], '调整「张三」本期已用 +2 GB(实际流量)');
    await call('POST', `/customers/${c.id}/sub-token`);
    assert.equal(summaries(db)[0], '重置「张三」的订阅链接(旧链接失效)');
    // 清零:已用 0 写 0 GB
    await call('POST', `/customers/${c.id}/reset-usage`);
    assert.equal(summaries(db)[0], '清零「张三」的流量(清零前已用 3 GB)');
    await call('POST', `/customers/${c.id}/reset-usage`);
    assert.equal(summaries(db)[0], '清零「张三」的流量(清零前已用 0 GB)');
    // 到期只改了时刻:带上时刻
    const exp = (await call('GET', '/customers')).body.find((x: any) => x.id === c.id).expire_at;
    await call('PATCH', `/customers/${c.id}`, { expire_at: exp - 3600_000 });
    assert.match(summaries(db)[0], /^修改客户「张三」:到期 \d{4}-\d{2}-\d{2} \d{2}:\d{2} → \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);

    // 没成的:记原因
    assert.equal((await call('POST', '/customers/999/renew', { months: 1 })).status, 400);
    const failed = listOpLog(db).rows[0];
    assert.deepEqual([failed.summary, failed.ok, failed.error, failed.customer_id], ['给「#999」续费', false, '客户不存在', null]);
    // 检查 / 同步这类不改东西的不记
    const n = listOpLog(db).rows.length;
    await call('POST', '/sync');
    assert.equal(listOpLog(db).rows.length, n);

    await call('DELETE', `/customers/${c.id}`);
    assert.equal(summaries(db)[0], '删除客户「张三」(连同 0 条线路)');
    // 客户删了,他的日志还能按 id 筛出来
    assert.equal(listOpLog(db, { customer_id: c.id }).rows.length, 11);
    assert.deepEqual(listOpLog(db, { failed: true }).rows.map((r) => r.summary), ['给「#999」续费', '登录']);
    assert.deepEqual(listOpLog(db, { q: '退款' }).rows.map((r) => r.summary), ['给「张三」记一笔退款 -5']);
  } finally {
    await close();
  }
});

test('操作日志:设置只写开关和数字的前后,令牌 / 密钥不写值;面板地址 / 令牌只写改了', async () => {
  const db = memoryDb();
  const { call, close } = await serve(db);
  try {
    await call('POST', '/login', { password: 'pw' });
    await call('POST', '/tokens', { name: '发卡站' });
    assert.equal(summaries(db)[0], '新建 API 令牌「发卡站」');

    const secret = '123456:ABCdef-fake-telegram-secret';
    await call('PATCH', '/settings', { telegram: { token: secret, chat_id: '42' }, notify: { expiring: false, expiring_days: 5 } });
    const s = summaries(db)[0];
    assert.match(s, /^修改设置:/);
    for (const part of ['Telegram 机器人令牌填了', 'Telegram 会话 ID填了', '快到期的通知 开 → 关', '提前几天通知到期 3 → 5']) assert.ok(s.includes(part), `${part} / ${s}`);
    assert.ok(!s.includes(secret) && !s.includes('42'));

    const p = addPanel(db, 'hk', 'https://hk.example:2053/secret-path');
    await call('PATCH', `/panels/${p.id}`, { base_url: 'https://hk2.example:2053/other', token: 'new-token', monthly_cost: 9 });
    const ps = summaries(db)[0];
    assert.equal(ps, '修改面板「hk」:地址改了;令牌改了;月成本 没填 → 9');
    assert.ok(!ps.includes('hk2.example') && !ps.includes('new-token'));
    // 面板节点名、一键改名
    await call('PATCH', `/panels/${p.id}`, { node_name: '香港 01' });
    assert.equal(summaries(db)[0], '修改面板「hk」:节点名 (面板生成的) → 香港 01');
    await call('POST', `/panels/${p.id}/line-names`);
    assert.equal(summaries(db)[0], '把面板「hk」上 0 条线路的节点名改成跟着面板的「香港 01」');
  } finally {
    await close();
  }
});

test('操作日志:令牌调的接口记令牌名;令牌不能看日志', async () => {
  const db = memoryDb();
  const { call, close } = await serve(db);
  try {
    await call('POST', '/login', { password: 'pw' });
    const token = (await call('POST', '/tokens', { name: '发卡站' })).body.token;
    const { call: anon, close: close2 } = await serve(db);
    try {
      const auth = { Authorization: `Bearer ${token}` };
      await anon('POST', '/customers', { name: '李四' }, auth);
      const row = listOpLog(db).rows[0];
      assert.deepEqual([row.actor, row.summary], ['令牌「发卡站」', '新建客户「李四」']);
      assert.equal((await anon('GET', '/oplog', undefined, auth)).status, 403);
      assert.equal((await call('GET', '/oplog?limit=1')).body.rows.length, 1);
      assert.equal((await call('GET', '/oplog?before=abc')).status, 400);
    } finally {
      await close2();
    }
  } finally {
    await close();
  }
});

test('操作日志的存取:翻页、筛选、清掉一年前的;内部通道带的「谁」编码来回', () => {
  const db = memoryDb();
  const now = Date.now();
  for (let i = 0; i < 5; i++) addOpLog(db, { at: now - (4 - i) * 1000, actor: '后台', ip: '', action: 'POST /x', summary: `第 ${i} 条 50%_`, ok: true, error: '', customer_id: i % 2 ? 7 : null });
  addOpLog(db, { at: now - (OPLOG_KEEP_DAYS + 1) * 86_400_000, actor: '后台', ip: '', action: 'POST /x', summary: '很久以前', ok: true, error: '', customer_id: null });
  const first = listOpLog(db, { limit: 2 });
  assert.deepEqual([first.rows.map((r) => r.summary), first.more], [['很久以前', '第 4 条 50%_'], true]);
  const next = listOpLog(db, { limit: 2, before: first.rows[1].id });
  assert.deepEqual(next.rows.map((r) => r.summary), ['第 3 条 50%_', '第 2 条 50%_']);
  assert.deepEqual(listOpLog(db, { customer_id: 7 }).rows.map((r) => r.summary), ['第 3 条 50%_', '第 1 条 50%_']);
  // % 和 _ 按字面匹配
  assert.equal(listOpLog(db, { q: '50%_' }).rows.length, 5);
  assert.equal(listOpLog(db, { q: '5_%' }).rows.length, 0);
  pruneOpLog(db, now);
  assert.equal(listOpLog(db).rows.length, 5);

  assert.deepEqual(decodeActor(encodeActor('MCP · 令牌「a」', '1.2.3.4')), { by: 'MCP · 令牌「a」', ip: '1.2.3.4' });
  for (const bad of [undefined, '', '%E0', encodeURIComponent('{"x":1}')]) assert.equal(decodeActor(bad), null);
});

test('操作日志:线路换出口写成「直出 → SOCKS isp」;批量写换好几条;已经是这个出口的不记', async () => {
  const db = memoryDb();
  const p = addPanel(db, 'hk');
  const data: Record<string, FakePanel> = { hk: { inbounds: [vlessInbound(5, 500)], clients: [], xray: relayXray(), restarts: 0 } };
  const app = express();
  app.use(express.json());
  app.use('/api', apiRouter({ db, adminPassword: '', clientFor: fakePanels(data), subBaseUrl: '', subLogDays: 7 }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const call = async (method: string, path: string, body?: unknown) => (await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })).json() as Promise<any>;
  try {
    const s = await call('POST', '/socks', { name: 'isp', address: 'socks5://isp.example.com:1080' });
    const c = await call('POST', '/customers', { name: '张三' });
    const l = (await call('POST', `/customers/${c.id}/lines`, { panel_id: p.id, inbound: { id: 5 } })).line;
    await call('PUT', `/customers/${c.id}/lines/${l.id}/exit`, { exit: { kind: 'socks', socks_id: s.id } });
    assert.equal(summaries(db)[0], `给「张三」线路 hk · ${l.email} 换出口:直出 → SOCKS isp`);
    const n = listOpLog(db).rows.length;
    await call('PUT', `/customers/${c.id}/lines/${l.id}/exit`, { exit: { kind: 'socks', socks_id: s.id } });
    assert.equal(listOpLog(db).rows.length, n);
    // 在面板上直接建客户端:写面板上实际的名字
    await call('POST', `/panels/${p.id}/clients`, { name: 'alice', inbound_id: 5 });
    assert.equal(summaries(db)[0], '在面板「hk」上新建客户端 alice');
    await call('POST', '/lines/batch-exit', { customer_id: c.id, exit: { kind: 'direct' } });
    const row = listOpLog(db).rows[0];
    assert.deepEqual([row.summary, row.customer_id], [`批量换出口 → 直出(换好 1 条):「张三」hk · ${l.email}`, c.id]);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
