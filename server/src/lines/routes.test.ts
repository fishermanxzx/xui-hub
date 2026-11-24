import assert from 'node:assert/strict';
import { test } from 'node:test';
import { routesForClient } from './routes';

const socksOut = (tag: string, address: string, port: number) => ({ tag, protocol: 'socks', settings: { servers: [{ address, port }] } });
const SOCKS = [{ id: 7, host: 'isp-us.example.net', port: 10002 }];

test('没有点名客户端的规则:走接住这个入站的兜底规则;都没有就是第一个出站。全局的带条件规则不列', () => {
  // 3x-ui 默认的配置:私有 IP、bittorrent 拦截,没有兜底规则 → 第一个出站(直连)
  const def = {
    outbounds: [{ tag: 'direct', protocol: 'freedom' }, { tag: 'blocked', protocol: 'blackhole' }],
    routing: { rules: [{ inboundTag: ['api'], outboundTag: 'api' }, { ip: ['geoip:private'], outboundTag: 'blocked' }, { protocol: ['bittorrent'], outboundTag: 'blocked' }] },
  };
  assert.deepEqual(routesForClient(def, 'in-443', 'a', SOCKS), [{ when: {}, to: { kind: 'direct', tag: 'direct' }, fallback: true }]);
  const caught = { ...def, routing: { rules: [...def.routing.rules, { inboundTag: ['in-443'], outboundTag: 'blocked' }] } };
  assert.deepEqual(routesForClient(caught, 'in-443', 'a', SOCKS), [{ when: {}, to: { kind: 'block', tag: 'blocked' }, fallback: true }]);
  assert.deepEqual(routesForClient({}, 'in-443', 'a', SOCKS), []);
});

test('一个客户端按规则走多个出口:按顺序列出条件和去向,登记过的 SOCKS 认出来,最后是其余流量', () => {
  const xray = {
    outbounds: [
      { tag: 'direct', protocol: 'freedom' },
      socksOut('socks-us', 'ISP-US.example.net', 10002),
      socksOut('jp-raw', '192.0.2.31', 1080),
      { tag: 'hk-vless', protocol: 'vless', settings: { vnext: [{ address: 'hk.example.com', port: 443 }] } },
    ],
    routing: {
      balancers: [{ tag: 'lb', selector: ['hk'] }],
      rules: [
        { inboundTag: ['in-443'], user: ['other'], outboundTag: 'jp-raw' },
        { inboundTag: ['in-443'], user: ['zhang', 'li'], domain: ['geosite:netflix', 'netflix.com'], outboundTag: 'socks-us' },
        { inboundTag: ['in-443'], user: ['zhang'], ip: ['geoip:jp'], port: '443', outboundTag: 'jp-raw', enabled: false },
        { user: ['zhang'], ip: ['geoip:jp'], network: 'tcp,udp', outboundTag: 'jp-raw' },
        { inboundTag: ['in-443'], user: ['zhang'], domain: ['openai.com'], balancerTag: 'lb' },
        { ip: ['geoip:private'], outboundTag: 'direct' },
        { inboundTag: ['in-443'], user: ['zhang'], outboundTag: 'hk-vless' },
        { inboundTag: ['in-443'], outboundTag: 'direct' },
      ],
    },
  };
  assert.deepEqual(routesForClient(xray, 'in-443', 'zhang', SOCKS), [
    { when: { domain: ['geosite:netflix', 'netflix.com'] }, to: { kind: 'socks', tag: 'socks-us', address: 'isp-us.example.net:10002', socks_id: 7 }, fallback: false, origin: 'shared' },
    { when: { ip: ['geoip:jp'], network: ['tcp', 'udp'] }, to: { kind: 'proxy', tag: 'jp-raw', address: '192.0.2.31:1080' }, fallback: false, origin: 'own' },
    { when: { domain: ['openai.com'] }, to: { kind: 'balancer', tag: 'lb' }, fallback: false, origin: 'own' },
    { when: {}, to: { kind: 'proxy', tag: 'hk-vless', address: 'hk.example.com:443' }, fallback: true, origin: 'xui' },
  ]);
  // 同入站的别的客户端:只有点名他的那条 + 兜底;别的入站不受这些规则影响
  assert.deepEqual(routesForClient(xray, 'in-443', 'li', SOCKS).map((h) => h.to.tag), ['socks-us', 'direct']);
  assert.deepEqual(routesForClient(xray, 'in-8443', 'zhang', SOCKS).map((h) => h.to.tag), ['jp-raw', 'direct']);
  // 出站名写错了:unknown
  assert.deepEqual(routesForClient({ outbounds: [], routing: { rules: [{ user: ['x'], outboundTag: 'gone' }] } }, 'in', 'x', SOCKS), [{ when: {}, to: { kind: 'unknown', tag: 'gone' }, fallback: true, origin: 'own' }]);
});
