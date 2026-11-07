import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LoginLimiter, passwordMatches, signSession, verifySession } from './auth';

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
