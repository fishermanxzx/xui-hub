import assert from 'node:assert/strict';
import { test } from 'node:test';
import { errorText, mapLimit, noOverlap, panelKey, serial, serialAll, using } from './util';

const tick = (ms = 1) => new Promise((r) => setTimeout(r, ms));

test('mapLimit:结果按输入顺序,同时跑的不超过上限', async () => {
  let running = 0;
  let peak = 0;
  const out = await mapLimit([5, 1, 4, 2, 3], 2, async (n) => {
    peak = Math.max(peak, ++running);
    await tick(n);
    running--;
    return n * 10;
  });
  assert.deepEqual(out, [50, 10, 40, 20, 30]);
  assert.equal(peak, 2);
  assert.deepEqual(await mapLimit([], 4, async (n: number) => n), []);
});

test('using:成功失败都关闭,关闭报错不盖住结果', async () => {
  let closed = 0;
  const admin = { close: async () => void closed++ };
  assert.equal(await using(admin, async () => 'ok'), 'ok');
  await assert.rejects(using(admin, async () => Promise.reject(new Error('boom'))), /boom/);
  assert.equal(closed, 2);
  assert.equal(await using({ close: async () => Promise.reject(new Error('关不掉')) }, async () => 1), 1);
  assert.equal(await using({}, async () => 2), 2);
});

test('serial:同一个 key 排队,前一个失败不影响后一个;不同 key 互不等待', async () => {
  const log: string[] = [];
  const job = (name: string, ms: number, fail = false) => async () => {
    log.push(`${name}+`);
    await tick(ms);
    log.push(`${name}-`);
    if (fail) throw new Error(name);
    return name;
  };
  const a = serial('k', job('a', 5, true));
  const b = serial('k', job('b', 1));
  const c = serial('other', job('c', 1));
  await assert.rejects(a, /a/);
  assert.equal(await b, 'b');
  await c;
  assert.deepEqual(log.filter((l) => l[0] !== 'c'), ['a+', 'a-', 'b+', 'b-']);
  assert.ok(log.indexOf('c+') < log.indexOf('a-'), '别的 key 不用等');
});

test('serialAll:占住全部 key,顺序相反的两个任务也不会互相卡住', async () => {
  const log: string[] = [];
  const job = (name: string) => async () => {
    log.push(`${name}+`);
    await tick(2);
    log.push(`${name}-`);
  };
  await Promise.all([serialAll(['x', 'y'], job('1')), serialAll(['y', 'x', 'y'], job('2')), serial('y', job('3'))]);
  // 三个任务都要 y:谁先谁后不定,但一个跑完下一个才开始
  assert.equal(log.length, 6);
  for (let i = 0; i < 6; i += 2) assert.equal(log[i + 1], log[i].replace('+', '-'));
});

test('noOverlap:上一次没跑完就跳过', async () => {
  let runs = 0;
  const guarded = noOverlap(async () => {
    runs++;
    await tick(3);
  });
  await Promise.all([guarded(), guarded(), guarded()]);
  assert.equal(runs, 1);
  await guarded();
  assert.equal(runs, 2);
  // 抛错后也能再跑
  const failing = noOverlap(async () => Promise.reject(new Error('x')));
  await assert.rejects(failing(), /x/);
  await assert.rejects(failing(), /x/);
});

test('errorText:Error 取 message,其它转成字符串;每块面板一把自己的锁', () => {
  assert.equal(errorText(new Error('连接失败')), '连接失败');
  assert.equal(errorText(new TypeError('x')), 'x');
  assert.deepEqual([errorText('boom'), errorText(404), errorText(null), errorText(undefined)], ['boom', '404', 'null', 'undefined']);
  assert.notEqual(panelKey(1), panelKey(2));
  assert.equal(panelKey(1), panelKey(1));
});
