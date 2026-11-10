import assert from 'node:assert/strict';
import { createServer, type AddressInfo } from 'node:net';
import { test } from 'node:test';
import { addLine, createCustomer, deleteLine } from '../customers/repo';
import { addPanel, memoryDb } from '../testUtil';
import { checkSocks, parseTrace } from './check';
import { createSocks, deleteSocks, getSocks, getSocksView, listSocks, parseSocksAddress, planSocksUpdate, saveCheck, updateSocks } from './repo';

test('解析各种 SOCKS 地址写法', () => {
  const ep = (host: string, port: number, username = '', password = '') => ({ host, port, username, password });
  assert.deepEqual(parseSocksAddress('socks5://u:p%40x@Proxy.Example.com:1080'), ep('proxy.example.com', 1080, 'u', 'p@x'));
  assert.deepEqual(parseSocksAddress('socks5h://u:p@1.2.3.4:5/'), ep('1.2.3.4', 5, 'u', 'p'));
  assert.deepEqual(parseSocksAddress('u:p:q@1.2.3.4:5'), ep('1.2.3.4', 5, 'u', 'p:q'));
  assert.deepEqual(parseSocksAddress('1.2.3.4:8022:user:pa:ss'), ep('1.2.3.4', 8022, 'user', 'pa:ss'));
  assert.deepEqual(parseSocksAddress(' 1.2.3.4:8022 '), ep('1.2.3.4', 8022));
  assert.throws(() => parseSocksAddress('http://1.2.3.4:80'), /只支持 socks5/);
  assert.throws(() => parseSocksAddress('1.2.3.4'), /地址格式不对/);
  assert.throws(() => parseSocksAddress('1.2.3.4:70000'), /端口/);
  assert.throws(() => parseSocksAddress(':p@1.2.3.4:5'), /有密码时必须有用户名/);
});

test('SOCKS 增改删:对外不含密码,地址留空不改,换地址清掉旧的测试结果', () => {
  const db = memoryDb();
  const id = createSocks(db, { name: 'att', address: 'socks5://u:secret@isp.example.com:10002' }, 1);
  const view = getSocksView(db, id)!;
  assert.equal('password' in view, false);
  assert.deepEqual([view.host, view.port, view.username, view.has_password], ['isp.example.com', 10002, 'u', true]);
  assert.equal(JSON.stringify(listSocks(db)).includes('secret'), false);
  assert.throws(() => createSocks(db, { name: 'att', address: '1.2.3.4:5' }), /名称已存在/);

  saveCheck(db, id, { at: 5, ok: true, ms: 100, ip: '9.9.9.9', loc: 'US', error: null });
  updateSocks(db, id, { name: 'AT&T', address: '', remark: '备注' }, 2);
  assert.equal(getSocks(db, id)!.password, 'secret');
  assert.equal(getSocksView(db, id)!.check?.ip, '9.9.9.9');
  updateSocks(db, id, { address: 'u:new@isp.example.com:10002' }, 3);
  assert.deepEqual([getSocks(db, id)!.password, getSocksView(db, id)!.check, getSocksView(db, id)!.name], ['new', null, 'AT&T']);
  deleteSocks(db, id);
  assert.equal(listSocks(db).length, 0);
  assert.throws(() => deleteSocks(db, id), /不存在/);
});

test('解析 Cloudflare trace', () => {
  assert.deepEqual(parseTrace('fl=1\nip=1.2.3.4\nloc=US\n'), { ip: '1.2.3.4', loc: 'US' });
  assert.deepEqual(parseTrace('nothing'), { ip: null, loc: null });
});

