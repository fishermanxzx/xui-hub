// 每轮同步后执行:
// - 客户不是"正常"(停用、到期、超额)但还有启用着的线路时,到面板上停用;
// - 正常客户的线路上被设了到期日 / 流量上限时清掉(到期和额度只由本系统管,免得面板按自己的限制停用)。
// 只停不启:恢复启用只发生在后台操作让客户回到正常时(改状态、延期、加额度、已用清零)。
// 面板上已经找不到的线路、暂停的面板不处理。

import type { DB } from '../db';
import type { Panel } from '../panels/repo';
import { operateLines, type LineOp, type LineOpResult, type PanelWriter } from './panelOps';
import { getCustomer, type CustomerState } from './repo';

const STATE_LABEL: Record<CustomerState, string> = { active: '正常', disabled: '停用', expired: '到期', over_quota: '超额' };

export interface EnforceResult {
  customer: string;
  state: CustomerState;
  lines: LineOpResult[];
}

export async function enforceCustomers(
  db: DB,
  clientFor: (panel: Panel) => PanelWriter,
  now = Date.now(),
  log: (line: string) => void = console.log,
): Promise<EnforceResult[]> {
  const candidates = (condition: string) =>
    (
      db
        .prepare(
          `SELECT DISTINCT b.customer_id AS id FROM bindings b
           JOIN client_counters c ON c.panel_id = b.panel_id AND c.email = b.email
           JOIN panels p ON p.id = b.panel_id
           WHERE p.enabled = 1 AND c.missing_since IS NULL AND ${condition}`,
        )
        .all() as { id: number }[]
    ).map((r) => r.id);
  const out: EnforceResult[] = [];
  const run = async (id: number, wantActive: boolean, op: LineOp, tag: string) => {
    const customer = getCustomer(db, id, now);
    if (!customer || (customer.state === 'active') !== wantActive) return;
    const lines = await operateLines(db, id, op, clientFor);
    out.push({ customer: customer.name, state: customer.state, lines });
    for (const l of lines.filter((l) => l.actions.length || l.error)) {
      log(`${tag} 客户「${customer.name}」${STATE_LABEL[customer.state]}:${l.panel} · ${l.email} ${l.error ? '失败:' + l.error : l.actions.join('、')}`);
    }
  };
  for (const id of candidates('c.enable = 1')) await run(id, false, { enable: false }, '[自动停用]');
  for (const id of candidates('(c.expiry_ms != 0 OR c.total_bytes > 0)')) await run(id, true, { clearLimits: true }, '[去掉面板限制]');
  return out;
}
