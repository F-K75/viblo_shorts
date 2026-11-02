// Verified snapshots of the JSON data stores and a checked restore.
//
// Snapshot = copy of every store file into BACKUP_DIR/snap-<UTC>-<reason>/ plus manifest.json with
// size + SHA-256 of every file. A snapshot is written to a temp directory, re-hashed from disk, and only
// then renamed into place, so a listed snapshot is always complete and verified.
//
// Restore never deletes anything and is all-or-nothing (J1):
//   1. the snapshot is verified; the server must be stopped;
//   2. a restore journal is created exclusively (DATA_DIR/.restore-in-progress.json); the server refuses to
//      start while it exists, and a second restore refuses to run;
//   3. the current state is captured in a "pre-restore" snapshot;
//   4. the snapshot is copied into a staging directory on the same filesystem and the staged copy is verified
//      (size + SHA-256 of every file against the manifest, every store file parses as JSON);
//   5. only then is the live data swapped: each store entry is renamed aside (*.pre-restore-<ts>) and the
//      staged entry renamed into place (atomic renames on one filesystem);
//   6. any failure during the swap is rolled back automatically (aside entries renamed back; restored entries
//      kept in .restore-failed-<ts>/, never deleted). If even the rollback fails, the journal stays: the
//      server refuses to start and `npm run backup -- recover` finishes the rollback (idempotent).
// Failures before step 5 change nothing in the live data.
//
// LIMITATION (documented): BACKUP_DIR defaults to DATA_DIR/backups, i.e. the same volume. Off-site
// copies / PITR come with PostgreSQL in Phase 2.
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

/** Store files/directories (relative to DATA_DIR) that make up the application state. Renders are ephemeral. */
export const STORE_ENTRIES = [
  'projects',
  'projects.migrated.json', // migration marker travels with the shards it describes
  'projects.json', // legacy single-file store (pre-migration snapshots)
  'jobs.json',
  'subscriptions.json',
  'usage.json',
] as const;

export interface ManifestFile {
  path: string;
  bytes: number;
  sha256: string;
  parseOk: boolean;
  records: number | null;
}
export interface Manifest {
  format: 1;
  name: string;
  reason: string;
  createdAt: string;
  files: ManifestFile[];
  totalBytes: number;
}

const sha256 = (buf: Buffer) => crypto.createHash('sha256').update(buf).digest('hex');

function countRecords(parsed: any): number | null {
  if (Array.isArray(parsed)) return parsed.length;
  if (parsed && Array.isArray(parsed.projects)) return parsed.projects.length; // project shard
  if (parsed && typeof parsed === 'object') return Object.keys(parsed).length;
  return null;
}

/** Lists store files under dataDir (relative paths), recursing into the projects shard directory. */
export function listStoreFiles(dataDir: string): string[] {
  const out: string[] = [];
  for (const entry of STORE_ENTRIES) {
    const abs = path.join(dataDir, entry);
    let st: fs.Stats;
    try {
      st = fs.statSync(abs);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      for (const f of fs.readdirSync(abs).sort()) {
        if (f.endsWith('.json') && !f.startsWith('.')) out.push(path.join(entry, f));
      }
    } else if (st.isFile()) {
      out.push(entry);
    }
  }
  return out;
}

function snapshotName(reason: string, now = new Date()) {
  const ts = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const safe = reason.replace(/[^a-z0-9-]/gi, '').slice(0, 24) || 'manual';
  return `snap-${ts}-${safe}-${crypto.randomBytes(2).toString('hex')}`;
}

/**
 * Creates and verifies a snapshot. Synchronous on purpose: the server's stores are written synchronously,
 * so a snapshot taken inside the event loop is a consistent point-in-time copy.
 */
