// 公开的订阅接口(无需登录):/sub/<token>,token 每个客户一个(后台「复制订阅」里的链接)。
// 返回该客户全部线路的统一订阅(全局用量),按 UA 返回 Clash / sing-box / base64 等格式,?target= 可强制指定。
// 非 base64 格式由内部 subconverter 转换,它带内部密钥回源 /internal/nodes/:id 取原始节点。

import { Router, type Request, type Response } from 'express';
import type { DB } from '../db';
import { customerIdBySubToken, getCustomer, touchSubFetch, type CustomerView } from '../customers/repo';
import type { Converter } from '../subscription/convert';
import { DEFAULT_CONVERT_OPTIONS, isBrowserUA, isStashUA, targetFromParam, targetFromUA, type Target } from '../subscription/format';
import { buildLoon, buildQuantumultX } from '../subscription/apple';
import { applyMihomoTemplate, withTrojanFingerprint } from '../subscription/mihomo';
import { parseNodes } from '../subscription/nodes';
import { buildSingbox, singboxLegacyDns } from '../subscription/singbox';
import { clientIp, recordSubFetch } from '../subscription/fetchLog';
import { collectLinks, encodeSubscription, mergeLinks, userinfoHeader, type LinkFetcher } from '../subscription/service';

export interface SubscriptionDeps {
  db: DB;
  fetcher: LinkFetcher;
  /** null = 未配置 subconverter,只能返回 base64 */
  convert: Converter | null;
  /** subconverter 回源访问本服务的地址,如 http://app:8788 */
  internalBaseUrl: string;
  /** 回源取节点的密钥 */
  internalSecret: string;
  /** 该客户的 Clash 输出是否套用 Mihomo 基础模板(dns / tcp-concurrent / unified-delay) */
  mihomoTemplate: (customerName: string) => boolean;
}

/** 客户端自动更新间隔(小时) */
const UPDATE_INTERVAL_HOURS = '24';

/**
 * 按格式给响应头(参照主流面板的做法):
 * - Clash:text/yaml,带文件名(客户端导入后显示客户名)和更新间隔
 * - sing-box:application/json,用 Profile-Title 给名称,带更新间隔;不带下载头
 * - 其他(base64、Quantumult X、Loon 等,含浏览器):text/plain,不带下载头,浏览器直接显示
 * - 流量信息走 subscription-userinfo(全局用量)
 */
function formatHeaders(target: Target, name: string, userinfo: string): Record<string, string> {
  const headers: Record<string, string> = { 'Cache-Control': 'no-cache, private', 'Subscription-Userinfo': userinfo };
  if (target === 'clash') {
    headers['Content-Type'] = 'text/yaml; charset=utf-8';
    headers['Content-Disposition'] = `attachment;filename*=UTF-8''${encodeURIComponent(name)}`;
    headers['Profile-Update-Interval'] = UPDATE_INTERVAL_HOURS;
  } else if (target === 'singbox') {
    headers['Content-Type'] = 'application/json';
    headers['Profile-Title'] = `base64:${Buffer.from(name, 'utf8').toString('base64')}`;
    headers['Profile-Update-Interval'] = UPDATE_INTERVAL_HOURS;
  } else {
    headers['Content-Type'] = 'text/plain; charset=utf-8';
  }
  return headers;
}

/** 这几种格式由本系统直接生成(subconverter 0.9.9 的输出在新版客户端上加载失败或缺参数) */
const OWN_TARGETS = new Set<Target>(['singbox', 'quanx', 'loon']);

function renderOwn(target: Target, links: string[], ua: string | undefined): string {
  const nodes = parseNodes(links);
  // 跳过证书校验(与 subconverter 的 scv=true 一致):落地机多用 IP 证书 / 自签证书
  const insecure = DEFAULT_CONVERT_OPTIONS.scv !== 'false';
  if (target === 'singbox') return JSON.stringify(buildSingbox(nodes, { legacyDns: singboxLegacyDns(ua), insecure }));
  if (target === 'quanx') return buildQuantumultX(nodes);
  return buildLoon(nodes, { insecure });
}

