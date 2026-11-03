// D2 test fixture (CI only; not part of the image). Runs a REAL snapshot restore inside the container and kills the
// process with SIGKILL in the middle of the swap (after the second live entry was moved aside), leaving a genuine
// unfinished-restore journal behind, exactly as a crash or OOM kill would. Same technique as
// tests/restore_atomic.test.ts. Usage (inside the image): node --import tsx kill-restore-midswap.mts <snapshot-name>
import fs from 'node:fs';
import path from 'node:path';
import { restoreSnapshot } from '/app/server/lib/backup.ts';

const DATA_DIR = process.env.DATA_DIR || '/data';
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(DATA_DIR, 'backups');
const real = fs.renameSync;
let n = 0;
(fs as any).renameSync = (a: string, b: string) => {
  if (String(b).includes('.pre-restore-') && ++n === 2) process.kill(process.pid, 'SIGKILL');
  return real(a, b);
};
restoreSnapshot(DATA_DIR, BACKUP_DIR, path.join(BACKUP_DIR, process.argv[2]));
console.error('restore finished without being killed (the fixture did not trigger)');
process.exit(3);