export function createSnapshot(dataDir: string, backupDir: string, reason = 'manual'): Manifest {
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const name = snapshotName(reason);
  const tmpDir = path.join(backupDir, `.${name}.partial`);
  fs.mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
  try {
    const files: ManifestFile[] = [];
    for (const rel of listStoreFiles(dataDir)) {
      const buf = fs.readFileSync(path.join(dataDir, rel));
      let parseOk = true;
      let records: number | null = null;
      try {
        records = countRecords(JSON.parse(buf.toString('utf8')));
      } catch {
        parseOk = false; // still backed up byte-for-byte: a corrupt file is evidence, not something to drop
      }
      const dest = path.join(tmpDir, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
      fs.writeFileSync(dest, buf, { mode: 0o600 });
      files.push({ path: rel, bytes: buf.length, sha256: sha256(buf), parseOk, records });
    }
    const manifest: Manifest = {
      format: 1,
      name,
      reason,
      createdAt: new Date().toISOString(),
      files,
      totalBytes: files.reduce((a, f) => a + f.bytes, 0),
    };
    fs.writeFileSync(path.join(tmpDir, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
    const problems = verifySnapshotDir(tmpDir);
    if (problems.length) throw new Error(`snapshot verification failed: ${problems.join('; ')}`);
    fs.renameSync(tmpDir, path.join(backupDir, name));
    return manifest;
  } catch (err) {
    fs.rmSync(tmpDir, { recursive: true, force: true }); // only our own partial temp dir
    throw err;
  }
}

/** Re-hashes every file of a snapshot. Returns a list of problems (empty = verified). */
export function verifySnapshotDir(snapDir: string): string[] {
  let manifest: Manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(snapDir, 'manifest.json'), 'utf8'));
  } catch {
    return ['manifest.json missing or unreadable'];
  }
  const problems: string[] = [];
  for (const f of manifest.files || []) {
    if (f.path.includes('..') || path.isAbsolute(f.path)) {
      problems.push(`illegal path ${f.path}`);
      continue;
    }
    try {
      const buf = fs.readFileSync(path.join(snapDir, f.path));
      if (buf.length !== f.bytes) problems.push(`${f.path}: size ${buf.length} != ${f.bytes}`);
      else if (sha256(buf) !== f.sha256) problems.push(`${f.path}: checksum mismatch`);
    } catch {
      problems.push(`${f.path}: missing`);
    }
  }
  return problems;
}

export interface SnapshotInfo {
  name: string;
  dir: string;
  createdAt: string;
  reason: string;
  files: number;
  totalBytes: number;
}

export function listSnapshots(backupDir: string): SnapshotInfo[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(backupDir).filter((n) => n.startsWith('snap-'));
  } catch {
    return [];
  }
  const out: SnapshotInfo[] = [];
  for (const name of names) {
    const dir = path.join(backupDir, name);
    try {
      const m: Manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
      out.push({ name, dir, createdAt: m.createdAt, reason: m.reason, files: m.files.length, totalBytes: m.totalBytes });
    } catch {
      // ignore unreadable entries (they are never pruned automatically either)
    }
  }
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** Keeps the newest `retain` scheduled snapshots. Snapshots with other reasons (pre-migration, pre-restore, manual) are never pruned. */
export function pruneSnapshots(backupDir: string, retain: number, reason = 'scheduled'): string[] {
  const scheduled = listSnapshots(backupDir).filter((s) => s.reason === reason);
  const remove = scheduled.slice(0, Math.max(0, scheduled.length - Math.max(1, retain)));
  for (const s of remove) fs.rmSync(s.dir, { recursive: true, force: true });
  return remove.map((s) => s.name);
}

// ---------- server lock (restore must not run while the server is writing) ----------
export interface ServerLock {
  pid: number;
  hostname: string;
  startedAt: string;
}
export const LOCK_FILE = '.server.lock';

export function writeServerLock(dataDir: string) {
  const lock: ServerLock = { pid: process.pid, hostname: os.hostname(), startedAt: new Date().toISOString() };
  fs.writeFileSync(path.join(dataDir, LOCK_FILE), JSON.stringify(lock), { mode: 0o600 });
}
export function removeServerLock(dataDir: string) {
  try {
    const lock: ServerLock = JSON.parse(fs.readFileSync(path.join(dataDir, LOCK_FILE), 'utf8'));
    if (lock.pid === process.pid && lock.hostname === os.hostname()) fs.rmSync(path.join(dataDir, LOCK_FILE), { force: true });
  } catch {
    // no lock
  }
}

/** Returns a reason the server may still be running, or null if it is safe to restore. */
export function serverRunningReason(dataDir: string): string | null {
  let lock: ServerLock;
  try {
    lock = JSON.parse(fs.readFileSync(path.join(dataDir, LOCK_FILE), 'utf8'));
  } catch {
    return null;
  }
  if (lock.hostname !== os.hostname()) {
    return `lock held by host "${lock.hostname}" (pid ${lock.pid}); cannot verify it is stopped`;
  }
  if (lock.pid === process.pid) return null;
  try {
    process.kill(lock.pid, 0);
    return `server process ${lock.pid} is running`;
  } catch {
    return null; // stale lock
  }
}

export interface RestoreResult {
  restored: string[];
  preRestoreSnapshot: string;
  movedAside: string[];
}

/** Journal of a restore in progress. Its presence blocks the server from starting (J1). */
export const RESTORE_JOURNAL = '.restore-in-progress.json';
interface RestoreJournal {
  format: 1;
  stamp: number;
  snapshot: string;
  startedAt: string;
  pid: number;
  hostname: string;
  /** staging: live data untouched; swapping: live entries are being replaced. */
  phase: 'staging' | 'swapping';
  /** store entries that existed in the live directory before the swap */
  original: string[];
}
const journalPath = (dataDir: string) => path.join(dataDir, RESTORE_JOURNAL);
const stagingDir = (dataDir: string, stamp: number) => path.join(dataDir, `.restore-staging-${stamp}`);
const failedDir = (dataDir: string, stamp: number) => path.join(dataDir, `.restore-failed-${stamp}`);
const asideName = (entry: string, stamp: number) => `${entry}.pre-restore-${stamp}`;

