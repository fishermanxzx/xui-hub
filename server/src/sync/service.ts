// 流量同步:定时拉取各面板 client 累计流量,算增量写入账本,并累加到绑定的客户。
// 只读:不对面板做任何修改。

import type { DB } from '../db';
import { getPanel, listPanels, type Panel } from '../panels/repo';
import { XUIClient } from '../xui/client';
import { needsInboundStats, normalizeClients, type ClientSnapshot } from '../xui/normalize';
import { counterDelta, hourStart, type Counter } from './delta';

export interface PanelSyncResult {
  panel_id: number;
  panel: string;
  ok: boolean;
  clients?: number;
  delta_bytes?: number;
  resets?: number;
  error?: string;
}

export interface SyncRun {
  started_at: number;
  finished_at: number;
  results: PanelSyncResult[];
}

export interface ApplyResult {
  clients: number;
  deltaBytes: number;
  resets: number;
}

/** 把一个面板的快照写入数据库(单个事务)。纯数据库操作,便于测试。 */
export function applyPanelSnapshot(db: DB, panel: Panel, clients: ClientSnapshot[], now: number): ApplyResult {
  const prev = new Map<string, Counter>();
  for (const row of db.prepare('SELECT email, up, down FROM client_counters WHERE panel_id = ?').all(panel.id) as any[]) {
    prev.set(row.email, { up: row.up, down: row.down });
  }
  const bound = new Map<string, number>();
  for (const row of db.prepare('SELECT email, customer_id FROM bindings WHERE panel_id = ?').all(panel.id) as any[]) {
    bound.set(row.email, row.customer_id);
  }
  const countNew = panel.last_sync_ok_at != null;
  const hour = hourStart(now);

  const upsertCounter = db.prepare(`
    INSERT INTO client_counters (panel_id, email, up, down, comment, enable, total_bytes, expiry_ms, last_online, updated_at, missing_since)
    VALUES (@panel_id, @email, @up, @down, @comment, @enable, @total_bytes, @expiry_ms, @last_online, @now, NULL)
    ON CONFLICT (panel_id, email) DO UPDATE SET
      up = excluded.up, down = excluded.down, comment = excluded.comment, enable = excluded.enable, total_bytes = excluded.total_bytes,
      expiry_ms = excluded.expiry_ms, last_online = excluded.last_online, updated_at = excluded.updated_at, missing_since = NULL`);
  const insertReset = db.prepare(
    'INSERT INTO counter_resets (panel_id, email, at, prev_up, prev_down, cur_up, cur_down) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  // relay:记下这一小时这台面板是不是中转,以后改类型不影响以前的统计
  const addHourly = db.prepare(`
    INSERT INTO traffic_hourly (hour, panel_id, email, customer_id, up, down, relay) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (hour, panel_id, email, customer_id) DO UPDATE SET up = up + excluded.up, down = down + excluded.down, relay = excluded.relay`);
  const addCustomerUsage = db.prepare('UPDATE customers SET used_up = used_up + ?, used_down = used_down + ? WHERE id = ?');
  const markMissing = db.prepare(
    'UPDATE client_counters SET missing_since = COALESCE(missing_since, ?) WHERE panel_id = ? AND email = ?',
  );
  const markPanel = db.prepare(
    'UPDATE panels SET last_sync_at = ?, last_sync_ok_at = ?, last_sync_error = NULL, client_count = ? WHERE id = ?',
  );

  let deltaBytes = 0;
  let resets = 0;
  db.transaction(() => {
    const present = new Set<string>();
    for (const c of clients) {
      present.add(c.email);
      const before = prev.get(c.email);
      const d = counterDelta(before, c, countNew);
      upsertCounter.run({
        panel_id: panel.id,
        email: c.email,
        up: c.up,
        down: c.down,
        comment: c.comment,
        enable: c.enable ? 1 : 0,
        total_bytes: c.totalBytes,
        expiry_ms: c.expiryMs,
        last_online: c.lastOnline,
        now,
      });
      if (d.reset && before) {
        resets++;
        insertReset.run(panel.id, c.email, now, before.up, before.down, c.up, c.down);
      }
      if (d.up > 0 || d.down > 0) {
        const customerId = bound.get(c.email) ?? 0;
        addHourly.run(hour, panel.id, c.email, customerId, d.up, d.down, panel.role === 'relay' ? 1 : 0);
        if (customerId) addCustomerUsage.run(d.up, d.down, customerId);
        deltaBytes += d.up + d.down;
      }
    }
    for (const email of prev.keys()) {
      if (!present.has(email)) markMissing.run(now, panel.id, email);
    }
    markPanel.run(now, now, clients.length, panel.id);
  })();
  return { clients: clients.length, deltaBytes, resets };
}

async function fetchSnapshot(panel: Panel): Promise<ClientSnapshot[]> {
  const client = new XUIClient(panel);
  try {
    const clients = await client.listClients();
    const inbounds = needsInboundStats(clients) ? await client.listInbounds() : [];
    return normalizeClients(clients, inbounds);
  } finally {
    await client.close().catch(() => {});
  }
}

export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

export class SyncService {
  private timer?: NodeJS.Timeout;
  private running: Promise<SyncRun> | null = null;
  lastRun: SyncRun | null = null;

  constructor(
    private db: DB,
    private opts: {
      intervalSec: number;
      concurrency: number;
      /** 每轮同步写库之后执行(按最新用量停用超额客户的线路等) */
      afterRun?: () => Promise<unknown>;
    },
  ) {}

  start(): void {
    void this.runOnce();
    this.timer = setInterval(() => void this.runOnce(), this.opts.intervalSec * 1000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  get busy(): boolean {
    return this.running != null;
  }

  /** 正在同步时返回同一轮的结果,不重复发起 */
  runOnce(): Promise<SyncRun> {
    if (!this.running) {
      this.running = this.run().finally(() => {
        this.running = null;
      });
    }
    return this.running;
  }

  private async run(): Promise<SyncRun> {
    const startedAt = Date.now();
    const panels = listPanels(this.db).filter((p) => p.enabled);
    const results = await mapLimit(panels, this.opts.concurrency, async (panel): Promise<PanelSyncResult> => {
      try {
        const snapshot = await fetchSnapshot(panel);
        // 拉取期间面板可能被修改或删除,写入前重新读取
        const fresh = getPanel(this.db, panel.id);
        if (!fresh) return { panel_id: panel.id, panel: panel.name, ok: false, error: '面板已删除' };
        const applied = applyPanelSnapshot(this.db, fresh, snapshot, Date.now());
        return { panel_id: panel.id, panel: panel.name, ok: true, clients: applied.clients, delta_bytes: applied.deltaBytes, resets: applied.resets };
      } catch (e: any) {
        const error = e?.message ?? String(e);
        this.db.prepare('UPDATE panels SET last_sync_at = ?, last_sync_error = ? WHERE id = ?').run(Date.now(), error, panel.id);
        return { panel_id: panel.id, panel: panel.name, ok: false, error };
      }
    });
    if (this.opts.afterRun) {
      try {
        await this.opts.afterRun();
      } catch (e) {
        console.error('同步后处理失败:', e);
      }
    }
    this.lastRun = { started_at: startedAt, finished_at: Date.now(), results };
    return this.lastRun;
  }
}
