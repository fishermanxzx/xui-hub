// 续费:没到期的从原到期日往后顺延,已到期的从今天算起;按自然月加,到期时间固定在当天 23:59:59.999(按时区)。
// 月底顺延到短月时取该月最后一天(1-31 加一个月是 2-28 / 2-29)。

import { InputError } from '../panels/repo';

const MIN_MS = 60_000;

/** 按时区的年月日 → 那天 23:59:59.999 的时间戳 */
function endOf(y: number, m: number, d: number, tzOffsetMin: number): number {
  return Date.UTC(y, m, d, 23, 59, 59, 999) - tzOffsetMin * MIN_MS;
}

function localParts(ms: number, tzOffsetMin: number): [number, number, number] {
  const t = new Date(ms + tzOffsetMin * MIN_MS);
  return [t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()];
}

export function addMonths(ms: number, months: number, tzOffsetMin: number): number {
  const [y, m, d] = localParts(ms, tzOffsetMin);
  const lastDay = new Date(Date.UTC(y, m + months + 1, 0)).getUTCDate();
  return endOf(y, m + months, Math.min(d, lastDay), tzOffsetMin);
}

export function renewedExpiry(expireAt: number, months: number, now: number, tzOffsetMin: number): number {
  if (!Number.isInteger(months) || months < 1 || months > 36) throw new InputError('续费月数必须是 1 到 36 的整数');
  if (!expireAt) throw new InputError('这位客户不限期,不用续费');
  const base = expireAt > now ? expireAt : endOf(...localParts(now, tzOffsetMin), tzOffsetMin);
  return addMonths(base, months, tzOffsetMin);
}
