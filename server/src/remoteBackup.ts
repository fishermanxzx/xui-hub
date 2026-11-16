// 异地备份:把数据库 gzip 后传到 S3 兼容的对象存储(Cloudflare R2、MinIO、各家云的 OSS)。
// 用官方 @aws-sdk/client-s3;每天一次由主循环调 dailyRemoteBackup,后台也能手动「现在备份」、看列表、从远端恢复。
// 保留策略:上传完把前缀下超过 keep_days 的旧备份删掉(只删本程序命名的文件,且总留最新 3 份)。

import { DeleteObjectsCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { gunzipSync, gzipSync } from 'node:zlib';
import { backupBuffer, backupName } from './backup';
import { getMeta, setMeta, type DB } from './db';
import { InputError } from './panels/repo';
import type { Settings } from './settings';

export type RemoteConfig = Settings['backup']['remote'];

/** 四项都填了才算配置好 */
export const remoteEnabled = (c: RemoteConfig): boolean => !!(c.endpoint && c.bucket && c.access_key && c.secret_key);

/** 只认自己命名的文件,免得删到桶里别的东西 */
const NAME_RE = /xui-hub-(\d{8})-(\d{4})\.db\.gz$/;
const KEEP_AT_LEAST = 3;

export interface RemoteFile {
  key: string;
  size: number;
  at: number;
}

export interface RemoteResult {
  key: string;
  size: number;
  /** 这次清掉的旧备份数 */
  deleted: number;
}

export interface RemoteStatus {
  at: number;
  ok: boolean;
  key?: string;
  size?: number;
  error?: string;
}

/** SDK 客户端里我们用到的那一点 */
export interface S3Like {
  send(cmd: unknown): Promise<any>;
}

export function s3ClientFor(c: RemoteConfig): S3Like {
  // R2 要 region=auto;MinIO 这类按路径寻址的服务要 forcePathStyle
  return new S3Client({
    endpoint: c.endpoint,
    region: c.region || 'auto',
    credentials: { accessKeyId: c.access_key, secretAccessKey: c.secret_key },
    forcePathStyle: true,
    requestHandler: { requestTimeout: 120_000 },
  });
}

/** 前缀规范化:去掉开头的 /,非空就以 / 结尾 */
export function prefixOf(c: RemoteConfig): string {
  const p = c.prefix.replace(/^\/+/, '').replace(/\/+$/, '');
  return p ? `${p}/` : '';
}

export async function listRemote(c: RemoteConfig, client: S3Like = s3ClientFor(c)): Promise<RemoteFile[]> {
  const prefix = prefixOf(c);
  const out: RemoteFile[] = [];
  let token: string | undefined;
  do {
    const res = await client.send(new ListObjectsV2Command({ Bucket: c.bucket, Prefix: prefix, ContinuationToken: token }));
    for (const o of res.Contents ?? []) {
      if (!o.Key || !NAME_RE.test(o.Key)) continue;
      out.push({ key: o.Key, size: o.Size ?? 0, at: o.LastModified ? new Date(o.LastModified).getTime() : 0 });
    }
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  // 按文件名里的时间倒序(比 LastModified 稳,时区无关)
  return out.sort((a, b) => (b.key.match(NAME_RE)![1] + b.key.match(NAME_RE)![2]).localeCompare(a.key.match(NAME_RE)![1] + a.key.match(NAME_RE)![2]));
}

/** 文件名里的时间(本地时间)→ 毫秒;解析不了返回 0 */
function stampOf(key: string): number {
  const m = key.match(NAME_RE);
  if (!m) return 0;
  const [, d, t] = m;
  return new Date(Number(d.slice(0, 4)), Number(d.slice(4, 6)) - 1, Number(d.slice(6, 8)), Number(t.slice(0, 2)), Number(t.slice(2, 4))).getTime();
}

/** 删掉超过 keep_days 的旧备份;keep_days 为 0 不删;总留最新 KEEP_AT_LEAST 份 */
export async function pruneRemote(c: RemoteConfig, now: number, client: S3Like = s3ClientFor(c)): Promise<number> {
  if (!c.keep_days) return 0;
  const files = await listRemote(c, client);
  const cutoff = now - c.keep_days * 86_400_000;
  const old = files.slice(KEEP_AT_LEAST).filter((f) => (stampOf(f.key) || f.at) < cutoff);
  for (let i = 0; i < old.length; i += 1000) {
    await client.send(new DeleteObjectsCommand({ Bucket: c.bucket, Delete: { Objects: old.slice(i, i + 1000).map((f) => ({ Key: f.key })), Quiet: true } }));
  }
  return old.length;
}

export async function uploadBackup(db: DB, c: RemoteConfig, now = Date.now(), client: S3Like = s3ClientFor(c)): Promise<RemoteResult> {
  const body = gzipSync(await backupBuffer(db));
  const key = `${prefixOf(c)}${backupName(now)}.gz`;
  await client.send(new PutObjectCommand({ Bucket: c.bucket, Key: key, Body: body, ContentType: 'application/gzip', ContentLength: body.length }));
  let deleted = 0;
  try {
    deleted = await pruneRemote(c, now, client);
  } catch (e) {
    console.error('清理旧的异地备份失败', e);
  }
  return { key, size: body.length, deleted };
}

/** 从远端取一份备份回来(解压后的 .db 内容) */
export async function downloadBackup(c: RemoteConfig, key: string, client: S3Like = s3ClientFor(c)): Promise<Buffer> {
  if (!key.startsWith(prefixOf(c)) || !NAME_RE.test(key)) throw new InputError('不是本程序的备份文件');
  const res = await client.send(new GetObjectCommand({ Bucket: c.bucket, Key: key }));
  const bytes = await res.Body.transformToByteArray();
  return gunzipSync(Buffer.from(bytes));
}

const STATUS_KEY = 'backup_remote_last';
export const remoteStatus = (db: DB): RemoteStatus | null => {
  const raw = getMeta(db, STATUS_KEY);
  return raw ? (JSON.parse(raw) as RemoteStatus) : null;
};
const setStatus = (db: DB, s: RemoteStatus) => setMeta(db, STATUS_KEY, JSON.stringify(s));

/** 跑一次并记下结果(后台「现在备份」和每日都走这里);失败抛出去由调用方决定怎么报 */
export async function runRemoteBackup(db: DB, c: RemoteConfig, now = Date.now(), client?: S3Like): Promise<RemoteResult> {
  try {
    const r = await uploadBackup(db, c, now, client);
    setStatus(db, { at: now, ok: true, key: r.key, size: r.size });
    return r;
  } catch (e) {
    setStatus(db, { at: now, ok: false, error: errorText(e) });
    throw e;
  }
}

/** SDK 的报错信息通常够用;连不上 / 签名错给出更直白的说法 */
export function errorText(e: unknown): string {
  const err = e as { name?: string; message?: string; $metadata?: { httpStatusCode?: number } };
  const code = err.$metadata?.httpStatusCode;
  if (err.name === 'InvalidAccessKeyId' || err.name === 'SignatureDoesNotMatch' || code === 403) return `鉴权失败(${err.name ?? code}):检查 Access Key / Secret Key 和桶名`;
  if (err.name === 'NoSuchBucket') return `桶不存在:${err.message ?? ''}`.trim();
  return err.message ?? String(e);
}
