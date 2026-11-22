// 3x-ui v3 面板 API 客户端。鉴权:Authorization: Bearer <token>。
// undici 直连面板,不读 shell 的代理变量;面板多为自签证书,不校验 TLS。

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Agent, fetch, type Dispatcher } from 'undici';

export class XUIError extends Error {
  /** 面板回的 HTTP 状态(连不上时没有) */
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

/** 面板 geo 库(Xray 目录里的 .dat):geosite 是域名库,geoip 是 IP 库 */
export type GeoKind = 'site' | 'ip';
export interface GeoFile {
  name: string;
  kind: GeoKind | '';
  size: number;
  /** 毫秒时间戳 */
  modifiedAt: number;
  categories: number;
  /** 解析不了(下载不完整、太大)时的原因 */
  error?: string;
}
export interface GeoCategory {
  code: string;
  entries: number;
  /** geosite 分类里带的属性,如 ads、cn、!cn;规则里写 geosite:分类@属性 */
  attributes: string[];
}
export interface GeoEntry {
  /** domain / full / keyword / regexp;IP 库是 cidr */
  kind: string;
  value: string;
}
export interface GeoPage<T> {
  total: number;
  items: T[];
}
/** 规则里一个写法在面板 geo 库里对不上的原因 */
export interface GeoIssue {
  token: string;
  reason: 'syntax' | 'fileMissing' | 'categoryMissing' | 'attributeMissing' | 'wrongKind' | string;
  file?: string;
  code?: string;
}

export interface XUIConnection {
  name: string;
  base_url: string;
  token: string;
}

export class XUIClient {
  private dispatcher: Dispatcher;

  constructor(
    private conn: XUIConnection,
    private opts: { timeoutMs?: number } = {},
  ) {
    this.dispatcher = new Agent({ connect: { rejectUnauthorized: false } });
  }

  close(): Promise<void> {
    return this.dispatcher.close();
  }

