import assert from 'node:assert/strict';
import { test } from 'node:test';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { getCustomer } from '../customers/repo';
import type { DB } from '../db';
import { recordSubFetch } from '../subscription/fetchLog';
import { shareEvents } from '../notify/events';
import { DEFAULT_SETTINGS } from '../settings';
import { checkCustomTemplate, type TemplateFetcher } from '../subscription/templates';
import { fakePanels, memoryDb, type FakePanel } from '../testUtil';
import { clientBody } from '../xui/client';
import { apiRouter } from './routes';
import { createToken, listTokens, verifyToken } from './tokens';

async function serve(db: DB, data: Record<string, FakePanel> = {}, adminPassword = '', fetchTemplate?: TemplateFetcher) {
  const app = express();
  app.use(express.json());
  app.use('/api', apiRouter({ db, adminPassword, clientFor: fakePanels(data), subBaseUrl: '', subLogDays: 7, fetchTemplate }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(base + path, { method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as any, cookie: (res.headers.get('set-cookie') ?? '').split(';')[0] };
  };
  return { call, close: () => new Promise((r) => server.close(r)) };
}

test('API 令牌:明文只给一次、库里只有哈希;带令牌能调客户接口,碰不了设置 / 备份 / 令牌管理;删掉就失效', async () => {
  const db = memoryDb();
  const { call, close } = await serve(db, {}, 'pw');
  try {
    const cookie = (await call('POST', '/login', { password: 'pw' })).cookie;
    assert.equal((await call('POST', '/tokens', { name: '' }, { Cookie: cookie })).status, 400);
    const made = (await call('POST', '/tokens', { name: '发卡站' }, { Cookie: cookie })).body;
    assert.match(made.token, /^xh_[\w-]{43}$/);
    assert.equal(made.hint, made.token.slice(-4));
    const stored = db.prepare('SELECT * FROM api_tokens').all() as any[];
    assert.equal(stored.length, 1);
    assert.ok(!JSON.stringify(stored).includes(made.token));
    assert.deepEqual((await call('GET', '/tokens', undefined, { Cookie: cookie })).body.map((t: any) => [t.name, t.hint, 'token' in t]), [['发卡站', made.hint, false]]);

    const auth = { Authorization: `Bearer ${made.token}` };
    const created = await call('POST', '/customers', { name: '小王', quota_bytes: 1024 }, auth);
    assert.deepEqual([created.status, created.body.name, typeof created.body.sub_token], [200, '小王', 'string']);
    assert.equal((await call('GET', '/customers', undefined, auth)).body.length, 1);
    assert.ok(listTokens(db)[0].last_used_at);
    for (const [m, p] of [['GET', '/settings'], ['GET', '/backup'], ['POST', '/restore'], ['GET', '/tokens'], ['POST', '/tokens'], ['DELETE', `/tokens/${made.id}`]] as const) {
      const res = await call(m, p, m === 'POST' ? {} : undefined, auth);
      assert.deepEqual([p, res.status], [p, 403]);
    }
    assert.deepEqual([(await call('GET', '/customers', undefined, { Authorization: 'Bearer xh_wrong' })).status, (await call('GET', '/customers')).status], [401, 401]);

    assert.equal((await call('DELETE', `/tokens/${made.id}`, undefined, { Cookie: cookie })).status, 200);
    assert.equal((await call('GET', '/customers', undefined, auth)).status, 401);
    assert.equal(verifyToken(db, `Bearer ${made.token}`), undefined);
  } finally {
    await close();
  }
});

test('API 令牌:乱试会被限流', async () => {
  const db = memoryDb();
  const good = createToken(db, { name: 'x' }).token;
  const { call, close } = await serve(db, {}, 'pw');
  try {
    for (let i = 0; i < 10; i++) assert.equal((await call('GET', '/customers', undefined, { Authorization: `Bearer xh_bad${i}` })).status, 401);
    assert.equal((await call('GET', '/customers', undefined, { Authorization: `Bearer ${good}` })).status, 429);
  } finally {
    await close();
  }
});

test('续期接口:在到期日上加天数,过期的从现在起算,可以顺带清零', async () => {
  const db = memoryDb();
  const { call, close } = await serve(db);
  try {
    const now = Date.now();
    const a = (await call('POST', '/customers', { name: 'a', expire_at: now + 5 * 86_400_000 })).body;
    const b = (await call('POST', '/customers', { name: 'b', expire_at: now - 86_400_000 })).body;
    assert.equal(b.state, 'expired');
    assert.equal((await call('POST', `/customers/${a.id}/renew`, { days: 30 })).body.expire_at, a.expire_at + 30 * 86_400_000);
    const renewed = (await call('POST', `/customers/${b.id}/renew`, { days: 30, reset_usage: true })).body;
    assert.equal(renewed.state, 'active');
    assert.ok(Math.abs(renewed.expire_at - (now + 30 * 86_400_000)) < 5000);
    assert.equal((await call('POST', `/customers/${a.id}/renew`, { days: 0 })).status, 400);
  } finally {
    await close();
  }
});

test('改面板客户端:记录里的 uuid 当 id 带回去,密钥和开关原样,不认识的字段不带', () => {
  const rec = { id: 12, uuid: 'u-1', email: 'a', password: 'p', auth: 'k', subId: 's', flow: 'xtls-rprx-vision', enable: true, limitIp: 0, totalGB: 5, allowedIPs: '', keepAlive: 0, reverse: null, createdAt: 1 };
  assert.deepEqual(clientBody(rec), { id: 'u-1', email: 'a', password: 'p', flow: 'xtls-rprx-vision', auth: 'k', limitIp: 0, totalGB: 5, enable: true, subId: 's' });
});

test('自定义模板:保存前试拉,取不到 / 不是模板 / 内网地址都不让存;没改就不再拉', async () => {
  const INI = '[custom]\nruleset=DIRECT,[]GEOIP,CN\ncustom_proxy_group=节点`select`.*\n';
  await checkCustomTemplate('https://x.example/a.ini', async () => ({ status: 200, body: INI }));
  await assert.rejects(checkCustomTemplate('https://x.example/a.ini', async () => ({ status: 404, body: '' })), /返回 404/);
  await assert.rejects(checkCustomTemplate('https://x.example/a.ini', async () => ({ status: 200, body: '<html>' })), /不像/);
  await assert.rejects(checkCustomTemplate('https://x.example/a.ini', async () => Promise.reject(new Error('timeout'))), /取不到:timeout/);
  for (const u of ['https://127.0.0.1/a.ini', 'https://localhost/a.ini', 'https://192.168.1.2/a.ini', 'https://[::1]/a.ini']) {
    await assert.rejects(checkCustomTemplate(u, async () => ({ status: 200, body: INI })), /内网/);
  }

  const db = memoryDb();
  let pulls = 0;
  let body = INI;
  const { call, close } = await serve(db, {}, '', async () => (pulls++, { status: 200, body }));
  try {
    const c = (await call('POST', '/customers', { name: 'a', sub_template: 'https://x.example/a.ini' })).body;
    assert.deepEqual([c.sub_template, pulls], ['https://x.example/a.ini', 1]);
    await call('PATCH', `/customers/${c.id}`, { remark: 'r', sub_template: 'https://x.example/a.ini' });
    await call('PATCH', `/customers/${c.id}`, { sub_template: 'ACL4SSR_Online_Full' });
    assert.equal(pulls, 1);
    body = 'oops';
    const bad = await call('PATCH', `/customers/${c.id}`, { sub_template: 'https://x.example/b.ini' });
    assert.deepEqual([bad.status, getCustomer(db, c.id)!.sub_template], [400, 'ACL4SSR_Online_Full']);
    assert.equal((await call('POST', '/customers', { name: 'b', sub_template: 'https://x.example/b.ini' })).status, 400);
  } finally {
    await close();
  }
});

test('疑似分享:24 小时内成功拉取的 IP 数到了门槛提醒一次,当天不重复;关掉就不提醒', async () => {
  const db = memoryDb();
  const { call, close } = await serve(db);
  try {
    const c = (await call('POST', '/customers', { name: '老张' })).body;
    const now = Date.now();
    const rec = (ip: string, at = now, status = 200) => recordSubFetch(db, { at, customer_id: c.id, target: 'clash', status, ua: 'clash', ip });
    for (const ip of ['1.1.1.1', '1.1.1.2', '1.1.1.2', '1.1.1.3']) rec(ip);
    rec('9.9.9.9', now - 2 * 86_400_000);
    rec('8.8.8.8', now, 502);
    const s = { ...DEFAULT_SETTINGS.notify, sub_share_ips: 4 };
    assert.deepEqual(shareEvents(db, s, now), []);
    rec('1.1.1.4');
    assert.equal((await call('GET', '/customers')).body[0].sub_ips_day, 4);
    assert.deepEqual(shareEvents(db, { ...s, sub_share: false }, now), []);
    const [m] = shareEvents(db, s, now);
    assert.deepEqual([m.event, m.title], ['sub_shared', '客户「老张」的订阅 24 小时内被 4 个 IP 拉取']);
    assert.match(m.text, /1\.1\.1\.1、1\.1\.1\.2、1\.1\.1\.3、1\.1\.1\.4/);
    assert.deepEqual(shareEvents(db, s, now), []);
  } finally {
    await close();
  }
});
