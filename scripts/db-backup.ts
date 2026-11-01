// Encrypted off-site PostgreSQL backup CLI (docs/BACKUP_AND_RECOVERY.md).
//
//   npm run db-backup -- create                    pg_dump | age (public keys) -> BACKUP_TARGET (+ manifest)
//   npm run db-backup -- list
//   npm run db-backup -- verify <name>             download + SHA-256 check (no key needed)
//   npm run db-backup -- restore <name> <emptyDbUrl>  decrypt (BACKUP_AGE_IDENTITY_FILE) + pg_restore + row-count check
//   npm run db-backup -- prune <keepDays>          delete older backups (keeps the newest 3); prefer bucket lifecycle rules
//
// Env: DATABASE_URL, BACKUP_TARGET=s3://bucket/prefix, S3_ENDPOINT/S3_REGION + AWS credentials,
//      BACKUP_AGE_RECIPIENTS=age1...,age1...  (create)   BACKUP_AGE_IDENTITY_FILE=/secure/key.txt (restore)
import { createBackup, listBackups, offsiteConfigFromEnv, pruneBackups, restoreBackup, verifyBackup } from '../server/db/offsiteBackup.ts';

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
      if (!a || !b) throw new Error('usage: restore <name> <empty-target-database-url>');
      const r = await restoreBackup(cfg, a, b, process.env.BACKUP_AGE_IDENTITY_FILE || '');
      console.log(JSON.stringify(r, null, 2));
      if (!r.verified) process.exitCode = 1;
      break;
    }
    case 'prune':
      if (!a || !(Number(a) >= 1)) throw new Error('usage: prune <keepDays>=1+>');
      console.log(JSON.stringify({ removed: await pruneBackups(cfg, Number(a)) }, null, 2));
      break;
    default:
      throw new Error('usage: db-backup <create|list|verify <name>|restore <name> <emptyDbUrl>|prune <days>>');
  }
}

main().catch((err) => {
  console.error(`db-backup ${cmd ?? ''} failed: ${err?.message || err}`);
  process.exit(1);
});
