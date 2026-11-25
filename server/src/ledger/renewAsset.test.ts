import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getPanel, updatePanel } from '../panels/repo';
import { createSocks, getSocks } from '../socks/repo';
import { addPanel, memoryDb } from '../testUtil';
import { listEntries } from './entries';
import { renewAsset } from './renewAsset';

const DAY = 86_400_000;
const at = (y: number, m: number, d: number) => new Date(y, m - 1, d, 12).getTime();

test('面板续费:在到期日上加月数;填了金额记一笔关联它的支出;没填金额只顺延', () => {
  const db = memoryDb();
  const p = addPanel(db, 'hk');
  updatePanel(db, p.id, { expire_at: at(2026, 12, 1) });
  const now = at(2026, 11, 25);
  const r = renewAsset(db, 'panel', p.id, { months: 3, amount: '45.5', category: '服务器', note: '年付打折' }, now);
  assert.deepEqual([r.kind, r.name, r.months, r.expire_before, r.expire_after], ['panel', 'hk', 3, at(2026, 12, 1), at(2027, 3, 1)]);
  assert.equal(getPanel(db, p.id)!.expire_at, at(2027, 3, 1));
  assert.deepEqual([r.entry!.kind, r.entry!.amount, r.entry!.at, r.entry!.category, r.entry!.note, r.entry!.panel_id, r.entry!.panel_name], ['expense', 45.5, now, '服务器', '年付打折', p.id, 'hk']);
  // 没填金额:只顺延,不记账
  const r2 = renewAsset(db, 'panel', p.id, { days: 10 }, now);
  assert.deepEqual([r2.expire_after, r2.entry], [at(2027, 3, 1) + 10 * DAY, null]);
  assert.equal(listEntries(db).length, 1);
});

test('SOCKS 续费:已过期 / 没填到期日的从现在起算;付款日期可以指定', () => {
  const db = memoryDb();
  const s = createSocks(db, { name: 'isp', address: '1.2.3.4:1080' });
  const now = at(2026, 11, 25);
  const r = renewAsset(db, 'socks', s, { months: 1, amount: 12, paid_at: at(2026, 11, 20) }, now);
  assert.deepEqual([r.expire_before, r.expire_after], [0, at(2026, 12, 25)]);
  assert.deepEqual([r.entry!.socks_id, r.entry!.socks_name, r.entry!.at, r.entry!.panel_id], [s, 'isp', at(2026, 11, 20), null]);
  db.prepare('UPDATE socks_proxies SET expire_at = ? WHERE id = ?').run(at(2026, 11, 1), s);
  assert.equal(renewAsset(db, 'socks', s, { months: 1 }, now).expire_after, at(2026, 12, 25));
  assert.equal(getSocks(db, s)!.expire_at, at(2026, 12, 25));
});

test('续费的校验:月数 / 天数给一个,金额要大于 0;校验没过到期日不动;不存在的报错', () => {
  const db = memoryDb();
  const p = addPanel(db, 'hk');
  updatePanel(db, p.id, { expire_at: at(2026, 12, 1) });
  assert.throws(() => renewAsset(db, 'panel', p.id, {}), /months/);
  assert.throws(() => renewAsset(db, 'panel', p.id, { months: 1, days: 3 }), /months/);
  assert.throws(() => renewAsset(db, 'panel', p.id, { months: 121 }), /1 到 120/);
  assert.throws(() => renewAsset(db, 'panel', p.id, { months: 1, amount: -5 }), /金额/);
  assert.throws(() => renewAsset(db, 'panel', p.id, { months: 1, amount: 5, category: '一'.repeat(21) }), /类别/);
  assert.equal(getPanel(db, p.id)!.expire_at, at(2026, 12, 1));
  assert.equal(listEntries(db).length, 0);
  assert.throws(() => renewAsset(db, 'panel', 999, { months: 1 }), /面板不存在/);
  assert.throws(() => renewAsset(db, 'socks', 999, { months: 1 }), /SOCKS 不存在/);
});
