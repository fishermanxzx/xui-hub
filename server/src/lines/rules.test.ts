import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSocks } from '../socks/repo';
import { memoryDb } from '../testUtil';
import { validRules } from './rules';

test('出口规则校验:条件至少一样,域名 / IP / 端口 / 网络的写法,出口只能是登记的 SOCKS、直出、拦截', () => {
  const db = memoryDb();
  const sid = createSocks(db, { name: 'us', address: '198.51.100.9:1080' });
  const ok = validRules(db, [
    { domain: 'geosite:netflix, netflix.com\nnetflix.com', to: { kind: 'socks', socks_id: sid } },
    { ip: ['geoip:cn', '203.0.113.0/24', '2001:db8::/32'], port: '80,443,1000-2000', network: 'TCP,UDP', to: { kind: 'direct' } },
    { domain: ['regexp:.*\\.ads\\.'], to: { kind: 'block' } },
  ]);
  assert.deepEqual(ok[0], { domain: ['geosite:netflix', 'netflix.com'], ip: [], port: '', network: '', to: { kind: 'socks', socks_id: sid } });
  assert.deepEqual([ok[1].ip, ok[1].port, ok[1].network], [['geoip:cn', '203.0.113.0/24', '2001:db8::/32'], '80,443,1000-2000', 'tcp,udp']);
  assert.deepEqual(validRules(db, []), []);
  for (const [bad, msg] of [
    [[{ to: { kind: 'direct' } }], /至少要填/],
    [[{ ip: 'cn', to: { kind: 'direct' } }], /IP「cn」不对/],
    [[{ port: '443a', to: { kind: 'direct' } }], /端口写法/],
    [[{ network: 'icmp', to: { kind: 'direct' } }], /tcp、udp/],
    [[{ domain: 'a b.com', to: { kind: 'direct' } }], /不能有空格/],
    [[{ domain: 'a.com', to: { kind: 'socks', socks_id: 999 } }], /SOCKS 页登记/],
    [[{ domain: 'a.com', to: { kind: 'vless' } }], /只能是 SOCKS、直出或拦截/],
    [Array.from({ length: 21 }, () => ({ domain: 'a.com', to: { kind: 'direct' } })), /最多 20 条/],
    ['x', /要是数组/],
  ] as const) {
    assert.throws(() => validRules(db, bad), msg);
  }
});
