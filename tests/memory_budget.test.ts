// Track C correction 1: the memory guard's default threshold must leave room for ffmpeg render processes, which
// run OUTSIDE the Node process (their memory is never part of Node's RSS).
//   L = 0.8 x M - R x S
//     M = container memory limit (cgroup, MEMORY_CONTAINER_LIMIT_MB, else host memory), in MB
//     R = MAX_CONCURRENT_RENDERS, S = RENDER_MEMORY_RESERVE_MB (default 256; measured worst case 169 MB)
//   An explicit MEMORY_SOFT_LIMIT_MB is the Node threshold itself: the reserve is NOT subtracted again.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as guards from '../server/lib/requestGuards.ts';

// resolved at call time, so the red run against the old module reports a clear failure instead of a crash
const budget = (o: Record<string, unknown>) => (guards as any).computeMemoryBudget(o);

describe('Correction 1: FFmpeg-aware default memory threshold (unit)', () => {
  test('1 GB container, 2 concurrent renders, default 256 MB reserve: 0.8 x 1024 - 2 x 256 = 307 MB', () => {
    const b = budget({ containerLimitMb: 1024, maxConcurrentRenders: 2, renderReserveMb: 256 });
    assert.equal(b.softLimitMb, 307);
    assert.equal(b.reservedForRendersMb, 512);
    assert.equal(b.source, 'computed');
    assert.equal(b.memoryMb, 1024);
  });

  test('one render vs two renders', () => {
    assert.equal(budget({ containerLimitMb: 1024, maxConcurrentRenders: 1, renderReserveMb: 256 }).softLimitMb, 563);
    assert.equal(budget({ containerLimitMb: 1024, maxConcurrentRenders: 2, renderReserveMb: 256 }).softLimitMb, 307);
  });

  test('a configured reserve is used', () => {
    assert.equal(budget({ containerLimitMb: 1024, maxConcurrentRenders: 2, renderReserveMb: 128 }).softLimitMb, 563);
    assert.equal(budget({ containerLimitMb: 2048, maxConcurrentRenders: 4, renderReserveMb: 200 }).softLimitMb, 838);
  });

  test('an explicit MEMORY_SOFT_LIMIT_MB is the Node threshold itself: the render reserve is not subtracted again', () => {
    const b = budget({ explicitSoftLimitMb: 700, containerLimitMb: 1024, maxConcurrentRenders: 2, renderReserveMb: 256 });
    assert.equal(b.softLimitMb, 700);
    assert.equal(b.source, 'explicit');
    assert.equal(b.reservedForRendersMb, 0);
    assert.equal(budget({ explicitSoftLimitMb: 0, containerLimitMb: 1024, maxConcurrentRenders: 2, renderReserveMb: 256 }).source, 'disabled');
  });

  test('without a container limit the host memory is the budget', () => {
    const b = budget({ containerLimitMb: null, hostMemoryMb: 4096, maxConcurrentRenders: 2, renderReserveMb: 256 });
    assert.equal(b.softLimitMb, Math.floor(0.8 * 4096 - 512));
    assert.equal(b.memoryMb, 4096);
  });

  test('an insufficient budget is refused with a clear message (never a silently useless or negative threshold)', () => {
    // 0.8 x 512 - 512 < 0
    assert.throws(() => budget({ containerLimitMb: 512, maxConcurrentRenders: 2, renderReserveMb: 256 }), /insufficient memory budget.*512 MB.*2 renders.*256 MB/s);
    // positive but below the minimum Node needs (default 192 MB): 0.8 x 768 - 512 = 102
    assert.throws(() => budget({ containerLimitMb: 768, maxConcurrentRenders: 2, renderReserveMb: 256 }), /insufficient memory budget.*102 MB.*minimum 192 MB/s);
    // the minimum is configurable
    assert.equal(budget({ containerLimitMb: 768, maxConcurrentRenders: 2, renderReserveMb: 256, minNodeMb: 100 }).softLimitMb, 102);
  });

  test('invalid inputs are rejected, never turned into NaN (which would silently disable the guard)', () => {
    for (const bad of [NaN, 0, -1, 1.5]) {
      assert.throws(() => budget({ containerLimitMb: 1024, maxConcurrentRenders: bad, renderReserveMb: 256 }), /MAX_CONCURRENT_RENDERS/);
    }
    for (const bad of [NaN, -1]) {
      assert.throws(() => budget({ containerLimitMb: 1024, maxConcurrentRenders: 2, renderReserveMb: bad }), /RENDER_MEMORY_RESERVE_MB/);
    }
    assert.throws(() => budget({ explicitSoftLimitMb: -5, containerLimitMb: 1024, maxConcurrentRenders: 2, renderReserveMb: 256 }), /MEMORY_SOFT_LIMIT_MB/);
  });
});
