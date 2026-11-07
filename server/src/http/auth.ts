// 后台登录:单一管理员密码,HMAC 签名的会话 cookie。未设置 ADMIN_PASSWORD 时(仅限本机监听)不鉴权。

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { getMeta, setMeta, type DB } from '../db';

export const SESSION_COOKIE = 'xm2_session';
const SESSION_TTL_MS = 7 * 86_400_000;

export function loadSessionSecret(db: DB): string {
  let secret = getMeta(db, 'session_secret');
  if (!secret) {
    secret = randomBytes(32).toString('base64url');
    setMeta(db, 'session_secret', secret);
  }
  return secret;
}

function mac(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
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
    if (eq > 0 && part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
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
    const entry = this.attempts.get(ip);
    if (!entry || entry.resetAt <= now) this.attempts.set(ip, { count: 1, resetAt: now + 600_000 });
    else entry.count++;
  }

  clear(ip: string): void {
    this.attempts.delete(ip);
  }
}

export function requireAuth(enabled: boolean, secret: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!enabled || verifySession(secret, readCookie(req, SESSION_COOKIE))) return next();
    res.status(401).json({ error: '未登录' });
  };
}
