import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addPanel, memoryDb } from '../testUtil';
import { createSocks, getSocksView, saveCheck, updateSocks } from '../socks/repo';
import { GEO_RETRY_MS, geoIpOf, refreshPanelGeo, refreshSocksGeo, type GeoLookup } from './geo';
import { getPanel, recordIp, updatePanel, validLocation } from './repo';

/** 假的 IP 库:记下查了哪些 IP;fail 里的 IP 查不到 */
function fakeLookup(calls: string[], fail = new Set<string>()): GeoLookup {
  return async (ip) => {
    calls.push(ip);
    if (fail.has(ip)) throw new Error('ipwho.is:Reserved range');
    return { lat: 22.3, lng: 114.2, city: 'Hong Kong', country: 'HK' };
  };
}
const geo = (db: ReturnType<typeof memoryDb>, id: number) => {
  const p = getPanel(db, id)!;
  return [p.geo_lat, p.geo_lng, p.geo_city, p.geo_country, p.geo_manual, p.geo_error];
};

test('按 IP 查位置:地址是 IP 或检查时解析出了 IP 才查;查过的不重查,IP 变了重查;同一个 IP 只查一次', async () => {
  const db = memoryDb();
  const a = addPanel(db, 'a', 'https://203.0.113.5:2053/x');
  const b = addPanel(db, 'b', 'https://b.example:2053/x');
  const c = addPanel(db, 'c', 'https://203.0.113.5:8443/y');
  const calls: string[] = [];
  await refreshPanelGeo(db, fakeLookup(calls), 1000);
  assert.deepEqual(calls, ['203.0.113.5']);
  assert.deepEqual(geo(db, a.id), [22.3, 114.2, 'Hong Kong', 'HK', false, '']);
  assert.deepEqual(geo(db, c.id), [22.3, 114.2, 'Hong Kong', 'HK', false, '']);
  // 域名还没解析出 IP:不查,写上原因
  assert.deepEqual(geo(db, b.id), [null, null, '', '', false, '还没解析出 IP,检查一次面板后再看']);
  await refreshPanelGeo(db, fakeLookup(calls), 2000);
  assert.deepEqual(calls, ['203.0.113.5']);
  // 解析出 IP 了:查;面板 IP 变了:重查
  recordIp(db, b.id, '198.51.100.7');
  recordIp(db, a.id, '198.51.100.8');
  await refreshPanelGeo(db, fakeLookup(calls), 3000);
  assert.deepEqual(calls.slice(1).sort(), ['198.51.100.7', '198.51.100.8']);
  assert.equal(getPanel(db, b.id)!.geo_city, 'Hong Kong');
  assert.equal(geoIpOf({ ip: null, base_url: 'https://[2001:db8::1]:2053' }), '2001:db8::1');
});

test('查不到:记原因、清掉坐标,1 小时内不重试', async () => {
  const db = memoryDb();
  const a = addPanel(db, 'a', 'https://10.0.0.1:2053/x');
  const calls: string[] = [];
  const fail = new Set(['10.0.0.1']);
  await refreshPanelGeo(db, fakeLookup(calls, fail), 1000);
  assert.deepEqual(geo(db, a.id), [null, null, '', '', false, 'ipwho.is:Reserved range']);
  await refreshPanelGeo(db, fakeLookup(calls, fail), 1000 + GEO_RETRY_MS - 1);
  assert.equal(calls.length, 1);
  fail.clear();
  await refreshPanelGeo(db, fakeLookup(calls, fail), 1000 + GEO_RETRY_MS);
  assert.deepEqual([calls.length, getPanel(db, a.id)!.geo_error, getPanel(db, a.id)!.geo_lat], [2, '', 22.3]);
});

