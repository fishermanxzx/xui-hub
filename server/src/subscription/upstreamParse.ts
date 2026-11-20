// 外部订阅的内容 → 节点分享链接。认三种写法:
// - 节点链接,每行一个(明文或整体 base64,v2rayN 等客户端拉到的就是这种);
// - Clash / Mihomo 配置(取 proxies);
// - sing-box 配置(取 outbounds)。
// 后两种按协议换成分享链接(vless / vmess / trojan / ss / hysteria2 / tuic / anytls),协议参数(REALITY 的 pbk / sid、flow、fp,
// hy2 的混淆和端口跳跃等)都带上;认不出的协议跳过并计数。链接本身原样保留,不改写。

import YAML from 'yaml';

export interface ParsedUpstream {
  links: string[];
  /** 认不出、没法换成链接的节点个数 */
  skipped: number;
}

/** 当作节点的链接协议;其他 xx:// 开头的行(如网址)不算节点 */
const SCHEMES = new Set(['vmess', 'vless', 'trojan', 'ss', 'ssr', 'hysteria2', 'hy2', 'hysteria', 'tuic', 'anytls', 'wireguard', 'wg', 'socks', 'socks5', 'juicity', 'mieru']);

const schemeOf = (line: string) => /^([a-z][a-z0-9+.-]*):\/\//i.exec(line)?.[1]?.toLowerCase();

function fromLines(text: string): ParsedUpstream {
  const links: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const scheme = schemeOf(line);
    if (scheme && SCHEMES.has(scheme)) links.push(line);
  }
  return { links, skipped: 0 };
}

const hasLinks = (text: string) => text.split(/\r?\n/).some((l) => SCHEMES.has(schemeOf(l.trim()) ?? ''));

