// Track A (R-03): guest registration protection. Red-first regression tests, written before the implementation.
//
// Contract under test (POST /api/auth/guest, body {"cf-turnstile-response": <token>}):
//   403 captcha_required    no token
//   403 captcha_failed      provider says invalid, wrong hostname, wrong action, or token too old
//   403 captcha_replayed    the token was already redeemed (on any instance)
//   503 captcha_unavailable provider timeout / 5xx / malformed / unreachable (Retry-After); ONLY new guests affected
//   429 guest_rate_limited  device (cookie) / IP / IPv4 /24 / IPv6 /48 budget spent (Retry-After, scope)
//   429 guest_capacity      optional hard ceiling GUEST_MINT_HARD_PER_HOUR (disabled unless configured)
// The global soft threshold (GUEST_MINT_SOFT_PER_HOUR) alerts and tightens budgets but never rejects a verified mint.
// Device cookie: __Host-fs_dev, opaque 128-bit random, Secure, HttpOnly, SameSite=Lax, Path=/, no Domain, 1 year;
// only its SHA-256 is used as a rate-limit key.
import { test, describe, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';
import { startTestServer, healthDetails, type TestServer } from './helpers/server.ts';
import { createTestDatabase, pgSkip } from './helpers/pg.ts';
import { startTurnstileStub } from './helpers/turnstileStub.ts';

// Servers, stubs and databases are torn down after EACH test. With every server on PostgreSQL
// (TEST_STORAGE_BACKEND=postgres) each one holds a connection pool; keeping ~20 of them alive until the end of the file
// exhausted the database's max_connections (100) and later tests got 503 database_unavailable (gate on 07dd7ef).
const cleanups: Array<() => Promise<unknown>> = [];
const runCleanups = async () => {
  for (const c of cleanups.splice(0).reverse()) await c().catch(() => {});
};
afterEach(runCleanups);
after(runCleanups);

const SECRET = `test-turnstile-secret-${crypto.randomBytes(12).toString('hex')}`;
const HOST = 'forge.test';
const SITE_KEY = '1x-test-site-key-forge';
const SESSION_SECRET = crypto.randomBytes(32).toString('hex');

async function stub() {
  const s = await startTurnstileStub({ secret: SECRET, hostname: HOST });
  cleanups.push(() => s.close());
  return s;
}
const captchaEnv = (verifyUrl: string): Record<string, string> => ({
  CAPTCHA_REQUIRED: 'true',
  TURNSTILE_SECRET: SECRET,
  TURNSTILE_SITE_KEY: SITE_KEY,
  TURNSTILE_HOSTNAMES: HOST,
  TURNSTILE_VERIFY_URL: verifyUrl,
  TURNSTILE_TIMEOUT_MS: '800',
  TRUST_PROXY: '1',
  BACKUP_INTERVAL_HOURS: '0',
  SESSION_SECRET,
});
async function boot(env: Record<string, string>) {
  const s = await startTestServer(env);
  cleanups.push(() => s.stop());
  return s;
}
const tok = (kind: 'ok' | 'bad' | 'host' | 'act' | 'old' = 'ok') => `${kind}-${crypto.randomBytes(9).toString('hex')}`;
let ipSeq = 0;
/** A fresh IPv4 address in its own /24 (so per-IP and per-subnet budgets never interfere unless a test wants them to). */
const freshIp = () => {
  ipSeq++;
  return `10.${(ipSeq >> 8) & 255}.${ipSeq & 255}.7`;
};
interface Mint {
  status: number;
  code?: string;
  scope?: string;
  token?: string;
  setCookie: string | null;
  retryAfter: string | null;
  ms: number;
}
async function mint(s: TestServer, o: { token?: string | null; ip?: string; xff?: string; cookie?: string } = {}): Promise<Mint> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (o.xff !== undefined) headers['x-forwarded-for'] = o.xff;
  else headers['x-forwarded-for'] = o.ip ?? freshIp();
  if (o.cookie) headers.cookie = `__Host-fs_dev=${o.cookie}`;
  const body = o.token === null ? {} : { 'cf-turnstile-response': o.token ?? tok() };
  const t0 = Date.now();
  const r = await fetch(`${s.baseUrl}/api/auth/guest`, { method: 'POST', headers, body: JSON.stringify(body) });
  const j: any = await r.json().catch(() => ({}));
  return { status: r.status, code: j.code, scope: j.scope, token: j.token, setCookie: r.headers.get('set-cookie'), retryAfter: r.headers.get('retry-after'), ms: Date.now() - t0 };
}
const statuses = (ms: Mint[]) => ms.map((m) => `${m.status}${m.code ? `/${m.code}` : ''}`).join(',');
const okCount = (ms: Mint[]) => ms.filter((m) => m.status === 200).length;
const api = (s: TestServer, p: string, token: string, init: RequestInit = {}) =>
  fetch(`${s.baseUrl}${p}`, { ...init, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init.headers as any) } });
