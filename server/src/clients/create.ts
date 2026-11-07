// 在一台面板上创建客户端(client),协议 vless(reality)或 hy2:
// - 面板上已有这个协议、启用着的入站就复用(vless 优先 reality,都优先 client 多的);
// - 没有就新建一个入站:照其他面板上的同协议入站复制(换新密钥 / 证书),没有就用内置模板;
//   hy2 新建需要这台面板配置了证书(面板设置里的证书路径)。
// 建好后读回核对,再从面板取这个 client 的分享链接。

import { randomBytes, randomUUID } from 'node:crypto';
import { connect } from 'node:net';
import { InputError, type Panel } from '../panels/repo';
import { decodeJson } from '../xui/json';
import { builtinHysteria2, builtinVlessReality, cloneInbound, freshHysteria, freshReality, isReality, isTemplate, type ClientProtocol } from './templates';

export interface ClientAdmin {
  listInbounds(): Promise<any[]>;
  listClients(): Promise<any[]>;
  clientLinks(email: string): Promise<string[]>;
  addClient(client: unknown, inboundIds: number[]): Promise<void>;
  addInbound(body: unknown): Promise<void>;
  deleteInbound(id: number): Promise<void>;
  panelCert(): Promise<{ certFile: string; keyFile: string }>;
  close?(): Promise<void>;
}

export interface CreateClientInput {
  protocol?: unknown;
  /** 指定挂到哪个已有入站(不传则按协议自动选 / 新建) */
  inbound_id?: unknown;
  /** 客户端名称,作为面板上 client 的 email(同一面板内唯一,重名自动加后缀) */
  name?: unknown;
}

/** 能给客户端用的入站协议(shadowsocks 等密钥格式各异,不自动开) */
export const CLIENT_PROTOCOLS = new Set(['vless', 'hysteria', 'trojan', 'vmess']);

export interface CreatedClient {
  email: string;
  protocol: ClientProtocol;
  inbound: { id: number; remark: string; port: number; created: boolean };
  links: string[];
}

export interface CreateOptions {
  /** 其他面板(新建入站时照它们的同协议入站当模板) */
  otherPanels?: Panel[];
  adminFor?: (panel: Panel) => ClientAdmin;
  /** 新建 vless 入站后探测端口是否在监听 */
  probe?: (host: string, port: number) => Promise<boolean>;
  now?: number;
}

export function protocolOf(value: unknown): ClientProtocol {
  if (value === undefined || value === 'vless') return 'vless';
  if (value === 'hysteria' || value === 'hy2' || value === 'hysteria2') return 'hysteria';
  throw new InputError('协议只能是 vless 或 hy2');
}

/** 客户端名称 → 面板上的 email:去掉空白和 / \ ? # & %,重名加 -2、-3 */
export function emailFor(name: unknown, taken: Set<string>): string {
  const base = String(name ?? '')
    .trim()
    .replace(/[\s/\\?#&%]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!base) throw new InputError('缺少客户端名称');
  let email = base;
  for (let i = 2; taken.has(email); i++) email = `${base}-${i}`;
  return email;
}

export function newClient(email: string, inbound: any) {
  const stream = decodeJson(inbound.streamSettings) ?? {};
  const vision = inbound.protocol === 'vless' && stream.network === 'tcp' && (stream.security === 'reality' || stream.security === 'tls');
  const id = randomUUID();
  return {
    id,
    email,
    password: id,
    auth: randomBytes(12).toString('hex'),
    flow: vision ? 'xtls-rprx-vision' : '',
    limitIp: 0,
    totalGB: 0,
    expiryTime: 0,
    enable: true,
    tgId: 0,
    subId: randomBytes(8).toString('hex'),
    comment: '',
    reset: 0,
  };
}

/** 新入站的端口:20000~59999 里随机挑,避开已有入站和面板自己用的端口 */
export function pickPort(panel: Panel, inbounds: any[]): number {
  const used = new Set([...inbounds.map((ib) => Number(ib.port)), Number(new URL(panel.base_url).port) || 0, 2096, 2053, 443, 80]);
  for (let i = 0; i < 100; i++) {
    const port = 20000 + Math.floor(Math.random() * 40000);
    if (!used.has(port)) return port;
  }
  throw new Error('挑不到空闲端口');
}

export function tcpOpen(host: string, port: number, timeoutMs = 6000): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect({ host, port });
    const done = (ok: boolean) => {
      s.destroy();
      resolve(ok);
    };
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
    s.setTimeout(timeoutMs, () => done(false));
  });
}

const onInbound = (c: any, ib: any) => (c.inboundIds ?? []).map(Number).includes(Number(ib.id));

/** 能复用的入站:启用的、这个协议的;vless 优先 reality,都优先 client 多的 */
function reusable(protocol: ClientProtocol, inbounds: any[], clients: any[]): any | undefined {
  return inbounds
    .filter((ib) => ib.protocol === protocol && ib.enable !== false)
    .map((ib) => ({ ib, clients: clients.filter((c) => onInbound(c, ib)).length }))
    .sort((a, b) => Number(isReality(b.ib)) - Number(isReality(a.ib)) || b.clients - a.clients || Number(a.ib.id) - Number(b.ib.id))[0]?.ib;
}

