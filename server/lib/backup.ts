// Verified snapshots of the JSON data stores and a checked restore.
//
// Snapshot = copy of every store file into BACKUP_DIR/snap-<UTC>-<reason>/ plus manifest.json with
// size + SHA-256 of every file. A snapshot is written to a temp directory, re-hashed from disk, and only
// then renamed into place, so a listed snapshot is always complete and verified.
//
// Restore never deletes anything: the current files are first captured in a "pre-restore" snapshot and
// then moved aside (renamed *.pre-restore-<ts>) before the snapshot's files are copied in.
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

/**
 * Restores `snapDir` into `dataDir`. Refuses unless the snapshot verifies and the server is stopped
 * (override with force when the lock cannot be checked, e.g. a different container).
 */
export function restoreSnapshot(dataDir: string, backupDir: string, snapDir: string, opts: { force?: boolean } = {}): RestoreResult {
  const problems = verifySnapshotDir(snapDir);
  if (problems.length) throw new Error(`refusing to restore: snapshot does not verify (${problems.join('; ')})`);
  const running = serverRunningReason(dataDir);
  if (running && !opts.force) throw new Error(`refusing to restore while the server may be running: ${running}. Stop it first (or pass --force if you are sure).`);

  const manifest: Manifest = JSON.parse(fs.readFileSync(path.join(snapDir, 'manifest.json'), 'utf8'));
  const pre = createSnapshot(dataDir, backupDir, 'pre-restore');
  const stamp = Date.now();
  const movedAside: string[] = [];

  // Move every current store entry aside (never delete), then copy the snapshot in.
  for (const entry of STORE_ENTRIES) {
    const abs = path.join(dataDir, entry);
    if (fs.existsSync(abs)) {
      const aside = `${abs}.pre-restore-${stamp}`;
      fs.renameSync(abs, aside);
      movedAside.push(path.basename(aside));
    }
  }
  const restored: string[] = [];
  for (const f of manifest.files) {
    const dest = path.join(dataDir, f.path);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.restore-tmp`;
    fs.copyFileSync(path.join(snapDir, f.path), tmp);
    fs.renameSync(tmp, dest);
    restored.push(f.path);
  }
  return { restored, preRestoreSnapshot: pre.name, movedAside };
}
