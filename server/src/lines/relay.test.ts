import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSocks } from '../socks/repo';
import { memoryDb } from '../testUtil';
import { applyRoutes, ensureOutbound, parseExitSocksId, prepareExit, removeRoutes, routeUserToExit, unrouteUser } from './relay';

const socksOut = (tag: string, address: string, port: number, user?: string, pass?: string) => ({
  tag,
  protocol: 'socks',
  settings: { servers: [{ address, port, ...(user ? { users: [{ user, pass }] } : {}) }] },
});

test('出站:地址、端口、账号都一致才复用,否则新加一个不重名的 socks 出站', () => {
  const xray: any = { outbounds: [{ tag: 'direct', protocol: 'freedom' }, socksOut('socks-1.2.3.4-1080', '1.2.3.4', 1080, 'u', 'p')] };
  assert.equal(ensureOutbound(xray, { address: '1.2.3.4', port: 1080, user: 'u', pass: 'p' }), 'socks-1.2.3.4-1080');
  assert.equal(ensureOutbound(xray, { address: '1.2.3.4', port: 1080, user: 'u', pass: 'other' }), 'socks-1.2.3.4-1080-2');
  assert.equal(xray.outbounds.length, 3);
  assert.deepEqual(xray.outbounds[2].settings.servers[0], { address: '1.2.3.4', port: 1080, users: [{ user: 'u', pass: 'other' }] });
  assert.equal(ensureOutbound(xray, { address: '5.5.5.5', port: 1, user: '', pass: '' }), 'socks-5.5.5.5-1');
  assert.deepEqual(xray.outbounds[3].settings.servers[0].users, []);
});

test('按客户端路由:规则带 user,放在会接住这个入站的兜底规则之前;同入站别的客户端不受影响;换出口替换旧规则;删线路去掉规则', () => {
  const xray: any = {
    outbounds: [{ tag: 'direct', protocol: 'freedom' }, { tag: 'block', protocol: 'blackhole' }],
    routing: {
      rules: [
        { type: 'field', ip: ['geoip:private'], outboundTag: 'block' },
        { type: 'field', inboundTag: ['in-a', 'in-b'], outboundTag: 'direct' },
        { type: 'field', outboundTag: 'direct' },
      ],
    },
  };
  const tag = routeUserToExit(xray, 'in-a', 'zhang', { address: '9.9.9.9', port: 1080, user: 'u', pass: 'p' });
  assert.equal(tag, 'socks-9.9.9.9-1080');
  assert.deepEqual(xray.routing.rules, [
    { type: 'field', ip: ['geoip:private'], outboundTag: 'block' },
    { type: 'field', inboundTag: ['in-a'], user: ['zhang'], outboundTag: 'socks-9.9.9.9-1080' },
    { type: 'field', inboundTag: ['in-a', 'in-b'], outboundTag: 'direct' },
    { type: 'field', outboundTag: 'direct' },
  ]);
  // 同一入站上另一位客户端走别的出口:两条规则并存
  routeUserToExit(xray, 'in-a', 'li', { address: '8.8.8.8', port: 1080, user: '', pass: '' });
  // 张三换出口:他的旧规则被替换,李四的不动
  routeUserToExit(xray, 'in-a', 'zhang', { address: '8.8.8.8', port: 1080, user: '', pass: '' });
  assert.deepEqual(
    xray.routing.rules.map((r: any) => [r.inboundTag ?? null, r.user ?? null, r.outboundTag]),
    [[null, null, 'block'], [['in-a'], ['li'], 'socks-8.8.8.8-1080'], [['in-a'], ['zhang'], 'socks-8.8.8.8-1080'], [['in-a', 'in-b'], null, 'direct'], [null, null, 'direct']],
  );
  // 张三原来的出站(9.9.9.9)没人用了,随着换出口删掉
  assert.deepEqual(xray.outbounds.map((o: any) => o.tag), ['direct', 'block', 'socks-8.8.8.8-1080']);
  // 已经是这个出口:再做一遍什么都不变
  const before = JSON.stringify(xray);
  routeUserToExit(xray, 'in-a', 'zhang', { address: '8.8.8.8', port: 1080, user: '', pass: '' });
  assert.equal(JSON.stringify(xray), before);
  assert.equal(unrouteUser(xray, 'in-a', 'zhang'), true);
  assert.equal(unrouteUser(xray, 'in-a', 'zhang'), false);
  assert.equal(xray.routing.rules.filter((r: any) => r.user).length, 1);
  assert.equal(xray.outbounds.length, 3, '李四还在用 8.8.8.8 的出站');
  assert.equal(unrouteUser(xray, 'in-a', 'li'), true);
  assert.deepEqual(xray.outbounds.map((o: any) => o.tag), ['direct', 'block']);
  // 没有兜底规则时追加在最后
  const bare: any = { outbounds: [{ tag: 'direct', protocol: 'freedom' }], routing: {} };
  routeUserToExit(bare, 'in-x', 'w', { address: '9.9.9.9', port: 1, user: '', pass: '' });
  assert.equal(bare.routing.rules.length, 1);
});

