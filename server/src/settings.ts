// 后台里改的设置(通知渠道、提醒项、备份),存在 meta 表的 settings 键里,一份 JSON。

import { getMeta, setMeta, type DB } from './db';
import { InputError } from './panels/repo';

export interface Settings {
  telegram: { token: string; chat_id: string };
  webhook: { url: string };
  /** 飞书(Lark)群机器人:Webhook 地址,开了「签名校验」再填密钥 */
  feishu: { url: string; secret: string };
  notify: {
    /** 面板连不上 / 恢复 */
    panel_down: boolean;
    /** 连续几次检查失败才算连不上(1 = 一失败就发) */
    panel_down_after: number;
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
    /** 订阅疑似被分享:24 小时内从几个以上不同 IP 拉过 */
    sub_share: boolean;
    sub_share_ips: number;
  };
  backup: {
    /** 每天把数据库备份发到 Telegram */
    daily: boolean;
    /** 异地备份:S3 兼容对象存储(Cloudflare R2 等);四项填齐就每天上传一份 */
    remote: {
      endpoint: string;
      region: string;
      bucket: string;
      access_key: string;
      secret_key: string;
      /** 桶内目录,可空 */
      prefix: string;
      /** 远端只留最近几天的,0 = 不清理 */
      keep_days: number;
    };
  };
}

export const DEFAULT_SETTINGS: Settings = {
  telegram: { token: '', chat_id: '' },
  webhook: { url: '' },
  feishu: { url: '', secret: '' },
  notify: { panel_down: true, panel_down_after: 3, customer_disabled: true, expiring: true, expiring_days: 3, quota_warn: true, quota_warn_pct: 90, monthly_reset: true, sub_share: true, sub_share_ips: 5 },
  backup: { daily: false, remote: { endpoint: '', region: 'auto', bucket: '', access_key: '', secret_key: '', prefix: 'xui-hub', keep_days: 30 } },
};

export function getSettings(db: DB): Settings {
  const raw = getMeta(db, 'settings');
  if (!raw) return structuredClone(DEFAULT_SETTINGS);
  const s = JSON.parse(raw) as Partial<Settings>;
  return {
    telegram: { ...DEFAULT_SETTINGS.telegram, ...s.telegram },
    webhook: { ...DEFAULT_SETTINGS.webhook, ...s.webhook },
    feishu: { ...DEFAULT_SETTINGS.feishu, ...s.feishu },
    notify: { ...DEFAULT_SETTINGS.notify, ...s.notify },
    backup: { ...DEFAULT_SETTINGS.backup, ...s.backup, remote: { ...DEFAULT_SETTINGS.backup.remote, ...s.backup?.remote } },
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
  const fs = input?.feishu ?? {};
  const n = input?.notify ?? {};
  const b = input?.backup ?? {};
  const rm = b.remote ?? {};
  const cr = cur.backup.remote;
  const next: Settings = {
    telegram: {
      token: tg.token === undefined ? cur.telegram.token : str(tg.token, 200, 'Bot token'),
      chat_id: tg.chat_id === undefined ? cur.telegram.chat_id : str(tg.chat_id, 64, 'Chat ID'),
    },
    webhook: { url: wh.url === undefined ? cur.webhook.url : str(wh.url, 500, 'Webhook 地址') },
    feishu: {
      url: fs.url === undefined ? cur.feishu.url : str(fs.url, 500, '飞书机器人地址'),
      secret: fs.secret === undefined ? cur.feishu.secret : str(fs.secret, 200, '飞书签名密钥'),
    },
    notify: {
      panel_down: bool(n.panel_down, cur.notify.panel_down),
      panel_down_after: int(n.panel_down_after, cur.notify.panel_down_after, 1, 60, '连续失败次数'),
      customer_disabled: bool(n.customer_disabled, cur.notify.customer_disabled),
      expiring: bool(n.expiring, cur.notify.expiring),
      expiring_days: int(n.expiring_days, cur.notify.expiring_days, 1, 30, '提前天数'),
      quota_warn: bool(n.quota_warn, cur.notify.quota_warn),
      quota_warn_pct: int(n.quota_warn_pct, cur.notify.quota_warn_pct, 50, 99, '流量百分比'),
      monthly_reset: bool(n.monthly_reset, cur.notify.monthly_reset),
      sub_share: bool(n.sub_share, cur.notify.sub_share),
      sub_share_ips: int(n.sub_share_ips, cur.notify.sub_share_ips, 2, 50, 'IP 个数'),
    },
    backup: {
      daily: bool(b.daily, cur.backup.daily),
      remote: {
        endpoint: rm.endpoint === undefined ? cr.endpoint : str(rm.endpoint, 300, 'Endpoint').replace(/\/+$/, ''),
        region: rm.region === undefined ? cr.region : str(rm.region, 64, 'Region') || 'auto',
        bucket: rm.bucket === undefined ? cr.bucket : str(rm.bucket, 128, '桶名'),
        access_key: rm.access_key === undefined ? cr.access_key : str(rm.access_key, 256, 'Access Key'),
        secret_key: rm.secret_key === undefined ? cr.secret_key : str(rm.secret_key, 256, 'Secret Key'),
        prefix: rm.prefix === undefined ? cr.prefix : str(rm.prefix, 200, '目录'),
        keep_days: int(rm.keep_days, cr.keep_days, 0, 3650, '保留天数'),
      },
    },
  };
  if (next.telegram.token && !/^\d+:[\w-]{20,}$/.test(next.telegram.token)) throw new InputError('Bot token 格式不对,应形如 123456:ABC-DEF…');
  if (next.webhook.url && !/^https?:\/\//.test(next.webhook.url)) throw new InputError('Webhook 地址要以 http:// 或 https:// 开头');
  if (next.feishu.url && !/^https:\/\/[^/]+\/open-apis\/bot\/v2\/hook\/[\w-]+$/.test(next.feishu.url)) throw new InputError('飞书机器人地址应形如 https://open.feishu.cn/open-apis/bot/v2/hook/xxxx(群设置 → 群机器人 → 自定义机器人里复制)');
  if (next.backup.remote.endpoint && !/^https?:\/\/[^/]+$/.test(next.backup.remote.endpoint)) throw new InputError('Endpoint 要是 https://主机名 的形式,不带桶名和路径');
  setMeta(db, 'settings', JSON.stringify(next));
  return next;
}
