import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { DB } from '../db';
import { apiRouter } from '../http/routes';
import { createToken } from '../http/tokens';
import { addPanel, fakePanels, memoryDb, vlessInbound, type FakePanel } from '../testUtil';
import { listGrants, oauthRouter, pkceMatches, redirectAllowed, revokeGrant, validRedirectUri, type DocFetcher } from './oauth';
import { mcpRouter } from './server';
import type { ApiCall } from './tools';
import { ACTOR_HEADER, listOpLog } from '../oplog/log';

async function serve(db: DB, data: Record<string, FakePanel> = {}, adminPassword = 'pw', fetchClientDoc?: DocFetcher) {
  const app = express();
  let base = '';
  const api: ApiCall = async (method, path, body, actor) => {
    const res = await fetch(`${base}/internal/api${path}`, { method, headers: { ...(actor ? { [ACTOR_HEADER]: actor } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  app.use(oauthRouter({ db, adminPassword, fetchClientDoc }));
  app.use(mcpRouter({ db, adminPassword, api, version: '1.2.3' }));
  app.use('/internal/api', express.json(), apiRouter({ db, adminPassword: '', clientFor: fakePanels(data), subBaseUrl: '', subLogDays: 7, trustActorHeader: true }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  /** 握手协议的请求 */
  const rpc = async (auth: string | null, method: string, params?: unknown, headers: Record<string, string> = {}, id: number | null = 1) => {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(auth ? { Authorization: `Bearer ${auth}` } : {}), ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', ...(id === null ? {} : { id }), method, ...(params === undefined ? {} : { params }) }),
    });
    const text = await res.text();
    // SDK 可能用 JSON 也可能用 SSE 回(两种都合规);SSE 时取最后一条 data
    const payload = (res.headers.get('content-type') ?? '').includes('text/event-stream') ? (text.split('\n').filter((l) => l.startsWith('data:')).pop() ?? '').slice(5) : text;
    let body: any = null;
    try {
      body = payload.trim() ? JSON.parse(payload) : null;
    } catch {
      body = { raw: text };
    }
    return { status: res.status, headers: res.headers, body };
  };
  /** 2026-07-28 的请求:版本放 _meta,带 Mcp-* 头 */
  const modern = (auth: string, method: string, params: any = {}, headerOver: Record<string, string> = {}) =>
    rpc(auth, method, { ...params, _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} } }, { 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': method, ...(params.name ? { 'Mcp-Name': params.name } : {}), ...headerOver });
  return { base, rpc, modern, close: () => new Promise((r) => server.close(r)) };
}

const panel = (): FakePanel => ({ inbounds: [vlessInbound(7, 443)], clients: [], xray: {}, restarts: 0 });
const toolJson = (r: any) => JSON.parse(r.body.result.content[0].text);

test('MCP 握手协议 + API 令牌:initialize、tools/list、建客户开线路续期;没带 / 带错令牌 401 并指向 OAuth 元数据', async () => {
  const db = memoryDb();
  addPanel(db, 'p1');
  const data = { p1: panel() };
  const token = createToken(db, { name: 'mcp' }).token;
  const { base, rpc, close } = await serve(db, data);
  try {
    const anon = await rpc(null, 'initialize', {});
    assert.equal(anon.status, 401);
    assert.equal(anon.headers.get('www-authenticate'), `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp", scope="mcp"`);
    const wrong = await rpc('xh_nope', 'tools/list');
    assert.deepEqual([wrong.status, /error="invalid_token"/.test(wrong.headers.get('www-authenticate') ?? '')], [401, true]);
    assert.equal((await fetch(`${base}/mcp`, { headers: { Authorization: `Bearer ${token}` } })).status, 405);

    const init = await rpc(token, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    assert.deepEqual([init.status, init.body.result.protocolVersion, init.body.result.serverInfo.name, 'tools' in init.body.result.capabilities], [200, '2025-06-18', 'xui-hub', true]);
    assert.equal(init.headers.get('mcp-session-id'), null);
    assert.equal((await rpc(token, 'initialize', { protocolVersion: '1999-01-01', capabilities: {}, clientInfo: { name: 't', version: '1' } })).body.result.protocolVersion, '2025-11-25');
    assert.deepEqual([(await rpc(token, 'notifications/initialized', undefined, {}, null)).status, (await rpc(token, 'ping')).body.result], [202, {}]);

    const tools = (await rpc(token, 'tools/list', {}, { 'MCP-Protocol-Version': '2025-06-18' })).body.result.tools;
    assert.ok(tools.length >= 15);
    assert.ok(tools.every((t: any) => t.name && t.description && t.inputSchema.type === 'object'));
    assert.deepEqual(tools.find((t: any) => t.name === 'list_customers').annotations, { readOnlyHint: true });

    const call = (name: string, args: unknown = {}) => rpc(token, 'tools/call', { name, arguments: args });
    assert.deepEqual(toolJson(await call('list_panels')).map((p: any) => [p.id, p.name]), [[1, 'p1']]);
    const c = toolJson(await call('create_customer', { name: '小王', quota_gb: 100, expire_in_days: 30 }));
    assert.deepEqual([c.name, c.quota_gb, c.state], ['小王', 100, 'active']);
    assert.match(c.sub_url, new RegExp(`^${base}/sub/[\\w-]+$`));
    const line = toolJson(await call('open_line', { customer_id: c.id, panel_id: 1 }));
    assert.deepEqual([line.email, line.links.length, data.p1.clients.map((x) => x.email)], ['小王', 1, ['小王']]);
    // 换出口:直出 → SOCKS → 直出,线路还是那条
    const exitBad = await call('change_line_exit', { customer_id: c.id, direct: true, socks_id: 1 });
    assert.equal(exitBad.body.result.isError, true);
    const direct = toolJson(await call('change_line_exit', { customer_id: c.id, direct: true }));
    assert.deepEqual([direct.changed.length, direct.changed[0].exit, direct.failed], [1, '直出', []]);
    const renewed = toolJson(await call('renew_customer', { customer_id: c.id, days: 30 }));
    assert.ok(Math.abs(Date.parse(renewed.expire_at) - Date.parse(c.expire_at) - 30 * 86_400_000) < 1000);
    assert.deepEqual([renewed.payment.amount, renewed.payment.days, renewed.last_payment], [null, 30, null]);
    const paid = toolJson(await call('renew_customer', { customer_id: c.id, months: 1, amount: 30, note: '微信' }));
    assert.deepEqual([paid.payment.amount, paid.payment.months, paid.payment.note, paid.last_payment.amount], [30, 1, '微信', 30]);
    const ledger = toolJson(await call('list_payments', {}));
    assert.deepEqual([ledger.total, ledger.payments.map((p: any) => p.amount)], [30, [30, null]]);
    assert.equal(toolJson(await call('list_payments', { customer_id: c.id })).payments.length, 2);
    assert.equal((await call('renew_customer', { customer_id: c.id })).body.result.isError, true);
    // 自己记的收入 / 支出
    const spent = toolJson(await call('add_ledger_entry', { kind: 'expense', amount: 300, date: '2026-11-20', category: '服务器' }));
    assert.deepEqual([spent.kind, spent.amount, spent.category, new Date(spent.date).getDate()], ['expense', 300, '服务器', 20]);
    toolJson(await call('add_ledger_entry', { kind: 'income', amount: 50 }));
    assert.equal((await call('add_ledger_entry', { kind: 'income', amount: 1, date: '2026-02-30' })).body.result.isError, true);
    const own = toolJson(await call('list_ledger_entries', { days: 3650 }));
    assert.deepEqual([own.income, own.expense, own.entries.length], [50, 300, 2]);
    // 关联面板 / 客户
    const tied = toolJson(await call('add_ledger_entry', { kind: 'income', amount: 5, panel_id: 1, customer_id: c.id }));
    assert.deepEqual([tied.panel?.id, tied.customer?.name, tied.socks], [1, '小王', undefined]);
    assert.equal((await call('add_ledger_entry', { kind: 'expense', amount: 5, customer_id: c.id })).body.result.isError, true);
    assert.deepEqual(toolJson(await call('list_ledger_entries', { customer_id: c.id })).entries.map((e: any) => e.id), [tied.id]);
    assert.equal(toolJson(await call('list_payments', {})).total, 30);
    // 改一笔:只改给了的;0 = 取消关联
    const fixed = toolJson(await call('update_ledger_entry', { id: tied.id, amount: 8, date: '2026-11-21', panel_id: 0 }));
    assert.deepEqual([fixed.amount, new Date(fixed.date).getDate(), fixed.panel, fixed.customer?.id], [8, 21, undefined, c.id]);
    assert.equal((await call('update_ledger_entry', { id: tied.id, kind: 'expense', customer_id: c.id })).body.result.isError, true);
    const repaid = toolJson(await call('update_payment', { id: paid.payment.id, amount: 35, note: '' }));
    assert.deepEqual([repaid.amount, repaid.note, repaid.months], [35, undefined, 1]);
    // 操作日志:记成「MCP · 令牌「名字」」,IP 是调 MCP 的那台
    const logs = listOpLog(db).rows;
    assert.ok(logs.some((l) => l.actor === 'MCP · 令牌「mcp」' && l.summary.startsWith('新建客户「小王」') && l.ip === '127.0.0.1'), JSON.stringify(logs.slice(0, 3)));
    assert.ok(logs.some((l) => l.summary.startsWith('给「小王」续费 1 个月') && l.summary.includes('收款 30')));
    assert.equal(toolJson(await call('update_customer', { customer_id: c.id, limit_devices: 2, expire_at: '' })).expire_at, null);
    assert.deepEqual(toolJson(await call('list_devices', { customer_id: c.id })), { devices: [], recent_fetches: [] });

    // 业务上的失败放在结果里;不认识的工具 / 方法是协议错误
    const bad = await call('open_line', { customer_id: c.id, panel_id: 1, exit_socks_id: 99 });
    assert.deepEqual([bad.body.result.isError, /SOCKS 不存在/.test(bad.body.result.content[0].text)], [true, true]);
    assert.equal((await call('renew_customer', { customer_id: 999, days: 1 })).body.result.isError, true);
    assert.equal((await call('nope')).body.error.code, -32602);
    assert.equal((await rpc(token, 'resources/list')).body.error.code, -32601);

    assert.equal(toolJson(await call('delete_customer', { customer_id: c.id })).deleted, true);
    assert.deepEqual(data.p1.clients, []);
  } finally {
    await close();
  }
});

test('MCP 2026-07-28(无握手):server/discover、工具调用带 resultType;版本不支持、头和正文对不上、未知方法各有各的错', async () => {
  const db = memoryDb();
  const token = createToken(db, { name: 'mcp' }).token;
  const { rpc, modern, close } = await serve(db);
  try {
    const d = await modern(token, 'server/discover');
    assert.deepEqual([d.status, d.body.result.resultType, d.body.result.supportedVersions.includes('2026-07-28'), 'tools' in d.body.result.capabilities], [200, 'complete', true, true]);
    assert.deepEqual(d.body.result._meta['io.modelcontextprotocol/serverInfo'], { name: 'xui-hub', title: 'xui-hub', version: '1.2.3' });
    const list = (await modern(token, 'tools/list')).body.result;
    assert.deepEqual([list.resultType, typeof list.cacheScope, typeof list.ttlMs, list.tools.length > 10], ['complete', 'string', 'number', true]);
    const called = await modern(token, 'tools/call', { name: 'list_customers', arguments: {} });
    assert.deepEqual([called.status, called.body.result.resultType, called.body.result.isError, toolJson(called)], [200, 'complete', false, []]);

    // 下面这些不合规的请求由 SDK 把关,这里只确认都被拒(具体的错误码是 SDK 的事)
    const meta = (v: string) => ({ _meta: { 'io.modelcontextprotocol/protocolVersion': v, 'io.modelcontextprotocol/clientCapabilities': {} } });
    const rejected = (r: { status: number; body: any }) => [r.status >= 400, typeof r.body?.error?.code];
    const cases = {
      版本不支持: await rpc(token, 'tools/list', meta('2030-01-01'), { 'MCP-Protocol-Version': '2030-01-01', 'Mcp-Method': 'tools/list' }),
      方法头对不上: await modern(token, 'tools/list', {}, { 'Mcp-Method': 'tools/call' }),
      工具名头对不上: await modern(token, 'tools/call', { name: 'list_customers', arguments: {} }, { 'Mcp-Name': 'delete_customer' }),
      未知方法: await modern(token, 'nope/nope'),
    };
    for (const [name, r] of Object.entries(cases)) assert.deepEqual([name, ...rejected(r)], [name, true, 'number']);
    assert.equal(cases.版本不支持.body.error.data.supported.includes('2026-07-28'), true);
    // 参数不合 JSON Schema:SDK 拦下,不会调到后台
    const badArgs = await modern(token, 'tools/call', { name: 'renew_customer', arguments: { customer_id: 'abc' } });
    assert.ok(badArgs.body.error || badArgs.body.result.isError);
  } finally {
    await close();
  }
});

test('OAuth:发现文档、动态注册、授权页要后台密码、PKCE 换令牌、刷新轮换、撤销;各种不对的请求都被拒', async () => {
  const db = memoryDb();
  const { base, rpc, close } = await serve(db);
  const form = (path: string, body: Record<string, string>) => fetch(base + path, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });
  try {
    const prm = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json();
    assert.deepEqual([prm.resource, prm.authorization_servers], [`${base}/mcp`, [base]]);
    const as = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
    assert.deepEqual([as.issuer, as.code_challenge_methods_supported, as.token_endpoint_auth_methods_supported, as.client_id_metadata_document_supported], [base, ['S256'], ['none'], true]);

    const reg = await fetch(as.registration_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_name: 'Claude', redirect_uris: ['http://127.0.0.1:3000/callback'], application_type: 'native' }) });
    const client = await reg.json();
    assert.deepEqual([reg.status, client.token_endpoint_auth_method, 'client_secret' in client], [201, 'none', false]);
    assert.equal((await fetch(as.registration_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['javascript:alert(1)'] }) })).status, 400);

    const verifier = 'v'.repeat(50);
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    // 桌面客户端回调的端口每次不一样
    const redirect_uri = 'http://127.0.0.1:51234/callback';
    const params = { client_id: client.client_id, redirect_uri, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', state: 'st', scope: 'mcp', resource: `${base}/mcp` };
    const page = await fetch(`${as.authorization_endpoint}?${new URLSearchParams(params)}`);
    const html = await page.text();
    assert.deepEqual([page.status, html.includes('「Claude」想连接你的 xui-hub'), html.includes('name="password"'), page.headers.get('x-frame-options')], [200, true, true, 'DENY']);
    // 回调地址 / client 不对:出错误页,不跳转
    assert.equal((await fetch(`${as.authorization_endpoint}?${new URLSearchParams({ ...params, redirect_uri: 'https://evil.example/cb' })}`, { redirect: 'manual' })).status, 400);
    assert.equal((await fetch(`${as.authorization_endpoint}?${new URLSearchParams({ ...params, client_id: 'nope' })}`, { redirect: 'manual' })).status, 400);
    // resource 指向别的站(哪怕前缀和这里一样):带着 error 跳回客户端
    const evilResource = await fetch(`${as.authorization_endpoint}?${new URLSearchParams({ ...params, resource: `${base}.evil.example/mcp` })}`, { redirect: 'manual' });
    assert.deepEqual([evilResource.status, new URL(evilResource.headers.get('location')!).searchParams.get('error')], [302, 'invalid_target']);
    // 没有 PKCE:带着 error 跳回客户端
    const noPkce = await fetch(`${as.authorization_endpoint}?${new URLSearchParams({ ...params, code_challenge: '' })}`, { redirect: 'manual' });
    assert.deepEqual([noPkce.status, new URL(noPkce.headers.get('location')!).searchParams.get('error')], [302, 'invalid_request']);

    assert.equal((await form('/oauth/authorize', { ...params, action: 'allow', password: 'wrong' })).status, 401);
    const denied = await form('/oauth/authorize', { ...params, action: 'deny' });
    assert.equal(new URL(denied.headers.get('location')!).searchParams.get('error'), 'access_denied');
    const ok = await form('/oauth/authorize', { ...params, action: 'allow', password: 'pw' });
    const back = new URL(ok.headers.get('location')!);
    assert.deepEqual([ok.status, back.origin + back.pathname, back.searchParams.get('state'), back.searchParams.get('iss')], [302, redirect_uri, 'st', base]);
    const code = back.searchParams.get('code')!;

    const exchange = (over: Record<string, string> = {}) => form('/oauth/token', { grant_type: 'authorization_code', code, redirect_uri, client_id: client.client_id, code_verifier: verifier, ...over });
    // 验证码不对:拒绝,而且这个授权码就此作废
    assert.equal((await exchange({ code_verifier: 'x'.repeat(50) })).status, 400);
    assert.equal((await exchange()).status, 400);
    const code2 = new URL((await form('/oauth/authorize', { ...params, action: 'allow', password: 'pw' })).headers.get('location')!).searchParams.get('code')!;
    const tokRes = await exchange({ code: code2 });
    const tok = await tokRes.json();
    assert.deepEqual([tokRes.status, tok.token_type, tok.expires_in, tokRes.headers.get('cache-control')], [200, 'Bearer', 3600, 'no-store']);
    assert.match(tok.access_token, /^xho_/);
    assert.equal((await exchange({ code: code2 })).status, 400);
    assert.ok(!JSON.stringify(db.prepare('SELECT * FROM oauth_access').all()).includes(tok.access_token));

    assert.equal((await rpc(tok.access_token, 'tools/list')).status, 200);
    assert.deepEqual(listGrants(db).map((g) => [g.client_name, !!g.last_used_at]), [['Claude', true]]);

    // 刷新:换新的一对,旧的刷新令牌作废
    const refreshed = await (await form('/oauth/token', { grant_type: 'refresh_token', refresh_token: tok.refresh_token, client_id: client.client_id })).json();
    assert.match(refreshed.access_token, /^xho_/);
    assert.equal((await form('/oauth/token', { grant_type: 'refresh_token', refresh_token: tok.refresh_token })).status, 400);
    assert.equal((await rpc(refreshed.access_token, 'tools/list')).status, 200);

    // 撤销:访问令牌和刷新令牌一起失效
    revokeGrant(db, listGrants(db)[0].id);
    assert.equal((await rpc(refreshed.access_token, 'tools/list')).status, 401);
    assert.equal((await form('/oauth/token', { grant_type: 'refresh_token', refresh_token: refreshed.refresh_token })).status, 400);
    assert.equal((await form('/oauth/token', { grant_type: 'password' })).status, 400);
  } finally {
    await close();
  }
});

