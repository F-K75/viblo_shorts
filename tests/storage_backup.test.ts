// Unit tests (real modules) for Phase 1: sharded project store + quotas, migration, snapshots/restore,
// usage ledger reserve/refund, TRUST_PROXY parsing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProjectStore, StoreLimitError, shardFileName, UNOWNED_SHARD_USER, type StoreLimits } from '../server/lib/projectStore.ts';
import { StoreUnavailableError } from '../server/lib/storage.ts';
import { createSnapshot, listSnapshots, pruneSnapshots, restoreSnapshot, verifySnapshotDir, writeServerLock } from '../server/lib/backup.ts';
import { UsageLedger } from '../server/lib/usage.ts';
import { parseTrustProxy } from '../server/lib/security.ts';

const KB = 1024;
const limits = (o: Partial<StoreLimits> = {}): StoreLimits => ({
  maxProjectBytes: 64 * KB,
  guestMaxProjects: 3,
  guestMaxBytes: 100 * KB,
  userMaxProjects: 50,
  userMaxBytes: 400 * KB,
  guestPoolMaxBytes: 10_000 * KB,
  totalMaxBytes: 100_000 * KB,
  minFreeDiskBytes: 0,
  ...o,
});
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'p1-'));
const proj = (id: string, userId: string, size = 10) => ({ id, userId, title: id, topic: 'x'.repeat(size), updatedAt: new Date().toISOString() });

test('project store: per-user isolation, guest project/byte caps, shrinking always allowed', () => {
  const dir = tmp();
  const s = new ProjectStore(dir, path.join(dir, 'backups'), limits());
  s.init();
  const g = 'guest_' + 'a'.repeat(32);
  s.put(g, proj('proj_1', g, 30 * KB));
  s.put(g, proj('proj_2', g, 30 * KB));
  s.put(g, proj('proj_3', g, 30 * KB));
  assert.throws(() => s.put(g, proj('proj_4', g, 10)), (e: any) => e instanceof StoreLimitError && e.code === 'project_limit');
  assert.throws(() => s.put(g, proj('proj_3', g, 45 * KB)), (e: any) => e instanceof StoreLimitError && e.code === 'storage_quota_exceeded');
  s.put(g, proj('proj_3', g, 1 * KB)); // shrink: allowed
  assert.throws(() => s.put(g, proj('proj_2', g, 70 * KB)), (e: any) => e instanceof StoreLimitError && e.code === 'project_too_large');
  assert.equal(s.listByUser(g).length, 3);
  assert.equal(s.listByUser('firebase-user').length, 0);
  assert.equal(s.ownerOf('proj_1'), g);
  // shard on disk holds only that user's data
  const shard = JSON.parse(fs.readFileSync(path.join(dir, 'projects', shardFileName(g)), 'utf8'));
  assert.equal(shard.userId, g);
  assert.equal(shard.projects.length, 3);
});

test('project store: guest pool cap protects authenticated users; global cap applies to everyone', () => {
  const dir = tmp();
  const s = new ProjectStore(dir, path.join(dir, 'b'), limits({ guestPoolMaxBytes: 50 * KB, totalMaxBytes: 120 * KB, guestMaxProjects: 10 }));
  s.init();
  const g1 = 'guest_' + '1'.repeat(32);
  const g2 = 'guest_' + '2'.repeat(32);
  s.put(g1, proj('proj_a', g1, 40 * KB));
  assert.throws(() => s.put(g2, proj('proj_b', g2, 20 * KB)), (e: any) => e.status === 507 && e.code === 'guest_storage_full');
  s.put('user-1', proj('proj_c', 'user-1', 60 * KB)); // authenticated user unaffected by guest pool
  assert.throws(() => s.put('user-2', proj('proj_d', 'user-2', 30 * KB)), (e: any) => e.status === 507 && e.code === 'storage_full');
});