test('手动填坐标:不再自动查;改回自动就清掉,下次按 IP 重查;校验', async () => {
  const db = memoryDb();
  const a = addPanel(db, 'a', 'https://203.0.113.5:2053/x');
  const calls: string[] = [];
  await refreshPanelGeo(db, fakeLookup(calls), 1000);
  updatePanel(db, a.id, { location: { lat: '35.6895', lng: 139.69171234, city: ' 东京 ' } });
  assert.deepEqual(geo(db, a.id), [35.6895, 139.69171, '东京', '', true, '']);
  recordIp(db, a.id, '198.51.100.9');
  await refreshPanelGeo(db, fakeLookup(calls), 2000);
  assert.equal(calls.length, 1);
  // 只改别的字段:位置不动
  updatePanel(db, a.id, { name: 'a2' });
  assert.equal(getPanel(db, a.id)!.geo_manual, true);
  updatePanel(db, a.id, { location: null });
  assert.deepEqual(geo(db, a.id), [null, null, '', '', false, '']);
  await refreshPanelGeo(db, fakeLookup(calls), 3000);
  assert.deepEqual([calls, getPanel(db, a.id)!.geo_lat], [['203.0.113.5', '198.51.100.9'], 22.3]);

  assert.equal(validLocation(''), null);
  for (const bad of [{ lat: 91, lng: 0 }, { lat: 0, lng: -181 }, { lat: '', lng: 1 }, { lat: 'x', lng: 1 }, { lat: 1 }, 'tokyo', { lat: 1, lng: 1, city: 'x'.repeat(41) }]) assert.throws(() => validLocation(bad), /纬度|经度|位置|地点名/, JSON.stringify(bad));
  assert.throws(() => updatePanel(db, a.id, { name: 'a3', location: { lat: 100, lng: 0 } }), /纬度/);
  assert.equal(getPanel(db, a.id)!.name, 'a2');
});

test('SOCKS 定位:按测出来的出口 IP;还没测过先按地址里的 IP;测试失败时留着原来的位置;能手动填', async () => {
  const db = memoryDb();
  const a = createSocks(db, { name: 'a', address: '198.51.100.20:1080' });
  const b = createSocks(db, { name: 'b', address: 'isp.example.net:1080' });
  const calls: string[] = [];
  await refreshSocksGeo(db, fakeLookup(calls), 1000);
  assert.deepEqual(calls, ['198.51.100.20']);
  assert.equal(getSocksView(db, a)!.geo_city, 'Hong Kong');
  assert.deepEqual([getSocksView(db, b)!.geo_lat, getSocksView(db, b)!.geo_error], [null, '还没测出出口 IP,点「测试」后再看']);
  // 测出出口 IP 了:按出口查(a 的出口和地址不一样,重查)
  saveCheck(db, a, { at: 2000, ok: true, ms: 100, ip: '203.0.113.30', loc: 'JP', error: null });
  saveCheck(db, b, { at: 2000, ok: true, ms: 100, ip: '203.0.113.31', loc: 'US', error: null });
  await refreshSocksGeo(db, fakeLookup(calls), 3000);
  assert.deepEqual(calls.slice(1).sort(), ['203.0.113.30', '203.0.113.31']);
  assert.equal(getSocksView(db, b)!.geo_error, '');
  // 测试失败(出口 IP 空了):不查,位置留着
  saveCheck(db, a, { at: 4000, ok: false, ms: 10000, ip: null, loc: null, error: '超时' });
  await refreshSocksGeo(db, fakeLookup(calls), 5000);
  assert.deepEqual([calls.length, getSocksView(db, a)!.geo_lat, getSocksView(db, a)!.geo_ip], [3, 22.3, '203.0.113.30']);
  // 手动填:不再查;改回自动按出口 IP 重查
  updateSocks(db, b, { location: { lat: 35.68, lng: 139.69, city: '东京' } });
  assert.deepEqual([getSocksView(db, b)!.geo_manual, getSocksView(db, b)!.geo_city], [true, '东京']);
  await refreshSocksGeo(db, fakeLookup(calls), 6000);
  assert.equal(calls.length, 3);
  updateSocks(db, b, { location: null });
  await refreshSocksGeo(db, fakeLookup(calls), 7000);
  assert.deepEqual([calls.at(-1), getSocksView(db, b)!.geo_manual, getSocksView(db, b)!.geo_lat], ['203.0.113.31', false, 22.3]);
  assert.throws(() => updateSocks(db, b, { location: { lat: 0, lng: 200 } }), /经度/);
});
