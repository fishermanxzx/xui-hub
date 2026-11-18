// MCP 工具:让 AI 客户端管理客户和线路。每个工具对应后台的一个接口,经内部通道调同一套 /api(校验、停用恢复等逻辑完全一致)。
// 不提供改设置、备份恢复、管理令牌、增删面板这些。

export type ApiCall = (method: string, path: string, body?: unknown) => Promise<{ status: number; body: any }>;

export interface ToolContext {
  api: ApiCall;
  /** 这次请求看到的后台地址(https://host[:port]),拼订阅链接用 */
  baseUrl: string;
}

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
  run(args: any, ctx: ToolContext): Promise<unknown>;
}

export class ToolError extends Error {}

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const int = (description: string, extra: Record<string, unknown> = {}) => ({ type: 'integer', description, ...extra });
const str = (description: string, extra: Record<string, unknown> = {}) => ({ type: 'string', description, ...extra });
const customerId = int('客户 id(list_customers 返回的 id)', { minimum: 1 });

const GB = 1024 ** 3;
const iso = (ms: number) => (ms ? new Date(ms).toISOString() : null);

/** 接口报错就把原因抛给模型 */
async function call(ctx: ToolContext, method: string, path: string, body?: unknown): Promise<any> {
  const res = await ctx.api(method, path, body);
  if (res.status >= 400) throw new ToolError(res.body?.error || `接口返回 ${res.status}`);
  return res.body;
}

/** 给模型看的客户:字节换成 GB、时间换成 ISO,带上订阅链接;线路只留要紧的字段 */
function customerView(c: any, ctx: ToolContext) {
  return {
    id: c.id,
    name: c.name,
    remark: c.remark,
    state: c.state,
    quota_gb: c.quota_bytes ? +(c.quota_bytes / GB).toFixed(2) : null,
    used_gb: +(c.used / GB).toFixed(2),
    expire_at: iso(c.expire_at),
    reset_day: c.reset_day || null,
    next_reset_at: c.next_reset_at ? new Date(c.next_reset_at).toISOString() : null,
    limit_devices: c.limit_devices || null,
    devices: c.sub_devices,
    sub_template: c.sub_template || 'ACL4SSR_Online_Mini',
    sub_url: c.sub_url || `${ctx.baseUrl}/sub/${c.sub_token}`,
    sub_last_fetched_at: iso(c.sub_fetched_at ?? 0),
    lines: (c.lines ?? []).map((l: any) => ({
      id: l.id,
      kind: l.kind,
      panel: l.panel_name,
      panel_id: l.panel_id,
      protocol: l.protocol === 'hysteria' ? 'hy2' : l.protocol,
      email: l.email,
      exit: l.kind === 'relay' ? l.exit_label || l.exit_panel_name || l.exit_socks_name : null,
      enabled: l.enable,
      used_gb: +((l.up + l.down) / GB).toFixed(2),
    })),
  };
}

/** quota_gb / expire_at(ISO 或 +N 天)换成接口要的字节和毫秒 */
function customerInput(a: any): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const k of ['name', 'remark', 'reset_day', 'limit_devices', 'sub_template']) if (a[k] !== undefined) body[k] = a[k];
  if (a.quota_gb !== undefined) body.quota_bytes = Math.round(Number(a.quota_gb) * GB);
  if (a.expire_at !== undefined) {
    if (a.expire_at === '' || a.expire_at === null) body.expire_at = 0;
    else {
      const ms = Date.parse(String(a.expire_at));
      if (!Number.isFinite(ms)) throw new ToolError('expire_at 要是 ISO 日期,如 2026-12-31 或 2026-12-31T00:00:00+08:00');
      body.expire_at = ms;
    }
  }
  if (a.expire_in_days !== undefined) body.expire_at = Date.now() + Number(a.expire_in_days) * 86_400_000;
  return body;
}