test('OAuth:client_id 是 https 地址时现取元数据文档;文档里的 client_id 对不上、内网地址都不认', async () => {
  const db = memoryDb();
  const id = 'https://app.example/oauth/client.json';
  const docs: Record<string, unknown> = {
    [id]: { client_id: id, client_name: 'Example App', redirect_uris: ['https://app.example/cb'] },
    'https://bad.example/c.json': { client_id: 'https://other.example/c.json', redirect_uris: ['https://bad.example/cb'] },
  };
  const { base, close } = await serve(db, {}, 'pw', async (url) => (docs[url] ? { status: 200, body: JSON.stringify(docs[url]) } : { status: 404, body: '' }));
  const page = (client_id: string, redirect_uri: string) => fetch(`${base}/oauth/authorize?${new URLSearchParams({ client_id, redirect_uri, response_type: 'code', code_challenge: 'c'.repeat(43), code_challenge_method: 'S256' })}`, { redirect: 'manual' });
  try {
    const ok = await page(id, 'https://app.example/cb');
    assert.deepEqual([ok.status, (await ok.text()).includes('「Example App」')], [200, true]);
    assert.equal((await page(id, 'https://evil.example/cb')).status, 400);
    assert.equal((await page('https://bad.example/c.json', 'https://bad.example/cb')).status, 400);
    assert.equal((await page('https://gone.example/c.json', 'https://gone.example/cb')).status, 400);
    assert.equal((await page('https://127.0.0.1/c.json', 'https://127.0.0.1/cb')).status, 400);
    assert.equal((await page('http://app.example/c.json', 'https://app.example/cb')).status, 400);
  } finally {
    await close();
  }
});

