// 面板上手配的、点名某条线路(某个入站上的某个客户端)的路由规则:不带 xui-hub: 标记,出口规则弹窗本来看不到也改不了。
// 这里把它们列出来:
// - 只点名这个客户端(user 正好是他的 email)、入站不限或只限这条线路的入站:可以删掉;
//   带条件、出口对得上(SOCKS 页登记的代理、直出、拦截)的还能「接管」:加上 xui-hub: 标记、存进线路的出口规则,以后在 xui-hub 里改;
// - 点名了多个客户端、或还限定了别的入站的:只读,去 3x-ui 里改。
// 对所有客户端都生效的全局规则不列。删除 / 接管都改这块面板的 Xray 路由并重启 Xray,改完读回核对,不对就改回去(editXrayChecked)。

import { createHash } from 'node:crypto';
import { getLine, setLineRoutes, setLineRules, type Line } from '../customers/repo';
import type { DB } from '../db';
import { getPanel, InputError, type Panel } from '../panels/repo';
import { allSocks, type SocksProxy } from '../socks/repo';
import { panelKey, serial, using } from '../util';
import { XUIError } from '../xui/client';
import { xrayConfig } from '../xui/json';
import { resolveRules, type LineAdmin } from './open';
import { dropUnusedOutbound, editXrayChecked, isManagedRule, isUserRule, MANAGED, sameServer, serverOf, setUserRules, socksServer } from './relay';
import { conditionsOf, enabled, hasInbound, list, routesForClient, targetOf, type ConditionKey, type RouteTarget } from './routes';
import { MAX_RULES, validRules, type LineRule } from './rules';

export interface PanelRule {
  /** 认这条规则用的指纹(规则内容的哈希);删除 / 接管时带上,面板上的规则变了就对不上 */
  key: string;
  /** 条件;空 = 这个客户端的全部流量 */
  when: Partial<Record<ConditionKey, string[]>>;
  to: RouteTarget;
  /** 现在生效吗:排在接住这个客户端全部流量的规则后面的轮不到 */
  active: boolean;
  /** 点名了几个客户端 */
  users: number;
  /** 只点名这个客户端、入站不限或只限这条线路的:能删 */
  own: boolean;
  /** 能接管时,接管后变成的出口规则;不能接管为 null */
  takeover: LineRule | null;
  /** 不能接管(或不能删)的原因 */
  why: string;
}

interface Scanned extends PanelRule {
  rule: any;
}

/** 规则内容的指纹:同样的内容同样的 key */
export const ruleKey = (r: any) => createHash('sha256').update(JSON.stringify(r)).digest('hex').slice(0, 16);

/** xui-hub 的出口规则只认这几样条件 */
const SUPPORTED = new Set<ConditionKey>(['domain', 'ip', 'port', 'network']);

/** 某种协议的第一个出站(xui-hub 写直出 / 拦截规则时用它,见 relay.ts 的 outboundOf) */
const firstOf = (xray: any, protocol: string) => (Array.isArray(xray.outbounds) ? xray.outbounds : []).find((o: any) => o?.protocol === protocol && typeof o?.tag === 'string' && o.tag);

/** 这条手配的规则接管成 xui-hub 的出口规则会是什么样;接不了返回原因 */
function takeoverOf(db: DB, xray: any, r: any, socks: SocksProxy[]): LineRule | string {
  const when = conditionsOf(r);
  const extra = Object.keys(when).filter((k) => !SUPPORTED.has(k as ConditionKey));
  if (extra.length) return `带了 xui-hub 不支持的条件(${extra.join('、')}),只能删掉或去 3x-ui 里改`;
  if (!r.outboundTag) return r.balancerTag ? `走的是负载均衡「${r.balancerTag}」,xui-hub 的规则只支持 SOCKS、直出、拦截` : '规则没有出站';
  const tag = String(r.outboundTag);
  const out = (Array.isArray(xray.outbounds) ? xray.outbounds : []).find((o: any) => o?.tag === tag);
  if (!out) return `出站「${tag}」在面板上不存在`;
  let to: LineRule['to'];
  if (out.protocol === 'freedom' || out.protocol === 'blackhole') {
    // xui-hub 写直出 / 拦截时用这种协议的第一个出站;指向别的同类出站(可能带了自己的设置)接管后会变,不接
    if (firstOf(xray, out.protocol)?.tag !== tag) return `出站「${tag}」不是面板上第一个${out.protocol === 'freedom' ? '直出' : '拦截'}出站,接管后会换成第一个,只能删掉或去 3x-ui 里改`;
    to = out.protocol === 'freedom' ? { kind: 'direct' } : { kind: 'block' };
  } else if (out.protocol === 'socks') {
    const server = serverOf(out);
    const s = socks.find((x) => sameServer(socksServer(x), server));
    if (!s) {
      const near = socks.find((x) => x.host.toLowerCase() === server.address && x.port === server.port);
      return near ? `出站的账号密码和 SOCKS 页登记的「${near.name}」对不上` : `出站连的 ${server.address}:${server.port} 没在 SOCKS 页登记;先登记,或者直接删掉`;
    }
    to = { kind: 'socks', socks_id: s.id };
  } else {
    return `出站「${tag}」是 ${out.protocol || '未知'} 协议,xui-hub 的规则只支持 SOCKS、直出、拦截`;
  }
  const raw = { domain: when.domain ?? [], ip: when.ip ?? [], port: (when.port ?? []).join(','), network: (when.network ?? []).join(','), to };
  try {
    return validRules(db, [raw])[0];
  } catch (e) {
    return e instanceof Error ? e.message.replace(/^第 1 条规则的?/, '') : String(e);
  }
}

