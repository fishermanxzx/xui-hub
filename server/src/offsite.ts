// 异地备份:数据库快照 gzip 后上传到 S3 兼容的对象存储(如 Cloudflare R2),对象名 hub-<时间>.db.gz。
// 只上传、不删:远端留多久用存储桶的生命周期规则设置。请求用 AWS Signature V4 签名(路径风格)。

import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { gzipSync } from 'node:zlib';

export interface S3Target {
  /** 如 https://<账号 ID>.r2.cloudflarestorage.com(末尾带 /<桶名> 也行) */
  endpoint: string;
  bucket: string;
  /** R2 用 auto */
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const hmac = (key: string | Buffer, data: string) => createHmac('sha256', key).update(data).digest();

/** PUT 上传一个对象所需的地址和签名请求头 */
export function signedPut(t: S3Target, key: string, body: Buffer, now = new Date()): { url: string; headers: Record<string, string> } {
  const base = new URL(t.endpoint);
  // R2 页面上显示的 S3 API 地址末尾带着桶名(…/<桶名>),照抄过来也能用
  const prefix = base.pathname.replace(/\/+$/, '');
  const path = `${prefix === `/${t.bucket}` ? '' : prefix}/${[t.bucket, ...key.split('/')].map(encodeURIComponent).join('/')}`;
  const amzDate = now.toISOString().replace(/[-:]|\.\d{3}/g, '');
  const day = amzDate.slice(0, 8);
  const payloadHash = sha256(body);
  // 按名称排好序;host 由 fetch 按地址自动带上
  const signed: [string, string][] = [
    ['host', base.host],
    ['x-amz-content-sha256', payloadHash],
    ['x-amz-date', amzDate],
  ];
  const signedNames = signed.map(([k]) => k).join(';');
  const canonical = ['PUT', path, '', ...signed.map(([k, v]) => `${k}:${v}`), '', signedNames, payloadHash].join('\n');
  const scope = `${day}/${t.region}/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
  const signingKey = [t.region, 's3', 'aws4_request'].reduce<Buffer>((k, part) => hmac(k, part), hmac(`AWS4${t.secretAccessKey}`, day));
  return {
    url: `${base.origin}${path}`,
    headers: {
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
      Authorization: `AWS4-HMAC-SHA256 Credential=${t.accessKeyId}/${scope}, SignedHeaders=${signedNames}, Signature=${hmac(signingKey, toSign).toString('hex')}`,
    },
  };
}

/** 把一个数据库快照文件 gzip 后上传,返回对象名 */
export async function uploadBackup(t: S3Target, file: string): Promise<string> {
  const key = `${basename(file)}.gz`;
  const body = gzipSync(readFileSync(file));
  const { url, headers } = signedPut(t, key, body);
  const res = await fetch(url, {
    method: 'PUT',
    headers: { ...headers, 'Content-Type': 'application/gzip' },
    body,
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
  return key;
}
