// JSON-file persistence primitives.
//  * Atomic, durable writes: temp file + fsync + rename + directory fsync.
//  * FAIL CLOSED on corruption: an unparsable file is never treated as "empty", because the next
//    write would then replace every record in it (verified data-loss bug FS-002). Callers get a
//    StoreUnavailableError and must refuse the operation; the file is left untouched.
// NOTE: still a single-process store. The durable fix is PostgreSQL (Phase 2).
import fs from 'fs';
import path from 'path';

export class StoreUnavailableError extends Error {
  readonly code = 'store_unavailable';
  constructor(
    message: string,
    readonly filePath: string,
  ) {
    super(message);
    this.name = 'StoreUnavailableError';
  }
}

// One forensic copy per (file, size, mtime): repeated reads of the same corrupt file must not fill the disk.
const preservedVersions = new Set<string>();

function preserveCorruptFile(filePath: string): string | null {
  try {
    const st = fs.statSync(filePath);
    const sig = `${filePath}:${st.size}:${st.mtimeMs}`;
    if (preservedVersions.has(sig)) return null;
    preservedVersions.add(sig);
    const backup = `${filePath}.corrupt-${Date.now()}`;
    fs.copyFileSync(filePath, backup);
    return backup;
  } catch {
    return null;
  }
}

/**
 * Reads and parses a JSON file. Missing file => `fallback`. Unparsable file => throws
 * StoreUnavailableError (after preserving a forensic copy once). Never returns partial data.
 */
export function readJsonFile<T>(filePath: string, fallback: T): T {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err: any) {
    if (err?.code === 'ENOENT') return fallback;
    throw new StoreUnavailableError(`Cannot read ${path.basename(filePath)}: ${err?.code || err?.message}`, filePath);
  }
  try {
    return JSON.parse(raw) as T;
  } catch (err: any) {
    const copy = preserveCorruptFile(filePath);
    console.error(
      JSON.stringify({
        level: 'error',
        event: 'store_corrupt',
        file: filePath,
        forensicCopy: copy,
        error: String(err?.message || err).slice(0, 200),
      }),
    );
    throw new StoreUnavailableError(`${path.basename(filePath)} is corrupt; refusing to read or overwrite it`, filePath);
  }
}

function fsyncDir(dir: string) {
  let fd: number | null = null;
  try {
    fd = fs.openSync(dir, 'r');
    fs.fsyncSync(fd);
  } catch {
    // Directory fsync is not supported on every platform/filesystem; the rename is still atomic.
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

/** Atomic + durable write. `indent` 0 writes compact JSON (used for per-user shards). */
export function writeJsonFileAtomic<T>(filePath: string, data: T, indent = 2): number {
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`);
  const body = indent > 0 ? JSON.stringify(data, null, indent) : JSON.stringify(data);
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeFileSync(fd, body, 'utf8');
    fs.fsyncSync(fd);
  } catch (err) {
    fs.closeSync(fd);
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  fs.closeSync(fd);
  try {
    fs.renameSync(tmp, filePath);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  fsyncDir(dir);
  return Buffer.byteLength(body);
}

/** Free bytes available to this process on the filesystem holding `p` (null if unknown). */
export function freeDiskBytes(p: string): number | null {
  try {
    const s = fs.statfsSync(p);
    return s.bavail * s.bsize;
  } catch {
    return null;
  }
}
