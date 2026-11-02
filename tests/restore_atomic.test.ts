// J1: a JSON snapshot restore must be all-or-nothing, and the server must never observe a partially restored
// data directory. Failure injection at every stage: staging copy, disk full, verification, the live swap, the
// rollback itself, and the restore process being killed mid-swap.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as backup from '../server/lib/backup.ts';
import { createSnapshot, restoreSnapshot, writeServerLock } from '../server/lib/backup.ts';
import { startTestServer } from './helpers/server.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const cleanups: Array<() => Promise<unknown> | unknown> = [];
after(async () => {
  for (const c of cleanups.reverse()) await c();
});
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'j1-'));
// resolved at call time, so the red run against the old module reports a clear failure instead of a crash
const recover = (dataDir: string) => (backup as any).recoverInterruptedRestore(dataDir);
const restoreBlocked = (dataDir: string) => (backup as any).restoreInProgressReason(dataDir);

/** A data dir with three users' projects, usage (quota) counts, jobs and subscriptions. */
function seed(dir: string, version: string) {
  fs.mkdirSync(path.join(dir, 'projects'), { recursive: true });
  for (const u of ['alice', 'bob', 'carol']) {
    fs.writeFileSync(path.join(dir, 'projects', `${u}.json`), JSON.stringify({ userId: u, projects: [{ id: `proj_${u}`, title: `${u} ${version}` }] }));
  }
  fs.writeFileSync(path.join(dir, 'projects.migrated.json'), JSON.stringify({ version }));
  fs.writeFileSync(path.join(dir, 'usage.json'), JSON.stringify({ version: 1, day: 20000, counts: { 'user:alice': version === 'snapshot' ? 3 : 9 } }));
  fs.writeFileSync(path.join(dir, 'jobs.json'), JSON.stringify([{ id: `job_${version}` }]));
  fs.writeFileSync(path.join(dir, 'subscriptions.json'), JSON.stringify({ alice: { plan: 'free', version } }));
}

/** Every store file under dir (relative path -> sha256), ignoring backups and our own hidden bookkeeping. */
function storeState(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rel of backup.listStoreFiles(dir)) out[rel] = crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, rel))).digest('hex');
  return out;
}
/** Hidden or aside entries that hold data (never silently deleted). */
const sideEntries = (dir: string) => fs.readdirSync(dir).filter((n) => /pre-restore|restore-failed|restore-staging/.test(n));

function setup() {
  const dir = tmp();
  const backups = path.join(dir, 'backups');
  seed(dir, 'snapshot');
  const snap = createSnapshot(dir, backups, 'manual');
  const snapshotState = storeState(dir);
  seed(dir, 'current'); // the live state the operator restores away from
  const currentState = storeState(dir);
  return { dir, backups, snapDir: path.join(backups, snap.name), snapshotState, currentState };
}

/** Patches an fs function for the duration of fn; `when(callIndex, args)` decides whether to throw. */
function failing<T>(name: 'copyFileSync' | 'renameSync' | 'writeFileSync', when: (n: number, args: any[]) => boolean, err: NodeJS.ErrnoException, fn: () => T): T {
  const real = (fs as any)[name];
  let n = 0;
  (fs as any)[name] = (...args: any[]) => {
    if (when(++n, args)) throw err;
    return real.apply(fs, args);
  };
  try {
    return fn();
  } finally {
    (fs as any)[name] = real;
  }
}
const enospc = () => Object.assign(new Error('ENOSPC: no space left on device (injected)'), { code: 'ENOSPC' });
const eio = () => Object.assign(new Error('EIO: i/o error (injected)'), { code: 'EIO' });

