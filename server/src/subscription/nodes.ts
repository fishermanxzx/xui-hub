// 把面板给的分享链接解析成结构化节点,供 sing-box / Quantumult X / Loon 生成器使用。
// 支持 vless(reality)、hysteria2(salamander 混淆)和 trojan(TLS,tcp / ws / grpc);其他协议返回 null,由调用方跳过。

export interface VlessNode {
  type: 'vless';
  name: string;
  server: string;
  port: number;
  uuid: string;
  flow?: string;
  network: string;
  security: string;
  sni?: string;
  fingerprint?: string;
  publicKey?: string;
  shortId?: string;
}

export interface Hysteria2Node {
  type: 'hysteria2';
  name: string;
  server: string;
  port: number;
  password: string;
  sni?: string;
  alpn: string[];
  obfs?: string;
  obfsPassword?: string;
  insecure: boolean;
}

export interface TrojanNode {
  type: 'trojan';
  name: string;
  server: string;
  port: number;
  password: string;
  /** tcp / ws / grpc */
  network: string;
  sni?: string;
  alpn: string[];
  fingerprint?: string;
  insecure: boolean;
  /** ws 的路径和 Host */
  path?: string;
  host?: string;
  /** grpc 的服务名 */
  serviceName?: string;
}

export type ProxyNode = VlessNode | Hysteria2Node | TrojanNode;

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function host(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, '');
}

export function parseNode(link: string): ProxyNode | null {
  const scheme = link.slice(0, link.indexOf('://')).toLowerCase();
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return null;
  }
  const q = url.searchParams;
  const name = decode(url.hash.slice(1)) || `${host(url)}:${url.port}`;
  const port = Number(url.port);
  if (!host(url) || !Number.isInteger(port) || port <= 0) return null;
  const opt = (key: string) => q.get(key) || undefined;

  if (scheme === 'vless') {
    const uuid = decode(url.username);
    if (!uuid) return null;
    return {
      type: 'vless',
      name,
      server: host(url),
      port,
      uuid,
      flow: opt('flow'),
      network: opt('type') ?? 'tcp',
      security: opt('security') ?? 'none',
      sni: opt('sni') ?? opt('servername'),
      fingerprint: opt('fp'),
      publicKey: opt('pbk'),
      shortId: opt('sid'),
    };
  }
  if (scheme === 'hysteria2' || scheme === 'hy2') {
    const password = decode(url.username) + (url.password ? `:${decode(url.password)}` : '');
    if (!password) return null;
    return {
      type: 'hysteria2',
      name,
      server: host(url),
      port,
      password,
      sni: opt('sni') ?? opt('peer'),
      alpn: (opt('alpn') ?? '').split(',').map((s) => s.trim()).filter(Boolean),
      obfs: opt('obfs'),
      obfsPassword: opt('obfs-password'),
      insecure: ['1', 'true'].includes(q.get('insecure') ?? q.get('allowInsecure') ?? ''),
    };
  }
  if (scheme === 'trojan') {
    const password = decode(url.username);
    // trojan 只认 TLS;reality 等其他安全层先不支持
    if (!password || (opt('security') ?? 'tls') !== 'tls') return null;
    const network = opt('type') ?? 'tcp';
    if (!['tcp', 'ws', 'grpc'].includes(network)) return null;
    return {
      type: 'trojan',
      name,
      server: host(url),
      port,
      password,
      network,
      sni: opt('sni') ?? opt('peer'),
      alpn: (opt('alpn') ?? '').split(',').map((s) => s.trim()).filter(Boolean),
      fingerprint: opt('fp'),
      insecure: ['1', 'true'].includes(q.get('allowInsecure') ?? q.get('insecure') ?? ''),
      path: opt('path'),
      host: opt('host'),
      serviceName: opt('serviceName'),
    };
  }
  return null;
}

/** 节点名在配置里要唯一:重名的依次加 " 2"、" 3"(跳过已被占用的) */
export function parseNodes(links: string[]): ProxyNode[] {
  const taken = new Set<string>();
  const out: ProxyNode[] = [];
  for (const link of links) {
    const node = parseNode(link);
    if (!node) continue;
    let name = node.name;
    for (let i = 2; taken.has(name); i++) name = `${node.name} ${i}`;
    taken.add(name);
    out.push(name === node.name ? node : { ...node, name });
  }
  return out;
}
