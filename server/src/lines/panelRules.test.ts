import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Line } from '../customers/repo';
import { createSocks } from '../socks/repo';
import { memoryDb } from '../testUtil';
import { listPanelRules, ruleKey } from './panelRules';
import { routesForClient } from './routes';

const outbounds = [
  { tag: 'direct', protocol: 'freedom' },
  { tag: 'direct-v4', protocol: 'freedom', settings: { domainStrategy: 'UseIPv4' } },
  { tag: 'blocked', protocol: 'blackhole' },
  { tag: 'socks-us', protocol: 'socks', settings: { servers: [{ address: 'ISP.example.com', port: 1080, users: [{ user: 'u', pass: 'p' }] }] } },
  { tag: 'socks-bad', protocol: 'socks', settings: { servers: [{ address: 'isp.example.com', port: 1080, users: [{ user: 'u', pass: 'x' }] }] } },
  { tag: 'socks-other', protocol: 'socks', settings: { servers: [{ address: 'other.example.com', port: 9 }] } },
  { tag: 'vm', protocol: 'vmess', settings: { vnext: [{ address: 'vm.example.com', port: 443 }] } },
];
const line = (rules = 0) => ({ email: 'zhang', rules: Array.from({ length: rules }, () => ({ domain: ['a.com'], ip: [], port: '', network: '', to: { kind: 'direct' } })) }) as unknown as Line;

test('面板上手配的规则:只点名他的能删,条件和出口对得上的能接管;多人共用 / 别的入站只读;xui-hub 写的、别人的、别的入站的不列', () => {
  const db = memoryDb();
  const us = createSocks(db, { name: 'us', address: 'socks5://u:p@isp.example.com:1080' });
  const rules = [
    { type: 'field', ruleTag: 'xui-hub:in-500:zhang:1', inboundTag: ['in-500'], user: ['zhang'], domain: ['x.com'], outboundTag: 'direct' },
    { type: 'field', inboundTag: ['in-500'], user: ['zhang'], domain: ['geosite:google'], outboundTag: 'socks-us' },
    { type: 'field', user: ['zhang'], ip: ['geoip:cn'], port: 443, network: 'tcp', outboundTag: 'direct' },
    { type: 'field', inboundTag: ['in-500'], user: ['zhang'], domain: ['ads.com'], outboundTag: 'blocked' },
    { type: 'field', inboundTag: ['in-500'], user: ['zhang'], domain: ['v4.com'], outboundTag: 'direct-v4' },
    { type: 'field', inboundTag: ['in-500'], user: ['zhang'], domain: ['bad.com'], outboundTag: 'socks-bad' },
    { type: 'field', inboundTag: ['in-500'], user: ['zhang'], domain: ['other.com'], outboundTag: 'socks-other' },
    { type: 'field', inboundTag: ['in-500'], user: ['zhang'], domain: ['vm.com'], outboundTag: 'vm' },
    { type: 'field', inboundTag: ['in-500'], user: ['zhang'], source: ['10.0.0.0/8'], outboundTag: 'direct' },
    { type: 'field', inboundTag: ['in-500'], user: ['zhang'], domain: ['lb.com'], balancerTag: 'lb' },
    { type: 'field', inboundTag: ['in-500'], user: ['zhang', 'li'], domain: ['shared.com'], outboundTag: 'direct' },
    { type: 'field', inboundTag: ['in-500', 'in-600'], user: ['zhang'], domain: ['two.com'], outboundTag: 'direct' },
    { type: 'field', inboundTag: ['in-600'], user: ['zhang'], domain: ['elsewhere.com'], outboundTag: 'direct' },
    { type: 'field', inboundTag: ['in-500'], user: ['li'], domain: ['li.com'], outboundTag: 'direct' },
    { type: 'field', inboundTag: ['in-500'], user: ['zhang'], domain: ['off.com'], outboundTag: 'direct', enabled: false },
    { type: 'field', user: ['zhang'], outboundTag: 'socks-us' },
    { type: 'field', inboundTag: ['in-500'], user: ['zhang'], domain: ['dead.com'], outboundTag: 'direct' },
    { type: 'field', inboundTag: ['in-500'], outboundTag: 'direct' },
  ];
  const xray = { outbounds, routing: { rules } };
  const got = listPanelRules(db, xray, 'in-500', line());
  const by = (d: string) => got.find((r) => (r.when.domain ?? r.when.ip ?? [])[0] === d || (d === '' && !Object.keys(r.when).length))!;
  assert.deepEqual(
    got.map((r) => (r.when.domain ?? r.when.ip ?? r.when.source ?? ['(全部)'])[0]),
    ['geosite:google', 'geoip:cn', 'ads.com', 'v4.com', 'bad.com', 'other.com', 'vm.com', '10.0.0.0/8', 'lb.com', 'shared.com', 'two.com', '(全部)', 'dead.com'],
  );
  assert.deepEqual(by('geosite:google').takeover, { domain: ['geosite:google'], ip: [], port: '', network: '', to: { kind: 'socks', socks_id: us } });
  assert.deepEqual(by('geoip:cn').takeover, { domain: [], ip: ['geoip:cn'], port: '443', network: 'tcp', to: { kind: 'direct' } });
  assert.deepEqual(by('ads.com').takeover?.to, { kind: 'block' });
  assert.match(by('v4.com').why, /不是面板上第一个直出出站/);
  assert.match(by('bad.com').why, /账号密码.*「us」对不上/);
  assert.match(by('other.com').why, /other\.example\.com:9 没在 SOCKS 页登记/);
  assert.match(by('vm.com').why, /vmess 协议/);
  assert.match(got.find((r) => r.when.source)!.why, /不支持的条件\(source\)/);
  assert.match(by('lb.com').why, /负载均衡「lb」/);
  assert.deepEqual([by('shared.com').own, by('shared.com').users, by('shared.com').takeover], [false, 2, null]);
  assert.match(by('shared.com').why, /点名了 2 个客户端/);
  assert.deepEqual([by('two.com').own, by('two.com').why], [false, '还限定了别的入站,只能去 3x-ui 里改']);
  const whole = got[11];
  assert.deepEqual([whole.own, whole.takeover, whole.active, whole.to.kind, whole.to.socks_id], [true, null, true, 'socks', us]);
  assert.match(whole.why, /没有条件/);
  // 排在接住他全部流量的规则后面:不生效
  assert.deepEqual([by('dead.com').active, by('geosite:google').active], [false, true]);
  assert.equal(by('geosite:google').key, ruleKey(rules[1]));

  // 线路的出口规则满了:不能再接管,能删
  const full = listPanelRules(db, xray, 'in-500', line(20)).find((r) => r.when.domain?.[0] === 'geosite:google')!;
  assert.deepEqual([full.own, full.takeover], [true, null]);
  assert.match(full.why, /已经有 20 条/);
});