const customerFields = {
  name: str('客户名称,也用来生成面板上客户端的名字'),
  remark: str('备注'),
  quota_gb: { type: 'number', description: '总流量额度(GB),0 = 不限', minimum: 0 },
  expire_at: str('到期时间,ISO 日期(如 2026-12-31);空字符串 = 不限期'),
  expire_in_days: int('从现在起多少天后到期(和 expire_at 二选一)', { minimum: 1, maximum: 3650 }),
  reset_day: int('按月重置流量:0 = 不重置;1-28 = 开启。客户有到期时间时重置日跟着到期日走(每月到期日那天),这个数只在没有到期时间时当「每月几号」用', { minimum: 0, maximum: 28 }),
  limit_devices: int('能拉订阅的设备数上限,0 = 不限', { minimum: 0, maximum: 100 }),
  sub_template: str('Clash 订阅模板:内置模板 id(如 ACL4SSR_Online_Full)或 https 模板地址;空字符串 = 默认'),
};

export const TOOLS: ToolDef[] = [
  {
    name: 'list_customers',
    title: '客户列表',
    description: '列出全部客户:状态(active 正常 / expired 已到期 / over_quota 已超额)、已用和总流量、到期时间、订阅链接、线路。',
    inputSchema: obj({}),
    annotations: { readOnlyHint: true },
    run: async (_a, ctx) => (await call(ctx, 'GET', '/customers')).map((c: any) => customerView(c, ctx)),
  },
  {
    name: 'create_customer',
    title: '新建客户',
    description: '新建一位客户(还没有线路,之后用 open_line 给他开)。返回客户信息和订阅链接。',
    inputSchema: obj(customerFields, ['name']),
    annotations: { destructiveHint: false },
    run: async (a, ctx) => customerView(await call(ctx, 'POST', '/customers', customerInput(a)), ctx),
  },
  {
    name: 'update_customer',
    title: '修改客户',
    description: '修改客户的名称、备注、额度、到期时间、清零日、设备数上限或订阅模板,只传要改的。改了额度 / 到期会立刻停用或恢复他在面板上的客户端。',
    inputSchema: obj({ customer_id: customerId, ...customerFields }, ['customer_id']),
    annotations: { destructiveHint: false, idempotentHint: true },
    run: async (a, ctx) => customerView(await call(ctx, 'PATCH', `/customers/${Number(a.customer_id)}`, customerInput(a)), ctx),
  },
  {
    name: 'renew_customer',
    title: '续期',
    description: '给客户续期:在现在的到期日上加 days 天(已到期或没设到期日的从现在起算)。reset_usage 为 true 时顺带把已用流量清零。',
    inputSchema: obj({ customer_id: customerId, days: int('加多少天', { minimum: 1, maximum: 3650 }), reset_usage: { type: 'boolean', description: '是否同时把已用流量清零' } }, ['customer_id', 'days']),
    annotations: { destructiveHint: false },
    run: async (a, ctx) => customerView(await call(ctx, 'POST', `/customers/${Number(a.customer_id)}/renew`, { days: a.days, reset_usage: a.reset_usage === true }), ctx),
  },
  {
    name: 'reset_customer_usage',
    title: '清零流量',
    description: '把客户各线路在面板上的已用流量清零,因超额被停用的随之恢复。',
    inputSchema: obj({ customer_id: customerId }, ['customer_id']),
    annotations: { destructiveHint: true },
    run: async (a, ctx) => {
      const r = await call(ctx, 'POST', `/customers/${Number(a.customer_id)}/reset-usage`);
      return { customer: customerView(r, ctx), failed: r.failed };
    },
  },
  {
    name: 'reset_subscription_link',
    title: '重置订阅链接',
    description: '给客户换一条新的订阅链接,旧链接立即失效(怀疑订阅被分享时用)。返回新链接。',
    inputSchema: obj({ customer_id: customerId }, ['customer_id']),
    annotations: { destructiveHint: true },
    run: async (a, ctx) => customerView(await call(ctx, 'POST', `/customers/${Number(a.customer_id)}/sub-token`), ctx),
  },
  {
    name: 'delete_customer',
    title: '删除客户',
    description: '删除客户,连同他在各面板上的全部客户端。不可恢复,执行前向用户确认。',
    inputSchema: obj({ customer_id: customerId }, ['customer_id']),
    annotations: { destructiveHint: true },
    run: async (a, ctx) => ({ deleted: true, ...(await call(ctx, 'DELETE', `/customers/${Number(a.customer_id)}`)) }),
  },
  {
    name: 'list_devices',
    title: '客户的设备',
    description: '列出拉过这位客户订阅的设备(客户端 UA、最近的来源 IP、首次和最近拉取时间),以及最近的拉取记录。用来判断订阅有没有被分享。',
    inputSchema: obj({ customer_id: customerId }, ['customer_id']),
    annotations: { readOnlyHint: true },
    run: async (a, ctx) => {
      const id = Number(a.customer_id);
      const [devices, fetches] = await Promise.all([call(ctx, 'GET', `/customers/${id}/devices`), call(ctx, 'GET', `/customers/${id}/sub-fetches`)]);
      return {
        devices: devices.map((d: any) => ({ id: d.id, client: d.ua, ip: d.ip, first_at: iso(d.first_at), last_at: iso(d.last_at) })),
        recent_fetches: fetches.rows.slice(0, 50).map((f: any) => ({ at: iso(f.at), client: f.ua, ip: f.ip, format: f.target, status: f.status })),
      };
    },
  },
  {
    name: 'remove_device',
    title: '移除设备',
    description: '移除客户的一台设备,让出设备名额。那台设备下次更新订阅会重新占名额,名额满了就拉不到。',
    inputSchema: obj({ customer_id: customerId, device_id: int('设备 id(list_devices 返回的)', { minimum: 1 }) }, ['customer_id', 'device_id']),
    annotations: { destructiveHint: true },
    run: async (a, ctx) => ({ removed: true, ...(await call(ctx, 'DELETE', `/customers/${Number(a.customer_id)}/devices/${Number(a.device_id)}`)) }),
  },
  {
    name: 'open_line',
    title: '开线路',
    description:
      '给客户开一条线路:在 panel_id 这块面板上新建一个客户端,只改这一块面板。默认从这块面板直出;' +
      '给 exit_socks_id(list_socks 返回的,SOCKS 页登记的代理)就让这个客户端的流量从那个代理出去。要从别的机器出,先在那台机器上建 socks 入站并登记到 SOCKS 页。' +
      '入站默认按 protocol 自动选,没有同协议的就新建;也可以用 inbound_id 指定。返回线路和分享链接。',
    inputSchema: obj(
      {
        customer_id: customerId,
        panel_id: int('面板 id(list_panels 返回的)', { minimum: 1 }),
        protocol: { type: 'string', enum: ['vless', 'hy2'], description: '协议,默认 vless(reality)' },
        inbound_id: int('挂到面板上哪个已有入站(不传则按协议自动选或新建)', { minimum: 1 }),
        exit_socks_id: int('出口:SOCKS 代理 id(list_socks 返回的);不传就从这块面板直出', { minimum: 1 }),
      },
      ['customer_id', 'panel_id'],
    ),
    annotations: { destructiveHint: false, openWorldHint: true },
    run: async (a, ctx) => {
      const body: any = { panel_id: a.panel_id, inbound: a.inbound_id ? { id: a.inbound_id } : { protocol: a.protocol ?? 'vless' } };
      if (a.exit_socks_id) body.exit = { kind: 'socks', socks_id: a.exit_socks_id };
      const r = await call(ctx, 'POST', `/customers/${Number(a.customer_id)}/lines`, body);
      return { line_id: r.line.id, panel: r.line.panel_name, protocol: r.line.protocol === 'hysteria' ? 'hy2' : r.line.protocol, email: r.line.email, exit: r.line.exit_label || null, links: r.links, created: r.created };
    },
  },
  {
    name: 'get_line_links',
    title: '线路的分享链接',
    description: '取一条线路的节点分享链接(vless:// / hysteria2:// …)。',
    inputSchema: obj({ customer_id: customerId, line_id: int('线路 id', { minimum: 1 }) }, ['customer_id', 'line_id']),
    annotations: { readOnlyHint: true, openWorldHint: true },
    run: (a, ctx) => call(ctx, 'GET', `/customers/${Number(a.customer_id)}/lines/${Number(a.line_id)}/links`),
  },
  {
    name: 'delete_line',
    title: '删线路',
    description: '删掉客户的一条线路,面板上的客户端和它的出口规则一起删。面板连不上时 force 为 true 只删记录。执行前向用户确认。',
    inputSchema: obj({ customer_id: customerId, line_id: int('线路 id', { minimum: 1 }), force: { type: 'boolean', description: '面板连不上也删掉这条记录' } }, ['customer_id', 'line_id']),
    annotations: { destructiveHint: true, openWorldHint: true },
    run: async (a, ctx) => ({ deleted: true, ...(await call(ctx, 'DELETE', `/customers/${Number(a.customer_id)}/lines/${Number(a.line_id)}${a.force === true ? '?force=1' : ''}`)) }),
  },
  {
    name: 'list_panels',
    title: '面板列表',
    description: '列出接入的 3x-ui 面板:id、名称、是否连得上、版本、入站和客户端数量。开线路前用它拿 panel_id。',
    inputSchema: obj({}),
    annotations: { readOnlyHint: true },
    run: async (_a, ctx) =>
      (await call(ctx, 'GET', '/panels')).map((p: any) => ({
        id: p.id,
        name: p.name,
        ok: !p.check_error,
        error: p.check_error || null,
        checked_at: iso(p.checked_at ?? 0),
        panel_version: p.panel_version ?? null,
        xray_version: p.xray_version ?? null,
        xray_state: p.xray_state ?? null,
        inbounds: p.inbound_count ?? null,
        clients: p.client_count ?? null,
      })),
  },
  {
    name: 'list_panel_inbounds',
    title: '面板上的入站',
    description: '现读一块面板上的入站和各入站上的客户端(属于哪位客户、流量、是否启用)。',
    inputSchema: obj({ panel_id: int('面板 id', { minimum: 1 }) }, ['panel_id']),
    annotations: { readOnlyHint: true, openWorldHint: true },
    run: (a, ctx) => call(ctx, 'GET', `/panels/${Number(a.panel_id)}/inbounds`),
  },
  {
    name: 'list_socks',
    title: 'SOCKS 代理列表',
    description: '列出登记的 SOCKS5 代理(开线路时可选作出口):id、名称、地址、最近一次连通性测试的出口 IP 和地区。不含密码。',
    inputSchema: obj({}),
    annotations: { readOnlyHint: true },
    run: (_a, ctx) => call(ctx, 'GET', '/socks'),
  },
  {
    name: 'sync_now',
    title: '立即同步',
    description: '立刻从全部面板同步流量,并执行额度 / 到期(该停的停、该恢复的恢复)。平时每分钟自动同步一次。',
    inputSchema: obj({}),
    annotations: { destructiveHint: false, openWorldHint: true },
    run: (_a, ctx) => call(ctx, 'POST', '/sync'),
  },
];

/** 跑一个工具;业务上的失败(参数不对、面板连不上)放在结果里(isError),不抛 */
export async function runTool(tool: ToolDef, args: unknown, ctx: ToolContext): Promise<{ content: { type: 'text'; text: string }[]; isError: boolean }> {
  try {
    const out = await tool.run(args && typeof args === 'object' ? args : {}, ctx);
    return { content: [{ type: 'text', text: JSON.stringify(out ?? { ok: true }, null, 1) }], isError: false };
  } catch (e) {
    return { content: [{ type: 'text', text: `失败:${e instanceof Error ? e.message : String(e)}` }], isError: true };
  }
}

export const INSTRUCTIONS =
  'xui-hub 把多台 3x-ui 面板接到一个后台,按「客户」管理线路。一位客户有若干线路(每条是某块面板上的一个客户端)、一个总流量额度、一个到期时间和一条订阅链接。' +
  '常见流程:list_panels 看有哪些面板 → create_customer → open_line → 把返回的 sub_url 发给客户。续费用 renew_customer。删除类操作(delete_customer、delete_line、reset_subscription_link)执行前先向用户确认。';
