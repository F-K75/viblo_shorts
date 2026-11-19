// Concurrency regression suite (validation standard: real PostgreSQL, multiple instances, realistic contention).
// R-02: AI quota reservation and refund deadlocked under concurrent requests sharing one IP key, which produced
// HTTP 500s and LOST refunds (users charged for template fallbacks).
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { startTestServer, type TestServer } from './helpers/server.ts';
import { createTestDatabase, pgSkip, type TestDb } from './helpers/pg.ts';
import { startGeminiStub } from './helpers/geminiStub.ts';

const cleanups: Array<() => Promise<unknown>> = [];
after(async () => {
  for (const c of cleanups.reverse()) await c().catch(() => {});
});
async function freshDb() {
  const d = await createTestDatabase({ migrate: false });
  cleanups.push(() => d.drop());
  return d;
}
async function boot(env: Record<string, string>) {
  const s = await startTestServer(env);
  cleanups.push(() => s.stop());
  return s;
}
async function rows(db: TestDb, sql: string, params: any[] = []) {
  const c = new pg.Client({ connectionString: db.url.replace(/[?&]sslmode=disable/, '') });
  await c.connect();
  try {
    return (await c.query(sql, params)).rows;
  } finally {
    await c.end();
  }
}
const ai = (s: TestServer, token: string, path = '/api/gemini/suggest-hooks') =>
  fetch(`${s.baseUrl}${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ topic: 'sleep' }) });
/** Refunds settle when the response socket closes; wait until counters stop changing. */
async function settled(db: TestDb): Promise<Array<{ key: string; count: number }>> {
  let prev = '';
  for (let i = 0; i < 40; i++) {
    const cur = JSON.stringify(await rows(db, 'SELECT key, count FROM ai_usage_daily ORDER BY key'));
    if (cur === prev) return JSON.parse(cur) as Array<{ key: string; count: number }>;
    prev = cur;
    await new Promise((r) => setTimeout(r, 150));
  }
  return JSON.parse(prev);
}
const errorsIn = (s: TestServer) => s.logs().split('\n').filter((l) => /deadlock|ai_refund_failed|ai_quota_settle_failed|"status":500|Internal server error/i.test(l));

describe('R-02: AI quota under concurrency (two instances, one shared IP)', { skip: pgSkip }, () => {
  test('fallback storm: 80 concurrent AI calls from 16 users behind one IP => no 500s, no lost refunds, nobody charged', async () => {
    const db = await freshDb();
    const A = await boot({ DATABASE_URL: db.url, FREE_DAILY_AI_QUOTA: '50', IP_DAILY_AI_CAP: '10000' });
    const B = await boot({ DATABASE_URL: db.url, FREE_DAILY_AI_QUOTA: '50', IP_DAILY_AI_CAP: '10000' });
    const users = Array.from({ length: 16 }, (_, i) => A.signFirebaseToken({ sub: `storm-${i}` }));
    // 5 calls per user (suggest-hooks: 30/min per user, 120/min per IP) spread over both instances
    const res = await Promise.all(users.flatMap((u, i) => Array.from({ length: 5 }, (_, k) => ai([A, B][(i + k) % 2], u))));
    const statuses = res.map((r) => r.status);
    const bodies = await Promise.all(res.map((r) => r.json()));
    assert.deepEqual([...new Set(statuses)], [200], `statuses: ${statuses.join(',')}`);
    assert.ok(bodies.every((b) => b.isFallback === true), 'no key configured: every response is a labelled fallback');
    const counters = await settled(db);
    assert.deepEqual(counters.filter((c) => c.count !== 0), [], `every reservation refunded: ${JSON.stringify(counters)}`);
    assert.deepEqual([...errorsIn(A), ...errorsIn(B)], [], 'no deadlocks or failed refunds in either instance log');
  });

  test('mixed storm with a real (stubbed) model: charge == successes exactly, refunds never lost, quota never exceeded', async () => {
    const stub = await startGeminiStub();
    cleanups.push(() => stub.close());
    stub.delayMs = 50;
    const db = await freshDb();
    const env = { DATABASE_URL: db.url, GEMINI_API_KEY: 'stub-key-0123456789', GEMINI_BASE_URL: stub.baseUrl, GEMINI_MODELS: 'stub-model', FREE_DAILY_AI_QUOTA: '3', IP_DAILY_AI_CAP: '10000' };
    const A = await boot(env);
    const B = await boot(env);
    const users = Array.from({ length: 10 }, (_, i) => A.signFirebaseToken({ sub: `mixed-${i}` }));
    const res = await Promise.all(users.flatMap((u, i) => Array.from({ length: 6 }, (_, k) => ai([A, B][(i + k) % 2], u))));
    const bodies = await Promise.all(res.map((r) => r.json()));
    const real = res.filter((r, i) => r.status === 200 && bodies[i].isFallback === false).length;
    assert.ok(res.every((r) => r.status === 200 || r.status === 429), `statuses: ${res.map((r) => r.status).join(',')}`);
    assert.equal(real, 30, 'exactly 3 real model results per user');
    assert.equal(stub.calls, 30, 'model called exactly as often as charged');
    const counters = await settled(db);
    for (let i = 0; i < 10; i++) assert.equal(counters.find((c) => c.key === `user:mixed-${i}`)?.count, 3, `user ${i} charged exactly 3`);
    assert.equal(counters.find((c) => c.key.startsWith('ip:'))?.count, 30, 'IP charged only for real results');
    assert.deepEqual([...errorsIn(A), ...errorsIn(B)], []);
  });
});