const cookieValue = (setCookie: string | null) => /__Host-fs_dev=([^;]*)/.exec(setCookie || '')?.[1];

// ---------------------------------------------------------------- A1: flood and verified-user lockout
describe('A1: guest registration flood and verified-user lockout', () => {
  test('without a valid CAPTCHA token nobody is minted', async () => {
    const v = await stub();
    const s = await boot(captchaEnv(v.url));
    const none = await Promise.all(Array.from({ length: 20 }, () => mint(s, { token: null })));
    assert.ok(none.every((m) => m.status === 403 && m.code === 'captcha_required'), statuses(none));
    const bad = await Promise.all(Array.from({ length: 10 }, () => mint(s, { token: tok('bad') })));
    assert.ok(bad.every((m) => m.status === 403 && m.code === 'captcha_failed'), statuses(bad));
    assert.ok([...none, ...bad].every((m) => !m.token), 'no guest token was issued');
    assert.equal((await healthDetails(s.baseUrl)).guestMints.thisHour, 0, 'nothing was minted');
  });

  test('an attacker exhausting the global hourly budget no longer locks out a CAPTCHA-verified newcomer (soft threshold alerts instead)', async () => {
    const v = await stub();
    // GUEST_MINT_PER_HOUR is the old name of the global budget; on the old code it is a hard reject.
    const s = await boot({ ...captchaEnv(v.url), GUEST_MINT_PER_HOUR: '20', GUEST_MINT_SOFT_PER_HOUR: '20' });
    const attacker: Mint[] = [];
    for (let i = 0; i < 25; i++) attacker.push(await mint(s)); // rotating IPs, each solving a CAPTCHA
    const victim = await mint(s);
    assert.equal(victim.status, 200, `verified newcomer after the flood: ${statuses([victim])} (attacker: ${statuses(attacker)})`);
    assert.equal(okCount(attacker), 25, 'the soft threshold never rejects a verified mint');
    const h = await healthDetails(s.baseUrl);
    assert.equal(h.guestMints.softThresholdTripped, true);
    assert.match(s.logs(), /"event":"guest_mint_soft_threshold"/, 'an alert is raised');
    const signedIn = s.signFirebaseToken({ sub: 'a1-verified' });
    assert.equal((await api(s, '/api/projects', signedIn)).status, 200, 'signed-in users are never affected');
  });
});

// ---------------------------------------------------------------- A2: server-side verification
describe('A2: server-side Turnstile verification', () => {
  test('missing, invalid, wrong-hostname, wrong-action and expired tokens are refused; the provider sees the secret and the client IP', async () => {
    const v = await stub();
    const s = await boot(captchaEnv(v.url));
    assert.equal((await mint(s, { token: null })).code, 'captcha_required');
    assert.equal(v.calls.length, 0, 'no provider call without a token');
    for (const kind of ['bad', 'host', 'act', 'old'] as const) {
      const m = await mint(s, { token: tok(kind) });
      assert.deepEqual([m.status, m.code], [403, 'captcha_failed'], `${kind}: ${statuses([m])}`);
      assert.equal(m.token, undefined);
    }
    const ip = '198.51.100.23';
    const good = await mint(s, { ip });
    assert.equal(good.status, 200, statuses([good]));
    assert.match(good.token!, /^guest\./);
    const last = v.calls.at(-1)!;
    assert.equal(last.secret, SECRET, 'the secret is sent to the provider (and only there)');
    assert.equal(last.remoteip, ip, 'remoteip is the trusted client address');
    const me = await (await api(s, '/api/auth/me', good.token!)).json();
    assert.equal(me.kind, 'guest');
  });
});

