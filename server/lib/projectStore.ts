// Per-user sharded project store (Phase 1 interim; PostgreSQL replaces it in Phase 2).
//
// Why: the old single projects.json was parsed on every request, so one user's data slowed every other
// user (FS-001), and one corrupt file wiped everyone's projects on the next save (FS-002).
// Now:
//  * every user's projects live in DATA_DIR/projects/<shard>.json, so a request only reads its own shard
//    (bounded by the per-user quota);
//  * an in-memory id -> owner index (built once at boot) answers "who owns this id" without scanning;
//  * a corrupt shard makes only that user's projects unavailable (503); it is never overwritten;
//  * per-user, guest-pool, global and free-disk limits bound storage growth.
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { readJsonFile, writeJsonFileAtomic, StoreUnavailableError, freeDiskBytes } from './storage.ts';
import { createSnapshot, verifySnapshotDir } from './backup.ts';

export interface StoreLimits {
  maxProjectBytes: number;
  guestMaxProjects: number;
  guestMaxBytes: number;
  userMaxProjects: number;
  userMaxBytes: number;
  guestPoolMaxBytes: number;
  totalMaxBytes: number;
  minFreeDiskBytes: number;
}

export class StoreLimitError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'StoreLimitError';
  }
}

interface Shard {
  v: 1;
  userId: string;
  projects: any[];
}

export const UNOWNED_SHARD_USER = '__legacy_unowned__';
const SAFE_NAME = /^[A-Za-z0-9_-]{1,128}$/;
export const isGuestUser = (userId: string) => userId.startsWith('guest_');

export function shardFileName(userId: string): string {
  return SAFE_NAME.test(userId) ? `${userId}.json` : `x_${crypto.createHash('sha256').update(userId).digest('hex').slice(0, 40)}.json`;
}

export interface MigrationReport {
  migrated: boolean;
  records?: number;
  shards?: number;
  snapshot?: string;
  legacyRenamedTo?: string;
  note?: string;
}

export class ProjectStore {
  readonly dir: string;
  readonly legacyFile: string;
  readonly markerFile: string;
  private index = new Map<string, string>(); // projectId -> owner userId
  private shardBytes = new Map<string, number>(); // userId -> bytes on disk
  private corruptShards = new Set<string>(); // userIds whose shard failed to parse at boot
  private unavailableReason: string | null = null;

  constructor(
    private readonly dataDir: string,
    private readonly backupDir: string,
    private readonly limits: StoreLimits,
  ) {
    this.dir = path.join(dataDir, 'projects');
    this.legacyFile = path.join(dataDir, 'projects.json');
    this.markerFile = path.join(dataDir, 'projects.migrated.json');
  }

