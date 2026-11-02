// Encrypted off-site PostgreSQL backups (ADR-006, docs/BACKUP_AND_RECOVERY.md).
//
//   pg_dump -Fc  ──pipe──▶  age -r <public key(s)>  ──▶ temp file (ciphertext only) ──▶ S3-compatible bucket
//
//  * Plaintext never touches disk: pg_dump streams straight into age.
//  * The backup job holds only age PUBLIC keys; the private key lives offline with operators, so a compromised
//    server or bucket cannot read backups.
//  * Each backup has a manifest (SHA-256 of the ciphertext, size, schema version, per-table row counts).
//    Restore refuses a checksum mismatch and verifies row counts after pg_restore.
//  * Restore only targets an EMPTY database (restore-then-switch), never the live one.
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { pipeline } from 'stream/promises';
import { PassThrough, Transform } from 'stream';
import { DeleteObjectCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import pg from 'pg';

/** Tables whose row counts are recorded and verified (application data). */
export const BACKUP_TABLES = ['users', 'projects', 'subscriptions', 'jobs', 'ai_usage_daily', 'storage_totals', 'data_migrations', 'schema_migrations'] as const;

export interface BackupManifest {
  format: 1;
  name: string;
  objectKey: string;
  createdAt: string;
  bytes: number;
  sha256: string;
  encryption: 'age';
  recipients: number;
  schemaVersion: number | null;
  serverVersion: string;
  rowCounts: Record<string, number>;
  durationMs: number;
}

export interface OffsiteConfig {
  target: string; // s3://bucket/prefix  (or file:///abs/dir only when allowFileTarget)
  s3Endpoint?: string;
  s3Region?: string;
  allowFileTarget?: boolean;
}

export function offsiteConfigFromEnv(env = process.env): OffsiteConfig {
  return {
    target: env.BACKUP_TARGET || '',
    s3Endpoint: env.S3_ENDPOINT || undefined,
    s3Region: env.S3_REGION || env.AWS_REGION || 'us-east-1',
    allowFileTarget: env.BACKUP_ALLOW_FILE_TARGET === '1',
  };
}

// ---------------- storage targets ----------------
interface Target {
  put(key: string, file: string, bytes: number, meta: Record<string, string>): Promise<void>;
  putJson(key: string, value: unknown): Promise<void>;
  getToFile(key: string, file: string): Promise<void>;
  getJson<T>(key: string): Promise<T>;
  list(prefix: string): Promise<string[]>;
  remove(key: string): Promise<void>;
  describe: string;
}

function s3Target(cfg: OffsiteConfig): Target {
  const m = /^s3:\/\/([^/]+)\/?(.*)$/.exec(cfg.target);
  if (!m) throw new Error('BACKUP_TARGET must look like s3://bucket/prefix');
  const [, bucket, rawPrefix] = m;
  const prefix = rawPrefix.replace(/\/+$/, '');
  const client = new S3Client({
    region: cfg.s3Region,
    ...(cfg.s3Endpoint ? { endpoint: cfg.s3Endpoint, forcePathStyle: true } : {}),
    // Integrity is end-to-end via our own SHA-256 manifest; plain bodies keep S3-compatible stores working.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
  const full = (k: string) => (prefix ? `${prefix}/${k}` : k);
  return {
    describe: `s3://${bucket}/${prefix}`,
    async put(key, file, bytes, meta) {
      await client.send(new PutObjectCommand({ Bucket: bucket, Key: full(key), Body: fs.createReadStream(file), ContentLength: bytes, Metadata: meta, ContentType: 'application/octet-stream' }));
    },
    async putJson(key, value) {
      await client.send(new PutObjectCommand({ Bucket: bucket, Key: full(key), Body: JSON.stringify(value, null, 2), ContentType: 'application/json' }));
    },
    async getToFile(key, file) {
      const r = await client.send(new GetObjectCommand({ Bucket: bucket, Key: full(key) }));
      await pipeline(r.Body as NodeJS.ReadableStream, fs.createWriteStream(file, { mode: 0o600 }));
    },
    async getJson(key) {
      const r = await client.send(new GetObjectCommand({ Bucket: bucket, Key: full(key) }));
      return JSON.parse(await (r.Body as any).transformToString());
    },
    async list(p) {
      const out: string[] = [];
      let token: string | undefined;
      do {
        const r = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: full(p), ContinuationToken: token }));
        for (const o of r.Contents || []) if (o.Key) out.push(prefix ? o.Key.slice(prefix.length + 1) : o.Key);
        token = r.IsTruncated ? r.NextContinuationToken : undefined;
      } while (token);
      return out;
    },
    async remove(key) {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: full(key) }));
    },
  };
}

