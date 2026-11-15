import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { compareVersions, createUpdater } from './update';

test('版本比较:只比三段数字;dev 当成最旧', () => {
  assert.ok(compareVersions('0.13.1', '0.13.0') > 0);
  assert.ok(compareVersions('0.9.9', '0.10.0') < 0);
  assert.ok(compareVersions('v1.0.0', '0.99.99') > 0);
  assert.equal(compareVersions('0.13.0', 'v0.13.0'), 0);
  assert.ok(compareVersions('0.1.0', 'dev') > 0);
});

test('版本检查:结果缓存,refresh 才重查;查失败留着上次的结果并给出原因', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'xh-up-'));
  try {
    let calls = 0;
    let answer: string | Error = '0.14.0';
    const up = createUpdater({ version: '0.13.0', dataDir: dir, docker: false, unitPath: join(dir, 'none'), logPath: join(dir, 'log'), fetchLatest: async () => { calls++; if (answer instanceof Error) throw answer; return answer; } });
    const a = await up.info(false, 1000);
    assert.deepEqual([a.current, a.latest, a.update_available, a.method, a.command, a.state, calls], ['0.13.0', '0.14.0', true, 'manual', 'xui-hub update', 'idle', 1]);
    await up.info(false, 2000);
    assert.equal(calls, 1);
    answer = new Error('GitHub 连不上');
    const b = await up.info(true, 3000);
    assert.deepEqual([b.latest, b.update_available, b.error, calls], ['0.14.0', true, 'GitHub 连不上', 2]);
    await assert.rejects(up.start(4000), /没有装自动更新/);
    assert.equal((await createUpdater({ version: '0.14.0', dataDir: dir, docker: true, fetchLatest: async () => '0.14.0' }).info()).method, 'docker');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('后台里更新:放下请求文件;进行中不能再点;脚本失败且版本还落后时报失败并带日志,已是最新不能更新', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'xh-up-'));
  try {
    const unit = join(dir, 'unit');
    const log = join(dir, 'log');
    writeFileSync(unit, '');
    const mk = (version: string) => createUpdater({ version, dataDir: dir, docker: false, unitPath: unit, logPath: log, fetchLatest: async () => '0.14.0' });
    const up = mk('0.13.0');
    assert.equal((await up.info()).method, 'auto');
    await up.start();
    assert.ok(existsSync(join(dir, 'update-request')));
    assert.equal((await up.info()).state, 'running');
    await assert.rejects(up.start(), /已经在更新/);
    // root 的更新服务接手:删请求文件、写日志;没写完(没有 exit 行)算进行中
    rmSync(join(dir, 'update-request'));
    writeFileSync(log, '\x1b[0;32m下载 xui-hub v0.14.0\x1b[0m\n');
    assert.deepEqual(await up.info().then((i) => [i.state, i.log]), ['running', '下载 xui-hub v0.14.0']);
    writeFileSync(log, '下载 xui-hub v0.14.0\n\x1b[0;31m下载发布包失败\x1b[0m\nexit=1\n');
    assert.deepEqual(await up.info().then((i) => [i.state, i.log]), ['failed', '下载 xui-hub v0.14.0\n下载发布包失败']);
    // 更新成功后起来的是新版本:上次的日志不再算什么
    assert.equal((await mk('0.14.0').info()).state, 'idle');
    await assert.rejects(mk('0.14.0').start(), /已经是最新/);
    // 日志很久没动、也没写完(更新服务被杀了):不再当它在跑
    writeFileSync(log, '下载中\n');
    utimesSync(log, new Date(Date.now() - 3_600_000), new Date(Date.now() - 3_600_000));
    assert.equal((await up.info()).state, 'idle');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
