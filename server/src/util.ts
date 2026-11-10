// 小工具:限并发、用完即关、按 key 排队、防重入。

export const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** 最多 limit 个同时跑,结果按输入顺序返回 */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** 用完关闭连接(没有 close 或关闭失败都不管) */
export async function using<A extends { close?(): Promise<unknown> }, R>(admin: A, fn: (admin: A) => Promise<R>): Promise<R> {
  try {
    return await fn(admin);
  } finally {
    await admin.close?.().catch(() => {});
  }
}

const tails = new Map<string, Promise<unknown>>();

/** 同一个 key 的任务排队执行,前一个成败都不影响后一个 */
export function serial<R>(key: string, fn: () => Promise<R>): Promise<R> {
  const run = (tails.get(key) ?? Promise.resolve()).then(fn, fn);
  const tail = run.catch(() => {});
  tails.set(key, tail);
  void tail.then(() => {
    if (tails.get(key) === tail) tails.delete(key);
  });
  return run;
}

/** 同时占住多个 key:去重、排序后依次获取,两个任务不会互相等 */
export function serialAll<R>(keys: string[], fn: () => Promise<R>): Promise<R> {
  return [...new Set(keys)]
    .sort()
    .reduceRight<() => Promise<R>>((inner, key) => () => serial(key, inner), fn)();
}

/** 面板的 Xray 模板、入站、client 都是整份读出再写回,对同一块面板的改动要排队 */
export const panelKey = (panelId: number) => `panel:${panelId}`;

/** 上一次还没跑完就跳过这一次 */
export function noOverlap(fn: () => Promise<unknown>): () => Promise<void> {
  let running = false;
  return async () => {
    if (running) return;
    running = true;
    try {
      await fn();
    } finally {
      running = false;
    }
  };
}
