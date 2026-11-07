// 节点实测:取每位客户订阅里的真实链接(他自己的凭据),照 3x-ui 的写法转成 Xray 出站,
// 交给一台面板的 /xray/testOutbounds(http 模式)起临时 Xray 真连一次,拿到成功与否、延迟和出口 IP,
// 再对照本系统按配置快照推算的落地 IP。结果里不含链接和凭据。
// 测试从那台面板所在的机器(海外)发起:证明服务端配置和凭据没问题,测不出国内到各机器的线路是否被封。

import { getCustomer } from './customers/repo';
import type { DB } from './db';
import { exitKey, lineExits } from './panels/exits';
import { listPanels, type Panel } from './panels/repo';
import { collectLinks, type LinkFetcher } from './subscription/service';

export interface NodeResult {
  customer: string;
  /** 客户状态;不是 active 的线路本来就是停用的,连不上属正常 */
  state: string;
  panel: string;
  /** 节点名(链接 # 后面的部分) */
  name: string;
  protocol: string;
  ok: boolean;
  delay?: number;
  /** 实际出口 IP */
  egress?: string;
  /** 本系统推算的落地 IP;实际出口不在其中时 exitMismatch = true */
  expected: string[];
  exitMismatch?: boolean;
  error?: string;
}

export interface NodeCheckReport {
  runner: string;
  customers: number;
  results: NodeResult[];
  /** 取不到链接或协议不支持测试的 */
  skipped: string[];
}

/** 跑测试的面板:给 outbounds,按顺序返回结果 */
export type OutboundTester = (outbounds: unknown[]) => Promise<any[]>;

const decode = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};
const list = (v: string | null, fallback: string[]) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : fallback);

/** 分享链接 → Xray 出站(vless / hysteria2 / trojan,写法同 3x-ui 的 link/outbound.go);不支持的返回 null。
 *  SNI 照链接原样:空着就空着,好测出 Xray 内核客户端会不会连不上 */
export function linkToOutbound(link: string, tag: string): any | null {
  const scheme = link.slice(0, link.indexOf('://')).toLowerCase();
  let u: URL;
  try {
    u = new URL(link);
  } catch {
    return null;
  }
  const q = u.searchParams;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const port = Number(u.port || 443);
  if (!host) return null;
  if (scheme === 'vless') {
    const network = q.get('type') || 'tcp';
    const security = q.get('security') || 'none';
    const stream: any = { network, security };
    if (network === 'tcp') stream.tcpSettings = { header: { type: 'none' } };
    if (network === 'ws') stream.wsSettings = { path: q.get('path') || '/', host: q.get('host') || '' };
    if (network === 'grpc') stream.grpcSettings = { serviceName: q.get('serviceName') || '' };
    if (security === 'reality') {
      stream.realitySettings = { serverName: q.get('sni') || '', fingerprint: q.get('fp') || 'chrome', publicKey: q.get('pbk') || '', shortId: q.get('sid') || '', spiderX: q.get('spx') || '' };
    }
    if (security === 'tls') stream.tlsSettings = { serverName: q.get('sni') || '', fingerprint: q.get('fp') || '', alpn: list(q.get('alpn'), []) };
    return {
      tag,
      protocol: 'vless',
      settings: { address: host, port, id: decode(u.username), flow: q.get('flow') || '', encryption: q.get('encryption') || 'none' },
      streamSettings: stream,
    };
  }
  if (scheme === 'hysteria2' || scheme === 'hy2') {
    const stream: any = {
      network: 'hysteria',
      security: 'tls',
      hysteriaSettings: { version: 2, auth: decode(u.username) + (u.password ? `:${decode(u.password)}` : ''), udpIdleTimeout: 60 },
      tlsSettings: { serverName: q.get('sni') || '', alpn: list(q.get('alpn'), ['h3']), fingerprint: q.get('fp') || '' },
    };
    const obfsPassword = q.get('obfs-password');
    if ((q.get('obfs') || '').toLowerCase() === 'salamander' && obfsPassword) stream.finalmask = { udp: [{ type: 'salamander', settings: { password: obfsPassword } }] };
    return { tag, protocol: 'hysteria', settings: { address: host, port, version: 2 }, streamSettings: stream };
  }
  if (scheme === 'trojan') {
    const network = q.get('type') || 'tcp';
    const stream: any = { network, security: 'tls', tlsSettings: { serverName: q.get('sni') || '', fingerprint: q.get('fp') || '', alpn: list(q.get('alpn'), []) } };
    if (network === 'tcp') stream.tcpSettings = { header: { type: 'none' } };
    if (network === 'ws') stream.wsSettings = { path: q.get('path') || '/', host: q.get('host') || '' };
    return { tag, protocol: 'trojan', settings: { servers: [{ address: host, port, password: decode(u.username) }] }, streamSettings: stream };
  }
  return null;
}

