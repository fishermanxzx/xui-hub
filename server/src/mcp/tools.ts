// MCP 工具:让 AI 客户端管理客户和线路。每个工具对应后台的一个接口,经内部通道调同一套 /api(校验、停用恢复等逻辑完全一致)。
// 不提供改设置、备份恢复、管理令牌、增删面板这些。

/** actor:编码过的「谁、从哪个 IP」(见 oplog/log.ts 的 encodeActor),内部通道带给 /api 记操作日志 */
export type ApiCall = (method: string, path: string, body?: unknown, actor?: string) => Promise<{ status: number; body: any }>;

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

/** YYYY-MM-DD → 那天中午的毫秒(按服务器时区;按月汇总时不会落到隔壁月);不给 = undefined */
function dayAt(value: unknown): number | undefined {
  if (!value) return undefined;
  const [y, m, d] = String(value).split('-').map(Number);
  const at = new Date(y, m - 1, d, 12).getTime();
  if (!Number.isFinite(at) || new Date(at).getMonth() !== m - 1 || new Date(at).getDate() !== d) throw new ToolError('date 要是 YYYY-MM-DD');
  return at;
}
/** 关联的 id:0 = 取消关联(接口里是 null),不给 = 不改 */
const linkArg = (v: unknown) => (v === undefined ? undefined : Number(v) === 0 ? null : v);

/** 给模型看的自己记的收入 / 支出 */
function entryView(e: any) {
  const link = (id: number | null, name: string, deleted: boolean) => (id == null ? undefined : { id, name, deleted: deleted || undefined });
  return {
    id: e.id,
    kind: e.kind,
    amount: e.amount,
    date: iso(e.at),
    category: e.category,
    note: e.note,
    customer: link(e.customer_id, e.customer_name, e.customer_deleted),
    panel: link(e.panel_id, e.panel_name, e.panel_deleted),
    socks: link(e.socks_id, e.socks_name, e.socks_deleted),
  };
}

/** 给模型看的续费 / 收款记录 */
function paymentView(p: any) {
  return {
    id: p.id,
    customer_id: p.customer_id,
    customer_name: p.customer_name,
    customer_deleted: p.customer_deleted || undefined,
    amount: p.amount,
    paid_at: iso(p.paid_at),
    months: p.months,
    days: p.days,
    expire_before: iso(p.expire_before),
    expire_after: iso(p.expire_after),
    note: p.note || undefined,
  };
}

/** 给模型看的客户:字节换成 GB、时间换成 ISO,带上订阅链接;线路只留要紧的字段 */
function customerView(c: any, ctx: ToolContext) {
  return {
    id: c.id,
    name: c.name,
    remark: c.remark,
    state: c.state,
    quota_gb: c.quota_bytes ? +(c.quota_bytes / GB).toFixed(2) : null,
    // 已用 = 计费用量(各线路实际流量 × 所在面板的倍率),额度按它算;actual_used_gb 是实际流量(含删掉的线路结转过来的)
    used_gb: +(c.used / GB).toFixed(2),
    actual_used_gb: +((c.actual_used ?? c.used) / GB).toFixed(2),
    expire_at: iso(c.expire_at),
    reset_day: c.reset_day || null,
    next_reset_at: c.next_reset_at ? new Date(c.next_reset_at).toISOString() : null,
    limit_devices: c.limit_devices || null,
    monthly_fee: c.monthly_fee ?? null,
    // 最近一笔收款(金额大于 0 的)
    last_payment: c.last_payment ? { amount: c.last_payment.amount, paid_at: iso(c.last_payment.paid_at) } : null,
    devices: c.sub_devices,
    sub_template: c.sub_template || 'ACL4SSR_Online_Mini',
    sub_url: c.sub_url || `${ctx.baseUrl}/sub/${c.sub_token}`,
    // 自定义链接:和 sub_url 同一个地址前缀
    custom_sub_urls: (c.sub_links ?? []).map((l: string) => `${c.sub_url ? String(c.sub_url).replace(/\/sub\/[^/]*$/, '') : ctx.baseUrl}${l}`),
    sub_last_fetched_at: iso(c.sub_fetched_at ?? 0),
    // 外部订阅:节点数是上次成功取到的(取不到时照常用这些),error 是上次没取到的原因
    upstreams: (c.upstreams ?? []).map((u: any) => ({
      url: u.url,
      node_name: u.node_name || null,
      nodes: u.nodes,
      // 订阅里的节点名(改名之后的)
      names: (u.names ?? []).slice(0, 30),
      skipped: u.skipped || undefined,
      last_ok_at: iso(u.ok_at),
      error: u.error || null,
    })),
    upstream_mode: c.upstreams?.length ? c.upstream_mode : undefined,
    upstream_userinfo: c.upstreams?.length ? c.upstream_userinfo : undefined,
    lines: (c.lines ?? []).map((l: any) => ({
      id: l.id,
      kind: l.kind,
      panel: l.panel_name,
      panel_id: l.panel_id,
      protocol: l.protocol === 'hysteria' ? 'hy2' : l.protocol,
      email: l.email,
      // 订阅里实际用的节点名:线路自己设的,没设就是面板的;null = 用面板生成的
      node_name: l.node_name || l.panel_node_name || null,
      node_name_from_panel: !l.node_name && !!l.panel_node_name ? true : undefined,
      // 面板上实际的出口(按路由规则顺序,每分钟同步时读):when 为空 = 其余流量
      rules: l.rules?.length ? l.rules : undefined,
      routes: l.routes
        ? l.routes.map((h: any) => ({ when: h.fallback ? 'rest' : h.when, kind: h.to.kind, outbound: h.to.tag, address: h.to.address, socks_id: h.to.socks_id }))
        : null,
      exit: l.kind === 'relay' ? l.exit_label || l.exit_panel_name || l.exit_socks_name : null,
      enabled: l.enable,
      used_gb: +((l.up + l.down) / GB).toFixed(2),
    })),
  };
}

