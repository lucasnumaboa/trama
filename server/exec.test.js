import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomSeed } from './exec.js';

test('seed without a declared max stays within 32 bits (numpy-safe)', () => {
  for (let i = 0; i < 200; i++) {
    const s = randomSeed({ kind: 'seed' });
    assert.ok(Number.isInteger(s) && s >= 0 && s <= 2 ** 32 - 1, `seed ${s}`);
  }
});

test('seed keeps a declared range, capped at 2**50', () => {
  assert.ok(randomSeed({ kind: 'seed', min: 10, max: 12 }) >= 10);
  assert.ok(randomSeed({ kind: 'seed', min: 10, max: 12 }) < 12);
  for (let i = 0; i < 50; i++) assert.ok(randomSeed({ kind: 'seed', max: 0xffffffffffffffff }) <= 2 ** 50);
});
