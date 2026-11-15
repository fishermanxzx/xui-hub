// 开放 API 的令牌:给发卡站、机器人这类程序用,请求头带 Authorization: Bearer <令牌> 就能调 /api。
// 库里只存 SHA-256,明文只在创建时返回一次。令牌不能改设置、备份恢复、管理令牌、更新 xui-hub(见 TOKEN_BLOCKED)。

import { createHash, randomBytes } from 'node:crypto';
import type { DB } from '../db';
import { InputError } from '../panels/repo';

export interface ApiToken {
  id: number;
  name: string;
  /** 明文的末 4 位 */
  hint: string;
  created_at: number;
  last_used_at: number | null;
}

const PREFIX = 'xh_';
const sha = (token: string) => createHash('sha256').update(token).digest('hex');

export function listTokens(db: DB): ApiToken[] {
  return db.prepare('SELECT id, name, hint, created_at, last_used_at FROM api_tokens ORDER BY id').all() as ApiToken[];
}

/** 返回的 token 是明文,只有这一次能拿到 */
export function createToken(db: DB, input: { name?: unknown }, now = Date.now()): ApiToken & { token: string } {
  const name = String(input?.name ?? '').trim();
  if (!name) throw new InputError('给令牌起个名字(用在哪儿的)');
  if (name.length > 64) throw new InputError('名字不能超过 64 个字符');
  if (listTokens(db).length >= 20) throw new InputError('最多 20 个令牌,先删掉不用的');
  const token = PREFIX + randomBytes(32).toString('base64url');
  const hint = token.slice(-4);
  const id = Number(db.prepare('INSERT INTO api_tokens (name, hash, hint, created_at) VALUES (?, ?, ?, ?)').run(name, sha(token), hint, now).lastInsertRowid);
  return { id, name, hint, created_at: now, last_used_at: null, token };
}

export function deleteToken(db: DB, id: number): void {
  if (!db.prepare('DELETE FROM api_tokens WHERE id = ?').run(id).changes) throw new InputError('令牌不存在');
}

/** Authorization 头里的令牌有效就返回它的 id;「上次使用」一分钟最多记一次 */
export function verifyToken(db: DB, header: string | undefined, now = Date.now()): number | undefined {
  const m = /^Bearer\s+(\S+)$/i.exec(header ?? '');
  if (!m || !m[1].startsWith(PREFIX)) return undefined;
  const row = db.prepare('SELECT id, last_used_at FROM api_tokens WHERE hash = ?').get(sha(m[1])) as { id: number; last_used_at: number | null } | undefined;
  if (!row) return undefined;
  if (!row.last_used_at || now - row.last_used_at > 60_000) db.prepare('UPDATE api_tokens SET last_used_at = ? WHERE id = ?').run(now, row.id);
  return row.id;
}

/** 令牌碰不了的接口:设置(里面有 Telegram token)、备份恢复(整库)、令牌管理 */
export const TOKEN_BLOCKED = /^\/(settings|backup|restore|tokens|oauth-grants|system)(\/|$)/;