test('没人用的出站才删:别的规则、负载均衡、链式出站还在用的,和不是本系统建的,都留着', () => {
  const server = (n: number) => ({ address: `${n}.${n}.${n}.${n}`, port: 1080, user: '', pass: '' });
  const xray: any = {
    outbounds: [
      { tag: 'direct', protocol: 'freedom' },
      socksOut('my-proxy', '1.1.1.1', 1080), // 用户自己建的,tag 不是 socks- 开头
      socksOut('socks-2.2.2.2-1080', '2.2.2.2', 1080), // 另一条规则在用
      socksOut('socks-3.3.3.3-1080', '3.3.3.3', 1080), // 负载均衡按前缀选中
      socksOut('socks-4.4.4.4-1080', '4.4.4.4', 1080), // 别的出站经它拨号
      { tag: 'chained', protocol: 'freedom', streamSettings: { sockopt: { dialerProxy: 'socks-4.4.4.4-1080' } } },
      socksOut('socks-5.5.5.5-1080', '5.5.5.5', 1080),
    ],
    routing: {
      balancers: [{ tag: 'b', selector: ['socks-3'] }],
      rules: [{ type: 'field', domain: ['example.com'], outboundTag: 'socks-2.2.2.2-1080' }],
    },
  };
  for (const n of [1, 2, 3, 4, 5]) routeUserToExit(xray, 'in', `u${n}`, server(n));
  assert.equal(xray.outbounds.length, 7, '都复用了已有的出站');
  for (const n of [1, 2, 3, 4, 5]) unrouteUser(xray, 'in', `u${n}`);
  assert.deepEqual(xray.outbounds.map((o: any) => o.tag), ['direct', 'my-proxy', 'socks-2.2.2.2-1080', 'socks-3.3.3.3-1080', 'socks-4.4.4.4-1080', 'chained']);
});

test('applyRoutes / removeRoutes:读配置、改路由、按原 testUrl 写回并重启;没有变化就不写不重启', async () => {
  const calls: string[] = [];
  let saved: any = { outbounds: [{ tag: 'direct', protocol: 'freedom' }], routing: { rules: [] } };
  const admin = {
    xraySettings: async () => ({ xraySetting: JSON.stringify(saved), outboundTestUrl: 'https://t/204' }),
    updateXray: async (x: any, url: string) => void (calls.push(`update ${url}`), (saved = x)),
    restartXray: async () => void calls.push('restart'),
  };
  const server = { address: '1.1.1.1', port: 1080, user: 'u', pass: 'p' };
  // 两位客户端一起加:只写回一次、重启一次
  const routes = [{ inboundTag: 'in-1', email: 'zhang', server }, { inboundTag: 'in-1', email: 'li', server }];
  assert.equal(await applyRoutes(admin, routes), true);
  assert.deepEqual(calls, ['update https://t/204', 'restart']);
  assert.deepEqual(saved.routing.rules, [
    { type: 'field', inboundTag: ['in-1'], user: ['zhang'], outboundTag: 'socks-1.1.1.1-1080' },
    { type: 'field', inboundTag: ['in-1'], user: ['li'], outboundTag: 'socks-1.1.1.1-1080' },
  ]);
  assert.equal(saved.outbounds.length, 2);
  // 重做一遍:已经是这样,不动
  assert.equal(await applyRoutes(admin, routes), false);
  assert.equal(calls.length, 2);
  // 删规则:一次写回并重启,出站也跟着删掉;没有就不动
  assert.equal(await removeRoutes(admin, routes), true);
  assert.deepEqual([saved.routing.rules.length, saved.outbounds.length], [0, 1]);
  assert.equal(await removeRoutes(admin, routes), false);
  assert.deepEqual(calls.slice(2), ['update https://t/204', 'restart']);
  // 读到的配置没有出站:不往上写
  saved = {};
  await assert.rejects(applyRoutes(admin, routes), /不完整/);
  assert.equal(calls.length, 4);
});

test('出口:只认 SOCKS 页登记的代理,取它的地址和账号;旧的「落地面板」出口不再接受', () => {
  const db = memoryDb();
  const sid = createSocks(db, { name: 'isp', address: 'socks5://u:p@isp.example.com:1080' });
  const s = prepareExit(db, parseExitSocksId({ kind: 'socks', socks_id: sid }));
  assert.deepEqual(s, { server: { address: 'isp.example.com', port: 1080, user: 'u', pass: 'p' }, label: 'SOCKS isp', socks_id: sid });
  // kind 省略也行,只看 socks_id
  assert.equal(parseExitSocksId({ socks_id: sid }), sid);
  assert.throws(() => parseExitSocksId({ kind: 'panel', panel_id: 2 }), /登记到 SOCKS 页/);
  assert.throws(() => parseExitSocksId({}), /出口/);
  assert.throws(() => parseExitSocksId(null), /出口/);
  assert.throws(() => prepareExit(db, 999), /SOCKS 不存在/);
});