/** file:// is for tests and for a mounted REMOTE filesystem only — never point it at the database host's disk. */
function fileTarget(cfg: OffsiteConfig): Target {
  const dir = new URL(cfg.target).pathname;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const p = (k: string) => path.join(dir, k);
  return {
    describe: cfg.target,
    async put(key, file) {
      fs.mkdirSync(path.dirname(p(key)), { recursive: true });
      fs.copyFileSync(file, p(key));
    },
    async putJson(key, value) {
      fs.mkdirSync(path.dirname(p(key)), { recursive: true });
      fs.writeFileSync(p(key), JSON.stringify(value, null, 2), { mode: 0o600 });
    },
    async getToFile(key, file) {
      fs.copyFileSync(p(key), file);
    },
    async getJson(key) {
      return JSON.parse(fs.readFileSync(p(key), 'utf8'));
    },
    async list(prefix) {
      const base = p(prefix);
      if (!fs.existsSync(base)) return [];
      return fs.readdirSync(base).map((f) => path.posix.join(prefix, f));
    },
    async remove(key) {
      fs.rmSync(p(key), { force: true });
    },
  };
}

export function openTarget(cfg: OffsiteConfig): Target {
  if (cfg.target.startsWith('s3://')) return s3Target(cfg);
  if (cfg.target.startsWith('file://')) {
    if (!cfg.allowFileTarget) throw new Error('file:// backup targets are disabled; use s3:// (off-site). Set BACKUP_ALLOW_FILE_TARGET=1 only for tests or a mounted remote filesystem.');
    return fileTarget(cfg);
  }
  throw new Error('BACKUP_TARGET is required (s3://bucket/prefix)');
}

