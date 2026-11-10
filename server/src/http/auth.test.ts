import assert from 'node:assert/strict';
import { test } from 'node:test';
import { memoryDb } from '../testUtil';
import { LoginLimiter, SESSION_COOKIE, passwordMatches, readCookie, sessionCookie, sessionKeys, signSession, verifySession } from './auth';

test('会话签名校验与过期', () => {
  const token = signSession('secret', 1000);
  assert.equal(verifySession('secret', token, 2000), true);
  assert.equal(verifySession('other', token, 2000), false);
  assert.equal(verifySession('secret', token, 1000 + 8 * 86_400_000), false);
  assert.equal(verifySession('secret', token.replace(/^\d+/, '9999999999999'), 2000), false);
  assert.equal(verifySession('secret', undefined), false);
});

test('密码比较', () => {
  assert.equal(passwordMatches('pw', 'pw'), true);
  assert.equal(passwordMatches('pw', 'px'), false);
  assert.equal(passwordMatches('pw', undefined), false);
});

test('登录失败限流', () => {
  const limiter = new LoginLimiter();
  for (let i = 0; i < 10; i++) limiter.fail('ip', 0);
  assert.equal(limiter.allow('ip', 1), false);
  assert.equal(limiter.allow('ip', 700_000), true);
});

test('读 cookie:按名字精确取并解码;没有、乱写的 %xx 都当作没有', () => {
  const read = (cookie?: string) => readCookie({ headers: { cookie } } as any, SESSION_COOKIE);
  assert.equal(read(`a=1; ${SESSION_COOKIE}=123%2Eabc; b=2`), '123.abc');
  assert.equal(read(`${SESSION_COOKIE}=x=y`), 'x=y');
  assert.equal(read(undefined), undefined);
  assert.equal(read('a=1'), undefined);
  assert.equal(read(`${SESSION_COOKIE}=%E0%A4%A`), undefined);
  // 名字只是长得像的不算
  assert.equal(read(`x${SESSION_COOKIE}=1; ${SESSION_COOKIE}2=2`), undefined);
});

test('会话密钥:存在库里重启不变,跟着后台密码变;rotate 之后旧会话全部作废', () => {
  const db = memoryDb();
  const keys = sessionKeys(db, 'pw');
  const key = keys.current();
  assert.equal(sessionKeys(db, 'pw').current(), key);
  assert.notEqual(sessionKeys(db, 'pw2').current(), key);
  assert.notEqual(sessionKeys(memoryDb(), 'pw').current(), key);

  const token = signSession(key, 1000);
  assert.equal(verifySession(keys.current(), token, 2000), true);
  keys.rotate();
  assert.notEqual(keys.current(), key);
  assert.equal(verifySession(keys.current(), token, 2000), false);
  assert.equal(sessionKeys(db, 'pw').current(), keys.current());
  assert.equal(verifySession(keys.current(), signSession(keys.current(), 1000), 2000), true);
});

test('会话 cookie:HttpOnly + SameSite=Strict,HTTPS 下加 Secure,有效期按秒', () => {
  assert.equal(sessionCookie({ secure: false } as any, 'a.b', 1500), `${SESSION_COOKIE}=a.b; Path=/; HttpOnly; SameSite=Strict; Max-Age=1`);
  assert.equal(sessionCookie({ secure: true } as any, 'a b', 60_000), `${SESSION_COOKIE}=a%20b; Path=/; HttpOnly; SameSite=Strict; Max-Age=60; Secure`);
  // 退出登录:清空
  assert.match(sessionCookie({ secure: false } as any, '', 0), /=; Path=\/; .*Max-Age=0$/);
});