  /** Migrates the legacy single file (if any) and builds the index. Never throws: failures make the store unavailable. */
  init(): MigrationReport {
    let report: MigrationReport = { migrated: false };
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      report = this.migrateLegacy();
      this.buildIndex();
    } catch (err: any) {
      this.unavailableReason = String(err?.message || err);
      console.error(JSON.stringify({ level: 'error', event: 'project_store_unavailable', reason: this.unavailableReason }));
    }
    return report;
  }

  status() {
    return {
      available: this.unavailableReason === null,
      reason: this.unavailableReason,
      projects: this.index.size,
      shards: this.shardBytes.size,
      corruptShards: this.corruptShards.size,
      totalBytes: this.totalBytes(),
      guestBytes: this.guestBytes(),
    };
  }

  private assertAvailable() {
    if (this.unavailableReason) throw new StoreUnavailableError(`Project storage unavailable: ${this.unavailableReason}`, this.dir);
  }

  // ---------- migration ----------
  private migrateLegacy(): MigrationReport {
    const hasLegacy = fs.existsSync(this.legacyFile);
    if (fs.existsSync(this.markerFile)) {
      if (hasLegacy) {
        console.warn(JSON.stringify({ level: 'warn', event: 'legacy_projects_file_ignored', file: this.legacyFile, note: 'store already migrated; file left untouched' }));
      }
      return { migrated: false, note: 'already migrated' };
    }
    if (!hasLegacy) {
      writeJsonFileAtomic(this.markerFile, { migratedAt: new Date().toISOString(), records: 0, note: 'fresh store' });
      return { migrated: false, note: 'fresh store' };
    }

    const sourceBuf = fs.readFileSync(this.legacyFile);
    const legacy = readJsonFile<any>(this.legacyFile, []); // throws (fail closed) if corrupt: nothing is touched
    if (!Array.isArray(legacy)) throw new Error('legacy projects.json is not an array; refusing to migrate');

    // 1. verified backup BEFORE touching anything
    const snap = createSnapshot(this.dataDir, this.backupDir, 'pre-migration');
    const problems = verifySnapshotDir(path.join(this.backupDir, snap.name));
    const legacyInSnap = snap.files.find((f) => f.path === 'projects.json');
    if (problems.length || !legacyInSnap || legacyInSnap.sha256 !== crypto.createHash('sha256').update(sourceBuf).digest('hex')) {
      throw new Error(`pre-migration snapshot failed verification (${problems.join('; ') || 'legacy file mismatch'}); migration aborted`);
    }

    // 2. split by owner
    const byUser = new Map<string, any[]>();
    for (const p of legacy) {
      if (!p || typeof p !== 'object') continue;
      const owner = typeof p.userId === 'string' && p.userId ? p.userId : UNOWNED_SHARD_USER;
      if (!byUser.has(owner)) byUser.set(owner, []);
      byUser.get(owner)!.push(p);
    }
    const expected = [...byUser.values()].reduce((a, l) => a + l.length, 0);
    for (const [userId, projects] of byUser) {
      writeJsonFileAtomic(path.join(this.dir, shardFileName(userId)), { v: 1, userId, projects } satisfies Shard, 0);
    }

    // 3. verify every record landed
    let found = 0;
    for (const [userId, projects] of byUser) {
      const shard = readJsonFile<Shard>(path.join(this.dir, shardFileName(userId)), null as any);
      if (!shard || shard.userId !== userId || shard.projects.length !== projects.length) {
        throw new Error(`migration verification failed for shard ${shardFileName(userId)}`);
      }
      found += shard.projects.length;
    }
    if (found !== expected) throw new Error(`migration verification failed: ${found} != ${expected} records`);

    // 4. mark done, keep the legacy file (renamed, never deleted)
    const renamed = `${this.legacyFile}.migrated-${Date.now()}`;
    writeJsonFileAtomic(this.markerFile, { migratedAt: new Date().toISOString(), records: expected, shards: byUser.size, snapshot: snap.name, legacyFile: path.basename(renamed) });
    fs.renameSync(this.legacyFile, renamed);
    const report = { migrated: true, records: expected, shards: byUser.size, snapshot: snap.name, legacyRenamedTo: path.basename(renamed) };
    console.log(JSON.stringify({ level: 'info', event: 'projects_migrated', ...report }));
    return report;
  }

  private buildIndex() {
    this.index.clear();
    this.shardBytes.clear();
    this.corruptShards.clear();
    let duplicates = 0;
    for (const f of fs.readdirSync(this.dir)) {
      if (!f.endsWith('.json') || f.startsWith('.')) continue;
      const file = path.join(this.dir, f);
      let shard: Shard;
      try {
        shard = readJsonFile<Shard>(file, null as any);
      } catch {
        // Owner unknown for a corrupt hashed shard; for plain names the file name is the user id.
        this.corruptShards.add(f.replace(/\.json$/, ''));
        continue;
      }
      if (!shard || typeof shard.userId !== 'string' || !Array.isArray(shard.projects)) {
        this.corruptShards.add(f.replace(/\.json$/, ''));
        continue;
      }
      this.shardBytes.set(shard.userId, fs.statSync(file).size);
      for (const p of shard.projects) {
        if (typeof p?.id !== 'string') continue;
        if (this.index.has(p.id)) duplicates++;
        else this.index.set(p.id, shard.userId);
      }
    }
    if (duplicates) console.warn(JSON.stringify({ level: 'warn', event: 'duplicate_project_ids', count: duplicates }));
  }

  // ---------- reads ----------
  private shardPath(userId: string) {
    return path.join(this.dir, shardFileName(userId));
  }

  /** Reads one user's shard. Throws StoreUnavailableError if that shard is corrupt (only that user is affected). */
  private readShard(userId: string): any[] {
    this.assertAvailable();
    const shard = readJsonFile<Shard | null>(this.shardPath(userId), null);
    if (shard === null) return [];
    if (!Array.isArray(shard.projects) || shard.userId !== userId) {
      throw new StoreUnavailableError('Project shard is malformed; refusing to use it', this.shardPath(userId));
    }
    this.corruptShards.delete(userId);
    return shard.projects;
  }

  listByUser(userId: string): any[] {
    return this.readShard(userId);
  }

  /** Admin only: O(total data). Corrupt shards are skipped and counted, never silently treated as empty. */
  listAll(): { projects: any[]; unreadableShards: number } {
    this.assertAvailable();
    const projects: any[] = [];
    let unreadableShards = 0;
    for (const f of fs.readdirSync(this.dir)) {
      if (!f.endsWith('.json') || f.startsWith('.')) continue;
      try {
        const shard = readJsonFile<Shard>(path.join(this.dir, f), null as any);
        if (shard && Array.isArray(shard.projects)) projects.push(...shard.projects);
      } catch {
        unreadableShards++;
      }
    }
    return { projects, unreadableShards };
  }

  ownerOf(id: string): string | undefined {
    this.assertAvailable();
    return this.index.get(id);
  }

  get(id: string): any | null {
    const owner = this.ownerOf(id);
    if (!owner) return null;
    return this.readShard(owner).find((p) => p.id === id) || null;
  }

  // ---------- writes ----------
  totalBytes() {
    let t = 0;
    for (const b of this.shardBytes.values()) t += b;
    return t;
  }
  guestBytes() {
    let t = 0;
    for (const [u, b] of this.shardBytes) if (isGuestUser(u)) t += b;
    return t;
  }

  /**
   * Enforces quotas for a shard that would grow from `oldBytes` to `newBytes`. Shrinking or same-size writes
   * are always allowed, so users already above a (new, stricter) limit can still edit and delete.
   */
  private checkGrowth(userId: string, oldCount: number, newCount: number, oldBytes: number, newBytes: number) {
    const guest = isGuestUser(userId);
    const L = this.limits;
    const growth = newBytes - oldBytes;
    const maxProjects = guest ? L.guestMaxProjects : L.userMaxProjects;
    if (newCount > oldCount && newCount > maxProjects) {
      throw new StoreLimitError(409, 'project_limit', guest
        ? `Guest accounts can keep up to ${maxProjects} projects. Sign up for more, or delete old projects.`
        : `Project limit reached (${maxProjects}). Delete old projects first.`);
    }
    if (growth <= 0) return;
    const maxBytes = guest ? L.guestMaxBytes : L.userMaxBytes;
    if (newBytes > maxBytes) {
      throw new StoreLimitError(409, 'storage_quota_exceeded', `Storage limit reached (${Math.round(maxBytes / 1048576)} MB${guest ? ' for guest accounts' : ''}). Delete old projects first.`);
    }
    if (guest && this.guestBytes() + growth > L.guestPoolMaxBytes) {
      throw new StoreLimitError(507, 'guest_storage_full', 'Guest storage is temporarily full. Sign up for an account to keep saving projects.');
    }
    if (this.totalBytes() + growth > L.totalMaxBytes) {
      throw new StoreLimitError(507, 'storage_full', 'Project storage is temporarily full. Please try again later.');
    }
    const free = freeDiskBytes(this.dir);
    if (free !== null && free - growth < L.minFreeDiskBytes) {
      throw new StoreLimitError(507, 'storage_full', 'Server storage is temporarily full. Please try again later.');
    }
  }

  private writeShard(userId: string, projects: any[], oldCount: number, oldBytes: number) {
    const shard: Shard = { v: 1, userId, projects };
    const newBytes = Buffer.byteLength(JSON.stringify(shard));
    this.checkGrowth(userId, oldCount, projects.length, oldBytes, newBytes);
    const written = writeJsonFileAtomic(this.shardPath(userId), shard, 0);
    this.shardBytes.set(userId, written);
  }

  /** Inserts or replaces a project owned by userId. Caller has already checked that userId may write `project.id`. */
  put(userId: string, project: any): void {
    const projects = this.readShard(userId);
    const oldCount = projects.length;
    const oldBytes = this.shardBytes.get(userId) ?? 0;
    const idx = projects.findIndex((p) => p.id === project.id);
    const next = idx >= 0 ? projects.map((p, i) => (i === idx ? project : p)) : [project, ...projects];
    if (Buffer.byteLength(JSON.stringify(project)) > this.limits.maxProjectBytes) {
      throw new StoreLimitError(413, 'project_too_large', `Project is too large (max ${Math.round(this.limits.maxProjectBytes / 1024)} KB).`);
    }
    this.writeShard(userId, next, oldCount, oldBytes);
    this.index.set(project.id, userId);
  }

  delete(ownerId: string, id: string): boolean {
    const projects = this.readShard(ownerId);
    const next = projects.filter((p) => p.id !== id);
    if (next.length === projects.length) return false;
    this.writeShard(ownerId, next, projects.length, this.shardBytes.get(ownerId) ?? 0);
    this.index.delete(id);
    return true;
  }

  countFor(userId: string): number {
    return this.readShard(userId).length;
  }
}
