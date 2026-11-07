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

export const env = {
  host: process.env.HOST?.trim() || '127.0.0.1',
  port: positiveInt('PORT', 8788),
  dataDir: resolve(process.env.DATA_DIR?.trim() || resolve(PROJECT_ROOT, 'data')),
  /** 后台登录密码;监听非本机地址时必填 */
  adminPassword: process.env.ADMIN_PASSWORD ?? '',
  /** 多久自动检查一次各面板连通性(秒) */
  checkIntervalSec: positiveInt('CHECK_INTERVAL_SEC', 300),
  /** HTTPS 证书文件;null = HTTP */
  tls: tlsFiles(),
};