// ---------------------------------------------------------------- A3: single use, across instances
describe('A3: CAPTCHA tokens are single-use', () => {
  test('one instance: a token works once; 20 concurrent uses of one token mint exactly one guest', async () => {
    const v = await stub();
    const s = await boot(captchaEnv(v.url));
    const t = tok();
    assert.equal((await mint(s, { token: t })).status, 200);
    const again = await mint(s, { token: t });
    assert.deepEqual([again.status, again.code], [403, 'captcha_replayed']);
    const t2 = tok();
    const burst = await Promise.all(Array.from({ length: 20 }, () => mint(s, { token: t2 })));
    assert.equal(okCount(burst), 1, statuses(burst));
    assert.ok(burst.filter((m) => m.status !== 200).every((m) => m.code === 'captcha_replayed'), statuses(burst));
  });

  test('two instances on one database: 30 concurrent uses of one token across both mint exactly one guest', { skip: pgSkip }, async () => {
    const v = await stub();
    const db = await createTestDatabase({ migrate: false });
    cleanups.push(() => db.drop());
    const env = { ...captchaEnv(v.url), DATABASE_URL: db.url };
    const A = await boot(env);
    const B = await boot(env);
    const t = tok();
    const burst = await Promise.all(Array.from({ length: 30 }, (_, i) => mint(i % 2 ? A : B, { token: t })));
    assert.equal(okCount(burst), 1, statuses(burst));
    assert.ok(burst.filter((m) => m.status !== 200).every((m) => m.code === 'captcha_replayed'), statuses(burst));
    assert.equal((await mint(B)).status, 200, 'a fresh token still works');
  });
});

// ---------------------------------------------------------------- A4: hierarchical budgets
const BUDGETS = { GUEST_MINT_PER_IP_PER_HOUR: '5', GUEST_MINT_PER_SUBNET_PER_HOUR: '8', GUEST_MINT_PER_DEVICE_PER_DAY: '3' };
async function budgetScenarios(servers: TestServer[]) {
  const pick = (i: number) => servers[i % servers.length];
  // per IP: 50 concurrent from one address
  const ip = await Promise.all(Array.from({ length: 50 }, (_, i) => mint(pick(i), { ip: '198.51.100.77' })));
  assert.equal(okCount(ip), 5, `per-IP budget: ${statuses(ip)}`);
  assert.ok(ip.some((m) => m.code === 'guest_rate_limited' && m.scope === 'ip' && Number(m.retryAfter) > 0), statuses(ip));
  // per IPv4 /24: 50 concurrent from 50 addresses of one /24
  const v4 = await Promise.all(Array.from({ length: 50 }, (_, i) => mint(pick(i), { ip: `203.0.113.${i + 1}` })));
  assert.equal(okCount(v4), 8, `per-/24 budget: ${statuses(v4)}`);
  assert.ok(v4.some((m) => m.scope === 'subnet'), statuses(v4));
  // per IPv6 /48: 50 concurrent from 50 different /64s inside one /48
  const v6 = await Promise.all(Array.from({ length: 50 }, (_, i) => mint(pick(i), { ip: `2001:db8:abcd:${(i + 1).toString(16)}::1` })));
  assert.equal(okCount(v6), 8, `per-/48 budget: ${statuses(v6)}`);
  assert.equal((await mint(pick(0), { ip: '2001:db8:abce::1' })).status, 200, 'another /48 is unaffected');
  // IPv4-mapped IPv6 counts as the IPv4 address (same /24 as plain IPv4)
  const mapped = await Promise.all([
    ...Array.from({ length: 6 }, (_, i) => mint(pick(i), { ip: `::ffff:192.0.2.${i + 1}` })),
    ...Array.from({ length: 6 }, (_, i) => mint(pick(i + 1), { ip: `192.0.2.${i + 101}` })),
  ]);
  assert.equal(okCount(mapped), 8, `IPv4-mapped IPv6 shares the IPv4 /24 budget: ${statuses(mapped)}`);
  // per device: 50 concurrent with one cookie from 50 unrelated networks
  const device = crypto.randomBytes(16).toString('base64url');
  const dev = await Promise.all(Array.from({ length: 50 }, (_, i) => mint(pick(i), { cookie: device })));
  assert.equal(okCount(dev), 3, `per-device budget: ${statuses(dev)}`);
  assert.ok(dev.some((m) => m.scope === 'device'), statuses(dev));
}
describe('A4: per-device, per-IP, IPv4 /24 and IPv6 /48 budgets', () => {
  test('single instance: each budget holds exactly at N under 50 concurrent requests', async () => {
    const v = await stub();
    await budgetScenarios([await boot({ ...captchaEnv(v.url), ...BUDGETS })]);
  });
  test('two instances on one database: each budget holds exactly at N under 50 concurrent requests', { skip: pgSkip }, async () => {
    const v = await stub();
    const db = await createTestDatabase({ migrate: false });
    cleanups.push(() => db.drop());
    const env = { ...captchaEnv(v.url), ...BUDGETS, DATABASE_URL: db.url };
    await budgetScenarios([await boot(env), await boot(env)]);
  });
});

