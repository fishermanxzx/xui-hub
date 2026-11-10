// 把面板给的分享链接解析成结构化节点,供 sing-box / Quantumult X / Loon 生成器使用。
// 支持 vless(reality / TLS / 明文)、vmess、trojan(TLS)和 hysteria2(salamander 混淆);
// vless / vmess / trojan 的传输层认 tcp、ws、grpc、httpupgrade。其他协议和传输返回 null,由调用方跳过。

/** 传输层和 TLS 参数(vless / vmess / trojan 共用) */
export interface Transport {
  /** tcp / ws / grpc / httpupgrade */
  network: string;
  /** ws / httpupgrade 的路径和 Host */
  path?: string;
  host?: string;
  /** grpc 的服务名 */
  serviceName?: string;
  sni?: string;
  alpn: string[];
  fingerprint?: string;
  insecure: boolean;
}

interface Endpoint {
  name: string;
  server: string;
  port: number;
}

export interface VlessNode extends Endpoint, Transport {
  type: 'vless';
  uuid: string;
  flow?: string;
  /** none / tls / reality */
  security: string;
  publicKey?: string;
  shortId?: string;
}

export interface VmessNode extends Endpoint, Transport {
  type: 'vmess';
  uuid: string;
  alterId: number;
  /** 加密方式(scy):auto / aes-128-gcm / chacha20-poly1305 / none / zero */
  cipher: string;
  tls: boolean;
}

export interface TrojanNode extends Endpoint, Transport {
  type: 'trojan';
  password: string;
}

export interface Hysteria2Node extends Endpoint {
  type: 'hysteria2';
  password: string;
  sni?: string;
  alpn: string[];
  obfs?: string;
  obfsPassword?: string;
  insecure: boolean;
}

export type ProxyNode = VlessNode | VmessNode | TrojanNode | Hysteria2Node;

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

const list = (value: string | undefined) => (value ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const truthy = (value: unknown) => value === true || value === '1' || value === 'true';
const validPort = (port: number) => Number.isInteger(port) && port > 0;

/** 生成器写得出来的传输:tcp(不带 http 伪装)、ws、grpc、httpupgrade;kcp、xhttp 等不行 */
function supported(network: string, headerType: string | undefined): boolean {
  return network === 'tcp' ? (headerType ?? 'none') === 'none' : ['ws', 'grpc', 'httpupgrade'].includes(network);
}

/** vmess://<base64 的 JSON>(v2rayN 的写法,3x-ui 给的就是这种) */
function parseVmess(body: string): VmessNode | null {
  let v: Record<string, unknown>;
  try {
    v = JSON.parse(Buffer.from(body, 'base64').toString('utf8'));
  } catch {
    return null;
  }
  if (!v || typeof v !== 'object') return null;
  const str = (key: string) => (v[key] == null || v[key] === '' ? undefined : String(v[key]));
  const server = str('add');
  const port = Number(v.port);
  const uuid = str('id');
  const network = str('net') ?? 'tcp';
  const security = str('tls') ?? 'none';
  if (!server || !uuid || !validPort(port) || !supported(network, str('type')) || !['none', 'tls'].includes(security)) return null;
  const grpc = network === 'grpc';
  return {
    type: 'vmess',
    name: str('ps') ?? `${server}:${port}`,
    server,
    port,
    uuid,
    alterId: Number(v.aid) || 0,
    cipher: str('scy') ?? 'auto',
    tls: security === 'tls',
    network,
    // grpc 的服务名放在 path 里
    path: grpc ? undefined : str('path'),
    host: str('host'),
    serviceName: grpc ? str('path') : undefined,
    sni: str('sni'),
    alpn: list(str('alpn')),
    fingerprint: str('fp'),
    insecure: truthy(v.allowInsecure),
  };
}

export function parseNode(link: string): ProxyNode | null {
  const scheme = link.slice(0, link.indexOf('://')).toLowerCase();
  if (scheme === 'vmess') return parseVmess(link.slice('vmess://'.length));
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return null;
  }
  const q = url.searchParams;
  const server = url.hostname.replace(/^\[|\]$/g, '');
  const port = Number(url.port);
  if (!server || !validPort(port)) return null;
  const opt = (key: string) => q.get(key) || undefined;
  const base = { name: decode(url.hash.slice(1)) || `${server}:${port}`, server, port };
  const sni = opt('sni') ?? opt('peer') ?? opt('servername');
  const alpn = list(opt('alpn'));
  const insecure = truthy(q.get('insecure')) || truthy(q.get('allowInsecure'));
  const secret = decode(url.username);

  if (scheme === 'hysteria2' || scheme === 'hy2') {
    const password = secret + (url.password ? `:${decode(url.password)}` : '');
    if (!password) return null;
    return { type: 'hysteria2', ...base, password, sni, alpn, obfs: opt('obfs'), obfsPassword: opt('obfs-password'), insecure };
  }
  if (scheme !== 'vless' && scheme !== 'trojan') return null;

  const network = opt('type') ?? 'tcp';
  if (!secret || !supported(network, opt('headerType'))) return null;
  const transport = { network, path: opt('path'), host: opt('host'), serviceName: opt('serviceName'), sni, alpn, fingerprint: opt('fp'), insecure };
  if (scheme === 'trojan') {
    // trojan 只认 TLS;reality 等其他安全层先不支持
    return (opt('security') ?? 'tls') === 'tls' ? { type: 'trojan', ...base, password: secret, ...transport } : null;
  }
  const security = opt('security') ?? 'none';
  if (!['none', 'tls', 'reality'].includes(security)) return null;
  return { type: 'vless', ...base, uuid: secret, flow: opt('flow'), security, publicKey: opt('pbk'), shortId: opt('sid'), ...transport };
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
