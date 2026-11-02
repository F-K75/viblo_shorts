// Operator CLI for data snapshots.
//
//   npm run backup -- create            take a verified snapshot now
//   npm run backup -- list              list snapshots (oldest first)
//   npm run backup -- verify <name>     re-hash a snapshot against its manifest
//   npm run backup -- restore <name>    restore, all-or-nothing (server must be stopped; current data is
//                                       snapshotted and moved aside, never deleted). --force only overrides a
//                                       lock written by ANOTHER host; a running local server always blocks.
//                                       --allow-unparseable restores corrupt store files kept as evidence.
//   npm run backup -- recover           finish an interrupted restore by rolling back to the data that was live
//                                       before it (the server refuses to start until this is done)
//
// Uses the same DATA_DIR / BACKUP_DIR environment variables as the server.
import path from 'path';
import { fileURLToPath } from 'url';
import { createSnapshot, listSnapshots, recoverInterruptedRestore, restoreSnapshot, verifySnapshotDir } from '../server/lib/backup.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(root, 'data'));
const BACKUP_DIR = path.resolve(process.env.BACKUP_DIR || path.join(DATA_DIR, 'backups'));

const [cmd, name, ...rest] = process.argv.slice(2);
const force = rest.includes('--force') || name === '--force';
const allowUnparseable = rest.includes('--allow-unparseable');

function snapDir(n?: string) {
  if (!n || !/^snap-[A-Za-z0-9-]+$/.test(n)) {
    console.error('Snapshot name required (see `list`).');
    process.exit(2);
  }
  return path.join(BACKUP_DIR, n);
}

try {
  switch (cmd) {
    case 'create': {
      const m = createSnapshot(DATA_DIR, BACKUP_DIR, 'manual');
      console.log(JSON.stringify({ created: m.name, files: m.files.length, bytes: m.totalBytes, unparseable: m.files.filter((f) => !f.parseOk).map((f) => f.path) }, null, 2));
      break;
    }
    case 'list':
      console.log(JSON.stringify(listSnapshots(BACKUP_DIR).map(({ dir: _d, ...s }) => s), null, 2));
      break;
    case 'verify': {
      const problems = verifySnapshotDir(snapDir(name));
      console.log(problems.length ? `FAILED:\n  ${problems.join('\n  ')}` : `OK: ${name} verified`);
      process.exit(problems.length ? 1 : 0);
    }
    // falls through (unreachable)
    case 'restore': {
      const r = restoreSnapshot(DATA_DIR, BACKUP_DIR, snapDir(name), { force, allowUnparseable });
      console.log(JSON.stringify({ restoredFrom: name, ...r }, null, 2));
      break;
    }
    case 'recover': {
      const r = recoverInterruptedRestore(DATA_DIR);
      console.log(JSON.stringify(r.state === 'none' ? { state: 'none', message: 'no interrupted restore found' } : { ...r, message: 'the data that was live before the interrupted restore is back in place' }, null, 2));
      break;
    }
    default:
      console.error('Usage: backup <create|list|verify <name>|restore <name> [--force] [--allow-unparseable]|recover>');
      process.exit(2);
  }
} catch (err: any) {
  console.error(`backup ${cmd} failed: ${err?.message || err}`);
  process.exit(1);
}
