// 操作日志的那句话:请求进来时先记下要动的对象(名字、改之前的样子),响应完再对比改之后的,写成「修改客户「张三」:额度 100 GB → 200 GB」。
// 只记改东西的请求(POST / PATCH / PUT / DELETE);查看、检查连通性、测试通知、立即同步这些不记。
// 密码、令牌、密钥、地址里的账号这类东西不写进日志,只写「改了」。

import { getCustomer, getLine, lineByEmail, type CustomerView, type Line } from '../customers/repo';
import { getPayment, type Payment } from '../customers/payments';
import type { DB } from '../db';
import { getPanel, type Panel } from '../panels/repo';
import { getSettings, type Settings } from '../settings';
import { getSocks, type SocksProxy } from '../socks/repo';

export const MUTATING = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

/** 不记的:只是查看 / 检查 / 测试,不改东西 */
const SKIP = new Set([
  'POST /panels/check',
  'POST /panels/:id/check',
  'POST /panels/:id/geodata/validate',
  'POST /customers/:id/upstreams/refresh',
  'POST /socks/:id/check',
  'POST /socks-check-all',
  'POST /settings/test',
  'POST /sync',
]);

/** 请求进来时(处理之前)记下的:路径各段、要动的对象改之前的样子 */
export interface Before {
  segs: string[];
  customer?: CustomerView;
  line?: Line;
  panel?: Panel;
  socks?: SocksProxy;
  payment?: Payment;
  /** 令牌 / MCP 授权的名字 */
  name?: string;
  settings?: Settings;
  lines?: Line[];
}

