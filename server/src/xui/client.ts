// 3x-ui v3 面板 API 客户端。鉴权:Authorization: Bearer <token>。
// undici 直连面板,不读 shell 的代理变量;面板多为自签证书,不校验 TLS。

import { Agent, fetch, type Dispatcher } from 'undici';

export class XUIError extends Error {}

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

  private async req<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const url = `${this.conn.base_url}/panel/api${path}`;
    let res: Awaited<ReturnType<typeof fetch>>;
    try {
      res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.conn.token}`,
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        dispatcher: this.dispatcher,
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 15000),
      });
    } catch (e: any) {
      throw new XUIError(`连接失败:${e?.cause?.message ?? e?.message ?? e}`);
    }
    if (res.status === 401 || res.status === 403) throw new XUIError(`鉴权失败(${res.status}):检查 token / webBasePath`);
    if (res.status === 404) throw new XUIError('404:webBasePath 不对或端点不存在');
    let data: any;
    try {
      data = await res.json();
    } catch {
      throw new XUIError(`非 JSON 响应(${res.status}),可能命中了登录页`);
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

  /** 面板升级信息;面板查 GitHub 失败时返回 null */
  async panelUpdateInfo(): Promise<{ channel: string; current: string; latest: string; available: boolean } | null> {
    try {
      const o = await this.req<any>('GET', '/server/getPanelUpdateInfo');
      if (!o) return null;
      return { channel: String(o.channel ?? ''), current: String(o.currentVersion ?? ''), latest: String(o.latestVersion ?? ''), available: o.updateAvailable === true };
    } catch (e) {
      if (e instanceof XUIError && /success=false/.test(e.message)) return null;
      throw e;
    }
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

  /** 面板设置里面板自己用的证书路径(新建 hy2 入站用这份证书) */
  async panelCert(): Promise<{ certFile: string; keyFile: string }> {
    const s = await this.req<any>('POST', '/setting/all');
    return { certFile: String(s?.webCertFile ?? ''), keyFile: String(s?.webKeyFile ?? '') };
  }
}
