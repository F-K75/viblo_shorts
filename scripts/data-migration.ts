// JSON -> PostgreSQL data migration CLI (see docs/BACKUP_AND_RECOVERY.md, "Cut-over runbook").
//
//   npm run data-migration -- plan               dry run: full migration + verification inside a transaction,
//                                                then ROLLBACK; prints the report. Changes nothing.
//   npm run data-migration -- migrate            the real migration (JSON server must be stopped). Takes a
//                                                verified JSON snapshot first. Idempotent: safe to re-run.
//   npm run data-migration -- export <new-dir>   rollback: write the whole PostgreSQL state into a NEW empty
//                                                directory in the Phase 1 JSON layout (verified).
//
// Env: DATA_DIR (JSON source), BACKUP_DIR, DATABASE_URL (target). Never modifies or deletes the JSON source.
import path from 'path';
import { fileURLToPath } from 'url';
import { createPool } from '../server/db/pool.ts';
import { migrate } from '../server/db/migrate.ts';
import { exportPostgresToJson, loadJsonSource, migrateJsonToPostgres } from '../server/db/dataMigration.ts';
import { createSnapshot, serverRunningReason } from '../server/lib/backup.ts';
import { ProjectStore } from '../server/lib/projectStore.ts';
import fs from 'fs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(root, 'data'));
const BACKUP_DIR = path.resolve(process.env.BACKUP_DIR || path.join(DATA_DIR, 'backups'));
const DATABASE_URL = process.env.DATABASE_URL || '';
const [cmd, arg, ...rest] = process.argv.slice(2);
const force = [arg, ...rest].includes('--force');
const NO_LIMITS = { maxProjectBytes: Infinity, guestMaxProjects: Infinity, guestMaxBytes: Infinity, userMaxProjects: Infinity, userMaxBytes: Infinity, guestPoolMaxBytes: Infinity, totalMaxBytes: Infinity, minFreeDiskBytes: 0 };

async function main() {
  if (!DATABASE_URL) throw new Error('DATABASE_URL is required');
  const db = createPool(DATABASE_URL, { max: 2, applicationName: 'forge-data-migration' });
  try {
    await migrate(db); // schema first (idempotent, advisory-locked)
    if (cmd === 'plan' || cmd === 'migrate') {
      const dryRun = cmd === 'plan';
      if (!dryRun) {
        const running = serverRunningReason(DATA_DIR);
        if (running && !force) throw new Error(`the JSON server may still be writing (${running}). Stop it first so no write is missed.`);
      }
      if (fs.existsSync(path.join(DATA_DIR, 'projects.json')) && !fs.existsSync(path.join(DATA_DIR, 'projects.migrated.json'))) {
        if (dryRun) throw new Error('legacy projects.json not yet converted; run `migrate` (it converts with a verified snapshot) or start the Phase 1 server once');
        const conv = new ProjectStore(DATA_DIR, BACKUP_DIR, NO_LIMITS);
        conv.init();
        if (!conv.status().available) throw new Error(`legacy conversion failed: ${conv.status().reason}`);
      }
      const snapshot = dryRun ? undefined : createSnapshot(DATA_DIR, BACKUP_DIR, 'pre-pg-migration').name;
      const report = await migrateJsonToPostgres(db, loadJsonSource(DATA_DIR), { dryRun, snapshot });
      console.log(JSON.stringify({ ...report, snapshot }, null, 2));
      if (!report.verification.ok) process.exitCode = 1;
    } else if (cmd === 'export') {
      if (!arg || arg.startsWith('--')) throw new Error('usage: export <new-empty-dir>');
      console.log(JSON.stringify(await exportPostgresToJson(db, path.resolve(arg)), null, 2));
    } else {
      throw new Error('usage: data-migration <plan|migrate [--force]|export <new-dir>>');
    }
  } finally {
    await db.end();
  }
}

main().catch((err) => {
  console.error(`data-migration ${cmd ?? ''} failed: ${err?.message || err}`);
  process.exit(1);
});
