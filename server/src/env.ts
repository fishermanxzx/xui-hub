// 运行配置,全部来自环境变量。

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { S3Target } from './offsite';

// 项目根 = server/src/../.. = xui-hub/
export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function integer(name: string, fallback: number, min = -Infinity): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) throw new Error(`${name} 必须是${min > 0 ? '正' : ''}整数`);
  return value;
}

const positiveInt = (name: string, fallback: number) => integer(name, fallback, 1);

/** 异地备份的对象存储:BACKUP_S3_ENDPOINT / BUCKET / ACCESS_KEY_ID / SECRET_ACCESS_KEY 都填才启用,都不填 = 不启用 */
function s3Target(): S3Target | null {
  const get = (name: string) => process.env[`BACKUP_S3_${name}`]?.trim() ?? '';
  const [endpoint, bucket, accessKeyId, secretAccessKey] = ['ENDPOINT', 'BUCKET', 'ACCESS_KEY_ID', 'SECRET_ACCESS_KEY'].map(get);
  if (!endpoint && !bucket && !accessKeyId && !secretAccessKey) return null;
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
    throw new Error('BACKUP_S3_ENDPOINT、BACKUP_S3_BUCKET、BACKUP_S3_ACCESS_KEY_ID、BACKUP_S3_SECRET_ACCESS_KEY 要么都填,要么都不填');
  }
  if (!/^https?:\/\//.test(endpoint)) throw new Error('BACKUP_S3_ENDPOINT 要是 https:// 开头的地址');
  return { endpoint, bucket, accessKeyId, secretAccessKey, region: get('REGION') || 'auto' };
}

export function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

export const env = {
  host: process.env.HOST?.trim() || '127.0.0.1',
  port: positiveInt('PORT', 8788),
  dataDir: resolve(process.env.DATA_DIR?.trim() || resolve(PROJECT_ROOT, 'data')),
  /** 后台登录密码;监听非本机地址时必填 */
  adminPassword: process.env.ADMIN_PASSWORD ?? '',
  syncIntervalSec: positiveInt('SYNC_INTERVAL_SEC', 60),
  syncConcurrency: positiveInt('SYNC_CONCURRENCY', 8),
  /** 流量历史(每小时流量、计数回退记录)保留天数,更早的每轮同步后删掉 */
  historyDays: positiveInt('HISTORY_DAYS', 60),
  /** 备份保留天数:备份目录(data/backups,每天自动备份一次数据库)和面板配置快照,更早的删掉 */
  backupKeepDays: positiveInt('BACKUP_KEEP_DAYS', 7),
  /** 异地备份(如 Cloudflare R2);null = 不启用 */
  offsite: s3Target(),
  /** 订阅拉取记录保留天数 */
  subLogDays: positiveInt('SUB_LOG_DAYS', 7),
  /** 订阅专用域名(SUB_DOMAINS,逗号分隔):只提供订阅,经 Cloudflare Tunnel 回源 */
  subDomains: (process.env.SUB_DOMAINS ?? '').split(',').map((d) => d.trim().toLowerCase()).filter(Boolean),
  /** 订阅链接的地址前缀,如 https://sub.example.com;空 = 前端用打开后台的地址拼 */
  subBaseUrl: (process.env.SUB_BASE_URL?.trim() || '').replace(/\/+$/, ''),
  /** Clash 输出套用 Mihomo 基础模板的范围:all / 逗号分隔的客户名(灰度)/ 空 = 关闭 */
  mihomoTemplate: process.env.MIHOMO_TEMPLATE ?? '',
  /** 内部 subconverter 地址;空 = 只提供 base64 格式 */
  subconverterUrl: process.env.SUBCONVERTER_URL?.trim() || '',
  /** subconverter 回源访问本服务的地址 */
  appInternalUrl: (process.env.APP_INTERNAL_URL?.trim() || `http://127.0.0.1:${positiveInt('PORT', 8788)}`).replace(/\/+$/, ''),
  /** 按天汇总用量时使用的时区偏移(分钟),默认 UTC+8 */
  tzOffsetMin: integer('TZ_OFFSET_MIN', 480),
};
