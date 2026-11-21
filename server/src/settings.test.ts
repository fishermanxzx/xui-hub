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

test('设置:异地备份配置,没传的字段不动,Endpoint 校验', () => {
  const db = memoryDb();
  assert.deepEqual(getSettings(db).backup.remote, DEFAULT_SETTINGS.backup.remote);
  const r = updateSettings(db, { backup: { remote: { endpoint: 'https://abc.r2.cloudflarestorage.com/', bucket: 'xui-backup', access_key: 'ak', secret_key: 'sk' } } }).backup.remote;
  assert.deepEqual(r, { endpoint: 'https://abc.r2.cloudflarestorage.com', region: 'auto', bucket: 'xui-backup', access_key: 'ak', secret_key: 'sk', prefix: 'xui-hub', keep_days: 30 });
  const r2 = updateSettings(db, { backup: { remote: { keep_days: 7, region: '' } } }).backup.remote;
  assert.deepEqual([r2.keep_days, r2.region, r2.secret_key], [7, 'auto', 'sk']);
  assert.throws(() => updateSettings(db, { backup: { remote: { endpoint: 'abc.r2.cloudflarestorage.com' } } }), /Endpoint/);
  assert.throws(() => updateSettings(db, { backup: { remote: { endpoint: 'https://host/bucket' } } }), /Endpoint/);
  assert.throws(() => updateSettings(db, { backup: { remote: { keep_days: -1 } } }), /0 到 3650/);
  // Telegram 那个开关还在
  assert.equal(updateSettings(db, { backup: { daily: true } }).backup.remote.bucket, 'xui-backup');
});

test('设置:飞书机器人地址 + 签名密钥,单独一个通道;地址格式有校验,旧数据没有这项时是空的', () => {
  const db = memoryDb();
  assert.deepEqual(getSettings(db).feishu, { url: '', secret: '' });
  const url = 'https://open.feishu.cn/open-apis/bot/v2/hook/0a1b2c3d-4e5f-6789-abcd-ef0123456789';
  const s = updateSettings(db, { feishu: { url: ` ${url} `, secret: 'sec' } });
  assert.deepEqual(s.feishu, { url, secret: 'sec' });
  // 改别的不动它;Lark 国际版的地址也认
  assert.equal(updateSettings(db, { webhook: { url: 'https://h.example/x' } }).feishu.url, url);
  assert.equal(updateSettings(db, { feishu: { url: 'https://open.larksuite.com/open-apis/bot/v2/hook/abc' } }).feishu.secret, 'sec');
  for (const bad of ['http://open.feishu.cn/open-apis/bot/v2/hook/abc', 'https://h.example/x', 'https://open.feishu.cn/open-apis/bot/v2/hook/']) assert.throws(() => updateSettings(db, { feishu: { url: bad } }), /飞书机器人地址/, bad);
  // 清空
  assert.deepEqual(updateSettings(db, { feishu: { url: '', secret: '' } }).feishu, { url: '', secret: '' });
  // 存着的老设置里没有 feishu
  db.prepare("UPDATE meta SET value = json_remove(value, '$.feishu') WHERE key = 'settings'").run();
  assert.deepEqual(getSettings(db).feishu, { url: '', secret: '' });
});
