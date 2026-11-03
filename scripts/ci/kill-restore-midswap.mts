// D2 test fixture (CI only; not part of the image). Runs a REAL snapshot restore inside the container and kills the
// process with SIGKILL in the middle of the swap, leaving a genuine unfinished-restore journal behind, exactly as a
// crash or OOM kill would. It dies right AFTER the first live entry was moved aside and before the snapshot's entry
// is moved in: the live store is then missing. That works for any number of store entries. Every rename is logged to
// stderr. It must NOT run as the container's PID 1 (the kernel ignores a self-sent SIGKILL there): the guard script
// starts it under tini. Technique as in tests/restore_atomic.test.ts.
// Usage (inside the image): node --import tsx kill-restore-midswap.mts <snapshot-name>
import fs from 'node:fs';
import path from 'node:path';
import { restoreSnapshot } from '/app/server/lib/backup.ts';

const DATA_DIR = process.env.DATA_DIR || '/data';
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(DATA_DIR, 'backups');
const real = fs.renameSync;
let n = 0;
console.error(`fixture: DATA_DIR=${DATA_DIR} entries=${JSON.stringify(fs.readdirSync(DATA_DIR))}`);
(fs as any).renameSync = (a: string, b: string) => {
  console.error(`fixture: rename ${a} -> ${b}`);
  real(a, b);
  if (String(b).includes('.pre-restore-') && ++n === 1) process.kill(process.pid, 'SIGKILL');
};
restoreSnapshot(DATA_DIR, BACKUP_DIR, path.join(BACKUP_DIR, process.argv[2]));
console.error('restore finished without being killed (the fixture did not trigger)');
process.exit(3);
