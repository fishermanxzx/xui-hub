import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { XUIClient, XUIError } from './client';

type Seen = { method: string; path: string; auth: string; type: string; body: string };
/** 回什么:json 按 JSON 回,text 按网页回;null = 一直不回(撞超时) */
type Reply = { status?: number; json?: unknown; text?: string } | null;

const ok = (obj: unknown = null): Reply => ({ json: { success: true, obj } });

/** 起一块假面板(webBasePath 是 /base):reply 决定每个请求回什么,seen 记下收到的请求(path 去掉了 /base/panel/api) */
async function fakePanel(reply: (req: Seen) => Reply, timeoutMs = 3000) {
  const seen: Seen[] = [];
  const server = createServer(async (req, res) => {
    req.setEncoding('utf8');
    let body = '';
    for await (const chunk of req) body += chunk;
    const got = { method: req.method ?? '', path: (req.url ?? '').replace('/base/panel/api', ''), auth: req.headers.authorization ?? '', type: req.headers['content-type'] ?? '', body };
    seen.push(got);
    const r = reply(got);
    if (!r) return;
    res.writeHead(r.status ?? 200, { 'Content-Type': r.text === undefined ? 'application/json' : 'text/html' });
    res.end(r.text ?? JSON.stringify(r.json));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const client = new XUIClient({ name: 'p', base_url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/base`, token: 'tok' }, { timeoutMs });
  const close = async () => {
    await client.close();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  };
  return { seen, client, close };
}

const rejectsWith = (p: Promise<unknown>, pattern: RegExp) => assert.rejects(p, (e) => e instanceof XUIError && pattern.test(e.message));

test('请求:带 Bearer token,接口拼在 webBasePath 后面,email 做 URL 编码,结果从 obj 里取', async () => {
  const p = await fakePanel((r) => (r.path === '/inbounds/list' ? ok([{ id: 1 }]) : r.path.startsWith('/clients/links/') ? ok(['vless://x']) : ok()));
  try {
    assert.deepEqual(await p.client.listInbounds(), [{ id: 1 }]);
    assert.deepEqual(await p.client.listClients(), []); // obj 是 null 时当空列表
    assert.deepEqual(await p.client.clientLinks('张 三/x'), ['vless://x']);
    await p.client.deleteClient('a b');
    await p.client.resetClientTraffic('a@b');
    await p.client.deleteInbound(7);
    await p.client.installXray('v25.1.1');
    assert.deepEqual(
      p.seen.map((r) => [r.method, r.path]),
      [
        ['GET', '/inbounds/list'],
        ['GET', '/clients/list'],
        ['GET', `/clients/links/${encodeURIComponent('张 三/x')}`],
        ['POST', '/clients/del/a%20b'],
        ['POST', '/clients/resetTraffic/a%40b'],
        ['POST', '/inbounds/del/7'],
        ['POST', '/server/installXray/v25.1.1'],
      ],
    );
    assert.ok(p.seen.every((r) => r.auth === 'Bearer tok' && r.body === '' && r.type === ''));
  } finally {
    await p.close();
  }
});

test('请求体:建 client / 入站、批量启停发 JSON,改 Xray 模板发表单;批量启停给空名单不发请求', async () => {
  const p = await fakePanel(() => ok());
  try {
    await p.client.addClient({ email: '张三' }, [1, 2]);
    await p.client.addInbound({ port: 443 });
    await p.client.setClientsEnabled(['a', 'b'], false);
    await p.client.setClientsEnabled(['a'], true);
    await p.client.setClientsEnabled([], true);
    assert.deepEqual(
      p.seen.map((r) => [r.method, r.path, r.type, JSON.parse(r.body)]),
      [
        ['POST', '/clients/add', 'application/json', { client: { email: '张三' }, inboundIds: [1, 2] }],
        ['POST', '/inbounds/add', 'application/json', { port: 443 }],
        ['POST', '/clients/bulkDisable', 'application/json', { emails: ['a', 'b'] }],
        ['POST', '/clients/bulkEnable', 'application/json', { emails: ['a'] }],
      ],
    );

    const xray = { outbounds: [{ tag: 'direct', protocol: 'freedom' }], remark: '出口 & 路由' };
    await p.client.updateXray(xray, 'https://t.example/204?a=1&b=2');
    const sent = p.seen[4];
    const form = new URLSearchParams(sent.body);
    assert.deepEqual([sent.path, sent.type], ['/xray/update', 'application/x-www-form-urlencoded']);
    assert.deepEqual(JSON.parse(form.get('xraySetting')!), xray);
    assert.equal(form.get('outboundTestUrl'), 'https://t.example/204?a=1&b=2');
  } finally {
    await p.close();
  }
});

test('报错:鉴权失败、404、回了登录页、success=false、超时、连不上,都换成说得清原因的 XUIError', async () => {
  let reply: Reply = ok();
  const p = await fakePanel(() => reply, 200);
  try {
    const fails = (r: Reply, pattern: RegExp) => {
      reply = r;
      return rejectsWith(p.client.listInbounds(), pattern);
    };
    await fails({ status: 401, json: {} }, /^鉴权失败\(401\):检查 token/);
    await fails({ status: 403, text: 'forbidden' }, /^鉴权失败\(403\)/);
    await fails({ status: 404, text: 'not found' }, /^404:webBasePath 不对或端点不存在$/);
    await fails({ text: '<html>登录</html>' }, /^非 JSON 响应\(200\),可能命中了登录页$/);
    await fails({ status: 502, text: 'bad gateway' }, /^非 JSON 响应\(502\)/);
    await fails({ json: { success: false, msg: '入站不存在' } }, /^入站不存在$/);
    await fails({ json: { success: false } }, /^API 返回 success=false$/);
    await fails(null, /^连接失败:/);
    // 不带 success 字段的 JSON 原样返回
    reply = { json: [{ id: 9 }] };
    assert.deepEqual(await p.client.listInbounds(), [{ id: 9 }]);
  } finally {
    await p.close();
  }

  const dead = new XUIClient({ name: 'dead', base_url: 'http://127.0.0.1:1/base', token: 't' }, { timeoutMs: 3000 });
  try {
    await rejectsWith(dead.listInbounds(), /^连接失败:/);
  } finally {
    await dead.close();
  }
});

test('状态和版本:只取用得到的字段,缺了给默认值;面板不报可升级信息(接口报错 / 没有这个接口)时返回 null', async () => {
  const routes: Record<string, Reply> = {
    '/server/status': ok({ panelVersion: '3.0.0', xray: { version: '25.1.1', state: 'running', errorMsg: '' }, cpu: 1 }),
    '/server/getXrayVersion': ok(['v25.1.1', 'v25.1.0']),
    '/server/getPanelUpdateInfo': ok({ channel: 'stable', currentVersion: '3.0.0', latestVersion: 'v3.1.0', updateAvailable: true }),
    '/server/updatePanel': ok({ runId: 'run-9' }),
    '/server/getUpdateStatus': ok({ runId: 'run-9', state: 'failed', exitCode: 2 }),
    '/setting/all': ok({ webCertFile: '/c.pem', webKeyFile: '/k.pem', webPort: 2053 }),
    '/xray/': ok({ xraySetting: '{}' }),
  };
  const p = await fakePanel((r) => routes[r.path] ?? { status: 404, text: '' });
  try {
    assert.deepEqual(await p.client.serverStatus(), { panelVersion: '3.0.0', xrayVersion: '25.1.1', xrayState: 'running', xrayError: '' });
    assert.deepEqual(await p.client.xrayVersions(), ['v25.1.1', 'v25.1.0']);
    assert.deepEqual(await p.client.panelUpdateInfo(), { channel: 'stable', current: '3.0.0', latest: 'v3.1.0', available: true });
    assert.equal(await p.client.updatePanel(), 'run-9');
    assert.deepEqual(await p.client.updateStatus(), { runId: 'run-9', state: 'failed', exitCode: 2 });
    assert.deepEqual(await p.client.panelCert(), { certFile: '/c.pem', keyFile: '/k.pem' });
    assert.deepEqual(await p.client.xraySettings(), { xraySetting: '{}' });
    assert.deepEqual(p.seen.map((r) => r.method), ['GET', 'GET', 'GET', 'POST', 'GET', 'POST', 'POST']);

    // 字段缺了
    routes['/server/status'] = ok({ xray: { state: 'error', errorMsg: '配置有误' } });
    assert.deepEqual(await p.client.serverStatus(), { panelVersion: '', xrayVersion: '', xrayState: 'error', xrayError: '配置有误' });
    routes['/server/getXrayVersion'] = ok();
    assert.deepEqual(await p.client.xrayVersions(), []);
    routes['/server/updatePanel'] = ok();
    assert.equal(await p.client.updatePanel(), '');
    routes['/server/getUpdateStatus'] = ok();
    assert.deepEqual(await p.client.updateStatus(), { runId: '', state: 'pending', exitCode: 0 });
    routes['/setting/all'] = ok({});
    assert.deepEqual(await p.client.panelCert(), { certFile: '', keyFile: '' });

    // 可升级信息:面板查 GitHub 失败 / 没内容 / 旧版面板没有这个接口
    routes['/server/getPanelUpdateInfo'] = ok({ currentVersion: '3.0.0', updateAvailable: 'yes' });
    assert.deepEqual(await p.client.panelUpdateInfo(), { channel: '', current: '3.0.0', latest: '', available: false });
    routes['/server/getPanelUpdateInfo'] = { json: { success: false, msg: 'GitHub 连不上' } };
    assert.equal(await p.client.panelUpdateInfo(), null);
    routes['/server/getPanelUpdateInfo'] = ok();
    assert.equal(await p.client.panelUpdateInfo(), null);
    delete routes['/server/getPanelUpdateInfo'];
    assert.equal(await p.client.panelUpdateInfo(), null);
  } finally {
    await p.close();
  }
});

test('重启 Xray:重启接口自己断了不算失败,等到状态回到 running 才算完', async () => {
  let polls = 0;
  const p = await fakePanel((r) => {
    if (r.path === '/server/restartXrayService') return { status: 502, text: 'bad gateway' };
    return ok({ xray: { state: ++polls < 2 ? 'stop' : 'running' } });
  });
  try {
    await p.client.restartXray();
    assert.deepEqual(p.seen.map((r) => `${r.method} ${r.path}`), ['POST /server/restartXrayService', 'GET /server/status', 'GET /server/status']);
  } finally {
    await p.close();
  }
});
