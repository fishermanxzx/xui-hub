import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addLine, createCustomer, listCustomers, updateLineStats } from '../customers/repo';
import { getPanel, recordCheck } from '../panels/repo';
import { DEFAULT_SETTINGS } from '../settings';
import { addPanel, memoryDb } from '../testUtil';
import { enforceEvents, panelEvents, thresholdEvents } from './events';
import { broadcast, channelsFor, type Message } from './send';

test('面板掉线 / 恢复:只在状态变化时提醒', () => {
  const db = memoryDb();
  const p = addPanel(db, 'a');
  const before = [getPanel(db, p.id)!];
  recordCheck(db, p.id, { ok: false, error: '连接失败' });
  const down = panelEvents(before, [getPanel(db, p.id)!], 1);
  assert.deepEqual(down.map((m) => [m.event, m.title, m.text]), [['panel_down', '面板「a」连不上', '连接失败']]);
  // 还是坏的:不重复
  assert.deepEqual(panelEvents([getPanel(db, p.id)!], [getPanel(db, p.id)!], 2), []);
  const bad = [getPanel(db, p.id)!];
  recordCheck(db, p.id, { ok: true, inbounds: 1, clients: 1 });
  assert.deepEqual(panelEvents(bad, [getPanel(db, p.id)!], 3).map((m) => m.event), ['panel_up']);
  // 新加的面板第一次检查就失败:不算「掉线」
  const q = addPanel(db, 'b');
  recordCheck(db, q.id, { ok: false, error: 'x' });
  assert.deepEqual(panelEvents(bad, [getPanel(db, q.id)!], 4), []);
});

test('停用 / 恢复按客户汇总;快到期和流量预警各只提醒一次,到期日 / 额度变了再提醒', () => {
  const db = memoryDb();
  const p = addPanel(db, 'a');
  const GB = 1024 ** 3;
  const now = Date.now();
  const cid = createCustomer(db, { name: 'zhu', quota_bytes: 10 * GB, expire_at: now + 2 * 86_400_000 });
  const l = addLine(db, { customer_id: cid, kind: 'direct', panel_id: p.id, inbound_id: 1, inbound_remark: 'r', protocol: 'vless', email: 'zhu' });
  updateLineStats(db, l.id, { up: 9 * GB, down: 0.5 * GB, enable: true, last_online: 0 });

  const ops = [
    { customer: 'zhu', panel: 'a', email: 'zhu', action: 'disable' as const, ok: true },
    { customer: 'zhu', panel: 'a', email: 'zhu-2', action: 'disable' as const, ok: true },
    { customer: 'zhu', panel: 'b', email: 'zhu', action: 'disable' as const, ok: false, error: 'x' },
  ];
  const ev = enforceEvents(ops, listCustomers(db), now);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].title, '客户「zhu」已停用 2 个客户端');
  assert.match(ev[0].text, /已用 9\.5 GB \/ 10 GB/);

  const first = thresholdEvents(db, DEFAULT_SETTINGS.notify, now);
  assert.deepEqual(first.map((m) => [m.event, m.title]), [['customer_expiring', '客户「zhu」2 天后到期'], ['customer_quota', '客户「zhu」流量已用 95%']]);
  assert.deepEqual(thresholdEvents(db, DEFAULT_SETTINGS.notify, now + 1000), []);
  // 关掉提醒项
  assert.deepEqual(thresholdEvents(db, { ...DEFAULT_SETTINGS.notify, expiring: false, quota_warn: false }, now), []);
});

test('渠道:没配就没有;测试用的假渠道一个成一个败,broadcast 各报各的', async () => {
  assert.deepEqual(channelsFor({ telegram: { token: '', chat_id: '' }, webhook: { url: '' } }), []);
  assert.deepEqual(channelsFor({ telegram: { token: 't', chat_id: 'c' }, webhook: { url: 'https://x' } }).map((c) => c.name), ['Telegram', 'Webhook']);
  const msg: Message = { event: 'test', title: 't', text: '', at: 0 };
  const r = await broadcast([{ name: 'ok', send: async () => {} }, { name: 'bad', send: async () => Promise.reject(new Error('nope')) }], msg);
  assert.deepEqual(r, [{ channel: 'ok', ok: true }, { channel: 'bad', ok: false, error: 'nope' }]);
});