// ---------------------------------------------------------------- A5: proxy trust boundary
describe('A5: proxy trust boundary', () => {
  test('TRUST_PROXY=1: only the address appended by the trusted proxy counts; a spoofed X-Forwarded-For prefix does not', async () => {
    const v = await stub();
    const s = await boot({ ...captchaEnv(v.url), GUEST_MINT_PER_IP_PER_HOUR: '2' });
    const r: Mint[] = [];
    for (let i = 0; i < 6; i++) r.push(await mint(s, { xff: `${i + 1}.${i + 1}.${i + 1}.${i + 1}, 198.51.100.9` }));
    assert.equal(okCount(r), 2, statuses(r));
    assert.ok(v.calls.every((c) => c.remoteip === '198.51.100.9'), JSON.stringify(v.calls.map((c) => c.remoteip)));
  });
  test('TRUST_PROXY=none: X-Forwarded-For is ignored entirely (every request is the socket address)', async () => {
    const v = await stub();
    const s = await boot({ ...captchaEnv(v.url), TRUST_PROXY: 'none', GUEST_MINT_PER_IP_PER_HOUR: '2' });
    const r: Mint[] = [];
    for (let i = 0; i < 6; i++) r.push(await mint(s, { xff: `198.51.100.${i + 1}` }));
    assert.equal(okCount(r), 2, statuses(r));
  });
});

// ---------------------------------------------------------------- A6: device cookie
describe('A6: device cookie', () => {
  test('__Host-fs_dev is opaque, random, Secure, HttpOnly, SameSite=Lax, Path=/, no Domain, 1 year; reused when sent back', async () => {
    const v = await stub();
    const s = await boot(captchaEnv(v.url));
    const a = await mint(s, { ip: '198.51.100.40' });
    const b = await mint(s, { ip: '198.51.100.40' });
    assert.equal(a.status, 200);
    const attrs = (a.setCookie || '').split(';').map((x) => x.trim());
    const value = cookieValue(a.setCookie);
    assert.match(value || '', /^[A-Za-z0-9_-]{22}$/, `opaque 128-bit base64url value: ${a.setCookie}`);
    for (const want of ['Path=/', 'HttpOnly', 'Secure', 'SameSite=Lax', 'Max-Age=31536000']) assert.ok(attrs.includes(want), `${want} in ${a.setCookie}`);
    assert.ok(!attrs.some((x) => /^domain=/i.test(x)), 'no Domain attribute');
    assert.notEqual(cookieValue(b.setCookie), value, 'same IP and user agent, different value: nothing is derived from them');
    const c = await mint(s, { cookie: value });
    assert.equal(c.status, 200);
    assert.equal(c.setCookie, null, 'a valid cookie is kept, not replaced');
    for (const junk of ['short', 'x'.repeat(300), 'bad value!']) {
      const d = await mint(s, { cookie: junk });
      assert.match(cookieValue(d.setCookie) || '', /^[A-Za-z0-9_-]{22}$/, `invalid cookie ${junk.slice(0, 10)} is replaced`);
    }
  });

  test('PostgreSQL: only SHA-256 of the device value is stored, and no rate-limit key contains the raw value', { skip: pgSkip }, async () => {
    const v = await stub();
    const db = await createTestDatabase({ migrate: false });
    cleanups.push(() => db.drop());
    const s = await boot({ ...captchaEnv(v.url), DATABASE_URL: db.url });
    const device = crypto.randomBytes(16).toString('base64url');
    assert.equal((await mint(s, { cookie: device })).status, 200);
    const c = new pg.Client({ connectionString: db.url });
    await c.connect();
    try {
      const keys = (await c.query('SELECT key FROM window_counters UNION ALL SELECT key FROM rate_buckets')).rows.map((r: any) => r.key as string);
      const hash = crypto.createHash('sha256').update(device).digest('hex');
      assert.ok(keys.some((k) => k.includes(hash)), `a key carries the hash: ${keys.join(' ')}`);
      assert.ok(!keys.some((k) => k.includes(device)), 'the raw device value is never stored');
    } finally {
      await c.end();
    }
  });
});

