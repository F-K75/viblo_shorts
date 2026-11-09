// Track D-1 review R5 (owner requirement 2026-11-09): concurrent-load measurement of /api/auth/guest refusals and
// successful mints, healthy database and slow refusal-stat writes. A measurement, not a pass/fail test.
//   node --import tsx scripts/load/guest-refusal-concurrency.mts <label>
// Needs TEST_DATABASE_URL (a PostgreSQL the test helpers can create databases in). Throwaway server, database and
// CAPTCHA stub; nothing else is touched. Pool size: the production default (DATABASE_POOL_MAX=10).
import crypto from 'node:crypto';
import pg from 'pg';
import { startTestServer, HEALTH_TOKEN } from '../../tests/helpers/server.ts';
import { createTestDatabase } from '../../tests/helpers/pg.ts';
import { startTurnstileStub } from '../../tests/helpers/turnstileStub.ts';

const label = process.argv[2] || 'run';
const PHASE_MS = Number(process.env.PHASE_MS || 8000);
const SLOW_MS = Number(process.env.SLOW_MS || 300);
const secret = `s-${crypto.randomBytes(6).toString('hex')}`;
const stub = await startTurnstileStub({ secret, hostname: 'forge.test' });
const db = await createTestDatabase({ migrate: false });
await db.pool.end();
const s = await startTestServer({
  DATABASE_URL: db.url, DATABASE_POOL_MAX: '10', CAPTCHA_REQUIRED: 'true', TURNSTILE_SECRET: secret, TURNSTILE_SITE_KEY: 'k',
  TURNSTILE_HOSTNAMES: 'forge.test', TURNSTILE_VERIFY_URL: stub.url, TRUST_PROXY: '1', BACKUP_INTERVAL_HOURS: '0', GUEST_MINT_PER_IP_PER_HOUR: '1',
});
const admin = new pg.Client({ connectionString: db.url });
await admin.connect();
let ipn = 0;
const ip = () => { ipn++; return `10.${(ipn >> 16) & 255}.${(ipn >> 8) & 255}.${ipn & 255}`; };
const ok = () => ({ 'cf-turnstile-response': `ok-${crypto.randomBytes(9).toString('hex')}` });
type Sample = { cls: string; status: number; ms: number };
async function post(cls: string, body: object, addr: string, out: Sample[]) {
  const t = performance.now();
  let status = 0;
  try {
    const r = await fetch(`${s.baseUrl}/api/auth/guest`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': addr }, body: JSON.stringify(body) });
    await r.arrayBuffer();
    status = r.status;
  } catch {
    status = -1;
  }
  out.push({ cls, status, ms: performance.now() - t });
  return status;
}
async function phase(name: string) {
  const out: Sample[] = [];
  const end = Date.now() + PHASE_MS;
  let peakConn = 0;
  const sampler = setInterval(async () => {
    try {
      const n = Number((await admin.query("SELECT count(*) AS n FROM pg_stat_activity WHERE datname = current_database() AND application_name LIKE 'forge-studio:%'")).rows[0].n);
      peakConn = Math.max(peakConn, n);
    } catch {}
  }, 200);
  // The server's own pool, from /api/health/details: 'waiting' = requests queued for a connection; 'latencyMs' = a
  // SELECT 1 through the same pool, i.e. the time to obtain a connection (plus a trivial query).
  const poolWaiting: number[] = [];
  const acquireMs: number[] = [];
  const poolSampler = setInterval(async () => {
    try {
      const d: any = await (await fetch(`${s.baseUrl}/api/health/details`, { headers: { authorization: `Bearer ${HEALTH_TOKEN}` } })).json();
      const st = d?.checks?.stores ?? d?.store ?? d;
      const found = JSON.stringify(d).match(/"latencyMs":(\d+)[^}]*"pool":\{"total":(\d+),"idle":(\d+),"waiting":(\d+)\}/);
      if (found) {
        acquireMs.push(Number(found[1]));
        poolWaiting.push(Number(found[4]));
      }
      void st;
    } catch {}
  }, 1100); // /api/health/details is rate-limited (probeLimit 60 per minute)
  const refusers = Array.from({ length: 15 }, async () => { while (Date.now() < end) await post('refusal_no_token', {}, ip(), out); });
  const ipLimited = Array.from({ length: 5 }, async () => { while (Date.now() < end) { const a = ip(); await post('mint_before_ip_refusal', ok(), a, out); await post('refusal_ip_limited', ok(), a, out); } });
  const minters = Array.from({ length: 5 }, async () => { while (Date.now() < end) await post('successful_mint', ok(), ip(), out); });
  await Promise.all([...refusers, ...ipLimited, ...minters]);
  clearInterval(sampler);
  clearInterval(poolSampler);
  const classes = [...new Set(out.map((x) => x.cls))].sort();
  for (const cls of classes) {
    const xs = out.filter((x) => x.cls === cls);
    const ms = xs.map((x) => x.ms).sort((a, b) => a - b);
    const pct = (p: number) => ms[Math.min(ms.length - 1, Math.floor(ms.length * p))].toFixed(1);
    const st: Record<string, number> = {};
    for (const x of xs) st[x.status] = (st[x.status] || 0) + 1;
    console.log(`${label} ${name} ${cls.padEnd(24)} n=${String(xs.length).padStart(5)} rate=${(xs.length / (PHASE_MS / 1000)).toFixed(1)}/s p50=${pct(0.5)}ms p95=${pct(0.95)}ms p99=${pct(0.99)}ms max=${ms.at(-1)!.toFixed(1)}ms statuses=${JSON.stringify(st)}`);
  }
  console.log(`${label} ${name} total=${out.length} req/s=${(out.length / (PHASE_MS / 1000)).toFixed(0)} 5xx_or_network=${out.filter((x) => x.status >= 500 || x.status < 0).length} peak_app_db_connections=${peakConn}`);
  const q = (xs: number[], p: number) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))] : NaN);
  console.log(`${label} ${name} pool samples=${poolWaiting.length} waiting p50=${q(poolWaiting, 0.5)} p95=${q(poolWaiting, 0.95)} p99=${q(poolWaiting, 0.99)} max=${Math.max(...poolWaiting)}; connection-acquire (SELECT 1 via the app pool) p50=${q(acquireMs, 0.5)}ms p95=${q(acquireMs, 0.95)}ms p99=${q(acquireMs, 0.99)}ms max=${Math.max(...acquireMs)}ms`);
}
try {
  await phase('healthy');
  await admin.query(`CREATE FUNCTION r5_slow_stat() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF starts_with(NEW.key, 'stats:guest-reject:') OR starts_with(NEW.key, 'stats:guest-network-') THEN PERFORM pg_sleep(${SLOW_MS / 1000}); END IF; RETURN NEW; END $$`);
  // INSERT only: the delay happens before the conflict check, without holding the counter row's lock (a slow
  // database, not artificial lock serialization).
  await admin.query('CREATE TRIGGER r5_slow_stat BEFORE INSERT ON window_counters FOR EACH ROW EXECUTE FUNCTION r5_slow_stat()');
  await phase(`slow-stat-${SLOW_MS}ms`);
  await new Promise((r) => setTimeout(r, SLOW_MS * 4)); // let pending fire-and-forget writes (pre-fix) drain
  const lost = (await admin.query("SELECT key, count FROM window_counters WHERE key LIKE 'stats:guest-reject:%' ORDER BY key")).rows;
  console.log(`${label} recorded refusal stats: ${JSON.stringify(lost)}`);
} finally {
  await admin.end().catch(() => {});
  await s.stop();
  await stub.close();
  await db.drop().catch(() => {});
}
