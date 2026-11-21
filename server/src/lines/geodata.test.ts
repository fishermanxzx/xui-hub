import assert from 'node:assert/strict';
import { test } from 'node:test';
import { XUIError, type GeoIssue, type GeoKind } from '../xui/client';
import { checkRulesGeo, isGeoToken, validateTokens } from './geodata';
import type { LineRule } from './rules';

const rule = (domain: string[], ip: string[] = []): LineRule => ({ domain, ip, port: '', network: '', to: { kind: 'block' } });

test('isGeoToken:geosite / geoip / ext 写法(含反选)才查库,普通域名和网段不查', () => {
  for (const x of ['geosite:cn', 'geoip:!cn', '!geoip:cn', 'ext:a.dat:b', 'ext-ip:a.dat:b', 'ext-domain:a.dat:b', ' GEOSITE:cn']) assert.ok(isGeoToken(x), x);
  for (const x of ['cn', 'domain:geosite.com', 'full:a.com', '1.1.1.0/24', 'keyword:geoip']) assert.ok(!isGeoToken(x), x);
});

test('validateTokens:去重、分批(每批 500 个)问面板;面板没有接口(404)返回 null,别的错照抛', async () => {
  const calls: string[][] = [];
  const admin = { geodataValidate: async (_k: GeoKind, tokens: string[]): Promise<GeoIssue[]> => (calls.push(tokens), []) };
  const tokens = Array.from({ length: 1200 }, (_, i) => `geosite:c${i}`);
  assert.deepEqual(await validateTokens(admin, 'site', [...tokens, 'geosite:c0', 'a.com']), []);
  assert.deepEqual(calls.map((c) => c.length), [500, 500, 200]);
  assert.equal(await validateTokens({ geodataValidate: async () => Promise.reject(new XUIError('404', 404)) }, 'site', ['geosite:cn']), null);
  assert.equal(await validateTokens({}, 'site', ['geosite:cn']), null);
  await assert.rejects(validateTokens({ geodataValidate: async () => Promise.reject(new XUIError('连接失败')) }, 'site', ['geosite:cn']), /连接失败/);
});

test('checkRulesGeo:没有 geo 写法不问面板;对不上的最多列 5 处,写明第几条规则', async () => {
  let asked = 0;
  const admin = {
    geodataValidate: async (_k: GeoKind, tokens: string[]): Promise<GeoIssue[]> => {
      asked++;
      return tokens.map((token) => ({ token, reason: 'categoryMissing', file: 'geosite.dat', code: token.slice(8) }));
    },
  };
  await checkRulesGeo(admin, [rule(['a.com'], ['1.1.1.0/24'])]);
  assert.equal(asked, 0);
  await assert.rejects(
    checkRulesGeo(admin, [rule(['a.com']), rule(['geosite:x1', 'geosite:x2', 'geosite:x3', 'geosite:x4', 'geosite:x5', 'geosite:x6'])]),
    (e: Error) => /^第 2 条规则的域名「geosite:x1」/.test(e.message) && /等 6 处/.test(e.message) && !e.message.includes('x6'),
  );
  // 属性不存在不拦
  await checkRulesGeo({ geodataValidate: async (_k, [token]) => [{ token, reason: 'attributeMissing', file: 'geosite.dat', code: 'zz' }] }, [rule(['geosite:cn@zz'])]);
});