const GB = 1024 ** 3;
const pad = (n: number) => String(n).padStart(2, '0');
const date = (ms: number) => {
  if (!ms) return '不限期';
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const gb = (n: number) => (n ? `${+(n / GB).toFixed(2)} GB` : '不限');
const money = (n: number | null) => (n == null ? '没填' : String(n));
const onOff = (v: unknown) => (v ? '开' : '关');
const lineName = (l: Line) => `${l.panel_name} · ${l.email}`;
const span = (p: Payment) => (p.months ? `${p.months} 个月` : `${p.days} 天`);
const exitOf = (l: Line) => (l.kind === 'direct' ? '直出' : l.exit_label || '走代理');

function decode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export function snapshot(db: DB, path: string, body: unknown): Before {
  const segs = path.split('/').filter(Boolean).map(decode);
  const id = (i: number) => {
    const n = Number(segs[i]);
    return Number.isInteger(n) && n > 0 ? n : 0;
  };
  const b: Before = { segs };
  switch (segs[0]) {
    case 'customers':
      if (id(1)) b.customer = getCustomer(db, id(1));
      if (segs[2] === 'lines' && id(3)) b.line = getLine(db, id(3));
      break;
    case 'panels':
      if (id(1)) b.panel = getPanel(db, id(1));
      if (b.panel && segs[2] === 'clients' && segs[3]) {
        b.line = lineByEmail(db, b.panel.id, segs[3]);
        if (b.line) b.customer = getCustomer(db, b.line.customer_id);
      }
      break;
    case 'socks':
      if (id(1)) b.socks = getSocks(db, id(1));
      break;
    case 'payments':
      if (id(1)) b.payment = getPayment(db, id(1));
      break;
    case 'tokens':
      if (id(1)) b.name = (db.prepare('SELECT name FROM api_tokens WHERE id = ?').get(id(1)) as { name: string } | undefined)?.name;
      break;
    case 'oauth-grants':
      if (id(1)) b.name = (db.prepare('SELECT client_name FROM oauth_grants WHERE id = ?').get(id(1)) as { client_name: string } | undefined)?.client_name;
      break;
    case 'settings':
      if (segs.length === 1) b.settings = structuredClone(getSettings(db));
      break;
    case 'lines': {
      const { line_ids: ids, customer_id: owner } = (body ?? {}) as { line_ids?: unknown; customer_id?: unknown };
      if ((segs[1] === 'batch-delete' || segs[1] === 'batch-exit') && Array.isArray(ids)) b.lines = ids.slice(0, 1000).flatMap((x) => getLine(db, Number(x)) ?? []);
      else if (segs[1] === 'batch-exit' && owner != null) b.lines = getCustomer(db, Number(owner))?.lines ?? [];
      break;
    }
  }
  return b;
}

function customerDiff(a: CustomerView, b: CustomerView): string[] {
  const out: string[] = [];
  const ch = <T>(label: string, x: T, y: T, fmt: (v: T) => string = String) => {
    if (x !== y) out.push(`${label} ${fmt(x)} → ${fmt(y)}`);
  };
  ch('名字', a.name, b.name);
  if (a.remark !== b.remark) out.push(b.remark ? `备注改成「${b.remark}」` : '清空了备注');
  ch('额度', a.quota_bytes, b.quota_bytes, gb);
  ch('到期', a.expire_at, b.expire_at, date);
  if (!a.reset_day !== !b.reset_day) out.push(`每月重置流量 ${onOff(a.reset_day)} → ${onOff(b.reset_day)}`);
  else if (a.reset_day !== b.reset_day && !b.expire_at) out.push(`每月重置日 ${a.reset_day} 号 → ${b.reset_day} 号`);
  ch('设备数上限', a.limit_devices, b.limit_devices, (n) => (n ? String(n) : '不限'));
  ch('月费', a.monthly_fee, b.monthly_fee, money);
  ch('流量倍率', a.traffic_ratio, b.traffic_ratio, (v) => `×${v}`);
  if (a.sub_template !== b.sub_template) out.push('换了订阅模板');
  if (JSON.stringify(a.sub_links) !== JSON.stringify(b.sub_links)) out.push(`自定义链接 ${a.sub_links.length} → ${b.sub_links.length} 条`);
  const ups = (c: CustomerView) => JSON.stringify(c.upstreams.map((u) => [u.url, u.node_name]));
  if (ups(a) !== ups(b)) out.push(`外部订阅改了(现在 ${b.upstreams.length} 个)`);
  ch('外部订阅', a.upstream_mode, b.upstream_mode, (m) => (m === 'replace' ? '只给外部的' : '和线路的合并'));
  ch('流量和到期用外部的', a.upstream_userinfo, b.upstream_userinfo, onOff);
  return out;
}

function costDiff(a: { name: string; monthly_cost: number | null; expire_at: number }, b: typeof a, out: string[]): string[] {
  if (a.name !== b.name) out.unshift(`名字 ${a.name} → ${b.name}`);
  if (a.monthly_cost !== b.monthly_cost) out.push(`月成本 ${money(a.monthly_cost)} → ${money(b.monthly_cost)}`);
  if (a.expire_at !== b.expire_at) out.push(`到期 ${date(a.expire_at)} → ${date(b.expire_at)}`);
  return out;
}

const panelDiff = (a: Panel, b: Panel) =>
  costDiff(a, b, [
    ...(a.base_url !== b.base_url ? ['地址改了'] : []),
    ...(a.token !== b.token ? ['令牌改了'] : []),
    ...(a.node_name !== b.node_name ? [`节点名 ${a.node_name || '(面板生成的)'} → ${b.node_name || '(面板生成的)'}`] : []),
  ]);

const socksDiff = (a: SocksProxy, b: SocksProxy) =>
  costDiff(a, b, [
    ...(a.host !== b.host || a.port !== b.port ? [`地址 ${a.host}:${a.port} → ${b.host}:${b.port}`] : []),
    ...(a.username !== b.username || a.password !== b.password ? ['账号密码改了'] : []),
    ...(a.remark !== b.remark ? [b.remark ? `备注改成「${b.remark}」` : '清空了备注'] : []),
  ]);

const SETTING_LABELS: Record<string, string> = {
  'telegram.token': 'Telegram 机器人令牌',
  'telegram.chat_id': 'Telegram 会话 ID',
  'webhook.url': 'Webhook 地址',
  'feishu.url': '飞书机器人地址',
  'feishu.secret': '飞书签名密钥',
  'notify.panel_down': '面板连不上的通知',
  'notify.panel_down_after': '连续失败几次算连不上',
  'notify.customer_disabled': '客户停用 / 恢复的通知',
  'notify.expiring': '快到期的通知',
  'notify.expiring_days': '提前几天通知到期',
  'notify.quota_warn': '流量用量通知',
  'notify.quota_warn_pct': '用到百分之几通知',
  'notify.monthly_reset': '按月清零的通知',
  'notify.sub_share': '订阅疑似分享的通知',
  'notify.sub_share_ips': '几个 IP 算分享',
  'backup.daily': '每天备份到 Telegram',
  'backup.remote.endpoint': '异地备份 Endpoint',
  'backup.remote.region': '异地备份 Region',
  'backup.remote.bucket': '异地备份桶名',
  'backup.remote.access_key': '异地备份 Access Key',
  'backup.remote.secret_key': '异地备份 Secret Key',
  'backup.remote.prefix': '异地备份目录',
  'backup.remote.keep_days': '异地备份保留天数',
};

function flatten(v: unknown, prefix = '', out: Record<string, unknown> = {}): Record<string, unknown> {
  if (v && typeof v === 'object' && !Array.isArray(v)) for (const [k, x] of Object.entries(v)) flatten(x, prefix ? `${prefix}.${k}` : k, out);
  else out[prefix] = v;
  return out;
}

/** 设置的改动:开关写开 / 关,数字写前后,文字(地址、令牌、密钥)只写填了 / 改了 / 清空了 */
function settingsDiff(a: Settings, b: Settings): string[] {
  const x = flatten(a);
  const y = flatten(b);
  const out: string[] = [];
  for (const key of new Set([...Object.keys(x), ...Object.keys(y)])) {
    const before = x[key];
    const after = y[key];
    if (JSON.stringify(before) === JSON.stringify(after)) continue;
    const label = SETTING_LABELS[key] ?? key;
    if (typeof after === 'boolean' || typeof before === 'boolean') out.push(`${label} ${onOff(before)} → ${onOff(after)}`);
    else if (typeof after === 'number' && typeof before === 'number') out.push(`${label} ${before} → ${after}`);
    else out.push(`${label}${!before ? '填了' : !after ? '清空了' : '改了'}`);
  }
  return out;
}

/** 请求里要换成的出口 */
function exitTarget(db: DB, exit: any): string {
  if (exit?.kind === 'direct') return '直出';
  const s = getSocks(db, Number(exit?.socks_id));
  return s ? `SOCKS ${s.name}` : `SOCKS #${exit?.socks_id ?? ''}`;
}

export interface Described {
  summary: string;
  customer_id: number | null;
}

/**
 * action 是方法 + 路由(如 PATCH /customers/:id);result 是接口返回的内容(没成时是 { error });ok = 成没成。
 * 返回 null = 不记(查看类的,或者保存了但什么都没改)。
 */
export function describe(db: DB, action: string, b: Before, req: { body?: any; query?: any }, result: any, ok: boolean): Described | null {
  if (SKIP.has(action)) return null;
  const body = req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body) ? req.body : {};
  const c = b.customer;
  const cid = c?.id ?? null;
  const cname = `「${c?.name ?? `#${b.segs[1] ?? ''}`}」`;
  const pname = `「${b.panel?.name ?? `#${b.segs[1] ?? ''}`}」`;
  const S = (summary: string, customer_id: number | null = cid): Described => ({ summary, customer_id });
  const changed = (what: string, diff: string[], customer_id: number | null = cid) => (ok && !diff.length ? null : S(`${what}${diff.length ? `:${diff.join(';')}` : ''}`, customer_id));
  const ofLine = b.line ? ` ${lineName(b.line)} ` : ' ';

  switch (action) {
    // ---------- 客户 ----------
    case 'POST /customers': {
      const parts = [body.quota_bytes ? `额度 ${gb(Number(body.quota_bytes))}` : '', body.expire_at ? `到期 ${date(Number(body.expire_at))}` : '', body.monthly_fee != null && body.monthly_fee !== '' ? `月费 ${body.monthly_fee}` : ''].filter(Boolean);
      return S(`新建客户「${result?.name ?? body.name ?? ''}」${parts.length ? `:${parts.join(';')}` : ''}`, typeof result?.id === 'number' ? result.id : null);
    }
    case 'PATCH /customers/:id': {
      const after = c && getCustomer(db, c.id);
      return changed(`修改客户${cname}`, c && after ? customerDiff(c, after) : []);
    }
    case 'DELETE /customers/:id':
      return S(`删除客户${cname}${c ? `(连同 ${c.lines.length} 条线路)` : ''}`);
    case 'POST /customers/:id/renew': {
      const p: Payment | undefined = result?.payment;
      if (!p) return S(`给${cname}续费`);
      const extra = [p.amount != null ? `收款 ${p.amount}` : '没记钱', p.note ? `备注「${p.note}」` : '', body.reset_usage ? '顺带清零流量' : ''].filter(Boolean);
      return S(`给${cname}续费 ${span(p)}:到期 ${date(p.expire_before)} → ${date(p.expire_after)};${extra.join(';')}`);
    }
    case 'POST /customers/:id/payments': {
      const amount = Number(result?.amount ?? body.amount);
      return S(`给${cname}记一笔${amount < 0 ? '退款' : '收款'} ${Number.isFinite(amount) ? amount : ''}${body.note ? `(${body.note})` : ''}`);
    }
    case 'DELETE /payments/:id': {
      const p = b.payment;
      if (!p) return S('删除一笔续费 / 收款记录', null);
      const what = [p.amount != null ? `金额 ${p.amount}` : '没记钱', p.months || p.days ? `续 ${span(p)}` : '只记收款'];
      return S(`删除「${p.customer_name}」${date(p.paid_at)} 的一笔记录(${what.join(',')};到期日不变)`, p.customer_id);
    }
    case 'POST /customers/:id/reset-usage':
      return S(`清零${cname}的流量${c ? `(清零前已用 ${gb(c.used)})` : ''}`);
    case 'POST /customers/:id/adjust-usage': {
      const n = (Number(body.up) || 0) + (Number(body.down) || 0);
      return S(`调整${cname}本期已用 ${n >= 0 ? '+' : ''}${+(n / GB).toFixed(2)} GB(实际流量)`);
    }
    case 'POST /customers/:id/sub-token':
      return S(`重置${cname}的订阅链接(旧链接失效)`);
    case 'DELETE /customers/:id/devices/:did':
      return S(`移除${cname}的一台订阅设备`);
    case 'POST /customers/:id/lines': {
      const l: Line | undefined = result?.line;
      const panel = l ? null : getPanel(db, Number(body.panel_id));
      return S(`给${cname}开线路:${l ? lineName(l) : `面板「${panel?.name ?? body.panel_id ?? ''}」`}${l?.exit_label ? `(出口 ${l.exit_label})` : ''}`);
    }
    case 'PATCH /customers/:id/lines/:lid': {
      const after = b.line && getLine(db, b.line.id);
      if (ok && b.line && after && b.line.node_name === after.node_name) return null;
      return S(`改${cname}线路${ofLine}的节点名:${b.line?.node_name || '(默认)'} → ${after?.node_name || '(默认)'}`);
    }
    case 'PUT /customers/:id/lines/:lid/rules': {
      const n = Array.isArray(body.rules) ? body.rules.length : 0;
      return S(`改${cname}线路${ofLine}的出口规则(${n ? `${n} 条` : '全部去掉'})`);
    }
    case 'PUT /customers/:id/lines/:lid/exit': {
      const after = b.line && getLine(db, b.line.id);
      if (ok && b.line && after && exitOf(b.line) === exitOf(after)) return null;
      return S(`给${cname}线路${ofLine}换出口:${b.line ? exitOf(b.line) : ''} → ${ok && after ? exitOf(after) : exitTarget(db, body.exit)}`);
    }
    case 'POST /lines/batch-exit': {
      const lines = b.lines ?? [];
      const owners = new Set(lines.map((l) => l.customer_id));
      const done = Array.isArray(result?.changed) ? result.changed.length : 0;
      const failed = Array.isArray(result?.failed) ? result.failed.length : 0;
      const names = lines.slice(0, 5).map((l) => `「${getCustomer(db, l.customer_id)?.name ?? `#${l.customer_id}`}」${lineName(l)}`);
      const counts = ok ? `换好 ${done} 条${failed ? `,${failed} 条没成` : ''}` : `${lines.length} 条`;
      return S(`批量换出口 → ${exitTarget(db, body.exit)}(${counts}):${names.join('、')}${lines.length > 5 ? ' 等' : ''}`, owners.size === 1 ? [...owners][0] : null);
    }
    case 'DELETE /customers/:id/lines/:lid':
      return S(`删除${cname}的线路${b.line ? ` ${lineName(b.line)}` : ''}`);
    case 'POST /lines/batch-delete': {
      const lines = b.lines ?? [];
      const owners = new Set(lines.map((l) => l.customer_id));
      const names = lines.slice(0, 5).map((l) => `「${getCustomer(db, l.customer_id)?.name ?? `#${l.customer_id}`}」${lineName(l)}`);
      return S(`批量删除 ${lines.length} 条线路${body.force === true ? '(连不上的只删记录)' : ''}:${names.join('、')}${lines.length > 5 ? ' 等' : ''}`, owners.size === 1 ? [...owners][0] : null);
    }
    case 'POST /customers/:id/lines/import': {
      const panel = getPanel(db, Number(body.panel_id));
      const n = Array.isArray(result?.lines) ? result.lines.length : 0;
      const failed = Array.isArray(result?.failed) ? result.failed.length : 0;
      return S(`把面板「${panel?.name ?? body.panel_id ?? ''}」上的 ${n} 个客户端归入${cname}${failed ? `(${failed} 个没成)` : ''}`);
    }

    // ---------- 面板 ----------
    case 'POST /panels':
      return S(`新增面板「${result?.name ?? body.name ?? ''}」`, null);
    case 'PATCH /panels/:id': {
      const after = b.panel && getPanel(db, b.panel.id);
      return changed(`修改面板${pname}`, b.panel && after ? panelDiff(b.panel, after) : [], null);
    }
    case 'DELETE /panels/:id':
      return S(`删除面板${pname}${req.query?.force === '1' ? '(连同上面的线路记录)' : ''}`, null);
    case 'POST /panels/:id/xray/:version':
      return S(`给面板${pname}换 Xray ${b.segs[3] ?? ''}`, null);
    case 'POST /panels/:id/line-names':
      return S(`把面板${pname}上 ${typeof result?.changed === 'number' ? result.changed : ''} 条线路的节点名改成跟着面板的「${b.panel?.node_name ?? ''}」`, null);
    case 'POST /panels/:id/restart':
      return S(`重启面板${pname}`, null);
    case 'POST /panels/:id/update':
      return S(`更新面板${pname}的 3x-ui`, null);
    case 'POST /panels/:id/clients':
      return S(`在面板${pname}上新建客户端${body.email ? ` ${body.email}` : ''}`, null);
    case 'DELETE /panels/:id/clients/:email':
      return S(`删除面板${pname}上的客户端 ${b.segs[3] ?? ''}${c ? `(${cname}的线路,记录一起删)` : ''}`);

    // ---------- SOCKS ----------
    case 'POST /socks':
      return S(`新增 SOCKS「${result?.name ?? body.name ?? ''}」`, null);
    case 'PATCH /socks/:id': {
      const after = b.socks && getSocks(db, b.socks.id);
      return changed(`修改 SOCKS「${b.socks?.name ?? b.segs[1]}」`, b.socks && after ? socksDiff(b.socks, after) : [], null);
    }
    case 'DELETE /socks/:id':
      return S(`删除 SOCKS「${b.socks?.name ?? b.segs[1]}」`, null);

    // ---------- 设置 / 令牌 / 备份 / 更新 ----------
    case 'PATCH /settings':
      return changed('修改设置', b.settings ? settingsDiff(b.settings, getSettings(db)) : [], null);
    case 'POST /tokens':
      return S(`新建 API 令牌「${body.name ?? ''}」`, null);
    case 'DELETE /tokens/:id':
      return S(`删除 API 令牌「${b.name ?? b.segs[1]}」`, null);
    case 'DELETE /oauth-grants/:id':
      return S(`撤销 MCP 授权「${b.name ?? b.segs[1]}」`, null);
    case 'POST /restore':
      return S('上传备份文件恢复数据', null);
    case 'POST /backup/remote':
      return S('立即做一次异地备份', null);
    case 'POST /backup/remote/restore':
      return S(`从异地备份 ${body.key ?? ''} 恢复数据`, null);
    case 'POST /system/update':
      return S('更新 xui-hub', null);
    default:
      return S(action, cid);
  }
}
