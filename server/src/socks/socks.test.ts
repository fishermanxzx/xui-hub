import assert from 'node:assert/strict';
import { createServer, type AddressInfo } from 'node:net';
import { test } from 'node:test';
import { addPanel, memoryDb } from '../testUtil';
import { checkSocks, parseTrace } from './check';
import { createSocks, getSocks, getSocksView, listSocks, parseSocksAddress, saveCheck, updateSocks } from './repo';
import { scanSocksUsage, socksOutbounds } from './usage';

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

test('SOCKS 增改:对外不含密码,地址留空不改,换地址清掉旧的测试结果', () => {
  const db = memoryDb();
  const id = createSocks(db, { name: 'att', address: 'socks5://u:secret@isp.example.com:10002', monthly_cost: '23' }, 1);
  const view = getSocksView(db, id)!;
  assert.equal('password' in view, false);
  assert.deepEqual([view.host, view.port, view.username, view.has_password, view.monthly_cost], ['isp.example.com', 10002, 'u', true, 23]);
  assert.equal(JSON.stringify(listSocks(db)).includes('secret'), false);
  assert.throws(() => createSocks(db, { name: 'att', address: '1.2.3.4:5' }), /名称已存在/);

  saveCheck(db, id, { at: 5, ok: true, ms: 100, ip: '9.9.9.9', loc: 'US', error: null });
  updateSocks(db, id, { name: 'AT&T', address: '', monthly_cost: 20 }, 2);
  assert.equal(getSocks(db, id)!.password, 'secret');
  assert.equal(getSocksView(db, id)!.check?.ip, '9.9.9.9');
  updateSocks(db, id, { address: 'u:new@isp.example.com:10002' }, 3);
  assert.deepEqual([getSocks(db, id)!.password, getSocksView(db, id)!.check, getSocksView(db, id)!.name], ['new', null, 'AT&T']);
});

const xray = (outbounds: any[], rules: any[] = []) => ({ xraySetting: JSON.stringify({ outbounds, routing: { rules } }) });
const socksOut = (tag: string, address: string, port: number, user?: string, pass?: string) => ({
  tag,
  protocol: 'socks',
  settings: { servers: [{ address, port, ...(user ? { users: [{ user, pass }] } : {}) }] },
});

test('解析面板 Xray 配置里的 socks 出站和路由到它的入站', () => {
  const outs = socksOutbounds(
    xray(
      [socksOut('att', 'ISP.example.com', 10002, 'u', 'p'), { tag: 'direct', protocol: 'freedom' }],
      [
        { outboundTag: 'att', inboundTag: ['in-1', 'in-2'] },
        { outboundTag: 'att', inboundTag: ['in-2', 'in-3'], enabled: false },
      ],
    ),
  );
  assert.deepEqual(outs, [{ tag: 'att', host: 'isp.example.com', port: 10002, username: 'u', password: 'p', inbound_tags: ['in-1', 'in-2'] }]);
});

test('扫描使用情况:已登记、账号不一致、外部未登记;自己面板的 mixed 入站不算外部', async () => {
  const db = memoryDb();
  const relay = addPanel(db, 'relay');
  const landing = addPanel(db, 'landing');
  db.prepare("UPDATE panels SET ip = '10.0.0.8' WHERE id = ?").run(landing.id);
  const att = createSocks(db, { name: 'att', address: 'u:p@isp.example.com:10002' });
  const tw = createSocks(db, { name: 'tw', address: 'a:b@5.5.5.5:52755' });
  const configs: Record<string, unknown> = {
    relay: xray(
      [
        socksOut('att', 'isp.example.com', 10002, 'u', 'p'),
        socksOut('tw-old', '5.5.5.5', 52755, 'a', 'old'),
        socksOut('to-landing', '10.0.0.8', 31653, 'x', 'y'),
        socksOut('ipfoxy', 'pop.ipfoxy.example', 1021, 'k', 'v'),
      ],
      [{ outboundTag: 'att', inboundTag: ['in-25364-tcp'] }],
    ),
  };
  const usage = await scanSocksUsage(db, (p) => ({
    async xraySettings() {
      if (!(p.name in configs)) throw new Error('连接失败');
      return configs[p.name];
    },
  }));
  assert.deepEqual(usage.uses[att], [{ panel: 'relay', outbound_tag: 'att', inbound_tags: ['in-25364-tcp'] }]);
  assert.deepEqual(usage.uses[tw], []);
  assert.deepEqual(usage.mismatched[tw], [{ panel: 'relay', outbound_tag: 'tw-old', inbound_tags: [] }]);
  assert.deepEqual(usage.unregistered, [
    { panel_id: relay.id, panel: 'relay', outbound_tag: 'ipfoxy', inbound_tags: [], host: 'pop.ipfoxy.example', port: 1021, has_auth: true },
  ]);
  assert.deepEqual(usage.errors, [{ panel: 'landing', error: '连接失败' }]);
});


test('连通性测试:密码错误、连接被拒绝都给出明确原因', async () => {
  // 只会说"用户名密码错误"的假 SOCKS5 服务器
  const server = createServer((sock) => {
    sock.once('data', () => {
      sock.write(Buffer.from([5, 2]));
      sock.once('data', () => sock.end(Buffer.from([1, 1])));
    });
  });
  server.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const port = (server.address() as AddressInfo).port;
  try {
    const bad = await checkSocks({ host: '127.0.0.1', port, username: 'u', password: 'wrong' }, 3000);
    assert.equal(bad.ok, false);
    assert.equal(bad.error, 'SOCKS 握手失败:用户名或密码错误');
  } finally {
    await new Promise((r) => server.close(r));
  }
  const refused = await checkSocks({ host: '127.0.0.1', port, username: '', password: '' }, 3000);
  assert.equal(refused.error, '连接代理失败:连接被拒绝');
  assert.deepEqual(parseTrace('fl=1\nip=203.0.113.9\nts=1\nloc=US\n'), { ip: '203.0.113.9', loc: 'US' });
});
