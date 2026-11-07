// 由面板累计计数器算本轮增量。

export interface Counter {
  up: number;
  down: number;
}

export interface Delta extends Counter {
  /** 计数器比上次小:面板重置了流量、重装或 client 被重建 */
  reset: boolean;
}

/**
 * @param prev 上次读数;undefined 表示首次见到这个 client
 * @param countNew 首次见到时是否把当前读数算作增量。面板此前已同步过时为 true:
 *   之前没出现的 client 是新建的,它的读数都发生在上次同步之后。面板首次同步时为 false,只建基线。
 */
export function counterDelta(prev: Counter | undefined, cur: Counter, countNew: boolean): Delta {
  if (!prev) {
    return countNew ? { up: cur.up, down: cur.down, reset: false } : { up: 0, down: 0, reset: false };
  }
  if (cur.up < prev.up || cur.down < prev.down) {
    // 重置后计数器从 0 开始,当前读数就是重置以来的用量
    return { up: cur.up, down: cur.down, reset: true };
  }
  return { up: cur.up - prev.up, down: cur.down - prev.down, reset: false };
}

export const HOUR_MS = 3_600_000;

export function hourStart(ts: number): number {
  return Math.floor(ts / HOUR_MS) * HOUR_MS;
}