test('project store: a corrupt shard affects only its owner and is never overwritten', () => {
  const dir = tmp();
  const s = new ProjectStore(dir, path.join(dir, 'b'), limits());
  s.init();
  s.put('alice', proj('proj_a1', 'alice'));
  s.put('bob', proj('proj_b1', 'bob'));
  const aliceFile = path.join(dir, 'projects', 'alice.json');
  fs.writeFileSync(aliceFile, '{"v":1,"userId":"alice","projects":[{"id":"proj_a1"'); // truncated
  const before = fs.readFileSync(aliceFile);
  assert.throws(() => s.listByUser('alice'), (e: any) => e instanceof StoreUnavailableError);
  assert.throws(() => s.put('alice', proj('proj_a2', 'alice')), (e: any) => e instanceof StoreUnavailableError);
  assert.deepEqual(fs.readFileSync(aliceFile), before, 'corrupt shard untouched');
  s.put('bob', proj('proj_b2', 'bob'));
  assert.equal(s.listByUser('bob').length, 2, 'other users keep working');
});

test('migration: verified pre-migration snapshot, every record moved, legacy file kept (renamed)', () => {
  const dir = tmp();
  const legacy = [proj('proj_1', 'u1'), proj('proj_2', 'u2'), proj('proj_3', 'u1'), { id: 'proj_4', title: 'orphan' }];
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify(legacy, null, 2));
  const s = new ProjectStore(dir, path.join(dir, 'backups'), limits());
  const r = s.init();
  assert.equal(r.migrated, true);
  assert.equal(r.records, 4);
  assert.deepEqual(s.listByUser('u1').map((p) => p.id).sort(), ['proj_1', 'proj_3']);
  assert.deepEqual(s.listByUser('u2').map((p) => p.id), ['proj_2']);
  assert.equal(s.ownerOf('proj_4'), UNOWNED_SHARD_USER);
  assert.ok(!fs.existsSync(path.join(dir, 'projects.json')));
  assert.ok(fs.readdirSync(dir).some((f) => f.startsWith('projects.json.migrated-')), 'legacy file renamed, not deleted');
  const snap = listSnapshots(path.join(dir, 'backups')).find((x) => x.reason === 'pre-migration')!;
  assert.ok(snap, 'pre-migration snapshot exists');
  assert.deepEqual(verifySnapshotDir(snap.dir), []);
  // idempotent: second init does not migrate again
  assert.equal(new ProjectStore(dir, path.join(dir, 'backups'), limits()).init().migrated, false);
});

test('migration: corrupt legacy file => no migration, nothing touched, store unavailable (fail closed)', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'projects.json'), '[{"id":"proj_1"');
  const s = new ProjectStore(dir, path.join(dir, 'b'), limits());
  s.init();
  assert.equal(s.status().available, false);
  assert.equal(fs.readFileSync(path.join(dir, 'projects.json'), 'utf8'), '[{"id":"proj_1"');
  assert.ok(!fs.existsSync(path.join(dir, 'projects.migrated.json')));
  assert.throws(() => s.listByUser('u1'), (e: any) => e instanceof StoreUnavailableError);
});

test('snapshot -> damage -> restore brings back the original data; current data moved aside, not deleted', () => {
  const dir = tmp();
  const backups = path.join(dir, 'backups');
  const s = new ProjectStore(dir, backups, limits());
  s.init();
  s.put('u1', proj('proj_1', 'u1'));
  s.put('u2', proj('proj_2', 'u2'));
  fs.writeFileSync(path.join(dir, 'jobs.json'), JSON.stringify([{ id: 'job_1' }]));
  const snap = createSnapshot(dir, backups, 'manual');
  assert.ok(snap.files.some((f) => f.path === 'projects/u1.json'));
  assert.ok(snap.files.some((f) => f.path === 'projects.migrated.json'));

  // damage: delete one user's projects, corrupt the other's shard and jobs.json
  s.delete('u1', 'proj_1');
  fs.writeFileSync(path.join(dir, 'projects', 'u2.json'), 'garbage');
  fs.writeFileSync(path.join(dir, 'jobs.json'), 'garbage');

  const res = restoreSnapshot(dir, backups, path.join(backups, snap.name));
  assert.ok(res.preRestoreSnapshot);
  assert.ok(res.movedAside.some((f) => f.startsWith('projects.pre-restore-')));
  const fresh = new ProjectStore(dir, backups, limits());
  fresh.init();
  assert.deepEqual(fresh.listByUser('u1').map((p) => p.id), ['proj_1']);
  assert.deepEqual(fresh.listByUser('u2').map((p) => p.id), ['proj_2']);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'jobs.json'), 'utf8')), [{ id: 'job_1' }]);
});

