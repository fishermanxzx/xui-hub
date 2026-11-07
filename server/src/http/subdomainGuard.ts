// 按域名分开订阅和后台:
// - 订阅域名(SUB_DOMAINS)只提供订阅(/sub/<token>),后台页面、/api 等一律 404;
// - 其他域名(后台)不提供订阅,订阅路径 404。
// 订阅域名经 Cloudflare Tunnel 直接回源到本服务、不经过 Caddy,所以在应用里拦。
// 没配置订阅域名时(本机开发)不区分。

import type { NextFunction, Request, Response } from 'express';

/** 请求的 Host(不含端口)。不用 req.hostname:开了 trust proxy 时它取 X-Forwarded-Host,
 *  经隧道回源时这个头可由客户端伪造;Caddy 和 cloudflared 都保留原始 Host */
export function requestHost(req: Request): string {
  return (req.headers.host ?? '').replace(/:\d+$/, '').toLowerCase();
}

export function subdomainGuard(subDomains: string[]) {
  const hosts = new Set(subDomains.map((d) => d.toLowerCase()));
  return (req: Request, res: Response, next: NextFunction) => {
    // Express 路由不区分大小写,这里按同样规则判断,否则 /SUB/... 能绕过
    const isSub = req.path.toLowerCase().startsWith('/sub/');
    if (hosts.size > 0 && hosts.has(requestHost(req)) !== isSub) {
      res.status(404).type('text/plain').send('not found');
      return;
    }
    next();
  };
}