/** 标准或 URL 安全的 base64,可以不带 =、可以分行;不是 base64 返回 null */
export function decodeBase64(text: string): string | null {
  const s = text.replace(/\s+/g, '');
  if (!s || !/^[A-Za-z0-9+/_-]+=*$/.test(s)) return null;
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

// ---------- 结构化节点 → 分享链接 ----------

interface Spec {
  type: 'vless' | 'vmess' | 'trojan' | 'ss' | 'hysteria2' | 'tuic' | 'anytls';
  name: string;
  server: string;
  port: number;
  uuid?: string;
  password?: string;
  /** ss 的加密方式 / vmess 的 scy */
  method?: string;
  alterId?: number;
  flow?: string;
  tls?: boolean;
  sni?: string;
  alpn?: string[];
  fp?: string;
  insecure?: boolean;
  reality?: { pbk: string; sid: string };
  /** tcp / ws / grpc / httpupgrade / h2 / http(tcp + http 伪装)/ xhttp */
  network?: string;
  path?: string;
  host?: string;
  serviceName?: string;
  mode?: string;
  /** ss 的 SIP003 插件,如 obfs-local;obfs=http;obfs-host=x */
  plugin?: string;
  obfs?: string;
  obfsPassword?: string;
  /** hy2 端口跳跃,如 20000-30000 */
  ports?: string;
  congestion?: string;
  udpRelayMode?: string;
}

const enc = encodeURIComponent;
/**
 * 链接里 @ 前面的密码 / uuid:只转义会把链接拆坏的字符(@ : / ? # % 空格、非 ASCII 等)。
 * 内置的 subconverter 不解百分号编码,常见的字母数字和 + = 之类原样写才能在 Clash 等格式里用对
 */
const encUser = (s: string) => s.replace(/[^A-Za-z0-9\-._~!$&'()*+,;=]/g, (c) => encodeURIComponent(c));

/** 只写有值的参数 */
function qs(params: Record<string, string | number | boolean | undefined | null>): string {
  const parts = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== '' && v !== false)
    .map(([k, v]) => `${k}=${enc(v === true ? '1' : String(v))}`);
  return parts.length ? `?${parts.join('&')}` : '';
}

const hostPart = (server: string) => (server.includes(':') && !server.startsWith('[') ? `[${server}]` : server);

/** vless / trojan 的传输层参数(Xray 分享链接的写法) */
function transportParams(s: Spec): Record<string, string | undefined> {
  const net = s.network ?? 'tcp';
  if (net === 'ws' || net === 'httpupgrade') return { type: net, path: s.path, host: s.host };
  if (net === 'grpc') return { type: 'grpc', serviceName: s.serviceName, mode: s.mode };
  if (net === 'h2') return { type: 'http', path: s.path, host: s.host };
  if (net === 'http') return { type: 'tcp', headerType: 'http', path: s.path, host: s.host };
  if (net === 'xhttp') return { type: 'xhttp', path: s.path, host: s.host, mode: s.mode };
  return { type: 'tcp' };
}

function tlsParams(s: Spec): Record<string, string | boolean | undefined> {
  if (s.reality) return { security: 'reality', sni: s.sni, fp: s.fp, pbk: s.reality.pbk, sid: s.reality.sid };
  if (!s.tls) return { security: 'none' };
  return { security: 'tls', sni: s.sni, fp: s.fp, alpn: s.alpn?.join(','), allowInsecure: s.insecure };
}

export function specToLink(s: Spec): string | null {
  const at = `${hostPart(s.server)}:${s.port}`;
  const name = `#${enc(s.name || `${s.server}:${s.port}`)}`;
  switch (s.type) {
    case 'vless':
      if (!s.uuid) return null;
      return `vless://${encUser(s.uuid)}@${at}${qs({ encryption: 'none', flow: s.flow, ...tlsParams(s), ...transportParams(s) })}${name}`;
    case 'trojan':
      if (!s.password) return null;
      return `trojan://${encUser(s.password)}@${at}${qs({ ...tlsParams({ ...s, tls: true }), ...transportParams(s) })}${name}`;
    case 'vmess': {
      if (!s.uuid) return null;
      const net = s.network ?? 'tcp';
      const json = {
        v: '2',
        ps: s.name || `${s.server}:${s.port}`,
        add: s.server,
        port: String(s.port),
        id: s.uuid,
        aid: String(s.alterId ?? 0),
        scy: s.method || 'auto',
        net: net === 'http' ? 'tcp' : net,
        type: net === 'http' ? 'http' : 'none',
        host: s.host ?? '',
        // grpc 的服务名放在 path 里(v2rayN 的写法)
        path: (net === 'grpc' ? s.serviceName : s.path) ?? '',
        tls: s.tls ? 'tls' : '',
        sni: s.sni ?? '',
        alpn: s.alpn?.join(',') ?? '',
        fp: s.fp ?? '',
        ...(s.insecure ? { allowInsecure: true } : {}),
      };
      return `vmess://${Buffer.from(JSON.stringify(json), 'utf8').toString('base64')}`;
    }
    case 'ss': {
      if (!s.method || !s.password) return null;
      // SIP002 的 base64url 写法(2022 系列也这样写:内置的 subconverter 只认 base64 的)
      return `ss://${Buffer.from(`${s.method}:${s.password}`, 'utf8').toString('base64url')}@${at}${s.plugin ? `/?plugin=${enc(s.plugin)}` : ''}${name}`;
    }
    case 'hysteria2':
      if (!s.password) return null;
      return `hysteria2://${encUser(s.password)}@${at}/${qs({ sni: s.sni, obfs: s.obfs, 'obfs-password': s.obfsPassword, insecure: s.insecure, alpn: s.alpn?.join(','), mport: s.ports })}${name}`;
    case 'tuic':
      if (!s.uuid || !s.password) return null;
      return `tuic://${encUser(s.uuid)}:${encUser(s.password)}@${at}${qs({ sni: s.sni, alpn: s.alpn?.join(','), congestion_control: s.congestion, udp_relay_mode: s.udpRelayMode, allow_insecure: s.insecure })}${name}`;
    case 'anytls':
      if (!s.password) return null;
      return `anytls://${encUser(s.password)}@${at}${qs({ sni: s.sni, insecure: s.insecure })}${name}`;
  }
}

// ---------- Clash / Mihomo ----------

const str = (v: unknown) => (v === undefined || v === null || v === '' ? undefined : String(v));
const strList = (v: unknown) => (Array.isArray(v) ? v.map(String).filter(Boolean) : typeof v === 'string' && v ? v.split(',').map((x) => x.trim()) : undefined);
const firstOf = (v: unknown) => (Array.isArray(v) ? str(v[0]) : str(v));
const obj = (v: unknown): Record<string, any> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, any>) : {});
const truthy = (v: unknown) => v === true || v === 'true' || v === 1 || v === '1';