test('OAuth 小件:回调地址的校验和匹配、PKCE', () => {
  assert.equal(validRedirectUri('cursor://anysphere.cursor-mcp/oauth/callback'), 'cursor://anysphere.cursor-mcp/oauth/callback');
  for (const bad of ['http://example.com/cb', 'javascript:alert(1)', 'data:text/html,x', 'https://a.example/cb#frag', 'not a url']) assert.throws(() => validRedirectUri(bad));
  assert.ok(redirectAllowed(['http://localhost:1/cb'], 'http://localhost:9999/cb'));
  assert.ok(!redirectAllowed(['http://localhost:1/cb'], 'http://localhost:9999/other'));
  assert.ok(!redirectAllowed(['http://localhost:1/cb'], 'http://127.0.0.1:1/cb'));
  assert.ok(!redirectAllowed(['https://a.example/cb'], 'https://a.example:8443/cb'));
  const v = 'a'.repeat(43);
  assert.ok(pkceMatches(createHash('sha256').update(v).digest('base64url'), v));
  assert.ok(!pkceMatches(createHash('sha256').update(v).digest('base64url'), 'b'.repeat(43)));
  assert.ok(!pkceMatches('x', 'short'));
});

test('没设后台密码(只监听本机)时 /mcp 不鉴权,但别的网页带来的 Origin 一律拒绝', async () => {
  const { base, rpc, close } = await serve(memoryDb(), {}, '');
  try {
    assert.equal((await rpc(null, 'tools/list')).status, 200);
    assert.equal((await rpc(null, 'tools/list', {}, { Origin: 'https://evil.example' })).status, 403);
    assert.equal((await rpc(null, 'tools/list', {}, { Origin: base })).status, 200);
  } finally {
    await close();
  }
});