/** 新入站的名字:<协议>-<序号> */
function remarkFor(protocol: ClientProtocol, inbounds: any[]): string {
  const taken = new Set(inbounds.map((ib) => String(ib.remark ?? '')));
  const base = protocol === 'vless' ? 'vless-reality' : 'hy2';
  let name = base;
  for (let i = 2; taken.has(name); i++) name = `${base}-${i}`;
  return name;
}

/** 新建入站照着谁:其他面板上的同协议入站(换密钥 / 证书),都没有就用内置模板。hy2 要这台面板配了证书 */
async function templateFor(protocol: ClientProtocol, panel: Panel, admin: ClientAdmin, opts: CreateOptions): Promise<{ body: any; from: string }> {
  let cert: { certFile: string; keyFile: string } | null = null;
  if (protocol === 'hysteria') {
    cert = await admin.panelCert();
    if (!cert.certFile || !cert.keyFile) throw new InputError('这台面板没有配置证书,建不了 hy2 入站:先在面板设置(面板设置 → 证书)里填好证书,或用 x-ui 命令申请一张');
  }
  const host = new URL(panel.base_url).hostname;
  for (const other of opts.otherPanels ?? []) {
    if (other.id === panel.id || !opts.adminFor) continue;
    const client = opts.adminFor(other);
    try {
      const ib = (await client.listInbounds()).find(isTemplate(protocol));
      if (!ib) continue;
      const from = `${other.name} 的 ${ib.remark || ib.port}`;
      return protocol === 'vless' ? { body: freshReality(ib), from } : { body: freshHysteria(ib, cert!, host), from };
    } catch {
      // 别的面板读不到就跳过
    } finally {
      await client.close?.().catch(() => {});
    }
  }
  return protocol === 'vless' ? { body: builtinVlessReality(), from: '内置模板' } : { body: builtinHysteria2(cert!, host), from: '内置模板' };
}

async function createInbound(protocol: ClientProtocol, panel: Panel, admin: ClientAdmin, inbounds: any[], opts: CreateOptions): Promise<any> {
  const template = await templateFor(protocol, panel, admin, opts);
  const port = pickPort(panel, inbounds);
  await admin.addInbound(cloneInbound(template.body, port, remarkFor(protocol, inbounds)));
  const created = (await admin.listInbounds()).find((ib) => Number(ib.port) === port && ib.protocol === protocol);
  if (!created) throw new Error('新建入站后读回没找到');
  if (protocol === 'vless' && opts.probe && !(await opts.probe(new URL(panel.base_url).hostname, port))) {
    await admin.deleteInbound(Number(created.id)).catch(() => {});
    throw new Error(`新入站 ${port} 端口连不上,可能被防火墙拦住;已删掉这个入站`);
  }
  return created;
}

/** 选定或新建一个能挂客户端的入站:给了 inbound_id 就用它,否则按协议复用 / 新建(forceNew 时不复用,一定新建)。不关闭 admin */
export async function ensureInbound(
  panel: Panel,
  admin: ClientAdmin,
  choice: { inbound_id?: unknown; protocol?: unknown; forceNew?: boolean },
  opts: CreateOptions = {},
): Promise<{ inbound: any; created: boolean; protocol: string }> {
  const [inbounds, clients] = await Promise.all([admin.listInbounds(), admin.listClients()]);
  if (choice.inbound_id != null && choice.inbound_id !== '') {
    const id = Number(choice.inbound_id);
    const inbound = inbounds.find((ib) => Number(ib.id) === id);
    if (!inbound) throw new InputError('面板上没有这个入站');
    if (!CLIENT_PROTOCOLS.has(String(inbound.protocol))) throw new InputError(`${inbound.protocol} 入站不能挂客户端,选 vless / hy2 / trojan / vmess 的`);
    if (inbound.enable === false) throw new InputError('这个入站已停用');
    return { inbound, created: false, protocol: String(inbound.protocol) };
  }
  const protocol = protocolOf(choice.protocol);
  const existing = choice.forceNew ? undefined : reusable(protocol, inbounds, clients);
  if (existing) return { inbound: existing, created: false, protocol };
  return { inbound: await createInbound(protocol, panel, admin, inbounds, opts), created: true, protocol };
}

/** 在入站上新建一个客户端(email 由名称生成、面板内唯一),读回核对,返回分享链接。不关闭 admin */
export async function addClientTo(admin: ClientAdmin, inbound: any, name: unknown): Promise<{ email: string; links: string[] }> {
  const email = emailFor(name, new Set((await admin.listClients()).map((c) => String(c.email))));
  const inboundId = Number(inbound.id);
  await admin.addClient(newClient(email, inbound), [inboundId]);
  const back = (await admin.listClients()).find((c) => c.email === email);
  if (!back || !(back.inboundIds ?? []).map(Number).includes(inboundId)) throw new Error('client 建好后读回没找到,或没挂到入站上');
  return { email, links: await admin.clientLinks(email) };
}

export async function createClient(panel: Panel, admin: ClientAdmin, input: CreateClientInput, opts: CreateOptions = {}): Promise<CreatedClient> {
  try {
    const { inbound, created, protocol } = await ensureInbound(panel, admin, input, opts);
    const { email, links } = await addClientTo(admin, inbound, input.name);
    return { email, protocol: protocol as ClientProtocol, inbound: { id: Number(inbound.id), remark: String(inbound.remark ?? ''), port: Number(inbound.port), created }, links };
  } finally {
    await admin.close?.().catch(() => {});
  }
}
