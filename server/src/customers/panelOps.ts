// 把客户的变化同步到面板上对应的 client:流量清零、启用/停用。
// 到期和额度由本系统管(到期、超额时停用线路),面板上的 client 不设到期日和流量上限;
// 重新启用线路时顺手清掉面板上残留的,免得面板按旧的到期日 / 额度又把它停掉。
// 每个面板先读一遍现状,只改不一致的;改完读回核对,结果逐条线路如实返回。

import type { DB } from '../db';
import { getPanel, type Panel } from '../panels/repo';

/** 用到的面板操作(XUIClient 实现;测试里用假的) */
export interface PanelWriter {
  listClients(): Promise<any[]>;
  exportClients(): Promise<any[]>;
  resetClientTraffic(email: string): Promise<void>;
  updateClient(email: string, client: unknown): Promise<void>;
  close?(): Promise<void>;
}

export interface LineOp {
  resetTraffic?: boolean;
  /** true 时同时清掉面板上的到期日和流量上限 */
  enable?: boolean;
  /** 只清面板上的到期日和流量上限,不动启用状态 */
  clearLimits?: boolean;
}

/**
 * 客户资料改动后要同步到面板的操作,不需要时返回 null:
 * 状态变成正常就启用线路,从正常变成停用/到期/超额就停用。
 * 不正常之间互相变化(如停用→到期)不动,线路本来就该是停用的。
 */
export function lineOpForChange(before: { state: string }, after: { state: string }): LineOp | null {
  if (after.state === before.state || (after.state !== 'active' && before.state !== 'active')) return null;
  return { enable: after.state === 'active' };
}

export type LineAction = '流量清零' | '启用' | '停用' | '去掉面板限制';

export interface LineOpResult {
  panel: string;
  email: string;
  ok: boolean;
  /** 实际做了的修改(已一致的不改) */
  actions: LineAction[];
  error?: string;
}

const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const usedOf = (c: any) => num(c?.traffic?.up) + num(c?.traffic?.down);
// 面板自动停用(流量用完、到期)时可能只改流量记录上的 enable
const enabledOf = (c: any) => c.enable !== false && c.enable !== 0 && c.traffic?.enable !== false && c.traffic?.enable !== 0;
const expiryOf = (c: any) => num(c?.expiryTime ?? c?.traffic?.expiryTime);
const totalOf = (c: any) => num(c?.totalGB ?? c?.traffic?.total);
// 到期为负数是"首次使用后 N 天",也算限制
const limited = (c: any) => expiryOf(c) !== 0 || totalOf(c) > 0;
const errorOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function operateLines(
  db: DB,
  customerId: number,
  op: LineOp,
  clientFor: (panel: Panel) => PanelWriter,
): Promise<LineOpResult[]> {
  const rows = db.prepare('SELECT panel_id, email FROM bindings WHERE customer_id = ? ORDER BY id').all(customerId) as { panel_id: number; email: string }[];
  const byPanel = new Map<number, string[]>();
  for (const r of rows) byPanel.set(r.panel_id, [...(byPanel.get(r.panel_id) ?? []), r.email]);

  const perPanel = await Promise.all(
    [...byPanel].map(async ([panelId, emails]): Promise<LineOpResult[]> => {
      const panel = getPanel(db, panelId);
      const name = panel?.name ?? `#${panelId}`;
      const fail = (error: string) => emails.map((email): LineOpResult => ({ panel: name, email, ok: false, actions: [], error }));
      if (!panel) return fail('面板不存在');
      if (!panel.enabled) return fail('面板已暂停,未处理');
      const client = clientFor(panel);
      try {
        const before = new Map((await client.listClients()).map((c) => [c.email, c]));
        let exported: any[] | null = null;
        const results: LineOpResult[] = [];
        for (const email of emails) {
          const result: LineOpResult = { panel: name, email, ok: false, actions: [] };
          results.push(result);
          try {
            const cur = before.get(email);
            if (!cur) throw new Error('面板上找不到该 client');
            if (op.resetTraffic) {
              await client.resetClientTraffic(email);
              result.actions.push('流量清零');
            }
            const patch: { enable?: boolean; expiryTime?: number; totalGB?: number } = {};
            if (op.enable !== undefined && enabledOf(cur) !== op.enable) patch.enable = op.enable;
            if ((op.enable || op.clearLimits) && limited(cur)) Object.assign(patch, { expiryTime: 0, totalGB: 0 });
            if (Object.keys(patch).length) {
              // 以导出的完整配置为底,只改这几个字段(flow 等保留)
              exported ??= await client.exportClients();
              const item = exported.find((x) => x?.client?.email === email);
              if (!item) throw new Error('面板导出里找不到该 client');
              await client.updateClient(email, { ...item.client, ...patch });
              if (patch.enable !== undefined) result.actions.push(patch.enable ? '启用' : '停用');
              if (patch.expiryTime !== undefined) result.actions.push('去掉面板限制');
            }
            result.ok = true;
          } catch (e) {
            result.error = errorOf(e);
          }
        }
        // 读回核对
        let after: Map<string, any>;
        try {
          after = new Map((await client.listClients()).map((c) => [c.email, c]));
        } catch (e) {
          for (const result of results.filter((r) => r.ok)) result.error = `已执行,读回核对失败:${errorOf(e)}`;
          return results;
        }
        for (const result of results.filter((r) => r.ok)) {
          const c = after.get(result.email);
          const was = usedOf(before.get(result.email));
          let error: string | undefined;
          if (!c) error = '读回时面板上找不到该 client';
          else if (op.resetTraffic && was > 0 && usedOf(c) >= was) error = '面板流量没有清零';
          else if (op.enable !== undefined && enabledOf(c) !== op.enable) error = `面板上仍是${op.enable ? '停用' : '启用'}`;
          else if ((op.enable || op.clearLimits) && limited(c)) error = '面板上的到期日 / 流量上限没有清掉';
          if (error) Object.assign(result, { ok: false, error });
          // 本地也记下启用状态和面板限制,不用等下一轮同步
          if (c && !error) {
            db.prepare('UPDATE client_counters SET enable = ?, expiry_ms = ?, total_bytes = ? WHERE panel_id = ? AND email = ?').run(
              enabledOf(c) ? 1 : 0,
              expiryOf(c),
              totalOf(c),
              panelId,
              result.email,
            );
          }
        }
        return results;
      } catch (e) {
        return fail(errorOf(e));
      } finally {
        await client.close?.();
      }
    }),
  );
  return perPanel.flat();
}