describe('J1: a failed restore never leaves a partially restored data directory', () => {
  test('copy failure on the 3rd file while staging: live data is exactly as before, nothing to recover, retry succeeds', () => {
    const { dir, backups, snapDir, snapshotState, currentState } = setup();
    let copies = 0;
    assert.throws(
      () => failing('copyFileSync', (_n, a) => String(a[0]).startsWith(snapDir) && ++copies === 3, eio(), () => restoreSnapshot(dir, backups, snapDir)),
      /nothing was changed/,
    );
    assert.deepEqual(storeState(dir), currentState, 'every live file unchanged (the old code left 2 of 3 shards and no usage.json)');
    assert.equal(restoreBlocked(dir), null, 'no interrupted restore to recover');
    restoreSnapshot(dir, backups, snapDir);
    assert.deepEqual(storeState(dir), snapshotState);
  });

  test('disk full while staging: live data unchanged; staging copies cleaned up', () => {
    const { dir, backups, snapDir, currentState } = setup();
    assert.throws(() => failing('copyFileSync', (_n, a) => String(a[0]).startsWith(snapDir) && String(a[0]).endsWith('usage.json'), enospc(), () => restoreSnapshot(dir, backups, snapDir)), /nothing was changed.*ENOSPC/s);
    assert.deepEqual(storeState(dir), currentState);
    assert.deepEqual(fs.readdirSync(dir).filter((n) => n.includes('restore-staging')), [], 'no staging leftovers');
  });

  test('a staged file that does not match the snapshot (silent corruption while copying) is caught before the swap', () => {
    const { dir, backups, snapDir, currentState } = setup();
    const real = fs.copyFileSync;
    (fs as any).copyFileSync = (src: string, dest: string) => {
      real(src, dest);
      if (String(src).startsWith(snapDir) && String(src).endsWith(`bob.json`)) fs.appendFileSync(dest, ' ');
    };
    try {
      assert.throws(() => restoreSnapshot(dir, backups, snapDir), /nothing was changed.*bob\.json/s);
    } finally {
      (fs as any).copyFileSync = real;
    }
    assert.deepEqual(storeState(dir), currentState);
  });

  test('failure while swapping into place: rolled back automatically, live data exactly as before, restored copy kept', () => {
    const { dir, backups, snapDir, currentState } = setup();
    let swaps = 0;
    assert.throws(
      () => failing('renameSync', (_n, a) => String(a[1]).startsWith(dir + path.sep) && !String(a[1]).includes('backups') && !String(a[0]).includes('.tmp') && ++swaps === 4, eio(), () => restoreSnapshot(dir, backups, snapDir)),
      /rolled back automatically.*live data is exactly as before/s,
    );
    assert.deepEqual(storeState(dir), currentState);
    assert.equal(restoreBlocked(dir), null);
  });

  test('the swap AND the automatic rollback fail: the server refuses to start; `recover` restores the original data', async () => {
    const { dir, backups, snapDir, currentState } = setup();
    let swaps = 0;
    let failedOnce = false;
    assert.throws(
      () =>
        failing(
          'renameSync',
          (_n, a) => {
            const intoLive = String(a[1]).startsWith(dir + path.sep) && !String(a[1]).includes('backups') && !String(a[0]).includes('.tmp');
            if (!intoLive) return false;
            swaps++;
            if (swaps === 4) return true; // the swap fails...
            if (swaps === 5 && !failedOnce) return (failedOnce = true); // ...and so does the first rollback step
            return false;
          },
          eio(),
          () => restoreSnapshot(dir, backups, snapDir),
        ),
      /automatic rollback failed.*backup -- recover/s,
    );
    assert.match(String(restoreBlocked(dir)), /interrupted restore/);
    // the server must not start on this directory
    await assert.rejects(startTestServer({ DATA_DIR: dir, BACKUP_INTERVAL_HOURS: '0' }), /interrupted restore/);
    const r = recover(dir);
    assert.equal(r.state, 'rolled-back');
    assert.deepEqual(storeState(dir), currentState, 'original data back, byte for byte');
    assert.equal(restoreBlocked(dir), null);
    const s = await startTestServer({ DATA_DIR: dir, BACKUP_INTERVAL_HOURS: '0' });
    cleanups.push(() => s.stop());
    assert.equal((await fetch(`${s.baseUrl}/api/ready`)).status, 200);
  });

  test('the restore process is SIGKILLed mid-swap: the server refuses to start; `recover` brings the original back', () => {
    const { dir, backups, snapDir, currentState } = setup();
    const runner = path.join(tmp(), 'kill.mts');
    fs.writeFileSync(
      runner,
      `import fs from 'node:fs';
import { restoreSnapshot } from ${JSON.stringify(path.join(ROOT, 'server/lib/backup.ts'))};
const real = fs.renameSync; let n = 0;
(fs as any).renameSync = (a: string, b: string) => {
  if (String(b).includes('.pre-restore-') && ++n === 2) process.kill(process.pid, 'SIGKILL');
  return real(a, b);
};
restoreSnapshot(process.env.D!, process.env.B!, process.env.S!);
`,
    );
    const r = spawnSync(process.execPath, ['--import', 'tsx', runner], { cwd: ROOT, env: { ...process.env, D: dir, B: backups, S: snapDir } });
    assert.equal(r.signal, 'SIGKILL', 'the restore really died mid-swap');
    assert.match(String(restoreBlocked(dir)), /interrupted restore/);
    assert.equal(recover(dir).state, 'rolled-back');
    assert.deepEqual(storeState(dir), currentState);
  });
});