/** 面板路由里点名这个客户端、不归 xui-hub 管的规则,按顺序;lineRules = 线路现有的出口规则条数(满了不能再接管) */
function scan(db: DB, xray: any, inboundTag: string, email: string, lineRules: number): Scanned[] {
  const rules: any[] = Array.isArray(xray?.routing?.rules) ? xray.routing.rules : [];
  const socks = allSocks(db);
  const known = socks.map((s) => ({ id: s.id, host: s.host, port: s.port }));
  const out: Scanned[] = [];
  let caught = false;
  for (const r of rules) {
    if (!enabled(r) || !hasInbound(r, inboundTag)) continue;
    const users = list(r.user);
    const conditional = Object.keys(conditionsOf(r)).length > 0;
    if (!users.includes(email)) {
      if (!users.length && !conditional) caught = true;
      continue;
    }
    // xui-hub 写的:带标记的出口规则、换出口写的那条
    if ((typeof r.ruleTag === 'string' && r.ruleTag.startsWith(MANAGED)) || isUserRule(r, inboundTag, email)) {
      if (!conditional) caught = true;
      continue;
    }
    const inbounds = list(r.inboundTag);
    const own = users.length === 1 && inbounds.every((t) => t === inboundTag);
    let takeover: LineRule | null = null;
    let why = '';
    if (users.length > 1) why = `点名了 ${users.length} 个客户端,只能去 3x-ui 里改`;
    else if (!own) why = '还限定了别的入站,只能去 3x-ui 里改';
    else if (!conditional) why = '没有条件,是这个客户端全部流量的出口;删掉后用「换出口」设';
    else if (lineRules >= MAX_RULES) why = `这条线路的出口规则已经有 ${MAX_RULES} 条,接管不了;可以删掉`;
    else {
      const t = takeoverOf(db, xray, r, socks);
      if (typeof t === 'string') why = t;
      else takeover = t;
    }
    out.push({ rule: r, key: ruleKey(r), when: conditionsOf(r), to: targetOf(xray, r, known), active: !caught, users: users.length, own, takeover, why });
    if (!conditional) caught = true;
  }
  return out;
}

/** 给前端的(去掉规则原文) */
const view = ({ rule: _, ...p }: Scanned): PanelRule => p;

/** 只读:面板上点名这个客户端、不归 xui-hub 管的规则 */
export function listPanelRules(db: DB, xray: any, inboundTag: string, line: Line): PanelRule[] {
  return scan(db, xray, inboundTag, line.email, line.rules.length).map(view);
}

async function inboundTagOf(admin: LineAdmin, line: Line): Promise<string> {
  const tag = (await admin.listInbounds()).find((ib) => Number(ib.id) === line.inbound_id)?.tag;
  if (!tag) throw new InputError('面板上找不到这条线路的入站(或入站没有 tag)');
  return String(tag);
}

function panelOf(db: DB, line: Line): Panel {
  const panel = getPanel(db, line.panel_id);
  if (!panel) throw new InputError('这条线路的面板已经不在了');
  return panel;
}

/** 读面板,列出这条线路在面板上手配的规则 */
export async function panelRulesOf(db: DB, line: Line, adminFor: (panel: Panel) => LineAdmin): Promise<PanelRule[]> {
  return using(adminFor(panelOf(db, line)), async (admin) => {
    const tag = await inboundTagOf(admin, line);
    return listPanelRules(db, xrayConfig(await admin.xraySettings()), tag, line);
  });
}

