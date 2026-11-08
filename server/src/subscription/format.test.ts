import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isBrowserUA, targetFromParam, targetFromUA } from './format';

test('按 UA 识别格式', () => {
  const cases: [string, string | null][] = [
    ['clash-verge/v2.2.3', 'clash'],
    ['mihomo.party/v1.7.0 (clash.meta)', 'clash'],
    ['FlClash/v0.8.80 clash-verge Platform/android', 'clash'],
    ['ClashMetaForAndroid/2.11.5.Meta', 'clash'],
    ['Stash/2.7.6 Clash/1.11.0', 'clash'],
    ['HiddifyNext/2.5.7 (android) like ClashMeta v2rayNG v2rayN', 'singbox'],
    ['SFA/1.11.0 (sing-box 1.11.0)', 'singbox'],
    ['SFI/1.11.0 (Version 1.11.0 (310); sing-box 1.11.0)', 'singbox'],
    ['Surge iOS/3270', 'surge'],
    ['Quantumult%20X/1.4.1', 'quanx'],
    ['Loon/774 CFNetwork/1568', 'loon'],
    ['Shadowrocket/2070 CFNetwork/1568 Darwin/24.0.0', 'clash'],
    ['v2rayN/7.10.5', 'base64'],
    ['v2rayNG/1.9.30', 'base64'],
    ['NekoBox/Android/1.3.4 (Prefer ClashMeta Format)', 'clash'],
    ['curl/8.0', null],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', null],
  ];
  for (const [ua, expected] of cases) assert.equal(targetFromUA(ua), expected, ua);
  assert.equal(targetFromUA(undefined), null);
});

test('?target= 参数', () => {
  assert.equal(targetFromParam('Clash'), 'clash');
  assert.equal(targetFromParam('v2ray'), 'base64');
  assert.equal(targetFromParam('sing-box'), 'singbox');
  assert.equal(targetFromParam('nope'), null);
  assert.equal(targetFromParam(['clash']), null);
});

test('识别浏览器', () => {
  assert.equal(isBrowserUA('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1'), true);
  assert.equal(isBrowserUA('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36'), true);
  assert.equal(isBrowserUA('clash-verge/v2.2.3'), false);
  assert.equal(isBrowserUA('Mozilla/5.0 Shadowrocket/2070'), false);
  assert.equal(isBrowserUA(undefined), false);
});