/**
 * sing-box 的 Content-Type 与主流面板一致为 application/json(不带 charset):
 * Express 的 res.set / res.send(string) 会自动补 charset,这里用原生 setHeader 并以 Buffer 发送。
 */
function sendOwn(res: Response, target: Target, body: string): void {
  if (target !== 'singbox') {
    res.send(body);
    return;
  }
  res.setHeader('Content-Type', 'application/json');
  res.send(Buffer.from(body, 'utf8'));
}

export function subscriptionRouter(deps: SubscriptionDeps): Router {
  const { db } = deps;
  const r = Router();

  const nodes = async (c: CustomerView) => {
    if (c.state !== 'active') return [];
    const lines = await collectLinks(db, c.id, deps.fetcher);
    // 全部线路都取不到时报错(502):客户端保留原来的配置,不会被一份空订阅冲掉
    if (lines.length && lines.every((l) => l.error)) throw new Error(`全部 ${lines.length} 条线路都取不到节点`);
    return mergeLinks(lines);
  };

  /** ?target= 优先;其次按 UA;浏览器给节点链接(纯文本直接显示);认不出的其他 UA 给 Clash */
  const requestedTarget = (req: Request): Target => {
    const ua = req.get('user-agent');
    return targetFromParam(req.query.target) ?? targetFromUA(ua) ?? (isBrowserUA(ua) ? 'base64' : 'clash');
  };

  const withTemplate = (req: Request, target: Target, customerName: string, body: string) => {
    if (target !== 'clash') return body;
    const stash = isStashUA(req.get('user-agent'));
    const out = stash ? body : withTrojanFingerprint(body);
    return deps.mihomoTemplate(customerName) ? applyMihomoTemplate(out, { stash }) : out;
  };

  const handle = (fn: (req: Request, res: Response) => Promise<void>) => async (req: Request, res: Response) => {
    try {
      await fn(req, res);
    } catch (e) {
      console.error(e);
      if (!res.headersSent) res.status(502).type('text/plain').send('subscription error');
    }
  };

  // 仅供内部 subconverter 回源:返回客户的原始节点(base64),不计入"上次获取"
  r.get(
    '/internal/nodes/:id',
    handle(async (req, res) => {
      const customer = deps.internalSecret && req.query.key === deps.internalSecret ? getCustomer(db, Number(req.params.id)) : undefined;
      if (!customer) {
        res.status(404).type('text/plain').send('not found');
        return;
      }
      res.type('text/plain; charset=utf-8').send(encodeSubscription(await nodes(customer)));
    }),
  );

  r.get(
    '/sub/:token',
    handle(async (req, res) => {
      const id = customerIdBySubToken(db, String(req.params.token));
      const customer = id != null ? getCustomer(db, id) : undefined;
      if (!customer) {
        res.status(404).type('text/plain').send('not found');
        return;
      }
      const ua = req.get('user-agent');
      const target = requestedTarget(req);
      // token 有效的请求都记一条拉取记录(响应发完后记,带上最终状态码)
      res.on('finish', () => recordSubFetch(db, { at: Date.now(), customer_id: customer.id, target, status: res.statusCode, ua: ua ?? '', ip: clientIp(req) }));
      touchSubFetch(db, customer.id, ua ?? '');
      res.set(formatHeaders(target, customer.name, userinfoHeader(customer)));
      if (target === 'base64') {
        res.send(encodeSubscription(await nodes(customer)));
        return;
      }
      if (customer.state !== 'active') {
        res.status(403).type('text/plain').send('subscription disabled');
        return;
      }
      if (OWN_TARGETS.has(target)) {
        sendOwn(res, target, renderOwn(target, await nodes(customer), ua));
        return;
      }
      if (!deps.convert) {
        res.status(503).type('text/plain').send('converter unavailable');
        return;
      }
      const source = `${deps.internalBaseUrl}/internal/nodes/${customer.id}?key=${encodeURIComponent(deps.internalSecret)}`;
      res.send(withTemplate(req, target, customer.name, (await deps.convert(target, source, DEFAULT_CONVERT_OPTIONS)).body));
    }),
  );

  return r;
}