const gone = () => new InputError('面板上没有这条规则了(可能刚在面板上改过),刷新再看');

/**
 * 删掉面板上手配、只点名这个客户端的一条规则(内容一样的几条一起删),出站没人用了按 dropUnusedOutbound 的规则清掉;
 * 重启 Xray,读回核对。返回删掉的那条和线路(实际出口按读回的配置重算)
 */
export async function deletePanelRule(db: DB, line: Line, key: string, adminFor: (panel: Panel) => LineAdmin): Promise<{ rule: PanelRule; line: Line }> {
  const panel = panelOf(db, line);
  return serial(panelKey(panel.id), () =>
    using(adminFor(panel), async (admin) => {
      const tag = await inboundTagOf(admin, line);
      let hit: Scanned | undefined;
      const back = await editXrayChecked(
        admin,
        (xray) => {
          hit = scan(db, xray, tag, line.email, line.rules.length).find((x) => x.key === key);
          if (!hit) throw gone();
          if (!hit.own) throw new InputError(`这条规则不能在这里删:${hit.why}`);
          const rules: any[] = xray.routing.rules;
          xray.routing = { ...xray.routing, rules: rules.filter((r) => !(ruleKey(r) === key && list(r.user).length === 1 && list(r.user)[0] === line.email)) };
          dropUnusedOutbound(xray, hit.rule.outboundTag);
        },
        (cfg) => {
          if (scan(db, cfg, tag, line.email, line.rules.length).some((x) => x.key === key)) throw new XUIError('改完读回来,这条规则还在面板上');
        },
      );
      setLineRoutes(db, line.id, routesForClient(back, tag, line.email, allSocks(db).map((s) => ({ id: s.id, host: s.host, port: s.port }))));
      return { rule: view(hit!), line: getLine(db, line.id)! };
    }),
  );
}

/**
 * 接管一条手配的规则:从面板上去掉它,换成同样条件、同样出口、带 xui-hub: 标记的出口规则,存进线路的出口规则
 * (按它在面板上排在 xui-hub 写的哪几条之后插进去,顺序不变)。重启 Xray,读回核对;没成就改回去,记录不动
 */
export async function adoptPanelRule(db: DB, line: Line, key: string, adminFor: (panel: Panel) => LineAdmin): Promise<{ rule: PanelRule; line: Line }> {
  const panel = panelOf(db, line);
  return serial(panelKey(panel.id), () =>
    using(adminFor(panel), async (admin) => {
      const tag = await inboundTagOf(admin, line);
      const current = getLine(db, line.id) ?? line;
      let hit: Scanned | undefined;
      let next: LineRule[] = [];
      const back = await editXrayChecked(
        admin,
        (xray) => {
          if (!Array.isArray(xray.outbounds) || !xray.outbounds.length) throw new Error('读到的 Xray 配置不完整(没有出站)');
          hit = scan(db, xray, tag, current.email, current.rules.length).find((x) => x.key === key);
          if (!hit) throw gone();
          if (!hit.takeover) throw new InputError(`这条规则不能接管:${hit.why}`);
          const rules: any[] = xray.routing.rules;
          const before = rules.slice(0, rules.indexOf(hit.rule)).filter((r) => isManagedRule(r, tag, current.email)).length;
          next = [...current.rules];
          next.splice(Math.min(before, next.length), 0, hit.takeover);
          xray.routing = { ...xray.routing, rules: rules.filter((r) => !(ruleKey(r) === key && list(r.user).length === 1 && list(r.user)[0] === current.email)) };
          setUserRules(xray, tag, current.email, resolveRules(db, next));
        },
        (cfg) => {
          const mine = (cfg?.routing?.rules ?? []).filter((r: any) => isManagedRule(r, tag, current.email));
          if (mine.length !== next.length) throw new XUIError(`改完读回来,出口规则是 ${mine.length} 条,应该是 ${next.length} 条`);
          if (scan(db, cfg, tag, current.email, next.length).some((x) => x.key === key)) throw new XUIError('改完读回来,手配的那条还在面板上');
        },
      );
      setLineRules(db, line.id, next);
      setLineRoutes(db, line.id, routesForClient(back, tag, current.email, allSocks(db).map((s) => ({ id: s.id, host: s.host, port: s.port }))));
      return { rule: view(hit!), line: getLine(db, line.id)! };
    }),
  );
}