function fsyncDir(dir: string) {
  try {
    const fd = fs.openSync(dir, 'r');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // not supported on every filesystem; renames are still atomic
  }
}
function writeJournal(dataDir: string, j: RestoreJournal, exclusive: boolean) {
  const fd = fs.openSync(journalPath(dataDir), exclusive ? 'wx' : 'w', 0o600);
  try {
    fs.writeSync(fd, JSON.stringify(j));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fsyncDir(dataDir);
}
function readJournal(dataDir: string): RestoreJournal | null {
  try {
    return JSON.parse(fs.readFileSync(journalPath(dataDir), 'utf8'));
  } catch (err: any) {
    if (err?.code === 'ENOENT') return null;
    // an unreadable journal still means "a restore was interrupted": never ignore it
    return { format: 1, stamp: 0, snapshot: '?', startedAt: '?', pid: 0, hostname: '?', phase: 'swapping', original: [] };
  }
}

/** Non-null when a restore is running or was interrupted: the server must not start on this directory. */
export function restoreInProgressReason(dataDir: string): string | null {
  const j = readJournal(dataDir);
  if (!j) return null;
  return `an interrupted restore (or one still running) was found (${RESTORE_JOURNAL}, snapshot ${j.snapshot}, phase ${j.phase}); run "npm run backup -- recover" before starting the server`;
}

/** Local lock state: a provably running local server can never be overridden, even with force. */
function lockState(dataDir: string): { blocked: string | null; overridable: boolean } {
  const reason = serverRunningReason(dataDir);
  if (!reason) return { blocked: null, overridable: false };
  return { blocked: reason, overridable: reason.startsWith('lock held by host') };
}

/** Puts the original live entries back after a failed or interrupted swap. Idempotent; throws if a step fails. */
function rollbackSwap(dataDir: string, j: RestoreJournal): string[] {
  const kept: string[] = [];
  const failed = failedDir(dataDir, j.stamp);
  const keep = (entry: string) => {
    fs.mkdirSync(failed, { recursive: true, mode: 0o700 });
    fs.renameSync(path.join(dataDir, entry), path.join(failed, entry));
    kept.push(entry);
  };
  for (const entry of STORE_ENTRIES) {
    const live = path.join(dataDir, entry);
    const aside = path.join(dataDir, asideName(entry, j.stamp));
    if (fs.existsSync(aside)) {
      if (fs.existsSync(live)) keep(entry); // restored copy: kept, never deleted
      fs.renameSync(aside, live);
    } else if (!j.original.includes(entry) && fs.existsSync(live)) {
      keep(entry); // entry that did not exist before the swap
    }
  }
  fsyncDir(dataDir);
  return kept;
}

/**
 * Restores `snapDir` into `dataDir`, all-or-nothing (see the header). `force` only overrides a lock written on
 * another host (which cannot be checked from here); a provably running local server always blocks a restore.
 */
export function restoreSnapshot(
  dataDir: string,
  backupDir: string,
  snapDir: string,
  opts: { force?: boolean; allowUnparseable?: boolean } = {},
): RestoreResult {
  const problems = verifySnapshotDir(snapDir);
  if (problems.length) throw new Error(`refusing to restore: snapshot does not verify (${problems.join('; ')})`);
  const manifest: Manifest = JSON.parse(fs.readFileSync(path.join(snapDir, 'manifest.json'), 'utf8'));
  const unparseable = manifest.files.filter((f) => !f.parseOk).map((f) => f.path);
  if (unparseable.length && !opts.allowUnparseable) {
    throw new Error(`refusing to restore: the snapshot contains unparseable store files (${unparseable.join(', ')}); the server would refuse to use them. Pass --allow-unparseable only to restore them as evidence.`);
  }
  const checkLock = () => {
    const lock = lockState(dataDir);
    if (lock.blocked && !(opts.force && lock.overridable)) {
      throw new Error(`refusing to restore while the server may be running: ${lock.blocked}. Stop it first${lock.overridable ? ' (or pass --force if you are sure the other host is stopped)' : ''}.`);
    }
  };
  checkLock();

  const stamp = Date.now();
  const journal: RestoreJournal = {
    format: 1,
    stamp,
    snapshot: path.basename(snapDir),
    startedAt: new Date().toISOString(),
    pid: process.pid,
    hostname: os.hostname(),
    phase: 'staging',
    original: [],
  };
  try {
    writeJournal(dataDir, journal, true); // exclusive: one restore at a time
  } catch (err: any) {
    if (err?.code === 'EEXIST') {
      throw new Error(`refusing to restore: a restore is in progress or was interrupted (${RESTORE_JOURNAL} exists); run "npm run backup -- recover" first`);
    }
    throw err;
  }

  // ---- stage + verify: the live data is not touched ----
  const staging = stagingDir(dataDir, stamp);
  let pre: Manifest;
  try {
    checkLock(); // again, after the journal exists: a server starting now refuses (it checks the journal after locking)
    pre = createSnapshot(dataDir, backupDir, 'pre-restore');
    fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
    for (const f of manifest.files) {
      const dest = path.join(staging, f.path);
      fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
      fs.copyFileSync(path.join(snapDir, f.path), dest);
    }
    fs.copyFileSync(path.join(snapDir, 'manifest.json'), path.join(staging, 'manifest.json'));
    const staged = verifySnapshotDir(staging);
    if (staged.length) throw new Error(`staged copy does not match the snapshot (${staged.join('; ')})`);
    for (const f of manifest.files) {
      if (!f.parseOk) continue;
      try {
        JSON.parse(fs.readFileSync(path.join(staging, f.path), 'utf8'));
      } catch {
        throw new Error(`staged ${f.path} does not parse`);
      }
    }
    fs.rmSync(path.join(staging, 'manifest.json'));
  } catch (err: any) {
    fs.rmSync(staging, { recursive: true, force: true }); // copies of the snapshot only
    fs.rmSync(journalPath(dataDir), { force: true });
    throw new Error(`restore aborted, nothing was changed (live data untouched): ${err?.message || err}`);
  }

  // ---- swap: journaled, rolled back on any failure ----
  journal.phase = 'swapping';
  journal.original = STORE_ENTRIES.filter((e) => fs.existsSync(path.join(dataDir, e)));
  const movedAside: string[] = [];
  try {
    writeJournal(dataDir, journal, false);
    for (const entry of STORE_ENTRIES) {
      const live = path.join(dataDir, entry);
      if (fs.existsSync(live)) {
        fs.renameSync(live, path.join(dataDir, asideName(entry, stamp)));
        movedAside.push(asideName(entry, stamp));
      }
      const stagedEntry = path.join(staging, entry);
      if (fs.existsSync(stagedEntry)) fs.renameSync(stagedEntry, live);
    }
    fsyncDir(dataDir);
  } catch (err: any) {
    let kept: string[];
    try {
      kept = rollbackSwap(dataDir, journal);
    } catch (rbErr: any) {
      throw new Error(
        `restore failed while replacing the live data (${err?.message || err}) AND the automatic rollback failed (${rbErr?.message || rbErr}). ` +
          `Nothing was deleted: the original entries are named *.pre-restore-${stamp} in ${dataDir}. The server will refuse to start until you run "npm run backup -- recover", which finishes the rollback.`,
      );
    }
    fs.rmSync(journalPath(dataDir), { force: true });
    fs.rmSync(staging, { recursive: true, force: true }); // only leftover copies of the snapshot
    throw new Error(
      `restore failed while replacing the live data and was rolled back automatically; the live data is exactly as before` +
        `${kept.length ? ` (partially restored entries kept in ${path.basename(failedDir(dataDir, stamp))}/)` : ''}: ${err?.message || err}`,
    );
  }
  fs.rmSync(journalPath(dataDir), { force: true });
  fs.rmSync(staging, { recursive: true, force: true }); // empty after the swap
  fsyncDir(dataDir);
  return { restored: manifest.files.map((f) => f.path), preRestoreSnapshot: pre.name, movedAside };
}

/**
 * Finishes an interrupted restore by rolling it back to the data that was live before it started (idempotent).
 * Refuses while the restoring process is provably still running on this host.
 */
export function recoverInterruptedRestore(dataDir: string): { state: 'none' | 'rolled-back'; snapshot?: string; keptInFailedDir: string[] } {
  const j = readJournal(dataDir);
  if (!j) return { state: 'none', keptInFailedDir: [] };
  if (j.hostname === os.hostname() && j.pid && j.pid !== process.pid) {
    try {
      process.kill(j.pid, 0);
      throw new Error(`the restore process ${j.pid} is still running; wait for it to finish`);
    } catch (err: any) {
      if (err?.code !== 'ESRCH') throw err;
    }
  }
  const kept = j.phase === 'swapping' && j.stamp ? rollbackSwap(dataDir, j) : [];
  if (j.stamp) {
    const staging = stagingDir(dataDir, j.stamp);
    if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true, force: true }); // copies of the snapshot only
  }
  fs.rmSync(journalPath(dataDir), { force: true });
  fsyncDir(dataDir);
  return { state: 'rolled-back', snapshot: j.snapshot, keptInFailedDir: kept };
}
