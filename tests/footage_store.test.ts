// Unit tests for the browser footage store's pure parts (IndexedDB itself is covered by tests/e2e/local_video).
import test from 'node:test';
import assert from 'node:assert/strict';
import { planEviction, footageKey, FOOTAGE_STORE_MAX_BYTES } from '../src/utils/footageStore.ts';

const GB = 1024 ** 3;

test('footage store: default cap is 2 GB and keys combine project and source video', () => {
  assert.equal(FOOTAGE_STORE_MAX_BYTES, 2 * GB);
  assert.equal(footageKey('proj_1', 'yt:arj7oStGLkU'), 'proj_1::yt:arj7oStGLkU');
});

test('planEviction: nothing evicted while under the cap', () => {
  const existing = [{ key: 'a', size: 0.5 * GB, lastUsed: 1 }, { key: 'b', size: 0.5 * GB, lastUsed: 2 }];
  assert.deepEqual(planEviction(existing, { key: 'c', size: 0.5 * GB }), []);
});

test('planEviction: least recently used go first, only as many as needed', () => {
  const existing = [
    { key: 'newest', size: 0.6 * GB, lastUsed: 30 },
    { key: 'oldest', size: 0.6 * GB, lastUsed: 10 },
    { key: 'middle', size: 0.6 * GB, lastUsed: 20 },
  ];
  assert.deepEqual(planEviction(existing, { key: 'x', size: 0.5 * GB }), ['oldest']);
  assert.deepEqual(planEviction(existing, { key: 'x', size: 1.2 * GB }), ['oldest', 'middle']);
});

test('planEviction: replacing the same key frees its old size; oversized files are refused', () => {
  const existing = [{ key: 'same', size: 1.9 * GB, lastUsed: 99 }, { key: 'other', size: 0.05 * GB, lastUsed: 1 }];
  assert.deepEqual(planEviction(existing, { key: 'same', size: 1.9 * GB }), ['same']);
  assert.equal(planEviction([], { key: 'huge', size: 2 * GB + 1 }), null);
  assert.deepEqual(planEviction([], { key: 'exact', size: 2 * GB }), []);
  // Custom caps (the constant is configurable).
  assert.deepEqual(planEviction([{ key: 'a', size: 60, lastUsed: 1 }], { key: 'b', size: 50 }, 100), ['a']);
});
