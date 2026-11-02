// Encrypted off-site PostgreSQL backup CLI (docs/BACKUP_AND_RECOVERY.md).
//
//   npm run db-backup -- create                    pg_dump | age (public keys) -> BACKUP_TARGET (+ manifest)
//   npm run db-backup -- list
//   npm run db-backup -- verify <name>             download + SHA-256 check (no key needed)
//   npm run db-backup -- restore <name>            decrypt (BACKUP_AGE_IDENTITY_FILE) into RESTORE_DATABASE_URL (an EMPTY
//                                                  database) in one transaction, then verify row counts
//   npm run db-backup -- verify-restore <name>    compare RESTORE_DATABASE_URL with the backup's manifest (read-only):
//                                                  state empty | complete | mismatch (exit 0 only for complete)
//   npm run db-backup -- prune <keepDays>          delete older backups (keeps the newest 3); prefer bucket lifecycle rules
//
// Env: DATABASE_URL, BACKUP_TARGET=s3://bucket/prefix, S3_ENDPOINT/S3_REGION + AWS credentials,
//      BACKUP_AGE_RECIPIENTS=age1...,age1...  (create)   BACKUP_AGE_IDENTITY_FILE=/secure/key.txt (restore)
//      RESTORE_DATABASE_URL (restore target). Database URLs are only ever read from the environment: command-line
//      arguments are visible to every user on the host (ps, /proc/<pid>/cmdline).
import { createBackup, listBackups, offsiteConfigFromEnv, pruneBackups, restoreBackup, verifyBackup, verifyRestoredDatabase } from '../server/db/offsiteBackup.ts';

const [cmd, a, b] = process.argv.slice(2);
const cfg = offsiteConfigFromEnv();

async function main() {
  switch (cmd) {
    case 'create': {
      if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
      const recipients = (process.env.BACKUP_AGE_RECIPIENTS || '').split(',').map((s) => s.trim()).filter(Boolean);
      const m = await createBackup(process.env.DATABASE_URL, cfg, recipients);
      console.log(JSON.stringify({ created: m.name, bytes: m.bytes, sha256: m.sha256, rowCounts: m.rowCounts, durationMs: m.durationMs }, null, 2));
      break;
    }
    case 'list':
      console.log(JSON.stringify((await listBackups(cfg)).map(({ name, createdAt, bytes, schemaVersion, rowCounts }) => ({ name, createdAt, bytes, schemaVersion, rowCounts })), null, 2));
      break;
    case 'verify':
      if (!a) throw new Error('usage: verify <name>');
      console.log(JSON.stringify(await verifyBackup(cfg, a), null, 2));
      break;
    case 'restore': {
      // F3: never accept the target (it carries a password) as an argument, and never echo what was passed
      if (b !== undefined || process.argv.length > 5) {
        throw new Error('restore takes only the backup name; pass the target database through the RESTORE_DATABASE_URL environment variable (never on the command line)');
      }
      if (!a) throw new Error('usage: RESTORE_DATABASE_URL=<empty database url> db-backup restore <name>');
      const targetUrl = process.env.RESTORE_DATABASE_URL;
      if (!targetUrl) throw new Error('RESTORE_DATABASE_URL (an empty target database) is required');
      const r = await restoreBackup(cfg, a, targetUrl, process.env.BACKUP_AGE_IDENTITY_FILE || '');
      console.log(JSON.stringify(r, null, 2));
      if (!r.verified) process.exitCode = 1;
      break;
    }
    case 'verify-restore': {
      if (b !== undefined) throw new Error('verify-restore takes only the backup name; the database comes from RESTORE_DATABASE_URL');
      if (!a) throw new Error('usage: RESTORE_DATABASE_URL=<db url> db-backup verify-restore <name>');
      if (!process.env.RESTORE_DATABASE_URL) throw new Error('RESTORE_DATABASE_URL is required');
      const r = await verifyRestoredDatabase(cfg, a, process.env.RESTORE_DATABASE_URL);
      console.log(JSON.stringify(r, null, 2));
      if (r.state !== 'complete') process.exitCode = 1;
      break;
    }
    case 'prune':
      if (!a || !(Number(a) >= 1)) throw new Error('usage: prune <keepDays>=1+>');
      console.log(JSON.stringify({ removed: await pruneBackups(cfg, Number(a)) }, null, 2));
      break;
    default:
      throw new Error('usage: db-backup <create|list|verify <name>|restore <name>|verify-restore <name> (database: RESTORE_DATABASE_URL)|prune <days>>');
  }
}

main().catch((err) => {
  console.error(`db-backup ${cmd ?? ''} failed: ${err?.message || err}`);
  process.exit(1);
});