export interface ClientRemover {
  listClients(): Promise<any[]>;
  deleteClient(email: string): Promise<void>;
  close?(): Promise<void>;
}

export interface LineDeleteResult {
  panel: string;
  email: string;
  ok: boolean;
  /** 面板上本来就没有这个 client */
  missing?: boolean;
  error?: string;
}

/** 删除客户前:删掉他在各面板上的 client */
export function deleteLines(db: DB, customerId: number, clientFor: (panel: Panel) => ClientRemover): Promise<LineDeleteResult[]> {
  const rows = db.prepare('SELECT panel_id, email FROM bindings WHERE customer_id = ? ORDER BY id').all(customerId) as { panel_id: number; email: string }[];
  return deleteClients(db, rows, clientFor);
}

/** 删掉面板上的这些 client(整个 client,含所挂的全部入站),删完读回核对;面板上已没有的算成功 */
export async function deleteClients(
  db: DB,
  items: { panel_id: number; email: string }[],
  clientFor: (panel: Panel) => ClientRemover,
): Promise<LineDeleteResult[]> {
  const byPanel = new Map<number, string[]>();
  for (const r of items) byPanel.set(r.panel_id, [...(byPanel.get(r.panel_id) ?? []), r.email]);

  const perPanel = await Promise.all(
    [...byPanel].map(async ([panelId, emails]): Promise<LineDeleteResult[]> => {
      const panel = getPanel(db, panelId);
      const name = panel?.name ?? `#${panelId}`;
      const fail = (error: string) => emails.map((email): LineDeleteResult => ({ panel: name, email, ok: false, error }));
      if (!panel) return fail('面板不存在');
      if (!panel.enabled) return fail('面板已暂停,未处理');
      const client = clientFor(panel);
      try {
        const present = new Set((await client.listClients()).map((c) => c.email));
        const results = emails.map((email): LineDeleteResult =>
          present.has(email) ? { panel: name, email, ok: false } : { panel: name, email, ok: true, missing: true },
        );
        for (const r of results.filter((x) => !x.ok)) {
          try {
            await client.deleteClient(r.email);
          } catch (e) {
            r.error = errorOf(e);
          }
        }
        const left = new Set((await client.listClients()).map((c) => c.email));
        for (const r of results.filter((x) => !x.ok && !x.error)) {
          if (left.has(r.email)) r.error = '删除后面板上还在';
          else r.ok = true;
        }
        return results;
      } catch (e) {
        return fail(errorOf(e));
      } finally {
        await client.close?.();
      }
    }),
  );
  return perPanel.flat();
}