/** quota_gb / expire_at(ISO 或 +N 天)换成接口要的字节和毫秒 */
function customerInput(a: any): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const k of ['name', 'remark', 'reset_day', 'limit_devices', 'monthly_fee', 'sub_template', 'sub_links', 'upstreams', 'upstream_mode', 'upstream_userinfo']) if (a[k] !== undefined) body[k] = a[k];
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
  monthly_fee: { type: ['number', 'null'], minimum: 0, maximum: 100_000_000, description: '月费(每月收这位客户多少钱),只用来记账;null = 清掉(不填)' },
  sub_template: str('Clash 订阅模板:内置模板 id(如 ACL4SSR_Online_Full)或 https 模板地址;空字符串 = 默认'),
  sub_links: {
    type: 'array',
    items: { type: 'string' },
    maxItems: 20,
    description: '自定义订阅链接(整组替换,空数组 = 清空):路径,可带参数,如 /s/zhangsan 或 /getprofile?name=a&token=b;也可以贴完整网址(只取路径和参数)。访问它和访问 sub_url 一样,常用来沿用别的系统发出去的旧链接',
  },
  upstreams: {
    type: 'array',
    items: {
      anyOf: [
        { type: 'string', description: '订阅地址(已有的保留原来的节点名)' },
        {
          type: 'object',
          properties: {
            url: str('订阅地址'),
            node_name: str('节点名:空字符串 = 用对方的;{name} 代表原名、{n} 代表序号(如「美国 {n}」「专线-{name}」);不带这两个就是固定名字,多个节点依次加 2、3', { maxLength: 64 }),
          },
          required: ['url'],
          additionalProperties: false,
        },
      ],
    },
    maxItems: 10,
    description:
      '外部订阅(整组替换,空数组 = 清空):别处的订阅链接(如出口代理商给的),内容可以是节点链接 / base64、Clash 配置或 sing-box 配置。只取那边的节点,分组和规则用本系统的;客户拉自己的订阅时那边的节点也在里面,每种格式都有,取不到时用上次取到的',
  },
  upstream_mode: { type: 'string', enum: ['merge', 'replace', 'own'], description: '外部订阅的用法:merge = 和自己线路的节点一起给(默认);replace = 只给外部订阅的节点;own = 只给自己线路的节点(外部订阅留着先不用,也不取)' },
  upstream_userinfo: { type: 'boolean', description: 'true = 订阅里的流量和到期(subscription-userinfo)用外部订阅给的;false = 用客户在 xui-hub 里的(默认);upstream_mode = own 时不起作用' },
};

