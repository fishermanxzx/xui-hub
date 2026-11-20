// 公开的订阅接口(无需登录):/sub/<token>,token 每个客户一个(后台「复制订阅」里的链接)。
// 客户另配的自定义链接(任意路径,可带参数)和 /sub/<token> 等价,见 subscription/customLinks.ts。
// 返回该客户全部线路的统一订阅(全局用量),按 UA 返回 Clash / sing-box / base64 等格式,?target= 可强制指定。
// 非 base64 格式由内部 subconverter 转换,它带内部密钥回源 /internal/nodes/:id 取原始节点。
// 客户配了外部订阅的,那边的节点也在里面(和自己线路的一起给,或只给那边的),见 subscription/upstream.ts。

import { Router, type Request, type Response } from 'express';
import type { DB } from '../db';
import { customerIdBySubToken, getCustomer, touchSubFetch, type CustomerView } from '../customers/repo';
import type { Converter } from '../subscription/convert';
import { DEFAULT_CONVERT_OPTIONS, isBrowserUA, isShadowrocketUA, isStashUA, targetFromParam, targetFromUA, type Target } from '../subscription/format';
import { buildLoon, buildQuantumultX } from '../subscription/apple';
import { applyMihomoTemplate, lowerMode, noLanAccess, withRealityMlkem, withTrojanFingerprint } from '../subscription/mihomo';
import { parseNodes } from '../subscription/nodes';
import { buildSingbox, singboxLegacyDns } from '../subscription/singbox';
import { customerIdByLink } from '../subscription/customLinks';
import { clientIp, recordSubFetch } from '../subscription/fetchLog';
import { collectLinks, encodeSubscription, mergeLinks, userinfoHeader, type LinkFetcher } from '../subscription/service';
import { cachedUpstream, fetchUpstream, HOP_HEADER, refreshUpstreams, userinfoText, type UpstreamFetcher } from '../subscription/upstream';
import { renderSubPage } from './subPage';
import { templateUrl } from '../subscription/templates';
import { admitDevice, deleteDevice, deviceKey, listDevices } from '../subscription/devices';

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
  /** 订阅链接的地址前缀(SUB_BASE_URL);空 = 按这次请求的地址拼 */
  subBaseUrl?: string;
  /** 拉外部订阅;默认直接请求 */
  upstreamFetcher?: UpstreamFetcher;
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
  const upstreamFetcher = deps.upstreamFetcher ?? fetchUpstream;
  const r = Router();

  /**
   * 客户的节点:自己各线路的,加上外部订阅的(upstream = false 时不带外部订阅:请求来自别处的 xui-hub 拉外部订阅,见 HOP_HEADER)。
   * 外部订阅 60 秒内取过就用存着的,取不到也用上次成功的
   */
  const nodes = async (c: CustomerView, upstream = true) => {
    if (c.state !== 'active') return [];
    const withUpstream = upstream && c.upstreams.length > 0;
    const [lines] = await Promise.all([
      withUpstream && c.upstream_mode === 'replace' ? [] : collectLinks(db, c.id, deps.fetcher),
      withUpstream ? refreshUpstreams(db, c.id, upstreamFetcher) : undefined,
    ]);
    const up = withUpstream ? cachedUpstream(db, c.id) : { links: [], total: 0, failed: 0 };
    // 全部来源(线路 + 外部订阅)都取不到时报错(502):客户端保留原来的配置,不会被一份空订阅冲掉
    const sources = lines.length + up.total;
    const failed = lines.filter((l) => l.error).length + up.failed;
    if (sources && failed === sources) throw new Error(up.total ? `全部 ${sources} 个来源(线路 / 外部订阅)都取不到节点` : `全部 ${sources} 条线路都取不到节点`);
    return [...new Set([...mergeLinks(lines), ...up.links])];
  };

  /** 请求来自别处 xui-hub 拉外部订阅:只给自己线路的节点 */
  const isHop = (req: Request) => !!req.get(HOP_HEADER);

  /** 订阅里的流量和到期:客户设了用外部订阅的、那边也给了,就用那边的;否则用自己的 */
  const userinfoOf = (c: CustomerView, upstream: boolean) => {
    const theirs = upstream && c.upstream_userinfo && c.upstreams.length ? cachedUpstream(db, c.id).userinfo : null;
    return theirs ? userinfoText(theirs) : userinfoHeader(c);
  };

  /** ?target= 优先;其次按 UA;浏览器给节点链接(纯文本直接显示);认不出的其他 UA 给 Clash */
  const requestedTarget = (req: Request): Target => {
    const ua = req.get('user-agent');
    return targetFromParam(req.query.target) ?? targetFromUA(ua) ?? (isBrowserUA(ua) ? 'base64' : 'clash');
  };

  const withTemplate = (req: Request, target: Target, customerName: string, body: string) => {
    if (target !== 'clash') return body;
    const ua = req.get('user-agent');
    const stash = isStashUA(ua);
    const fp = stash ? body : withTrojanFingerprint(body);
    // support-x25519mlkem768 只给 mihomo 系的客户端:Shadowrocket 带上它后,伪装站不支持后量子的 REALITY 节点连不上
    // (2026-11-20 实测:同一节点 base64 链接能连、带这一项的 Clash 配置连不上),Stash 也不认
    const out = noLanAccess(lowerMode(stash || isShadowrocketUA(ua) ? fp : withRealityMlkem(fp)));
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
      // hop=1:原请求来自别处 xui-hub 拉外部订阅,这里同样不带外部订阅
      res.type('text/plain; charset=utf-8').send(encodeSubscription(await nodes(customer, req.query.hop !== '1')));
    }),
  );

  /** 给这位客户回订阅(/sub/<token> 和自定义链接都走这里) */
  const subscribe = async (customer: CustomerView, req: Request, res: Response): Promise<void> => {
    const ua = req.get('user-agent');
    const upstream = !isHop(req);
    // 外部订阅先取一遍(60 秒内取过的不取):流量头、自助页和节点都用这一份
    const refresh = async () => {
      if (upstream && customer.state === 'active' && customer.upstreams.length) await refreshUpstreams(db, customer.id, upstreamFetcher);
    };
    // 浏览器直接打开(没指定格式):给客户看的自助页。?target=base64 仍然拿节点
    if (req.query.target === undefined && isBrowserUA(ua) && (req.get('accept') ?? '').includes('text/html')) {
      const base = deps.subBaseUrl || `${req.protocol}://${req.get('host')}`;
      await refresh();
      const up = customer.upstreams.length ? cachedUpstream(db, customer.id) : null;
      res.set({ 'Cache-Control': 'no-store', 'Content-Type': 'text/html; charset=utf-8' });
      res.send(
        renderSubPage({
          customer,
          url: `${base}/sub/${customer.sub_token}`,
          devices: listDevices(db, customer.id),
          removed: req.query.removed === '1',
          upstream: up ? { nodes: up.links.length, replace: customer.upstream_mode === 'replace', userinfo: customer.upstream_userinfo ? up.userinfo : null } : undefined,
        }),
      );
      return;
    }
    const target = requestedTarget(req);
    // token 有效的请求都记一条拉取记录(响应发完后记,带上最终状态码)
    res.on('finish', () => recordSubFetch(db, { at: Date.now(), customer_id: customer.id, target, status: res.statusCode, ua: ua ?? '', ip: clientIp(req) }));
    // 设备数上限:名额满了的新设备拉不到订阅(已经拿到节点的设备不受影响),客户在自助页删掉一台旧的就能再加
    if (!admitDevice(db, customer.id, customer.limit_devices, { key: deviceKey(req), ua: ua ?? '', ip: clientIp(req) })) {
      res.status(403).type('text/plain').send('device limit reached: open the subscription link in a browser and remove an old device first\n设备数已达上限:用浏览器打开订阅链接,删掉一台旧设备后再更新订阅');
      return;
    }
    touchSubFetch(db, customer.id, ua ?? '');
    await refresh();
    res.set(formatHeaders(target, customer.name, userinfoOf(customer, upstream)));
    if (target === 'base64') {
      res.send(encodeSubscription(await nodes(customer, upstream)));
      return;
    }
    if (customer.state !== 'active') {
      res.status(403).type('text/plain').send('subscription disabled');
      return;
    }
    if (OWN_TARGETS.has(target)) {
      sendOwn(res, target, renderOwn(target, await nodes(customer, upstream), ua));
      return;
    }
    if (!deps.convert) {
      res.status(503).type('text/plain').send('converter unavailable');
      return;
    }
    const source = `${deps.internalBaseUrl}/internal/nodes/${customer.id}?key=${encodeURIComponent(deps.internalSecret)}${upstream ? '' : '&hop=1'}`;
    res.send(withTemplate(req, target, customer.name, (await deps.convert(target, source, { ...DEFAULT_CONVERT_OPTIONS, config: templateUrl(customer.sub_template) })).body));
  };

  // 自定义链接:先于下面的路由匹配(本程序自己用的路径不会被占,见 isReserved)
  r.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const q = req.originalUrl.indexOf('?');
    const id = customerIdByLink(db, req.path, q < 0 ? '' : req.originalUrl.slice(q + 1));
    if (id === undefined) return next();
    const customer = id === null ? undefined : getCustomer(db, id);
    // 路径是自定义链接、参数对不上(如旧链接里的 token 写错):和 token 不对一样回 404,不落到后台页面
    if (!customer) return void res.status(404).type('text/plain').send('not found');
    void handle((rq, rs) => subscribe(customer, rq, rs))(req, res);
  });

  r.get(
    '/sub/:token',
    handle(async (req, res) => {
      const id = customerIdBySubToken(db, String(req.params.token));
      const customer = id != null ? getCustomer(db, id) : undefined;
      if (!customer) {
        res.status(404).type('text/plain').send('not found');
        return;
      }
      await subscribe(customer, req, res);
    }),
  );

  // 自助页上「移除」一台设备:凭订阅链接里的 token,只能动自己名下的
  r.post(
    '/sub/:token/devices/:did/delete',
    handle(async (req, res) => {
      const id = customerIdBySubToken(db, String(req.params.token));
      if (id == null) {
        res.status(404).type('text/plain').send('not found');
        return;
      }
      try {
        deleteDevice(db, id, Number(req.params.did));
      } catch {
        // 已经不在了(点了两次):照样回到页面
      }
      // 相对地址:前面有反代、带路径前缀时也能回到自助页
      res.redirect(303, `../../../${encodeURIComponent(String(req.params.token))}?removed=1`);
    }),
  );

  return r;
}