  /** body 是 URLSearchParams 时按表单提交(/xray/update 只认表单),其余按 JSON */
  private async req<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const url = `${this.conn.base_url}/panel/api${path}`;
    const form = body instanceof URLSearchParams;
    let res: Awaited<ReturnType<typeof fetch>>;
    try {
      res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.conn.token}`,
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': form ? 'application/x-www-form-urlencoded' : 'application/json' }),
        },
        body: body === undefined ? undefined : form ? body.toString() : JSON.stringify(body),
        dispatcher: this.dispatcher,
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 15000),
      });
    } catch (e: any) {
      throw new XUIError(`连接失败:${e?.cause?.message ?? e?.message ?? e}`);
    }
    if (res.status === 401 || res.status === 403) throw new XUIError(`鉴权失败(${res.status}):检查 token / webBasePath`, res.status);
    if (res.status === 404) throw new XUIError('404:webBasePath 不对或端点不存在', 404);
    let data: any;
    try {
      data = await res.json();
    } catch {
      throw new XUIError(`非 JSON 响应(${res.status}),可能命中了登录页`, res.status);
    }
    if (data && typeof data === 'object' && 'success' in data) {
      if (!data.success) throw new XUIError(data.msg || 'API 返回 success=false');
      return data.obj as T;
    }
    return data as T;
  }

  async listInbounds(): Promise<any[]> {
    return (await this.req<any[]>('GET', '/inbounds/list')) ?? [];
  }

  async listClients(): Promise<any[]> {
    return (await this.req<any[]>('GET', '/clients/list')) ?? [];
  }

  /** 该 client 在其所属各入站的分享链接(vless:// hysteria2:// ...),地址按面板的分享设置生成 */
  async clientLinks(email: string): Promise<string[]> {
    return (await this.req<string[]>('GET', `/clients/links/${encodeURIComponent(email)}`)) ?? [];
  }

  /** 新建 client 并挂到这些入站上 */
  async addClient(client: unknown, inboundIds: number[]): Promise<void> {
    await this.req('POST', '/clients/add', { client, inboundIds });
  }

  /** 批量启用 / 停用 client(面板会重载 Xray) */
  async setClientsEnabled(emails: string[], enable: boolean): Promise<void> {
    if (!emails.length) return;
    await this.req('POST', enable ? '/clients/bulkEnable' : '/clients/bulkDisable', { emails });
  }

  /** 把 client 的上下行流量清零 */
  async resetClientTraffic(email: string): Promise<void> {
    await this.req('POST', `/clients/resetTraffic/${encodeURIComponent(email)}`);
  }

  /** 删除 client(连同它挂的全部入站) */
  async deleteClient(email: string): Promise<void> {
    await this.req('POST', `/clients/del/${encodeURIComponent(email)}`);
  }

  /** 新建入站;body 是 /inbounds/list 里入站的字段(settings 等为 JSON 字符串) */
  async addInbound(body: unknown): Promise<void> {
    await this.req('POST', '/inbounds/add', body);
  }

  /** 删除入站(新建入站后核对失败时回滚用) */
  async deleteInbound(id: number): Promise<void> {
    await this.req('POST', `/inbounds/del/${id}`);
  }

  /** 面板地址的 IP:地址本身是 IP 就是它,域名就解析(优先 IPv4);解析不出来返回 null */
  hostIp(timeoutMs = 5000): Promise<string | null> {
    return resolveHostIp(new URL(this.conn.base_url).hostname, timeoutMs);
  }

  /** 面板版本、Xray 内核版本与运行状态(/server/status 的一小部分) */
  async serverStatus(): Promise<{ panelVersion: string; xrayVersion: string; xrayState: string; xrayError: string }> {
    const s = await this.req<any>('GET', '/server/status');
    return {
      panelVersion: String(s?.panelVersion ?? ''),
      xrayVersion: String(s?.xray?.version ?? ''),
      xrayState: String(s?.xray?.state ?? ''),
      xrayError: String(s?.xray?.errorMsg ?? ''),
    };
  }

  /** 可切换的 Xray 版本(面板从 GitHub 取并缓存),新的在前 */
  async xrayVersions(): Promise<string[]> {
    return ((await this.req<string[]>('GET', '/server/getXrayVersion')) ?? []).map(String);
  }

  /** 面板升级信息;拿不到(面板查 GitHub 失败、旧版面板没有这个接口)返回 null,不影响看当前版本 */
  async panelUpdateInfo(): Promise<{ channel: string; current: string; latest: string; available: boolean } | null> {
    const o = await this.req<any>('GET', '/server/getPanelUpdateInfo').catch(() => null);
    if (!o) return null;
    return { channel: String(o.channel ?? ''), current: String(o.currentVersion ?? ''), latest: String(o.latestVersion ?? ''), available: o.updateAvailable === true };
  }

  /** 切换 Xray 内核版本(面板下载并重启 Xray) */
  async installXray(version: string): Promise<void> {
    await this.req('POST', `/server/installXray/${encodeURIComponent(version)}`);
  }

  /** 让面板升级自己(后台异步跑 update.sh),返回 runId;用 updateStatus 查结果 */
  async updatePanel(): Promise<string> {
    const o = await this.req<any>('POST', '/server/updatePanel');
    return String(o?.runId ?? '');
  }

  /** 面板升级进度:state 为 pending / success / failed */
  async updateStatus(): Promise<{ runId: string; state: string; exitCode: number }> {
    const o = await this.req<any>('GET', '/server/getUpdateStatus');
    return { runId: String(o?.runId ?? ''), state: String(o?.state ?? 'pending'), exitCode: Number(o?.exitCode ?? 0) };
  }

  /** 读取 Xray 模板(接口是 POST,但只读);返回 { xraySetting: <JSON 字符串>, outboundTestUrl, ... } */
  xraySettings(): Promise<unknown> {
    return this.req('POST', '/xray/');
  }

  /** 覆盖 Xray 模板(出站、路由);需重启 Xray 才生效 */
  async updateXray(xray: unknown, testUrl: string): Promise<void> {
    await this.req('POST', '/xray/update', new URLSearchParams({ xraySetting: JSON.stringify(xray), outboundTestUrl: testUrl }));
  }

  /** 重启 Xray 并等它恢复运行(最多约 30 秒);没恢复就抛错 */
  async restartXray(): Promise<void> {
    try {
      await this.req('POST', '/server/restartXrayService');
    } catch {
      // 有的版本重启时接口本身会断开,以下面查到的状态为准
    }
    let state = '';
    for (let i = 0; i < 20 && state !== 'running'; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      state = (await this.req<any>('GET', '/server/status').catch(() => null))?.xray?.state ?? '';
    }
    if (state !== 'running') throw new XUIError(`Xray 没有恢复运行(${state || '读不到状态'}),看面板日志`);
  }

  /** 重启面板(3x-ui 自己的网页服务)并等它重新应答(最多约 40 秒);没回来就抛错 */
  async restartPanel(): Promise<void> {
    await this.req('POST', '/setting/restartPanel');
    // 面板回完这个请求过两三秒才真的重启,先等它停下再开始探
    await new Promise((r) => setTimeout(r, 4000));
    for (let i = 0; i < 24; i++) {
      if (await this.req('GET', '/server/status').then(() => true, () => false)) return;
      await new Promise((r) => setTimeout(r, 1500));
    }
    throw new XUIError('面板重启后没有恢复应答,去服务器上看一下(x-ui status)');
  }

  // ---- geo 库(3x-ui 3.7.0 起有;更老的面板这几个接口是 404) ----

  /** 面板 Xray 目录里的 geo 库:geosite.dat、geoip.dat 和别的 .dat */
  async geodataFiles(): Promise<GeoFile[]> {
    return (await this.req<GeoFile[]>('GET', '/xray/geodata/files')) ?? [];
  }

  /** 一个库的全部分类 */
  async geodataCategories(file: string): Promise<GeoCategory[]> {
    return (await this.req<GeoPage<GeoCategory>>('GET', `/xray/geodata/categories?${new URLSearchParams({ file })}`))?.items ?? [];
  }

  /** 一个分类里的条目(域名 / 网段),分页;q 按值过滤 */
  async geodataEntries(file: string, code: string, q: string, offset: number, limit: number): Promise<GeoPage<GeoEntry>> {
    const qs = new URLSearchParams({ file, code, q, offset: String(offset), limit: String(limit) });
    return (await this.req<GeoPage<GeoEntry>>('GET', `/xray/geodata/entries?${qs}`)) ?? { total: 0, items: [] };
  }

  /** 让面板按它的 geo 库核对规则里的写法,返回对不上的;普通域名 / 网段不查 */
  async geodataValidate(kind: GeoKind, tokens: string[]): Promise<GeoIssue[]> {
    return (await this.req<GeoIssue[]>('POST', '/xray/geodata/validate', new URLSearchParams({ kind, tokens: tokens.join(',') }))) ?? [];
  }

  /** 面板设置里面板自己用的证书路径(新建 hy2 入站用这份证书) */
  async panelCert(): Promise<{ certFile: string; keyFile: string }> {
    const s = await this.req<any>('POST', '/setting/all');
    return { certFile: String(s?.webCertFile ?? ''), keyFile: String(s?.webKeyFile ?? '') };
  }
}

/** 主机名 → IP:本身是 IP(含 [IPv6])直接返回;域名用系统解析,多个地址时优先 IPv4,超时或失败返回 null */
export async function resolveHostIp(hostname: string, timeoutMs = 5000): Promise<string | null> {
  const host = hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) return host;
  let timer: NodeJS.Timeout | undefined;
  try {
    const all = await Promise.race([
      lookup(host, { all: true }),
      new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error('timeout')), timeoutMs))),
    ]);
    return (all.find((a) => a.family === 4) ?? all[0])?.address ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
