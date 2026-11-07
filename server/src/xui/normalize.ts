// 把面板返回的 client 列表整理成统一快照。

export interface ClientSnapshot {
  email: string;
  comment: string;
  enable: boolean;
  totalBytes: number;
  expiryMs: number;
  inboundIds: number[];
  up: number;
  down: number;
  lastOnline: number;
}

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

function text(value: unknown): string | null {
  if (value == null) return null;
  const s = String(value).trim();
  return s || null;
}

/** 秒级时间戳统一成毫秒 */
function ms(value: unknown): number {
  const n = num(value);
  return n > 0 && n < 1e12 ? n * 1000 : n;
}

/** v3 的 client 自带 traffic;缺失时需要入站的 clientStats 兜底 */
export function needsInboundStats(clients: any[]): boolean {
  return clients.some((c) => c?.email && (c.traffic == null || typeof c.traffic !== 'object'));
}

/** email -> 流量行。一个 email 在面板上只有一行流量;若重复出现取较大者,不累加 */
function statsByEmail(inbounds: any[]): Map<string, any> {
  const map = new Map<string, any>();
  for (const inbound of inbounds) {
    for (const stat of inbound?.clientStats ?? []) {
      const email = text(stat?.email);
      if (!email) continue;
      const prev = map.get(email);
      if (!prev || num(stat.up) + num(stat.down) > num(prev.up) + num(prev.down)) map.set(email, stat);
    }
  }
  return map;
}

export function normalizeClients(clients: any[], inbounds: any[] = []): ClientSnapshot[] {
  const stats = statsByEmail(inbounds);
  const seen = new Set<string>();
  const out: ClientSnapshot[] = [];
  for (const c of clients) {
    const email = text(c?.email);
    if (!email || seen.has(email)) continue;
    seen.add(email);
    const traffic = c.traffic && typeof c.traffic === 'object' ? c.traffic : stats.get(email) ?? {};
    out.push({
      email,
      comment: String(c.comment ?? ''),
      // 面板因流量用完或到期自动停用时可能只改流量记录上的 enable
      enable: c.enable !== false && c.enable !== 0 && traffic.enable !== false && traffic.enable !== 0,
      totalBytes: num(c.totalGB ?? traffic.total),
      expiryMs: num(c.expiryTime ?? traffic.expiryTime),
      inboundIds: Array.isArray(c.inboundIds) ? c.inboundIds.map(Number).filter(Number.isFinite) : [],
      up: num(traffic.up),
      down: num(traffic.down),
      lastOnline: ms(traffic.lastOnline),
    });
  }
  return out;
}
