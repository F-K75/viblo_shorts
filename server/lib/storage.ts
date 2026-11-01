// Minimal JSON-file persistence with atomic writes (write temp file + rename),
// so a crash mid-write can never leave a truncated/corrupt data file.
// NOTE: this is a single-process store. Horizontal scaling requires a real database
// (documented in TECHNICAL_DEBT.md / RELEASE_READINESS_REPORT.md).
import fs from 'fs';
import path from 'path';

export function readJsonFile<T>(filePath: string, fallback: T): T {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
    }
  } catch (err) {
    // Preserve the corrupt file for forensics instead of silently overwriting it later.
    const backup = `${filePath}.corrupt-${Date.now()}`;
    try {
      fs.copyFileSync(filePath, backup);
    } catch {
      // ignore
    }
    console.error(`[Storage] Failed to parse ${filePath}; backed up to ${backup}:`, err);
  }
  return fallback;
}

export function writeJsonFileAtomic<T>(filePath: string, data: T): void {
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, filePath);
}