// ---------------------------------------------------------------- A7: provider outage
describe('A7: CAPTCHA provider outage pauses only new guest registrations', () => {
  test('timeout, 5xx, malformed and unreachable provider: new mints get 503; existing guests and signed-in users keep working; recovery', async () => {
    const v = await stub();
    const s = await boot(captchaEnv(v.url));
    const guest = await mint(s);
    assert.equal(guest.status, 200);
    const user = s.signFirebaseToken({ sub: 'a7-user' });
    for (const mode of ['timeout', '5xx', 'malformed', 'down'] as const) {
      await v.setMode(mode);
      const m = await mint(s);
      assert.deepEqual([m.status, m.code], [503, 'captcha_unavailable'], `${mode}: ${statuses([m])}`);
      assert.ok(Number(m.retryAfter) > 0, 'Retry-After');
      assert.ok(m.ms < 800 + 1500, `${mode}: bounded by the provider timeout (${m.ms} ms)`);
      // existing guest session: identity, project save, AI call
      assert.equal((await api(s, '/api/auth/me', guest.token!)).status, 200, `${mode}: guest /api/auth/me`);
      assert.equal((await api(s, '/api/projects', guest.token!, { method: 'POST', body: JSON.stringify({ title: `during ${mode}` }) })).status, 200, `${mode}: guest saves`);
      assert.equal((await api(s, '/api/generate-script', guest.token!, { method: 'POST', body: JSON.stringify({ topic: 'sleep' }) })).status, 200, `${mode}: guest AI call`);
      // signed-in user
      assert.equal((await api(s, '/api/projects', user, { method: 'POST', body: JSON.stringify({ title: `user during ${mode}` }) })).status, 200, `${mode}: user saves`);
    }
    await v.setMode('normal');
    assert.equal((await mint(s)).status, 200, 'recovers as soon as the provider is back');
    assert.match(s.logs(), /"event":"captcha_provider_unavailable"/);
  });
});