test('连通性测试:握手失败 / 认证失败 / 连接被拒绝都有明确原因', async () => {
  // 一个只会说"不接受认证方式"的假代理
  const server = createServer((socket) => {
    socket.once('data', () => socket.end(Buffer.from([5, 0xff])));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  try {
    const bad = await checkSocks({ host: '127.0.0.1', port, username: 'u', password: 'p' }, 3000);
    assert.equal(bad.ok, false);
    assert.match(bad.error!, /SOCKS 握手失败:代理不接受这种认证方式/);
  } finally {
    server.close();
  }
  const refused = await checkSocks({ host: '127.0.0.1', port: 1, username: '', password: '' }, 3000);
  assert.equal(refused.ok, false);
  assert.match(refused.error!, /连接代理失败/);
});

test('改 SOCKS 之前先算要不要动中转:地址和账号没变就不用;校验不过不落库', () => {
  const db = memoryDb();
  const id = createSocks(db, { name: 'att', address: 'socks5://u:secret@isp.example.com:10002', remark: '旧' }, 1);
  createSocks(db, { name: 'other', address: '1.2.3.4:5' }, 1);
  const endpoint = (input: object) => planSocksUpdate(db, id, input).endpoint;

  const plan = planSocksUpdate(db, id, { remark: ' 新备注 ' });
  assert.deepEqual([plan.name, plan.remark, plan.endpoint, plan.cur.password], ['att', '新备注', null, 'secret']);
  assert.equal(endpoint({ name: 'att2' }), null);
  assert.equal(endpoint({ address: '' }), null);
  // 同一个出口换种写法,不算变
  assert.equal(endpoint({ address: 'ISP.example.com:10002:u:secret' }), null);
  assert.deepEqual(endpoint({ address: 'isp.example.com:10002:u:new' }), { host: 'isp.example.com', port: 10002, username: 'u', password: 'new' });
  assert.equal(endpoint({ address: 'isp.example.com:10003:u:secret' })?.port, 10003);
  assert.equal(endpoint({ address: 'isp2.example.com:10002:u:secret' })?.host, 'isp2.example.com');
  assert.deepEqual(endpoint({ address: 'isp.example.com:10002' }), { host: 'isp.example.com', port: 10002, username: '', password: '' });

  assert.equal(planSocksUpdate(db, id, { name: ' att ' }).name, 'att');
  assert.throws(() => planSocksUpdate(db, id, { name: 'other' }), /名称已存在/);
  assert.throws(() => planSocksUpdate(db, id, { name: ' ' }), /名称不能为空/);
  assert.throws(() => planSocksUpdate(db, id, { address: 'http://x:1' }), /只支持 socks5/);
  assert.throws(() => planSocksUpdate(db, 999, { remark: 'x' }), /SOCKS 不存在/);
  // 只是算,什么都没写
  const cur = getSocks(db, id)!;
  assert.deepEqual([cur.name, cur.remark, cur.port, cur.password, cur.updated_at], ['att', '旧', 10002, 'secret', 1]);
});

test('在用的 SOCKS 删不了:有线路拿它当出口时先删线路', () => {
  const db = memoryDb();
  const a = addPanel(db, 'a');
  const id = createSocks(db, { name: 'att', address: '1.2.3.4:5' }, 1);
  const idle = createSocks(db, { name: 'idle', address: '1.2.3.4:6' }, 1);
  const cid = createCustomer(db, { name: 'zhang' });
  const line = addLine(db, { customer_id: cid, kind: 'relay', panel_id: a.id, inbound_id: 1, inbound_remark: 'r', protocol: 'vless', email: 'zhang', exit_kind: 'socks', exit_socks_id: id, exit_label: 'SOCKS att' });

  assert.deepEqual(listSocks(db).map((s) => [s.name, s.used_by]), [['att', 1], ['idle', 0]]);
  assert.equal(getSocksView(db, id)!.used_by, 1);
  assert.throws(() => deleteSocks(db, id), /还有 1 条线路在用这个 SOCKS/);
  assert.ok(getSocks(db, id));
  deleteSocks(db, idle);

  deleteLine(db, line.id);
  assert.equal(getSocksView(db, id)!.used_by, 0);
  deleteSocks(db, id);
  assert.deepEqual(listSocks(db), []);
});