/** 选跑测试的面板:指定了名字就用它,否则用第一台启用的落地 */
export function pickRunner(db: DB, name?: string): Panel {
  const panels = listPanels(db).filter((p) => p.enabled);
  const runner = name ? panels.find((p) => p.name === name) : (panels.find((p) => p.role !== 'relay') ?? panels[0]);
  if (!runner) throw new Error(name ? `找不到启用的面板:${name}` : '没有启用的面板');
  return runner;
}

export async function checkNodes(
  db: DB,
  opts: { runner: string; tester: OutboundTester; fetcher: LinkFetcher; customer?: string; batch?: number },
): Promise<NodeCheckReport> {
  const exits = await lineExits(db);
  const ids = (db.prepare('SELECT id, name FROM customers ORDER BY name COLLATE NOCASE').all() as { id: number; name: string }[])
    .filter((c) => !opts.customer || c.name === opts.customer)
    .map((c) => c.id);
  if (opts.customer && !ids.length) throw new Error(`找不到客户:${opts.customer}`);

  const items: { result: NodeResult; outbound: any }[] = [];
  const skipped: string[] = [];
  for (const id of ids) {
    const c = getCustomer(db, id)!;
    for (const line of await collectLinks(db, id, opts.fetcher)) {
      if (line.error) {
        skipped.push(`${c.name} @ ${line.panel_name}:${line.email} 取不到链接(${line.error})`);
        continue;
      }
      const expected = (exits.get(exitKey(line.panel_id, line.email)) ?? []).map((e) => e.ip);
      for (const link of line.links) {
        const name = decode(link.includes('#') ? link.slice(link.indexOf('#') + 1) : '');
        const outbound = linkToOutbound(link, `n${items.length}`);
        if (!outbound) {
          skipped.push(`${c.name} @ ${line.panel_name} ${name}:协议不支持测试`);
          continue;
        }
        items.push({ outbound, result: { customer: c.name, state: c.state, panel: line.panel_name, name, protocol: outbound.protocol, ok: false, expected } });
      }
    }
  }

  const size = opts.batch ?? 20;
  for (let i = 0; i < items.length; i += size) {
    const batch = items.slice(i, i + size);
    let answers: any[] = [];
    let failure = '';
    try {
      answers = await opts.tester(batch.map((x) => x.outbound));
    } catch (e) {
      failure = `测试请求失败:${e instanceof Error ? e.message : String(e)}`;
    }
    batch.forEach((x, k) => {
      const a = answers[k];
      const r = x.result;
      r.ok = Boolean(a?.success);
      if (a?.delay != null) r.delay = Number(a.delay);
      if (a?.egress?.ipv4) r.egress = String(a.egress.ipv4);
      if (!r.ok) r.error = failure || String(a?.error ?? '没有结果');
      if (r.ok && r.egress && r.expected.length && !r.expected.includes(r.egress)) r.exitMismatch = true;
    });
  }
  return { runner: opts.runner, customers: ids.length, results: items.map((x) => x.result), skipped };
}
