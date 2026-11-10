// 后台登录:单一管理员密码,HMAC 签名的会话 cookie。未设置 ADMIN_PASSWORD 时(仅限本机监听)不鉴权。

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { getMeta, setMeta, type DB } from '../db';

export const SESSION_COOKIE = 'xuihub_session';
const SESSION_TTL_MS = 7 * 86_400_000;

function mac(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

/**
 * 会话的签名密钥 = 库里存的随机数 + 管理员密码:改了密码,旧会话全部失效;
 * rotate 换掉随机数,所有设备上的会话一起失效(退出登录时用)。
 */
export function sessionKeys(db: DB, adminPassword: string): { current(): string; rotate(): void } {
  let secret = getMeta(db, 'session_secret') ?? '';
  const rotate = () => {
    secret = randomBytes(32).toString('base64url');
    setMeta(db, 'session_secret', secret);
  };
  if (!secret) rotate();
  return { current: () => mac(secret, `password:${adminPassword}`), rotate };
}

export function signSession(secret: string, now = Date.now()): string {
  const payload = String(now + SESSION_TTL_MS);
  return `${payload}.${mac(secret, payload)}`;
}

export function verifySession(secret: string, token: string | undefined, now = Date.now()): boolean {
  if (!token) return false;
  const dot = token.indexOf('.');
  if (dot <= 0) return false;
  const payload = token.slice(0, dot);
  const expected = Buffer.from(mac(secret, payload));
  const given = Buffer.from(token.slice(dot + 1));
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return false;
  return Number(payload) > now;
}

export function passwordMatches(expected: string, given: unknown): boolean {
  if (typeof given !== 'string') return false;
  const a = createHash('sha256').update(expected).digest();
  const b = createHash('sha256').update(given).digest();
  return timingSafeEqual(a, b);
}

export function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0 || part.slice(0, eq).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      return undefined; // 乱写的 %xx 当作没有 cookie
    }
  }
  return undefined;
}

export function sessionCookie(req: Request, value: string, maxAgeMs: number): string {
  const parts = [`${SESSION_COOKIE}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${Math.floor(maxAgeMs / 1000)}`];
  if (req.secure) parts.push('Secure');
  return parts.join('; ');
}

export const SESSION_MAX_AGE_MS = SESSION_TTL_MS;

/** 登录失败限流:每个 IP 10 分钟内最多 10 次 */
export class LoginLimiter {
  private attempts = new Map<string, { count: number; resetAt: number }>();

  allow(ip: string, now = Date.now()): boolean {
    const entry = this.attempts.get(ip);
    if (!entry || entry.resetAt <= now) return true;
    return entry.count < 10;
  }

  fail(ip: string, now = Date.now()): void {
    // 顺手清掉过期的,表不会越攒越大
    for (const [key, e] of this.attempts) if (e.resetAt <= now) this.attempts.delete(key);
    const entry = this.attempts.get(ip);
    if (entry) entry.count++;
    else this.attempts.set(ip, { count: 1, resetAt: now + 600_000 });
  }

  clear(ip: string): void {
    this.attempts.delete(ip);
  }
}

export function requireAuth(enabled: boolean, key: () => string) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!enabled || verifySession(key(), readCookie(req, SESSION_COOKIE))) return next();
    res.status(401).json({ error: '未登录' });
  };
}