// ---------------- helpers ----------------
function run(cmd: string, args: string[], opts: { stdin?: NodeJS.ReadableStream; env?: NodeJS.ProcessEnv } = {}) {
  const proc = spawn(cmd, args, { stdio: [opts.stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'], env: { ...process.env, ...opts.env } });
  let stderr = '';
  proc.stderr!.on('data', (d) => (stderr = (stderr + d).slice(-4000)));
  const done = new Promise<void>((resolve, reject) => {
    proc.on('error', (e) => reject(new Error(`${cmd}: ${e.message}`)));
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited with ${code}: ${stderr.trim().slice(-500)}`))));
  });
  done.catch(() => {}); // observed by the caller's await; never an unhandled rejection while it awaits something else
  if (opts.stdin) {
    proc.stdin!.on('error', () => {}); // EPIPE when the child exits first; its exit code carries the real error
    opts.stdin.pipe(proc.stdin!);
  }
  return { proc, done };
}

const sha256File = async (file: string) => {
  const h = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(file), h);
  return h.digest('hex');
};

// URL query parameters understood by libpq, mapped to their environment variables.
const LIBPQ_PARAM_ENV: Record<string, string> = {
  sslmode: 'PGSSLMODE',
  sslrootcert: 'PGSSLROOTCERT',
  sslcert: 'PGSSLCERT',
  sslkey: 'PGSSLKEY',
  application_name: 'PGAPPNAME',
  connect_timeout: 'PGCONNECT_TIMEOUT',
  options: 'PGOPTIONS',
  target_session_attrs: 'PGTARGETSESSIONATTRS',
};

/**
 * R-11: connection settings for pg_dump / pg_restore / psql as libpq ENVIRONMENT variables. The connection URL
 * (which contains the password) must never be a command-line argument: argv is readable by other processes on
 * the host via `ps` / /proc/<pid>/cmdline. The child's environment is private to its user.
 */
export function libpqEnv(url: string): NodeJS.ProcessEnv {
  const u = new URL(url);
  if (!/^postgres(ql)?:$/.test(u.protocol)) throw new Error('DATABASE_URL must be a postgres:// URL');
  const env: NodeJS.ProcessEnv = {};
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (host) env.PGHOST = decodeURIComponent(host);
  if (u.port) env.PGPORT = u.port;
  if (u.username) env.PGUSER = decodeURIComponent(u.username);
  if (u.password) env.PGPASSWORD = decodeURIComponent(u.password);
  const db = decodeURIComponent(u.pathname.replace(/^\//, ''));
  if (db) env.PGDATABASE = db;
  for (const [k, v] of u.searchParams) {
    const name = LIBPQ_PARAM_ENV[k];
    if (!name) throw new Error(`unsupported DATABASE_URL parameter "${k}" for backup tools`);
    env[name] = v;
  }
  return env;
}

async function connect(url: string, applicationName: string) {
  const c = new pg.Client({ connectionString: url.replace(/[?&]sslmode=disable/, ''), application_name: applicationName });
  c.on('error', () => {}); // a dropped connection surfaces as a rejected query, never as an uncaught exception
  await c.connect();
  return c;
}

/** Row counts, schema version and server version, all read by `c` (inside whatever snapshot `c` holds). */
async function countRows(c: pg.Client): Promise<{ counts: Record<string, number>; schemaVersion: number | null; serverVersion: string }> {
  const counts: Record<string, number> = {};
  for (const t of BACKUP_TABLES) {
    const exists = (await c.query('SELECT to_regclass($1) AS r', [`public.${t}`])).rows[0].r;
    if (exists) counts[t] = Number((await c.query(`SELECT count(*) AS n FROM ${t}`)).rows[0].n);
  }
  const sv = counts.schema_migrations !== undefined ? (await c.query('SELECT max(version) AS v FROM schema_migrations')).rows[0].v : null;
  const ver = (await c.query('SHOW server_version')).rows[0].server_version;
  return { counts, schemaVersion: sv === null ? null : Number(sv), serverVersion: ver };
}

export async function rowCounts(url: string) {
  const c = await connect(url, 'forge-backup-verify');
  try {
    return await countRows(c);
  } finally {
    await c.end();
  }
}

/** Session settings newer pg_dump versions emit in the dump header, with the server major that introduced them. */
const SESSION_SETTINGS_SINCE: Record<string, number> = { transaction_timeout: 17 };

async function serverMajor(url: string): Promise<number> {
  const c = await connect(url, 'forge-backup-verify');
  try {
    return Math.floor(Number((await c.query('SHOW server_version_num')).rows[0].server_version_num) / 10000);
  } finally {
    await c.end();
  }
}

const TX_CONTROL = /^(BEGIN|COMMIT|ROLLBACK|END|ABORT|START\s+TRANSACTION|SAVEPOINT|RELEASE|PREPARE\s+TRANSACTION)\b[^;]*;\s*$/i;

/**
 * Line filter for pg_restore SQL output: removes only top-level `SET <name> = ...;` lines for settings the target
 * server major does not know. Data (COPY blocks) and every other statement pass through unchanged.
 */
export function dropUnsupportedSessionSettings(targetMajor: number): Transform {
  const unsupported = Object.entries(SESSION_SETTINGS_SINCE).filter(([, since]) => targetMajor < since).map(([n]) => n);
  const re = unsupported.length ? new RegExp(`^SET (${unsupported.join('|')}) = [^;]*;$`) : null;
  let carry = '';
  let inCopy = false;
  const handle = (line: string) => {
    if (inCopy) {
      if (line === '\\.') inCopy = false;
      return line;
    }
    if (/^COPY .* FROM stdin;$/.test(line)) inCopy = true;
    // F2: the restore owns the transaction (BEGIN ... COMMIT only after every stage succeeded). A transaction-control
    // statement inside the dump would end it early and make a partial restore committable, so it is refused.
    if (TX_CONTROL.test(line)) throw new Error(`restore stream contains a transaction-control statement (${line.slice(0, 40)}); refusing to apply it`);
    return re && re.test(line) ? null : line;
  };
  return new Transform({
    transform(chunk, _enc, cb) {
      try {
        const parts = (carry + chunk.toString('utf8')).split('\n');
        carry = parts.pop() ?? '';
        const out = parts.map(handle).filter((l) => l !== null);
        cb(null, out.length ? out.join('\n') + '\n' : '');
      } catch (err) {
        cb(err as Error);
      }
    },
    flush(cb) {
      try {
        const last = carry ? handle(carry) : null;
        cb(null, last ?? '');
      } catch (err) {
        cb(err as Error);
      }
    },
  });
}

const bin = (name: string) => process.env[`${name.toUpperCase().replace(/[^A-Z]/g, '_')}_PATH`] || name;

// ---------------- operations ----------------
export async function createBackup(databaseUrl: string, cfg: OffsiteConfig, recipients: string[]): Promise<BackupManifest> {
  if (!recipients.length || !recipients.every((r) => /^age1[0-9a-z]{58}$/.test(r))) {
    throw new Error('BACKUP_AGE_RECIPIENTS must list age public keys (age1...); backups are never written unencrypted');
  }
  const target = openTarget(cfg);
  const started = Date.now();
  // F1: the manifest must describe exactly the data in the dump. One REPEATABLE READ transaction is held open for
  // the whole backup: its snapshot is exported, the row counts are read inside it, and pg_dump runs on that same
  // snapshot (--snapshot). Writes made during the backup are in neither, so restore verification is exact.
  // (Needs a direct/session connection; a transaction-mode pooler cannot share an exported snapshot.)
  const snap = await connect(databaseUrl, 'forge-backup-snapshot');
  const name = `forge-${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}-${crypto.randomBytes(3).toString('hex')}`;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-backup-'));
  const cipherFile = path.join(tmpDir, `${name}.dump.age`);
  try {
    await snap.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    // this session sits idle in its transaction while pg_dump runs; a server-wide idle timeout must not end it early
    await snap.query('SET LOCAL idle_in_transaction_session_timeout = 0');
    const snapshotId: string = (await snap.query('SELECT pg_export_snapshot() AS id')).rows[0].id;
    const before = await countRows(snap);
    const env = libpqEnv(databaseUrl);
    const dump = run(bin('pg_dump'), ['--format=custom', '--no-owner', '--no-acl', `--snapshot=${snapshotId}`], { env });
    const age = run(bin('age'), [...recipients.flatMap((r) => ['-r', r]), '-o', cipherFile], { stdin: dump.proc.stdout! });
    await Promise.all([dump.done, age.done]);
    const bytes = fs.statSync(cipherFile).size;
    const sha256 = await sha256File(cipherFile);
    const objectKey = `${name}.dump.age`;
    const manifest: BackupManifest = {
      format: 1,
      name,
      objectKey,
      createdAt: new Date().toISOString(),
      bytes,
      sha256,
      encryption: 'age',
      recipients: recipients.length,
      schemaVersion: before.schemaVersion,
      serverVersion: before.serverVersion,
      rowCounts: before.counts,
      durationMs: 0,
    };
    await target.put(objectKey, cipherFile, bytes, { sha256 });
    manifest.durationMs = Date.now() - started;
    await target.putJson(`${name}.manifest.json`, manifest); // written last: a listed manifest means a complete upload
    return manifest;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true }); // our own temp dir (ciphertext only)
    await snap.query('ROLLBACK').catch(() => {}); // read-only snapshot transaction: nothing to commit
    await snap.end().catch(() => {});
  }
}

export async function listBackups(cfg: OffsiteConfig): Promise<BackupManifest[]> {
  const target = openTarget(cfg);
  const keys = (await target.list('')).filter((k) => k.endsWith('.manifest.json'));
  const out: BackupManifest[] = [];
  for (const k of keys) out.push(await target.getJson<BackupManifest>(k));
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

async function download(cfg: OffsiteConfig, name: string, dir: string) {
  const target = openTarget(cfg);
  const manifest = await target.getJson<BackupManifest>(`${name}.manifest.json`);
  const file = path.join(dir, manifest.objectKey);
  await target.getToFile(manifest.objectKey, file);
  const sha = await sha256File(file);
  if (sha !== manifest.sha256) throw new Error(`checksum mismatch for ${name}: backup is corrupt or was tampered with`);
  return { manifest, file };
}

/** Downloads and checks the ciphertext checksum (no key needed). */
export async function verifyBackup(cfg: OffsiteConfig, name: string) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-verify-'));
  try {
    const { manifest } = await download(cfg, name, tmpDir);
    return { name, ok: true, bytes: manifest.bytes, sha256: manifest.sha256 };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

export interface RestoreReport {
  name: string;
  targetDatabase: string;
  rowCounts: Record<string, number>;
  expected: Record<string, number>;
  verified: boolean;
  timingsMs: { download: number; restore: number; total: number };
}

/** Restores into an EMPTY database and verifies row counts. Needs the age identity (private key) file. */
export async function restoreBackup(cfg: OffsiteConfig, name: string, targetUrl: string, identityFile: string): Promise<RestoreReport> {
  if (!identityFile || !fs.existsSync(identityFile)) throw new Error('BACKUP_AGE_IDENTITY_FILE (age private key) is required to restore');
  const pre = await rowCounts(targetUrl);
  if (Object.keys(pre.counts).length > 0) throw new Error('refusing to restore into a non-empty database: create a new empty database, restore, verify, then switch DATABASE_URL');
  const t0 = Date.now();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-restore-'));
  try {
    const { manifest, file } = await download(cfg, name, tmpDir);
    const t1 = Date.now();
    const env = libpqEnv(targetUrl);
    const major = await serverMajor(targetUrl); // before any child starts: nothing can fail unobserved meanwhile
    // age -d | pg_restore -f - (SQL) | drop unknown session SETs | psql, inside ONE transaction that WE control.
    //  * Why SQL and not pg_restore directly: a newer pg_dump (17+) emits session settings an older server rejects
    //    (e.g. `SET transaction_timeout = 0;`).
    //  * F2: psql --single-transaction commits at end of input, and a dying upstream stage looks exactly like end of
    //    input, so a partial restore got committed. Now BEGIN is sent first and COMMIT is appended only after age,
    //    pg_restore and the filter have all finished successfully. On any failure psql is killed before COMMIT, so
    //    the server rolls the transaction back and the target stays empty. If this process itself dies, psql sees
    //    end of input without COMMIT, disconnects, and the server rolls back as well.
    const dec = run(bin('age'), ['-d', '-i', identityFile, file]);
    const toSql = run(bin('pg_restore'), ['--no-owner', '--no-acl', '--file=-'], { stdin: dec.proc.stdout! });
    const filter = dropUnsupportedSessionSettings(major);
    const feed = new PassThrough();
    const apply = run(bin('psql'), ['-X', '-q', '--set=ON_ERROR_STOP=1'], { stdin: feed, env });
    feed.write('BEGIN;\n');
    let filterError: Error | null = null;
    const filtered = new Promise<void>((resolve, reject) => {
      toSql.proc.stdout!.on('error', reject);
      filter.on('error', (err) => reject((filterError = err)));
      filter.on('end', resolve);
    });
    filtered.catch(() => {});
    toSql.proc.stdout!.pipe(filter);
    filter.pipe(feed, { end: false }); // psql's input is ended below, with or without COMMIT
    const upstream = Promise.all([dec.done, toSql.done, filtered]);
    // psql never exits on its own before its input is ended, so an early exit is a failure (SQL error, lost
    // connection). It must also stop the upstream stages: nothing reads their output any more, and back-pressure
    // would otherwise stall them forever.
    const psqlEarlyExit = apply.done.then(
      () => Promise.reject(new Error('psql exited before the restore stream was complete')),
      (err) => Promise.reject(err),
    );
    let upstreamError: unknown = null;
    await Promise.race([upstream, psqlEarlyExit]).catch((err) => (upstreamError = err));
    if (upstreamError) {
      for (const p of [apply.proc, toSql.proc, dec.proc]) p.kill('SIGKILL'); // COMMIT was never sent: rollback
      filter.unpipe(feed);
      filter.destroy(); // nothing will read it any more; `filtered` may stay pending, so it is not awaited here
      const settled = await Promise.allSettled([dec.done, toSql.done, apply.done]);
      if (filterError) settled.push({ status: 'rejected', reason: filterError });
      // report every stage that failed on its own (not the ones we just killed), root cause first
      const causes = [...new Set(settled.flatMap((r) => (r.status === 'rejected' ? [String((r.reason as any)?.message || r.reason)] : [])).filter((m) => !/exited with null/.test(m)))];
      if (!causes.length) causes.push(String((upstreamError as any)?.message || upstreamError));
      throw new Error(`restore aborted, nothing was committed (target database is unchanged): ${causes.join(' | ')}`);
    }
    feed.end('COMMIT;\n');
    try {
      await apply.done;
    } catch (err: any) {
      // psql failed. Before COMMIT (SQL error, lost connection) nothing is committed; a failure DURING COMMIT has an
      // unknown outcome. Never guess: look at the target and say which case this is.
      const now = await rowCounts(targetUrl).catch(() => null);
      const state = !now
        ? 'the target could not be inspected: check it before retrying (it must be empty to restore into)'
        : Object.keys(now.counts).length === 0
          ? 'nothing was committed (target database is unchanged)'
          : 'the target is NOT empty (the failure happened during COMMIT): verify it or drop and recreate it before retrying';
      throw new Error(`restore failed; ${state}: ${err?.message || err}`);
    }
    const t2 = Date.now();
    const after = await rowCounts(targetUrl);
    const verified = Object.entries(manifest.rowCounts).every(([t, n]) => after.counts[t] === n);
    return { name, targetDatabase: new URL(targetUrl).pathname.slice(1), rowCounts: after.counts, expected: manifest.rowCounts, verified, timingsMs: { download: t1 - t0, restore: t2 - t1, total: t2 - t0 } };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/** Deletes backups older than keepDays, always keeping the newest `keepMin`. Prefer bucket lifecycle rules. */
export async function pruneBackups(cfg: OffsiteConfig, keepDays: number, keepMin = 3): Promise<string[]> {
  const target = openTarget(cfg);
  const all = await listBackups(cfg);
  const cutoff = Date.now() - keepDays * 86400000;
  const removable = all.slice(0, Math.max(0, all.length - keepMin)).filter((m) => new Date(m.createdAt).getTime() < cutoff);
  for (const m of removable) {
    await target.remove(m.objectKey);
    await target.remove(`${m.name}.manifest.json`);
  }
  return removable.map((m) => m.name);
}