test('实际出口标上归谁管:xui-hub 写的、手配只点名他的、多人共用的;入站兜底不标', () => {
  const xray = {
    outbounds,
    routing: {
      rules: [
        { type: 'field', ruleTag: 'xui-hub:in-500:zhang:1', inboundTag: ['in-500'], user: ['zhang'], domain: ['x.com'], outboundTag: 'blocked' },
        { type: 'field', inboundTag: ['in-500'], user: ['zhang'], domain: ['geosite:google'], outboundTag: 'socks-us' },
        { type: 'field', inboundTag: ['in-500'], user: ['zhang', 'li'], domain: ['shared.com'], outboundTag: 'direct' },
        { type: 'field', inboundTag: ['in-500'], user: ['zhang'], outboundTag: 'socks-us' },
      ],
    },
  };
  assert.deepEqual(routesForClient(xray, 'in-500', 'zhang', []).map((h) => [h.fallback, h.origin]), [
    [false, 'xui'],
    [false, 'own'],
    [false, 'shared'],
    [true, 'xui'],
  ]);
  // 没有他自己的出口:兜底是入站的规则,不标;不限入站的手配出口标 own
  assert.deepEqual(routesForClient({ outbounds, routing: { rules: [{ type: 'field', inboundTag: ['in-500'], outboundTag: 'direct' }] } }, 'in-500', 'zhang', []).map((h) => h.origin), [undefined]);
  assert.deepEqual(routesForClient({ outbounds, routing: { rules: [{ type: 'field', user: ['zhang'], outboundTag: 'direct' }] } }, 'in-500', 'zhang', []).map((h) => h.origin), ['own']);
});