test('restore refuses a tampered snapshot and refuses while the server lock is held by a live process', () => {
  const dir = tmp();
  const backups = path.join(dir, 'backups');
  fs.writeFileSync(path.join(dir, 'jobs.json'), '[]');
  const snap = createSnapshot(dir, backups, 'manual');
  fs.appendFileSync(path.join(backups, snap.name, 'jobs.json'), ' ');
  assert.throws(() => restoreSnapshot(dir, backups, path.join(backups, snap.name)), /does not verify/);

  const good = createSnapshot(dir, backups, 'manual');
  // simulate a running server: lock with the pid of a live process that is not us (our parent)
  writeServerLock(dir);
  const lockFile = path.join(dir, '.server.lock');
  const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
  fs.writeFileSync(lockFile, JSON.stringify({ ...lock, pid: process.ppid }));
  assert.throws(() => restoreSnapshot(dir, backups, path.join(backups, good.name)), /server may be running/);
  // J1: --force never overrides a provably running LOCAL server (it could observe the swap) ...
  assert.throws(() => restoreSnapshot(dir, backups, path.join(backups, good.name), { force: true }), /server process \d+ is running/);
  // ... it only overrides a lock written on another host, which cannot be checked from here
  fs.writeFileSync(lockFile, JSON.stringify({ ...lock, hostname: 'other-container', pid: 1 }));
  assert.throws(() => restoreSnapshot(dir, backups, path.join(backups, good.name)), /lock held by host "other-container"/);
  assert.doesNotThrow(() => restoreSnapshot(dir, backups, path.join(backups, good.name), { force: true }));
});

test('prune keeps the newest scheduled snapshots and never prunes other reasons', () => {
  const dir = tmp();
  const backups = path.join(dir, 'backups');
  fs.writeFileSync(path.join(dir, 'jobs.json'), '[]');
  createSnapshot(dir, backups, 'pre-migration');
  for (let i = 0; i < 4; i++) createSnapshot(dir, backups, 'scheduled');
  pruneSnapshots(backups, 2, 'scheduled');
  const all = listSnapshots(backups);
  assert.equal(all.filter((s) => s.reason === 'scheduled').length, 2);
  assert.equal(all.filter((s) => s.reason === 'pre-migration').length, 1);
});

test('usage ledger: reserve is all-or-nothing, refund restores, counts persist, corrupt file fails closed', () => {
  const dir = tmp();
  const file = path.join(dir, 'usage.json');
  const l = new UsageLedger(file, 0);
  const e = [{ key: 'user:a', limit: 2 }, { key: 'ip:1', limit: 3 }];
  assert.equal(l.reserve(e).ok, true);
  assert.equal(l.reserve(e).ok, true);
  assert.deepEqual(l.reserve(e), { ok: false, key: 'user:a' });
  assert.equal(l.peek('ip:1'), 2, 'failed reservation charges nothing');
  l.refund(['user:a', 'ip:1'], Math.floor(Date.now() / 86400000));
  assert.equal(l.peek('user:a'), 1);
  l.flush();
  assert.equal(new UsageLedger(file, 0).peek('user:a'), 1, 'persisted across restart');
  fs.writeFileSync(file, '{bad');
  const broken = new UsageLedger(file, 0);
  assert.equal(broken.available, false);
  assert.throws(() => broken.reserve(e), (err: any) => err instanceof StoreUnavailableError);
  broken.flush();
  assert.equal(fs.readFileSync(file, 'utf8'), '{bad', 'corrupt ledger never overwritten');
});

test('TRUST_PROXY parsing: explicit in production, "true" rejected, hop counts and CIDRs accepted', () => {
  assert.equal(parseTrustProxy(undefined, true).ok, false);
  assert.equal(parseTrustProxy('true', true).ok, false);
  assert.deepEqual(parseTrustProxy('none', true), { ok: true, value: false, description: 'none' });
  assert.deepEqual(parseTrustProxy('1', true), { ok: true, value: 1, description: '1 hop(s)' });
  assert.equal(parseTrustProxy('0', true).ok && (parseTrustProxy('0', true) as any).value, false);
  assert.equal(parseTrustProxy('99', true).ok, false);
  assert.equal(parseTrustProxy('10.0.0.0/8, loopback', true).ok, true);
  assert.equal(parseTrustProxy('evil.example.com', true).ok, false);
  assert.equal(parseTrustProxy(undefined, false).ok, true, 'development default: no proxy trusted');
});
