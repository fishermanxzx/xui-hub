import assert from 'node:assert/strict';
import { test } from 'node:test';
import { counterDelta, hourStart } from './delta';

test('首次见到:面板首次同步只建基线', () => {
  assert.deepEqual(counterDelta(undefined, { up: 5, down: 10 }, false), { up: 0, down: 0, reset: false });
});

test('首次见到:面板已同步过,视为新 client,当前读数全部计入', () => {
  assert.deepEqual(counterDelta(undefined, { up: 5, down: 10 }, true), { up: 5, down: 10, reset: false });
});

test('正常增长取差值', () => {
  assert.deepEqual(counterDelta({ up: 100, down: 200 }, { up: 150, down: 260 }, true), { up: 50, down: 60, reset: false });
});

test('任一方向回退视为重置,当前读数即重置后用量', () => {
  assert.deepEqual(counterDelta({ up: 100, down: 200 }, { up: 120, down: 30 }, true), { up: 120, down: 30, reset: true });
});

test('hourStart 按整点取整', () => {
  assert.equal(hourStart(3_600_000 * 5 + 1234), 3_600_000 * 5);
});