/** Clash 的 network + xx-opts → 传输层 */
function clashTransport(p: Record<string, any>): Pick<Spec, 'network' | 'path' | 'host' | 'serviceName' | 'mode'> {
  const network = str(p.network) ?? 'tcp';
  if (network === 'ws') {
    const o = obj(p['ws-opts']);
    const host = str(obj(o.headers).Host) ?? str(obj(o.headers).host);
    return { network: truthy(o['v2ray-http-upgrade']) ? 'httpupgrade' : 'ws', path: str(o.path), host };
  }
  if (network === 'grpc') return { network, serviceName: str(obj(p['grpc-opts'])['grpc-service-name']) };
  if (network === 'h2') {
    const o = obj(p['h2-opts']);
    return { network, path: str(o.path), host: strList(o.host)?.join(',') };
  }
  if (network === 'http') {
    const o = obj(p['http-opts']);
    const headers = obj(o.headers);
    return { network, path: firstOf(o.path), host: firstOf(headers.Host ?? headers.host) };
  }
  if (network === 'xhttp') {
    const o = obj(p['xhttp-opts']);
    return { network, path: str(o.path), host: str(o.host), mode: str(o.mode) };
  }
  return { network };
}

/** Clash 的 ss 插件 → SIP003 插件串;认不出的插件返回 null(没有插件的节点连不上,不出) */
function clashPlugin(p: Record<string, any>): string | undefined | null {
  const plugin = str(p.plugin);
  if (!plugin) return undefined;
  const o = obj(p['plugin-opts']);
  if (plugin === 'obfs') return ['obfs-local', `obfs=${str(o.mode) ?? 'http'}`, ...(str(o.host) ? [`obfs-host=${o.host}`] : [])].join(';');
  if (plugin === 'v2ray-plugin') {
    return ['v2ray-plugin', `mode=${str(o.mode) ?? 'websocket'}`, ...(str(o.host) ? [`host=${o.host}`] : []), ...(str(o.path) ? [`path=${o.path}`] : []), ...(truthy(o.tls) ? ['tls'] : [])].join(';');
  }
  return null;
}

export function clashToLink(p: Record<string, any>): string | null {
  const server = str(p.server);
  const port = Number(p.port);
  if (!server || !Number.isInteger(port) || port <= 0) return null;
  const base = { name: str(p.name) ?? '', server, port, sni: str(p.servername) ?? str(p.sni), alpn: strList(p.alpn), fp: str(p['client-fingerprint']), insecure: truthy(p['skip-cert-verify']) };
  const ro = obj(p['reality-opts']);
  const reality = str(ro['public-key']) ? { pbk: String(ro['public-key']), sid: str(ro['short-id']) ?? '' } : undefined;
  switch (String(p.type ?? '').toLowerCase()) {
    case 'vless':
      return specToLink({ type: 'vless', ...base, uuid: str(p.uuid), flow: str(p.flow), tls: truthy(p.tls) || !!reality, reality, ...clashTransport(p) });
    case 'vmess':
      return specToLink({ type: 'vmess', ...base, uuid: str(p.uuid), alterId: Number(p.alterId) || 0, method: str(p.cipher), tls: truthy(p.tls), ...clashTransport(p) });
    case 'trojan':
      return specToLink({ type: 'trojan', ...base, password: str(p.password), reality, ...clashTransport(p) });
    case 'ss': {
      const plugin = clashPlugin(p);
      return plugin === null ? null : specToLink({ type: 'ss', ...base, method: str(p.cipher), password: str(p.password), plugin });
    }
    case 'hysteria2':
    case 'hy2':
      return specToLink({ type: 'hysteria2', ...base, password: str(p.password) ?? str(p.auth), obfs: str(p.obfs), obfsPassword: str(p['obfs-password']), ports: str(p.ports) });
    case 'tuic':
      return specToLink({ type: 'tuic', ...base, uuid: str(p.uuid), password: str(p.password), congestion: str(p['congestion-controller']), udpRelayMode: str(p['udp-relay-mode']) });
    case 'anytls':
      return specToLink({ type: 'anytls', ...base, password: str(p.password) });
    default:
      return null;
  }
}

function fromClash(proxies: unknown[]): ParsedUpstream {
  const links: string[] = [];
  let skipped = 0;
  for (const p of proxies) {
    const link = clashToLink(obj(p));
    if (link) links.push(link);
    else skipped++;
  }
  return { links, skipped };
}

// ---------- sing-box ----------

