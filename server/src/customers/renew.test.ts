import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addMonths, renewedExpiry } from './renew';

const TZ = 480;
/** UTC+8 的某天 23:59:59.999 */
const day = (s: string) => Date.parse(`${s}T23:59:59.999+08:00`);
const iso = (ms: number) => new Date(ms + TZ * 60_000).toISOString().slice(0, 10);

test('按自然月加,月底顺延到短月取最后一天,跨年', () => {
  assert.equal(iso(addMonths(day('2026-11-27'), 1, TZ)), '2026-12-27');
  assert.equal(iso(addMonths(day('2026-01-31'), 1, TZ)), '2026-02-28');
  assert.equal(iso(addMonths(day('2028-01-31'), 1, TZ)), '2028-02-29');
  assert.equal(iso(addMonths(day('2026-11-30'), 3, TZ)), '2027-02-28');
  assert.equal(iso(addMonths(day('2026-12-15'), 12, TZ)), '2027-12-15');
  assert.equal(addMonths(day('2026-11-27'), 1, TZ), day('2026-12-27'));
});

test('没到期从原到期日顺延,已到期从今天算起;不限期和非法月数报错', () => {
  const now = Date.parse('2026-11-02T10:00:00+08:00');
  assert.equal(renewedExpiry(day('2026-11-20'), 1, now, TZ), day('2026-12-20'));
  assert.equal(renewedExpiry(day('2026-10-01'), 1, now, TZ), day('2026-12-02'));
  // 今天到期还没过 23:59:59 也算没到期
  assert.equal(renewedExpiry(day('2026-11-02'), 1, now, TZ), day('2026-12-02'));
  assert.throws(() => renewedExpiry(0, 1, now, TZ), /不限期/);
  assert.throws(() => renewedExpiry(day('2026-11-20'), 0, now, TZ), /1 到 36/);
  assert.throws(() => renewedExpiry(day('2026-11-20'), 1.5, now, TZ), /1 到 36/);
});