export const TOOLS: ToolDef[] = [
  {
    name: 'list_customers',
    title: '客户列表',
    description: '列出全部客户:状态(active 正常 / expired 已到期 / over_quota 已超额)、已用(used_gb 是计费用量 = 各线路实际流量 × 所在面板的流量倍率,actual_used_gb 是实际流量)和总流量、到期时间、月费(monthly_fee,null = 没填)、订阅链接、线路。',
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
    description: '修改客户的名称、备注、额度、到期时间、清零日、设备数上限、订阅模板、自定义订阅链接或外部订阅,只传要改的。改了额度 / 到期会立刻停用或恢复他在面板上的客户端;新填的外部订阅会马上取一次,结果在 upstreams 里。',
    inputSchema: obj({ customer_id: customerId, ...customerFields }, ['customer_id']),
    annotations: { destructiveHint: false, idempotentHint: true },
    run: async (a, ctx) => customerView(await call(ctx, 'PATCH', `/customers/${Number(a.customer_id)}`, customerInput(a)), ctx),
  },
  {
    name: 'refresh_upstreams',
    title: '重新取外部订阅',
    description: '把客户配的外部订阅马上重新取一遍(平时客户拉订阅时自动取,60 秒内不重复取)。返回客户信息,upstreams 里是每个外部订阅的节点数和没取到的原因。',
    inputSchema: obj({ customer_id: customerId }, ['customer_id']),
    annotations: { destructiveHint: false, idempotentHint: true },
    run: async (a, ctx) => customerView(await call(ctx, 'POST', `/customers/${Number(a.customer_id)}/upstreams/refresh`), ctx),
  },
  {
    name: 'renew_customer',
    title: '续费',
    description:
      '给客户续费:在现在的到期日上加 months 个月(日子不变)或 days 天,两个给一个;已到期或没设到期日的从现在起算。每次续费都记一条续费记录;收了钱就填 amount(按月续时通常是月费 × 月数),会记成一笔收款。reset_usage 为 true 时顺带把已用流量清零。',
    inputSchema: obj(
      {
        customer_id: customerId,
        months: int('加几个月', { minimum: 1, maximum: 120 }),
        days: int('加多少天', { minimum: 1, maximum: 3650 }),
        amount: { type: 'number', description: '这次收了多少钱(不填 = 只续期不记钱)' },
        note: str('备注(如付款方式),最多 200 字'),
        reset_usage: { type: 'boolean', description: '是否同时把已用流量清零' },
      },
      ['customer_id'],
    ),
    annotations: { destructiveHint: false },
    run: async (a, ctx) => {
      const r = await call(ctx, 'POST', `/customers/${Number(a.customer_id)}/renew`, { months: a.months, days: a.days, amount: a.amount, note: a.note, reset_usage: a.reset_usage === true });
      return { ...customerView(r, ctx), payment: paymentView(r.payment) };
    },
  },
  ...(['panel', 'socks'] as const).map((kind) => ({
    name: `renew_${kind}`,
    title: kind === 'panel' ? '面板续费' : 'SOCKS 续费',
    description: `${kind === 'panel' ? '面板(服务器)' : 'SOCKS'}续费后用这个记:到期日在现在的到期日上加 months 个月或 days 天(两个给一个;已过期或没填到期日的从现在起算)。付了钱就填 amount,会在账本里记一笔关联它的支出(按月续时通常是月成本 × 月数)。id 从 ${kind === 'panel' ? 'list_panels' : 'list_socks'} 里拿。`,
    inputSchema: obj(
      {
        id: int(kind === 'panel' ? '面板 id' : 'SOCKS id', { minimum: 1 }),
        months: int('加几个月', { minimum: 1, maximum: 120 }),
        days: int('加多少天', { minimum: 1, maximum: 3650 }),
        amount: { type: 'number', exclusiveMinimum: 0, maximum: 100_000_000, description: '这次付了多少钱(不填 = 只顺延到期日,不记账)' },
        note: str('备注,最多 200 字', { maxLength: 200 }),
      },
      ['id'],
    ),
    annotations: { destructiveHint: false },
    run: async (a: Record<string, any>, ctx: ToolContext) => {
      const span = a.months ? `续 ${a.months} 个月` : a.days ? `续 ${a.days} 天` : '';
      const r = await call(ctx, 'POST', `/${kind === 'panel' ? 'panels' : 'socks'}/${Number(a.id)}/renew`, { months: a.months, days: a.days, amount: a.amount, category: kind === 'panel' ? '服务器' : 'SOCKS', note: a.note || span });
      return { name: r.name, expire_before: iso(r.expire_before), expire_after: iso(r.expire_after), expense: r.entry ? entryView(r.entry) : null };
    },
  })),
  {
    name: 'list_payments',
    title: '续费 / 收款记录',
    description: '续费和收款记录(新的在前):amount 是收了多少(null = 只续期没记钱,负数 = 退款),months / days 是这笔续了多久(都是 0 = 只记收款),expire_before / expire_after 是续之前 / 之后的到期时间。给 customer_id 只看这位客户的;days 只看最近多少天的(默认 365)。',
    inputSchema: obj({ customer_id: customerId, days: int('最近多少天', { minimum: 1, maximum: 3650 }) }),
    annotations: { readOnlyHint: true },
    run: async (a, ctx) => {
      const from = Date.now() - (Number(a.days) || 365) * 86_400_000;
      const rows = a.customer_id ? await call(ctx, 'GET', `/customers/${Number(a.customer_id)}/payments`) : await call(ctx, 'GET', `/payments?from=${from}`);
      const list = (rows as any[]).filter((p) => p.paid_at >= from).map(paymentView);
      return { total: Math.round(list.reduce((sum, p) => sum + (p.amount ?? 0), 0) * 100) / 100, payments: list };
    },
  },
  {
    name: 'update_payment',
    title: '改一笔续费 / 收款记录',
    description: '改一笔续费 / 收款记录(id 从 list_payments 里拿):金额、收款日期、备注,只填要改的。只改记录,客户的到期日不会跟着变;续了多久不能改。',
    inputSchema: obj(
      {
        id: int('这笔记录的 id', { minimum: 1 }),
        amount: { type: 'number', minimum: -100_000_000, maximum: 100_000_000, description: '收了多少,负数 = 退款' },
        date: str('收款日期,YYYY-MM-DD(按服务器时区)', { pattern: '^\\d{4}-\\d{2}-\\d{2}$' }),
        note: str('备注,最多 200 字;空字符串 = 清空', { maxLength: 200 }),
      },
      ['id'],
    ),
    annotations: { destructiveHint: false },
    run: async (a, ctx) => paymentView(await call(ctx, 'PATCH', `/payments/${Number(a.id)}`, { amount: a.amount, paid_at: dayAt(a.date), note: a.note })),
  },
  {
    name: 'add_ledger_entry',
    title: '记一笔收入 / 支出',
    description:
      '在账本里自己记一笔收入或支出:如买服务器、域名、SOCKS 的支出,续费以外的收入。客户续费不要用这个,用 renew_customer(续费时填 amount)。kind = income(收入)或 expense(支出),amount 总是正数;date 是哪天(YYYY-MM-DD,不填 = 今天);category 是类别(如「服务器」「域名」)。可以关联一块面板(panel_id)或一个 SOCKS(socks_id),二选一;收入还可以关联客户(customer_id)。都可以不填。',
    inputSchema: obj(
      {
        kind: { type: 'string', enum: ['income', 'expense'], description: 'income = 收入,expense = 支出' },
        amount: { type: 'number', exclusiveMinimum: 0, maximum: 100_000_000, description: '金额,正数(支出也填正数)' },
        date: str('哪天,YYYY-MM-DD(按服务器时区);不填 = 今天', { pattern: '^\\d{4}-\\d{2}-\\d{2}$' }),
        category: str('类别,如「服务器」「域名」,最多 20 字', { maxLength: 20 }),
        note: str('备注,最多 200 字', { maxLength: 200 }),
        panel_id: int('关联的面板 id(list_panels 里的),和 socks_id 二选一;不填 = 不关联', { minimum: 1 }),
        socks_id: int('关联的 SOCKS id(list_socks 里的),和 panel_id 二选一;不填 = 不关联', { minimum: 1 }),
        customer_id: int('关联的客户 id,只有收入能填;不填 = 不关联', { minimum: 1 }),
      },
      ['kind', 'amount'],
    ),
    annotations: { destructiveHint: false },
    run: async (a, ctx) => entryView(await call(ctx, 'POST', '/ledger', { kind: a.kind, amount: a.amount, at: dayAt(a.date), category: a.category, note: a.note, panel_id: a.panel_id, socks_id: a.socks_id, customer_id: a.customer_id })),
  },
  {
    name: 'update_ledger_entry',
    title: '改一笔收入 / 支出',
    description:
      '改账本里自己记的一笔收入 / 支出(id 从 list_ledger_entries 里拿),只填要改的,没填的不变。改成支出时关联的客户会去掉;关联面板时原来关联的 SOCKS 会去掉(反过来也一样)。panel_id / socks_id / customer_id 填 0 = 取消关联。',
    inputSchema: obj(
      {
        id: int('这笔记录的 id', { minimum: 1 }),
        kind: { type: 'string', enum: ['income', 'expense'], description: 'income = 收入,expense = 支出' },
        amount: { type: 'number', exclusiveMinimum: 0, maximum: 100_000_000, description: '金额,正数(支出也填正数)' },
        date: str('哪天,YYYY-MM-DD(按服务器时区)', { pattern: '^\\d{4}-\\d{2}-\\d{2}$' }),
        category: str('类别,最多 20 字;空字符串 = 清空', { maxLength: 20 }),
        note: str('备注,最多 200 字;空字符串 = 清空', { maxLength: 200 }),
        panel_id: int('关联的面板 id;0 = 取消关联', { minimum: 0 }),
        socks_id: int('关联的 SOCKS id;0 = 取消关联', { minimum: 0 }),
        customer_id: int('关联的客户 id(只有收入能关联);0 = 取消关联', { minimum: 0 }),
      },
      ['id'],
    ),
    annotations: { destructiveHint: false },
    run: async (a, ctx) =>
      entryView(
        await call(ctx, 'PATCH', `/ledger/${Number(a.id)}`, {
          kind: a.kind,
          amount: a.amount,
          at: dayAt(a.date),
          category: a.category,
          note: a.note,
          panel_id: linkArg(a.panel_id),
          socks_id: linkArg(a.socks_id),
          customer_id: linkArg(a.customer_id),
        }),
      ),
  },
  {
    name: 'list_ledger_entries',
    title: '自己记的收入 / 支出',
    description: '账本里自己记的收入 / 支出(不含客户的续费 / 收款,那些用 list_payments),新的在前;days 只看最近多少天的(默认 365),customer_id 只看关联了这位客户的。返回收入合计、支出合计和每一笔(关联了面板 / SOCKS / 客户的带上它)。',
    inputSchema: obj({ days: int('最近多少天', { minimum: 1, maximum: 3650 }), customer_id: int('只看关联了这位客户的', { minimum: 1 }) }),
    annotations: { readOnlyHint: true },
    run: async (a, ctx) => {
      const from = Date.now() - (Number(a.days) || 365) * 86_400_000;
      const list = (await call(ctx, 'GET', `/ledger?from=${from}${a.customer_id ? `&customer_id=${Number(a.customer_id)}` : ''}`)) as any[];
      const sum = (kind: string) => list.filter((e) => e.kind === kind).reduce((n, e) => n + Math.round(e.amount * 100), 0) / 100;
      return { income: sum('income'), expense: sum('expense'), entries: list.map(entryView) };
    },
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
    name: 'adjust_customer_usage',
    title: '调整本期已用',
    description: '给客户本期已用加上或减去一些流量(直接加减计费用量 used_gb,不乘面板倍率),比如迁移时把旧系统里的本期用量搬过来、或者纠错。只记在 xui-hub 里,不改面板上的计数;清零时一起清。正数加、负数减,调完不能小于 0。执行前向用户确认数量。',
    inputSchema: obj(
      {
        customer_id: customerId,
        down_gb: { type: 'number', description: '下行加多少 GB(负数 = 减)' },
        up_gb: { type: 'number', description: '上行加多少 GB(负数 = 减),可不填' },
      },
      ['customer_id'],
    ),
    annotations: { destructiveHint: false },
    run: async (a, ctx) => {
      const bytes = (v: unknown) => (v === undefined ? 0 : Math.round(Number(v) * GB));
      const r = await call(ctx, 'POST', `/customers/${Number(a.customer_id)}/adjust-usage`, { up: bytes(a.up_gb), down: bytes(a.down_gb) });
      return { customer: customerView(r, ctx), ops: r.ops };
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
        node_name: str('自定义节点名:客户拉订阅时看到的名字;不传就跟着面板的节点名(面板也没设就用面板生成的)', { maxLength: 64 }),
      },
      ['customer_id', 'panel_id'],
    ),
    annotations: { destructiveHint: false, openWorldHint: true },
    run: async (a, ctx) => {
      const body: any = { panel_id: a.panel_id, inbound: a.inbound_id ? { id: a.inbound_id } : { protocol: a.protocol ?? 'vless' } };
      if (a.exit_socks_id) body.exit = { kind: 'socks', socks_id: a.exit_socks_id };
      if (a.node_name !== undefined) body.node_name = a.node_name;
      const r = await call(ctx, 'POST', `/customers/${Number(a.customer_id)}/lines`, body);
      return { line_id: r.line.id, panel: r.line.panel_name, protocol: r.line.protocol === 'hysteria' ? 'hy2' : r.line.protocol, email: r.line.email, node_name: r.line.node_name || null, exit: r.line.exit_label || null, links: r.links, created: r.created };
    },
  },
  {
    name: 'rename_line',
    title: '改节点名',
    description: '改一条线路的自定义节点名(客户拉订阅时看到的名字),空字符串 = 恢复用面板生成的名字。只改 xui-hub 里的记录,面板上不动,下次拉订阅生效。',
    inputSchema: obj({ customer_id: customerId, line_id: int('线路 id', { minimum: 1 }), node_name: str('新的节点名,最多 64 个字符;空字符串 = 跟着面板的节点名(面板也没设就用面板生成的)', { maxLength: 64 }) }, ['customer_id', 'line_id', 'node_name']),
    annotations: { destructiveHint: false, idempotentHint: true },
    run: async (a, ctx) => {
      const l = await call(ctx, 'PATCH', `/customers/${Number(a.customer_id)}/lines/${Number(a.line_id)}`, { node_name: a.node_name });
      return { line_id: l.id, node_name: l.node_name || null };
    },
  },
  {
    name: 'set_line_rules',
    title: '设置线路的出口规则',
    description:
      '给一条线路配「条件 → 出口」的规则(整组替换,空数组 = 去掉),写到它所在面板的 Xray 路由并重启 Xray(这块面板上的客户端会断几秒)。没命中规则的流量照旧走线路原来的出口。面板上手配的规则不动。',
    inputSchema: obj(
      {
        customer_id: customerId,
        line_id: int('线路 id', { minimum: 1 }),
        rules: {
          type: 'array',
          maxItems: 20,
          items: {
            type: 'object',
            properties: {
              domain: { type: 'array', items: { type: 'string' }, description: '域名:example.com、geosite:netflix、domain: / full: / keyword: / regexp: 开头的写法' },
              ip: { type: 'array', items: { type: 'string' }, description: 'IP、网段或 geoip:国家代码' },
              port: str('端口,如 443、1000-2000、80,443'),
              network: { type: 'string', enum: ['tcp', 'udp', 'tcp,udp'] },
              to: {
                type: 'object',
                description: '出口:{kind:"socks",socks_id}(SOCKS 页登记的)、{kind:"direct"}(直出)、{kind:"block"}(拦截)',
                properties: { kind: { type: 'string', enum: ['socks', 'direct', 'block'] }, socks_id: { type: 'integer' } },
                required: ['kind'],
              },
            },
            required: ['to'],
            additionalProperties: false,
          },
        },
      },
      ['customer_id', 'line_id', 'rules'],
    ),
    annotations: { destructiveHint: false, idempotentHint: true },
    run: async (a, ctx) => {
      const l = await call(ctx, 'PUT', `/customers/${Number(a.customer_id)}/lines/${Number(a.line_id)}/rules`, { rules: a.rules });
      return { line_id: l.id, rules: l.rules, routes: l.routes };
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
    name: 'change_line_exit',
    title: '线路换出口',
    description:
      '给线路原地换出口:换成 SOCKS 页登记的代理(socks_id),或者直出(direct 为 true,从线路所在的面板出去)。不删线路、UUID 不变,客户不用更新订阅。' +
      'line_ids 不给 = 这位客户的全部线路。同一块面板上的线路一起改,每块面板重启一次 Xray,上面所有客户端会断几秒(已经是这个出口的不动)。' +
      '线路上带条件的出口规则不变。哪块面板没成,只有那块上的线路不改,failed 里带原因。执行前向用户确认要换哪些线路、换成哪个出口,并说明会断几秒。',
    inputSchema: obj(
      {
        customer_id: customerId,
        line_ids: { type: 'array', items: { type: 'integer', minimum: 1 }, minItems: 1, maxItems: 1000, description: '要换的线路 id(都得是这位客户的);不给 = 他的全部线路' },
        socks_id: int('换成这个 SOCKS(list_socks 返回的 id)', { minimum: 1 }),
        direct: { type: 'boolean', description: 'true = 换成直出' },
      },
      ['customer_id'],
    ),
    annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: true },
    run: async (a, ctx) => {
      if ((a.direct === true) === (a.socks_id != null)) throw new ToolError('socks_id 和 direct 要给一个');
      const exit = a.direct === true ? { kind: 'direct' } : { kind: 'socks', socks_id: a.socks_id };
      const r = await call(ctx, 'POST', '/lines/batch-exit', { customer_id: Number(a.customer_id), ...(a.line_ids ? { line_ids: a.line_ids } : {}), exit });
      return { changed: r.lines.map((l: any) => ({ line_id: l.id, panel: l.panel_name, email: l.email, exit: l.exit_label || '直出' })), failed: r.failed };
    },
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
    description: '列出接入的 3x-ui 面板:id、名称、IP、是否连得上、版本、入站和客户端数量、标签、流量倍率(traffic_ratio:这块面板上线路的计费用量 = 实际流量 × 它,默认 1;改倍率在后台面板页)、月成本和到期时间。开线路前用它拿 panel_id。',
    inputSchema: obj({}),
    annotations: { readOnlyHint: true },
    run: async (_a, ctx) =>
      (await call(ctx, 'GET', '/panels')).map((p: any) => ({
        id: p.id,
        name: p.name,
        ip: p.ip ?? null,
        ok: !p.check_error,
        error: p.check_error || null,
        checked_at: iso(p.checked_at ?? 0),
        panel_version: p.panel_version ?? null,
        xray_version: p.xray_version ?? null,
        xray_state: p.xray_state ?? null,
        inbounds: p.inbound_count ?? null,
        clients: p.client_count ?? null,
        monthly_cost: p.monthly_cost ?? null,
        // 这块面板上没单独设节点名的线路在订阅里用的名字;null = 用面板生成的
        node_name: p.node_name || null,
        tags: p.tags?.length ? p.tags : undefined,
        // 流量倍率:这块面板上线路的计费用量 = 实际流量 × 它(默认 1)
        traffic_ratio: p.traffic_ratio ?? 1,
        expire_at: iso(p.expire_at ?? 0),
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
    description: '列出登记的 SOCKS5 代理(开线路时可选作出口):id、名称、地址、最近一次连通性测试的出口 IP 和地区、月成本(monthly_cost)和到期时间(expire_at,毫秒,0 = 不限期)。不含密码。',
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
  '常见流程:list_panels 看有哪些面板 → create_customer → open_line → 把返回的 sub_url 发给客户。续费用 renew_customer(收了钱填 amount,会记成一笔收款),查收款用 list_payments;续费以外的收入 / 支出(如买服务器,可以关联面板 / SOCKS / 客户)用 add_ledger_entry 记、list_ledger_entries 查;记错了用 update_ledger_entry / update_payment 改;面板 / SOCKS 续了费用 renew_panel / renew_socks 顺延到期日并记支出。删除类操作(delete_customer、delete_line、reset_subscription_link)和换出口(change_line_exit,会重启面板的 Xray)执行前先向用户确认。';
