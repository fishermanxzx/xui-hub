import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_SETTINGS, getSettings, updateSettings } from './settings';
import { memoryDb } from './testUtil';

test('设置:默认值;没传的字段不动;token / 地址 / 数字有校验', () => {
  const db = memoryDb();
  assert.deepEqual(getSettings(db), DEFAULT_SETTINGS);
  const s = updateSettings(db, { telegram: { token: '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ', chat_id: '-100123' }, notify: { expiring_days: 7, panel_down: false } });
  assert.equal(s.telegram.token, '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ');
  assert.deepEqual([s.notify.expiring_days, s.notify.panel_down, s.notify.quota_warn], [7, false, true]);
  // 再改别的,前面的还在
  assert.equal(updateSettings(db, { webhook: { url: 'https://h.example/x' } }).telegram.chat_id, '-100123');
  assert.equal(getSettings(db).webhook.url, 'https://h.example/x');
  assert.throws(() => updateSettings(db, { telegram: { token: 'nope' } }), /Bot token 格式不对/);
  assert.throws(() => updateSettings(db, { webhook: { url: 'ftp://x' } }), /http/);
  assert.throws(() => updateSettings(db, { notify: { quota_warn_pct: 10 } }), /50 到 99/);
  // 清空
  assert.equal(updateSettings(db, { telegram: { token: '' } }).telegram.token, '');
});
