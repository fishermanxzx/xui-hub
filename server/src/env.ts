// 运行配置,全部来自环境变量。

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// 项目根 = server/src/../.. = xui-hub/
export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function positiveInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} 必须是正整数`);
  return value;
}

export function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

/** HTTPS 证书:TLS_CERT_FILE / TLS_KEY_FILE 都填才启用,都不填 = 纯 HTTP */
function tlsFiles(): { cert: string; key: string } | null {
  const cert = process.env.TLS_CERT_FILE?.trim() ?? '';
  const key = process.env.TLS_KEY_FILE?.trim() ?? '';
  if (!cert && !key) return null;
  if (!cert || !key) throw new Error('TLS_CERT_FILE 和 TLS_KEY_FILE 要么都填,要么都不填');
  return { cert, key };
}

const internalPort = positiveInt('INTERNAL_PORT', 8789);

export const env = {
  host: process.env.HOST?.trim() || '127.0.0.1',
  port: positiveInt('PORT', 8788),
  dataDir: resolve(process.env.DATA_DIR?.trim() || resolve(PROJECT_ROOT, 'data')),
  /** 后台登录密码;监听非本机地址时必填 */
  adminPassword: process.env.ADMIN_PASSWORD ?? '',
  /** 多久同步一次各面板(连通性、客户端流量)并执行额度 / 到期(秒) */
  checkIntervalSec: positiveInt('CHECK_INTERVAL_SEC', 60),
  /** HTTPS 证书文件;null = HTTP */
  tls: tlsFiles(),
  /** 订阅链接的地址前缀,如 https://sub.example.com;空 = 前端用打开后台的地址拼 */
  subBaseUrl: (process.env.SUB_BASE_URL?.trim() || '').replace(/\/+$/, ''),
  /** Clash 输出套用 Mihomo 基础模板的范围:all / 逗号分隔的客户名(灰度)/ 空 = 关闭 */
  mihomoTemplate: process.env.MIHOMO_TEMPLATE ?? '',
  /** 内部 subconverter 地址(转 Clash / Surge 用);空 = 这两种格式不可用 */
  subconverterUrl: process.env.SUBCONVERTER_URL?.trim() || '',
  /** 内部监听(纯 HTTP,只给 subconverter 回源取节点):默认 127.0.0.1:8789;Docker 里绑 0.0.0.0 让 subconverter 容器能连 */
  internalHost: process.env.INTERNAL_HOST?.trim() || '127.0.0.1',
  internalPort,
  /** subconverter 回源访问本服务取节点的地址(对应上面的内部监听) */
  appInternalUrl: (process.env.APP_INTERNAL_URL?.trim() || `http://127.0.0.1:${internalPort}`).replace(/\/+$/, ''),
  /** 订阅拉取记录保留天数 */
  subLogDays: positiveInt('SUB_LOG_DAYS', 7),
};
