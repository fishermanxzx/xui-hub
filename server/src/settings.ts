// 后台里改的设置(通知渠道、提醒项、备份),存在 meta 表的 settings 键里,一份 JSON。

import { getMeta, setMeta, type DB } from './db';
import { InputError } from './panels/repo';

export interface Settings {
  telegram: { token: string; chat_id: string };
  webhook: { url: string };
  notify: {
    /** 面板连不上 / 恢复 */
    panel_down: boolean;
    /** 客户超额 / 到期被停用、恢复 */
    customer_disabled: boolean;
    /** 客户快到期(提前几天) */
    expiring: boolean;
    expiring_days: number;
    /** 流量用到额度的百分之几 */
    quota_warn: boolean;
    quota_warn_pct: number;
    /** 按月清零完成 */
    monthly_reset: boolean;
  };
  backup: {
    /** 每天把数据库备份发到 Telegram */
    daily: boolean;
  };
}

export const DEFAULT_SETTINGS: Settings = {
  telegram: { token: '', chat_id: '' },
  webhook: { url: '' },
  notify: { panel_down: true, customer_disabled: true, expiring: true, expiring_days: 3, quota_warn: true, quota_warn_pct: 90, monthly_reset: true },
  backup: { daily: false },
};

export function getSettings(db: DB): Settings {
  const raw = getMeta(db, 'settings');
  if (!raw) return structuredClone(DEFAULT_SETTINGS);
  const s = JSON.parse(raw) as Partial<Settings>;
  return {
    telegram: { ...DEFAULT_SETTINGS.telegram, ...s.telegram },
    webhook: { ...DEFAULT_SETTINGS.webhook, ...s.webhook },
    notify: { ...DEFAULT_SETTINGS.notify, ...s.notify },
    backup: { ...DEFAULT_SETTINGS.backup, ...s.backup },
  };
}

const str = (v: unknown, max: number, label: string) => {
  const s = String(v ?? '').trim();
  if (s.length > max) throw new InputError(`${label}太长`);
  return s;
};
const bool = (v: unknown, fallback: boolean) => (v === undefined ? fallback : v === true || v === 1 || v === '1' || v === 'true');
const int = (v: unknown, fallback: number, min: number, max: number, label: string) => {
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new InputError(`${label}只能是 ${min} 到 ${max} 的整数`);
  return n;
};

/** 没传的字段保持原值 */
export function updateSettings(db: DB, input: any): Settings {
  const cur = getSettings(db);
  const tg = input?.telegram ?? {};
  const wh = input?.webhook ?? {};
  const n = input?.notify ?? {};
  const b = input?.backup ?? {};
  const next: Settings = {
    telegram: {
      token: tg.token === undefined ? cur.telegram.token : str(tg.token, 200, 'Bot token'),
      chat_id: tg.chat_id === undefined ? cur.telegram.chat_id : str(tg.chat_id, 64, 'Chat ID'),
    },
    webhook: { url: wh.url === undefined ? cur.webhook.url : str(wh.url, 500, 'Webhook 地址') },
    notify: {
      panel_down: bool(n.panel_down, cur.notify.panel_down),
      customer_disabled: bool(n.customer_disabled, cur.notify.customer_disabled),
      expiring: bool(n.expiring, cur.notify.expiring),
      expiring_days: int(n.expiring_days, cur.notify.expiring_days, 1, 30, '提前天数'),
      quota_warn: bool(n.quota_warn, cur.notify.quota_warn),
      quota_warn_pct: int(n.quota_warn_pct, cur.notify.quota_warn_pct, 50, 99, '流量百分比'),
      monthly_reset: bool(n.monthly_reset, cur.notify.monthly_reset),
    },
    backup: { daily: bool(b.daily, cur.backup.daily) },
  };
  if (next.telegram.token && !/^\d+:[\w-]{20,}$/.test(next.telegram.token)) throw new InputError('Bot token 格式不对,应形如 123456:ABC-DEF…');
  if (next.webhook.url && !/^https?:\/\//.test(next.webhook.url)) throw new InputError('Webhook 地址要以 http:// 或 https:// 开头');
  setMeta(db, 'settings', JSON.stringify(next));
  return next;
}
