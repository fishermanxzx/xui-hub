import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Panel } from '../panels/repo';
import { createSocks } from '../socks/repo';
import { decodeJson } from '../xui/json';
import { addPanel, memoryDb } from '../testUtil';
import { accountOf, applyRoute, builtinMixedInbound, ensureOutbound, parseExitSpec, prepareExit, removeRoute, routeUserToExit, unrouteUser, type ExitAdmin } from './relay';

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
  assert.equal(xray.outbounds.length, 4);
  assert.equal(unrouteUser(xray, 'in-a', 'zhang'), true);
  assert.equal(unrouteUser(xray, 'in-a', 'zhang'), false);
  assert.equal(xray.routing.rules.filter((r: any) => r.user).length, 1);
  // 没有兜底规则时追加在最后
  const bare: any = { outbounds: [{ tag: 'direct', protocol: 'freedom' }], routing: {} };
  routeUserToExit(bare, 'in-x', 'w', { address: '9.9.9.9', port: 1, user: '', pass: '' });
  assert.equal(bare.routing.rules.length, 1);
});

test('applyRoute:读配置、改路由、按原 testUrl 写回并重启', async () => {
  const calls: string[] = [];
  let saved: any = null;
  const admin = {
    xraySettings: async () => ({ xraySetting: JSON.stringify({ outbounds: [{ tag: 'direct', protocol: 'freedom' }], routing: { rules: [] } }), outboundTestUrl: 'https://t/204' }),
    updateXray: async (x: any, url: string) => void (calls.push(`update ${url}`), (saved = x)),
    restartXray: async () => void calls.push('restart'),
  };
  const tag = await applyRoute(admin, 'in-1', 'zhang', { address: '1.1.1.1', port: 1080, user: 'u', pass: 'p' });
  assert.equal(tag, 'socks-1.1.1.1-1080');
  assert.deepEqual(calls, ['update https://t/204', 'restart']);
  assert.deepEqual(saved.routing.rules, [{ type: 'field', inboundTag: ['in-1'], user: ['zhang'], outboundTag: 'socks-1.1.1.1-1080' }]);
  // 删规则:有就写回并重启,没有就不动
  const admin2 = { xraySettings: async () => ({ xraySetting: JSON.stringify(saved) }), updateXray: async (x: any) => void (saved = x), restartXray: async () => void calls.push('restart2') };
  assert.equal(await removeRoute(admin2, 'in-1', 'zhang'), true);
  assert.equal(saved.routing.rules.length, 0);
  assert.equal(await removeRoute(admin2, 'in-1', 'zhang'), false);
  assert.deepEqual(calls.slice(2), ['restart2']);
});

test('出口:SOCKS 直接取登记的账号;落地用已有 socks 入站或新建一个带随机账号的 mixed 入站', async () => {
  const db = memoryDb();
  const landing = addPanel(db, 'landing', 'https://9.9.9.9:2053/p');
  const sid = createSocks(db, { name: 'isp', address: 'socks5://u:p@isp.example.com:1080' });
  const data: Record<string, any[]> = { landing: [{ id: 1, remark: 'old-socks', protocol: 'mixed', port: 3000, enable: true, settings: { auth: 'password', accounts: [{ user: 'a', pass: 'b' }] } }] };
  const adminFor = (p: Panel): ExitAdmin => ({
    listInbounds: async () => structuredClone(data[p.name]),
    addInbound: async (body: any) => void data[p.name].push({ ...structuredClone(body), id: data[p.name].length + 1 }),
  });

  const s = await prepareExit(db, parseExitSpec({ kind: 'socks', socks_id: sid }), adminFor, '1.1.1.1');
  assert.deepEqual([s.server, s.exit_kind, s.exit_socks_id, s.label], [{ address: 'isp.example.com', port: 1080, user: 'u', pass: 'p' }, 'socks', sid, 'SOCKS isp']);

  const existing = await prepareExit(db, parseExitSpec({ kind: 'panel', panel_id: landing.id, inbound_id: 1 }), adminFor, '1.1.1.1');
  assert.deepEqual([existing.server, existing.exit_port, existing.created_inbound], [{ address: '9.9.9.9', port: 3000, user: 'a', pass: 'b' }, 3000, null]);

  const fresh = await prepareExit(db, parseExitSpec({ kind: 'panel', panel_id: landing.id }), adminFor, '1.1.1.1');
  assert.equal(fresh.created_inbound, 'relay-socks');
  const ib = data.landing[1];
  assert.equal(ib.protocol, 'mixed');
  assert.deepEqual(accountOf(ib), { user: fresh.server.user, pass: fresh.server.pass });
  assert.ok(fresh.server.user.startsWith('r') && fresh.server.pass.length >= 12);
  assert.equal(fresh.server.port, Number(ib.port));
  assert.deepEqual(decodeJson(builtinMixedInbound(1, 'x', 'u', 'p').settings).accounts, [{ user: 'u', pass: 'p' }]);

  await assert.rejects(prepareExit(db, parseExitSpec({ kind: 'panel', panel_id: landing.id }), adminFor, '9.9.9.9'), /同一块面板/);
  await assert.rejects(prepareExit(db, parseExitSpec({ kind: 'panel', panel_id: landing.id, inbound_id: 99 }), adminFor, '1.1.1.1'), /没有这个入站/);
  assert.throws(() => parseExitSpec({}), /出口/);
});