function singboxTls(o: Record<string, any>): Pick<Spec, 'tls' | 'sni' | 'alpn' | 'fp' | 'insecure' | 'reality'> {
  const t = obj(o.tls);
  const r = obj(t.reality);
  return {
    tls: truthy(t.enabled),
    sni: str(t.server_name),
    alpn: strList(t.alpn),
    fp: truthy(obj(t.utls).enabled) ? str(obj(t.utls).fingerprint) : undefined,
    insecure: truthy(t.insecure),
    reality: truthy(r.enabled) && str(r.public_key) ? { pbk: String(r.public_key), sid: str(r.short_id) ?? '' } : undefined,
  };
}

function singboxTransport(o: Record<string, any>): Pick<Spec, 'network' | 'path' | 'host' | 'serviceName'> {
  const t = obj(o.transport);
  const type = str(t.type);
  if (type === 'ws') return { network: 'ws', path: str(t.path), host: str(obj(t.headers).Host) ?? str(obj(t.headers).host) };
  if (type === 'httpupgrade') return { network: 'httpupgrade', path: str(t.path), host: str(t.host) };
  if (type === 'grpc') return { network: 'grpc', serviceName: str(t.service_name) };
  if (type === 'http') return { network: 'h2', path: str(t.path), host: strList(t.host)?.join(',') };
  return { network: 'tcp' };
}

/** 不是代理的出站(直连、拦截、DNS、分组)返回 undefined,不算跳过 */
export function singboxToLink(o: Record<string, any>): string | null | undefined {
  const server = str(o.server);
  const port = Number(o.server_port);
  if (!server) return undefined;
  if (!Number.isInteger(port) || port <= 0) return null;
  const base = { name: str(o.tag) ?? '', server, port, ...singboxTls(o) };
  switch (String(o.type ?? '')) {
    case 'vless':
      return specToLink({ type: 'vless', ...base, uuid: str(o.uuid), flow: str(o.flow), ...singboxTransport(o) });
    case 'vmess':
      return specToLink({ type: 'vmess', ...base, uuid: str(o.uuid), alterId: Number(o.alter_id) || 0, method: str(o.security), ...singboxTransport(o) });
    case 'trojan':
      return specToLink({ type: 'trojan', ...base, password: str(o.password), ...singboxTransport(o) });
    case 'shadowsocks': {
      const plugin = str(o.plugin);
      return specToLink({ type: 'ss', ...base, method: str(o.method), password: str(o.password), plugin: plugin ? [plugin, str(o.plugin_opts)].filter(Boolean).join(';') : undefined });
    }
    case 'hysteria2': {
      const obfs = obj(o.obfs);
      const ports = Array.isArray(o.server_ports) ? o.server_ports.map((x: unknown) => String(x).replace(':', '-')).join(',') : undefined;
      return specToLink({ type: 'hysteria2', ...base, password: str(o.password), obfs: str(obfs.type), obfsPassword: str(obfs.password), ports });
    }
    case 'tuic':
      return specToLink({ type: 'tuic', ...base, uuid: str(o.uuid), password: str(o.password), congestion: str(o.congestion_control), udpRelayMode: str(o.udp_relay_mode) });
    case 'anytls':
      return specToLink({ type: 'anytls', ...base, password: str(o.password) });
    default:
      return null;
  }
}

function fromSingbox(outbounds: unknown[]): ParsedUpstream {
  const links: string[] = [];
  let skipped = 0;
  for (const o of outbounds) {
    const link = singboxToLink(obj(o));
    if (link) links.push(link);
    else if (link === null) skipped++;
  }
  return { links, skipped };
}

/** 认不出的内容返回空 */
export function parseUpstreamBody(body: string): ParsedUpstream {
  const text = body.replace(/^﻿/, '').trim();
  if (!text) return { links: [], skipped: 0 };
  if (text.startsWith('{')) {
    try {
      const json = JSON.parse(text);
      if (Array.isArray(json?.outbounds)) return fromSingbox(json.outbounds);
    } catch {
      // 不是 JSON:往下按其他写法认
    }
  }
  if (/^proxies\s*:/m.test(text)) {
    try {
      const yaml = YAML.parse(text);
      if (Array.isArray(yaml?.proxies)) return fromClash(yaml.proxies);
    } catch {
      // YAML 写坏了:往下按其他写法认
    }
  }
  if (hasLinks(text)) return fromLines(text);
  const decoded = decodeBase64(text);
  return decoded && hasLinks(decoded) ? fromLines(decoded) : { links: [], skipped: 0 };
}
