// 同一个改东西的请求只做一次。
// 连接中途断了时,浏览器会自己把请求再发一遍(Chrome 在复用的连接被重置、还没收到响应时会重试),代理也可能重放;
// 开线路、续费这种请求做两遍就是两条线路、两笔收款。后台页面每个改东西的请求都带一个 Idempotency-Key(每次新生成),
// 这里按「方法 + 地址 + key」记 10 分钟:同一个 key 再来,不再处理,等第一次做完、回同样的状态码和结果。

import type { NextFunction, Request, Response } from 'express';

const KEEP_MS = 10 * 60_000;
const MAX = 2000;

interface Entry {
  at: number;
  done: Promise<{ status: number; body: unknown } | null>;
}

export function replayGuard(methods: Set<string>) {
  const seen = new Map<string, Entry>();
  return (req: Request, res: Response, next: NextFunction) => {
    const key = req.get('idempotency-key');
    if (!methods.has(req.method) || !key || key.length > 100) return next();
    const now = Date.now();
    // Map 按放进去的先后排:从最早的开始清过期的
    for (const [k, e] of seen) {
      if (now - e.at <= KEEP_MS && seen.size < MAX) break;
      seen.delete(k);
    }
    const id = `${req.method} ${req.originalUrl} ${key}`;
    const first = seen.get(id);
    if (first) {
      void first.done.then((r) => {
        if (res.headersSent) return;
        if (r) res.status(r.status).json(r.body);
        else res.status(409).json({ error: '同一个请求已经处理过,结果没记下;刷新页面看看' });
      });
      return;
    }
    let resolve!: (r: { status: number; body: unknown } | null) => void;
    seen.set(id, { at: now, done: new Promise((r) => (resolve = r)) });
    const json = res.json.bind(res);
    res.json = (body: unknown) => {
      resolve({ status: res.statusCode, body });
      return json(body);
    };
    // 没走 res.json 就结束了(不是 JSON 的响应):没有可回的结果,重发的就按「已处理过」答
    res.on('finish', () => resolve(null));
    next();
  };
}
