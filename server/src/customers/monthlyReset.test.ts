import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyPanelSnapshot } from '../sync/service';
import { addPanel, memoryDb, snap } from '../testUtil';
import { autoResetCustomers, lastResetAt, nextResetAt } from './monthlyReset';
import type { PanelWriter } from './panelOps';
import { addBinding, createCustomer, getCustomer, updateCustomer } from './repo';

const TZ = 480;
/** UTC+8 的时刻 */
const at = (s: string) => Date.parse(`${s}+08:00`);

test('重置日:到期日那天的 0 点,该月没有那天取最后一天', () => {
  const exp31 = at('2027-01-31T23:59:59.999');
  assert.equal(lastResetAt(exp31, at('2026-11-15T10:00:00'), TZ), at('2026-10-31T00:00:00'));
  assert.equal(nextResetAt(exp31, at('2026-11-15T10:00:00'), TZ), at('2026-11-30T00:00:00'));
  assert.equal(nextResetAt(exp31, at('2027-02-10T00:00:00'), TZ), at('2027-02-28T00:00:00'));
  const exp15 = at('2027-03-15T23:59:59.999');
  assert.equal(lastResetAt(exp15, at('2026-11-15T00:00:00'), TZ), at('2026-11-15T00:00:00'));
  assert.equal(lastResetAt(exp15, at('2026-11-14T23:59:59'), TZ), at('2026-10-15T00:00:00'));
  assert.equal(nextResetAt(exp15, at('2026-11-15T00:00:00'), TZ), at('2026-12-15T00:00:00'));
});

function writer(clients: { email: string; enable: boolean }[]) {
  const calls: string[] = [];
  const w: PanelWriter = {
    listClients: async () => clients.map((c) => ({ ...c, traffic: { up: 0, down: 0, enable: c.enable } })),
    exportClients: async () => clients.map((c) => ({ client: { ...c }, inboundIds: [1] })),
    resetClientTraffic: async (email) => void calls.push('reset ' + email),
    updateClient: async (email, body: any) => {
      calls.push(`update ${email} enable=${body.enable}`);
      clients.find((c) => c.email === email)!.enable = body.enable;
    },
  };
  return { w, calls };
}

test('到了重置日自动清零,超额停掉的线路恢复;同一周期不重复;开启前的重置日不补;停用、到期、没开的不动', async () => {
  const db = memoryDb();
  const p = addPanel(db, 'a');
  applyPanelSnapshot(db, p, ['due', 'fresh', 'off', 'stopped', 'over'].map((e) => snap(e, 0, 0)), 0);
  const oct1 = at('2026-10-01T12:00:00');
  const exp = at('2027-01-15T23:59:59.999');
  const mk = (name: string, extra: Record<string, unknown> = {}, monthly = true) => {
    const id = createCustomer(db, { name, quota_bytes: 100, expire_at: exp, monthly_reset: monthly, ...extra }, oct1);
    addBinding(db, id, p.id, name, false, oct1);
    return id;
  };
  const due = mk('due');
  const over = mk('over');
  db.prepare('UPDATE customers SET used_down = 150 WHERE id = ?').run(over);
  mk('off', {}, false);
  mk('stopped', { status: 'disabled' });
  const fresh = mk('fresh');
  // 11-15 早上才开启的:11-15 0 点这次不补
  db.prepare('UPDATE customers SET monthly_reset_at = ? WHERE id = ?').run(at('2026-11-15T09:00:00'), fresh);

  const { w, calls } = writer([
    { email: 'due', enable: true },
    { email: 'over', enable: false },
  ]);
  const now = at('2026-11-15T10:00:00');
  const logs: string[] = [];
  const done = await autoResetCustomers(db, () => w, TZ, now, (l) => logs.push(l));

  assert.deepEqual(done, ['due', 'over']);
  assert.deepEqual(calls, ['reset due', 'reset over', 'update over enable=true']);
  assert.equal(getCustomer(db, over, now)!.used, 0);
  assert.equal(getCustomer(db, over, now)!.state, 'active');
  assert.equal(getCustomer(db, due, now)!.usage_reset_at, now);
  assert.equal(logs.length, 2);
  // 同一周期再跑不重复
  assert.deepEqual(await autoResetCustomers(db, () => w, TZ, now + 60_000, () => {}), []);
  // 下个月 15 号 0 点后才轮到 fresh 和另外两个
  assert.deepEqual(await autoResetCustomers(db, () => w, TZ, at('2026-12-15T00:00:30'), () => {}), ['due', 'over', 'fresh']);
});

test('开关:开启记下时间,已开着再开不改时间,关闭清零', () => {
  const db = memoryDb();
  const id = createCustomer(db, { name: 'x' }, 1000);
  assert.equal(getCustomer(db, id)!.monthly_reset_at, 0);
  updateCustomer(db, id, { monthly_reset: true }, 2000);
  updateCustomer(db, id, { monthly_reset: true }, 3000);
  assert.equal(getCustomer(db, id)!.monthly_reset_at, 2000);
  updateCustomer(db, id, { remark: 'r' }, 4000);
  assert.equal(getCustomer(db, id)!.monthly_reset_at, 2000);
  updateCustomer(db, id, { monthly_reset: false }, 5000);
  assert.equal(getCustomer(db, id)!.monthly_reset_at, 0);
});