// ---------------------------------------------------------------- A8: configuration, secrets, hard ceiling
describe('A8: configuration, secrets and the optional hard ceiling', () => {
  test('/api/config publishes the site key, never the secret; the secret never appears in logs, errors or diagnostics', async () => {
    const v = await stub();
    const s = await boot(captchaEnv(v.url));
    const cfg = await (await fetch(`${s.baseUrl}/api/config`)).json();
    assert.deepEqual(cfg.features.captcha, { provider: 'turnstile', siteKey: SITE_KEY });
    for (const kind of ['bad', 'host'] as const) await mint(s, { token: tok(kind) });
    await v.setMode('5xx');
    const unavailable = await fetch(`${s.baseUrl}/api/auth/guest`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': freshIp() }, body: JSON.stringify({ 'cf-turnstile-response': tok() }) });
    const texts = [JSON.stringify(cfg), await unavailable.text(), JSON.stringify(await healthDetails(s.baseUrl)), s.logs()];
    assert.ok(texts.every((t) => !t.includes(SECRET)), 'the secret leaks nowhere');
  });

  test('production refuses to start without a Turnstile secret unless CAPTCHA is explicitly disabled, and refuses a non-HTTPS verify URL', async () => {
    const prod = { NODE_ENV: 'production', TRUST_PROXY: 'none', STORAGE_BACKEND: 'json' };
    await assert.rejects(boot(prod), (e: any) => /exited early/.test(e.message) && /TURNSTILE_SECRET/.test(e.message));
    await assert.rejects(boot({ ...prod, TURNSTILE_SECRET: SECRET, TURNSTILE_SITE_KEY: SITE_KEY, TURNSTILE_HOSTNAMES: HOST, TURNSTILE_VERIFY_URL: 'http://127.0.0.1:9/x' }), (e: any) => /TURNSTILE_VERIFY_URL/.test(e.message));
    const off = await boot({ ...prod, CAPTCHA_REQUIRED: 'false' });
    assert.equal((await (await fetch(`${off.baseUrl}/api/config`)).json()).features.captcha, null);
    assert.match(off.logs(), /"event":"captcha_disabled"/, 'running without CAPTCHA is loud');
  });

  test('the hard ceiling is off by default; when configured it refuses new guests only, with a sign-in path', async () => {
    const v = await stub();
    const def = await boot(captchaEnv(v.url));
    assert.equal((await healthDetails(def.baseUrl)).guestMints.hardCeilingPerHour, null, 'no unmeasured ceiling by default');
    const s = await boot({ ...captchaEnv(v.url), GUEST_MINT_HARD_PER_HOUR: '4' });
    const r: Mint[] = [];
    for (let i = 0; i < 6; i++) r.push(await mint(s));
    assert.equal(okCount(r), 4, statuses(r));
    assert.ok(r.slice(4).every((m) => m.status === 429 && m.code === 'guest_capacity'), statuses(r));
    assert.equal((await api(s, '/api/projects', s.signFirebaseToken({ sub: 'a8-user' }))).status, 200, 'signed-in users are not affected');
  });
});

// ---------------------------------------------------------------- A0: baseline measurement
describe('A0: guest-mint baseline measurement', () => {
  test('hourly mint counts (30-day series) and rejection counts by reason are in /api/health/details', async () => {
    const v = await stub();
    const s = await boot(captchaEnv(v.url));
    for (let i = 0; i < 3; i++) assert.equal((await mint(s)).status, 200);
    await mint(s, { token: tok('bad') });
    await mint(s, { token: null });
    const g = (await healthDetails(s.baseUrl)).guestMints;
    assert.equal(g.thisHour, 3);
    assert.ok(Array.isArray(g.series) && g.series.length >= 1 && g.series.length <= 720, 'hourly series, at most 30 days');
    assert.equal(g.series.at(-1).count, 3);
    assert.equal(g.series.at(-1).hour, new Date(Math.floor(Date.now() / 3600000) * 3600000).toISOString());
    assert.equal(g.rejected.captcha_failed, 1);
    assert.equal(g.rejected.captcha_required, 1);
    assert.equal(g.softThresholdPerHour > 0, true);
  });

  test('PostgreSQL: the series is shared by all instances', { skip: pgSkip }, async () => {
    const v = await stub();
    const db = await createTestDatabase({ migrate: false });
    cleanups.push(() => db.drop());
    const env = { ...captchaEnv(v.url), DATABASE_URL: db.url };
    const A = await boot(env);
    const B = await boot(env);
    assert.equal((await mint(A)).status, 200);
    assert.equal((await mint(B)).status, 200);
    assert.equal((await healthDetails(A.baseUrl)).guestMints.thisHour, 2);
  });
});

// ---------------------------------------------------------------- verification additions (written after the implementation)
describe('A-verify: added after the implementation (not red-first)', () => {
  test('a provider configuration error (wrong secret) is an outage for new guests (503 + alert), never blamed on the user (403)', async () => {
    const v = await stub();
    const s = await boot({ ...captchaEnv(v.url), TURNSTILE_SECRET: 'not-the-secret-the-provider-expects' });
    const m = await mint(s);
    assert.deepEqual([m.status, m.code], [503, 'captcha_unavailable'], statuses([m]));
    assert.match(s.logs(), /"event":"captcha_provider_unavailable","reason":"provider_invalid-input-secret"/);
    assert.ok(!s.logs().includes('not-the-secret-the-provider-expects'), 'the configured secret is not logged');
  });

  test('an existing guest keeps working when the hard ceiling refuses new guests', async () => {
    const v = await stub();
    const s = await boot({ ...captchaEnv(v.url), GUEST_MINT_HARD_PER_HOUR: '1' });
    const first = await mint(s);
    assert.equal(first.status, 200);
    assert.equal((await mint(s)).code, 'guest_capacity');
    assert.equal((await api(s, '/api/projects', first.token!, { method: 'POST', body: JSON.stringify({ title: 'still works' }) })).status, 200);
    assert.equal((await api(s, '/api/auth/me', first.token!)).status, 200);
  });

  // The device budget limits a real browser's "clear the token, mint again" loop. A scripted client can always drop or
  // alter its cookie; scripts are held back by the CAPTCHA and the IP / subnet budgets, not by this one.
  test('a padded or decorated device cookie is never trusted as an existing device: it is replaced with a fresh one', async () => {
    const v = await stub();
    const s = await boot({ ...captchaEnv(v.url), GUEST_MINT_PER_DEVICE_PER_DAY: '1' });
    const device = crypto.randomBytes(16).toString('base64url');
    assert.equal((await mint(s, { cookie: device })).status, 200);
    assert.equal((await mint(s, { cookie: device })).scope, 'device', 'the same device is refused');
    for (const variant of [`${device}=`, ` ${device}`, `${device}%00`]) {
      const m = await mint(s, { cookie: variant });
      // a malformed value never matches the 22-character format, so it is treated as a NEW device and replaced
      assert.notEqual(cookieValue(m.setCookie), undefined, `variant ${JSON.stringify(variant)} gets a fresh cookie`);
      assert.notEqual(cookieValue(m.setCookie), device);
    }
  });
});
