import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addLine, createCustomer, listCustomers, updateLineStats } from '../customers/repo';
import { deletePanel, getPanel, recordCheck } from '../panels/repo';
import { DEFAULT_SETTINGS } from '../settings';
import { addPanel, memoryDb } from '../testUtil';
import { aboutDuration, enforceEvents, panelEvents, thresholdEvents } from './events';
import { broadcast, channelsFor, type Message } from './send';

/** 模拟一轮检查:先记下检查前的面板,检查完算通知 */
function round(db: ReturnType<typeof memoryDb>, id: number, ok: boolean, now: number, downAfter: number) {
  const before = [getPanel(db, id)!];
  recordCheck(db, id, ok ? { ok: true, inbounds: 1, clients: 1 } : { ok: false, error: '连接超时' }, now);
  return panelEvents(db, before, [getPanel(db, id)!], downAfter, now).map((m) => [m.event, m.title, m.text]);
}
const MIN = 60_000;

test('面板掉线:连续失败够次数才发「连不上」,发过的恢复时才发「恢复正常」', () => {
  const db = memoryDb();
  const p = addPanel(db, 'a');
  const t0 = 1_000_000_000_000;
  assert.deepEqual(round(db, p.id, false, t0, 3), []);
  assert.deepEqual(round(db, p.id, false, t0 + MIN, 3), []);
  assert.deepEqual(round(db, p.id, false, t0 + 2 * MIN, 3), [['panel_down', '面板「a」连不上', '连接超时\n连续 3 次检查失败,已经约 2 分钟']]);
  // 还是坏的:不重复
  assert.deepEqual(round(db, p.id, false, t0 + 3 * MIN, 3), []);
  assert.equal(getPanel(db, p.id)!.check_fail_count, 4);
  assert.deepEqual(round(db, p.id, true, t0 + 70 * MIN, 3), [['panel_up', '面板「a」恢复正常', '断了约 1 小时 10 分钟,连续 4 次检查失败\n之前:连接超时']]);
  assert.deepEqual([getPanel(db, p.id)!.check_fail_count, getPanel(db, p.id)!.check_fail_since], [0, null]);
  assert.deepEqual(round(db, p.id, true, t0 + 71 * MIN, 3), []);
});

test('面板掉线:没到次数就恢复的,两条都不发;中间成功一次就重新数', () => {
  const db = memoryDb();
  const p = addPanel(db, 'a');
  const t0 = 1_000_000_000_000;
  assert.deepEqual(round(db, p.id, false, t0, 3), []);
  assert.deepEqual(round(db, p.id, false, t0 + MIN, 3), []);
  assert.deepEqual(round(db, p.id, true, t0 + 2 * MIN, 3), []);
  assert.deepEqual(round(db, p.id, false, t0 + 3 * MIN, 3), []);
  assert.deepEqual(round(db, p.id, false, t0 + 4 * MIN, 3), []);
  assert.deepEqual(round(db, p.id, true, t0 + 5 * MIN, 3), []);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM notified WHERE key LIKE 'panel%'").get() as { n: number }).n, 0);
});

test('面板掉线:次数填 1 = 一失败就发(和以前一样),第一次失败不带次数', () => {
  const db = memoryDb();
  const p = addPanel(db, 'a');
  const t0 = 1_000_000_000_000;
  assert.deepEqual(round(db, p.id, false, t0, 1), [['panel_down', '面板「a」连不上', '连接超时']]);
  assert.deepEqual(round(db, p.id, true, t0 + MIN, 1), [['panel_up', '面板「a」恢复正常', '断了约 1 分钟\n之前:连接超时']]);
});

test('面板掉线:发过的记在库里,重启后照样发「恢复」;次数改大了已经发过的不受影响;删面板清记录', () => {
  const db = memoryDb();
  const p = addPanel(db, 'a');
  const q = addPanel(db, 'b');
  const t0 = 1_000_000_000_000;
  for (let i = 0; i < 3; i++) round(db, p.id, false, t0 + i * MIN, 3);
  // 「重启」:内存里什么都没有,检查前的面板从库里读
  assert.deepEqual(round(db, p.id, false, t0 + 3 * MIN, 10), []);
  assert.deepEqual(round(db, p.id, true, t0 + 4 * MIN, 10).map((m) => m[0]), ['panel_up']);
  // 恢复的是 a,b 的记录不动(id 前缀相同也不误删)
  for (let i = 0; i < 3; i++) round(db, q.id, false, t0 + i * MIN, 3);
  assert.ok(db.prepare('SELECT 1 FROM notified WHERE key = ?').get(`panel_down:${q.id}`));
  deletePanel(db, q.id);
  assert.equal(db.prepare('SELECT 1 FROM notified WHERE key = ?').get(`panel_down:${q.id}`), undefined);
});

test('时长的说法', () => {
  assert.deepEqual([20_000, 5 * MIN, 60 * MIN, 125 * MIN, 26 * 60 * MIN, 48 * 60 * MIN].map(aboutDuration), ['不到 1 分钟', '约 5 分钟', '约 1 小时', '约 2 小时 5 分钟', '约 1 天 2 小时', '约 2 天']);
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
  assert.doesNotMatch(first[0].text, /月费/);
  assert.deepEqual(thresholdEvents(db, DEFAULT_SETTINGS.notify, now + 1000), []);
  // 关掉提醒项
  assert.deepEqual(thresholdEvents(db, { ...DEFAULT_SETTINGS.notify, expiring: false, quota_warn: false }, now), []);
  // 填了月费:快到期的提醒带上月费,续费时知道该收多少
  const fee = createCustomer(db, { name: 'fee', expire_at: now + 86_400_000, monthly_fee: 30 });
  const ev2 = thresholdEvents(db, DEFAULT_SETTINGS.notify, now).find((m) => m.title.includes('fee'));
  assert.ok(fee && ev2);
  assert.match(ev2.text, /,月费 30$/);
});

test('渠道:没配就没有;测试用的假渠道一个成一个败,broadcast 各报各的', async () => {
  assert.deepEqual(channelsFor({ telegram: { token: '', chat_id: '' }, webhook: { url: '' } }), []);
  assert.deepEqual(channelsFor({ telegram: { token: 't', chat_id: 'c' }, webhook: { url: 'https://x' } }).map((c) => c.name), ['Telegram', 'Webhook']);
  const msg: Message = { event: 'test', title: 't', text: '', at: 0 };
  const r = await broadcast([{ name: 'ok', send: async () => {} }, { name: 'bad', send: async () => Promise.reject(new Error('nope')) }], msg);
  assert.deepEqual(r, [{ channel: 'ok', ok: true }, { channel: 'bad', ok: false, error: 'nope' }]);
});