describe('J1: successful, repeated and refused restores', () => {
  test('success restores every user, quota counts, jobs and subscriptions exactly; entries absent from the snapshot are absent; nothing is deleted', () => {
    const { dir, backups, snapDir, snapshotState, currentState } = setup();
    fs.writeFileSync(path.join(dir, 'projects.json'), '[]'); // live-only entry, not in the snapshot
    const res = restoreSnapshot(dir, backups, snapDir);
    assert.deepEqual(storeState(dir), snapshotState);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'usage.json'), 'utf8')).counts['user:alice'], 3, 'quota record restored');
    assert.ok(res.preRestoreSnapshot);
    assert.ok(res.movedAside.length > 0);
    void currentState;
    assert.ok(sideEntries(dir).some((n) => n.startsWith('projects.json.pre-restore-')), 'the live-only file was moved aside, not deleted');
    assert.equal(restoreBlocked(dir), null);
  });

  test('repeated restores (A, B, A) each produce exactly that snapshot', () => {
    const { dir, backups, snapDir, snapshotState, currentState } = setup();
    const snapB = createSnapshot(dir, backups, 'manual'); // of the current state
    restoreSnapshot(dir, backups, snapDir);
    assert.deepEqual(storeState(dir), snapshotState);
    restoreSnapshot(dir, backups, path.join(backups, snapB.name));
    assert.deepEqual(storeState(dir), currentState);
    restoreSnapshot(dir, backups, snapDir);
    assert.deepEqual(storeState(dir), snapshotState);
  });

  test('a snapshot with a missing or corrupt file, or an unparseable store file, is refused before anything changes', () => {
    const { dir, backups, snapDir, currentState } = setup();
    const copy = path.join(backups, 'snap-copy-missing');
    fs.cpSync(snapDir, copy, { recursive: true });
    fs.rmSync(path.join(copy, 'usage.json'));
    assert.throws(() => restoreSnapshot(dir, backups, copy), /does not verify.*usage\.json: missing/s);
    const corrupt = path.join(backups, 'snap-copy-corrupt');
    fs.cpSync(snapDir, corrupt, { recursive: true });
    fs.appendFileSync(path.join(corrupt, 'jobs.json'), 'x');
    assert.throws(() => restoreSnapshot(dir, backups, corrupt), /does not verify/);
    // a snapshot that faithfully captured an already-corrupt store file
    fs.writeFileSync(path.join(dir, 'jobs.json'), '{not json');
    const evidence = createSnapshot(dir, backups, 'manual');
    const liveNow = storeState(dir);
    assert.throws(() => restoreSnapshot(dir, backups, path.join(backups, evidence.name)), /unparseable.*jobs\.json/s);
    assert.deepEqual(storeState(dir), liveNow);
    void currentState;
  });

  test('a second restore while one is in progress (journal present) is refused', () => {
    const { dir, backups, snapDir } = setup();
    fs.writeFileSync(path.join(dir, '.restore-in-progress.json'), JSON.stringify({ format: 1, stamp: 1, phase: 'swapping', original: [], snapshot: 'x' }));
    assert.throws(() => restoreSnapshot(dir, backups, snapDir), /restore is in progress or was interrupted/);
  });

  test('--force never overrides a provably running local server (it could observe the swap)', () => {
    const { dir, backups, snapDir, currentState } = setup();
    writeServerLock(dir);
    const lockFile = path.join(dir, '.server.lock');
    fs.writeFileSync(lockFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(lockFile, 'utf8')), pid: process.ppid }));
    assert.throws(() => restoreSnapshot(dir, backups, snapDir, { force: true }), /server process \d+ is running/);
    assert.deepEqual(storeState(dir), currentState);
  });
});

describe('J1: the server and the restore can never overlap', () => {
  test('a running server blocks a restore; a restore journal blocks the server from starting', async () => {
    const { dir, backups, snapDir } = setup();
    const s = await startTestServer({ DATA_DIR: dir, BACKUP_INTERVAL_HOURS: '0' });
    cleanups.push(() => s.stop());
    assert.throws(() => restoreSnapshot(dir, backups, snapDir), /server may be running/);
    await s.stop();
    fs.writeFileSync(path.join(dir, '.restore-in-progress.json'), JSON.stringify({ format: 1, stamp: 1, phase: 'staging', original: [], snapshot: 'x' }));
    await assert.rejects(startTestServer({ DATA_DIR: dir, BACKUP_INTERVAL_HOURS: '0' }), /interrupted restore/);
    void spawn;
  });
});
