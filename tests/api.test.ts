// Integration tests: real server process, real HTTP, real ffmpeg, real file storage.
// LLM calls are NOT mocked: no GEMINI_API_KEY is passed, so these tests verify the honest
// fallback path. Live-provider behaviour is covered separately in llm.live.test.ts.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startTestServer, guestToken, healthDetails, type TestServer } from './helpers/server.ts';

let srv: TestServer;
let A: string; // alice (guest)
let M: string; // mallory (guest)

const api = (p: string, token?: string, init: RequestInit = {}) => {
  const headers = new Headers(init.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  return fetch(`${srv.baseUrl}${p}`, { ...init, headers });
};
const post = (p: string, token: string | undefined, body: unknown) => api(p, token, { method: 'POST', body: JSON.stringify(body) });

before(async () => {
  srv = await startTestServer();
  A = await guestToken(srv.baseUrl);
  M = await guestToken(srv.baseUrl);
});
after(async () => {
  await srv?.stop();
});

describe('health, readiness, config', () => {
  test('public health is liveness only; diagnostics (services, memory, AI metrics) need the diagnostics token', async () => {
    const r = await api('/api/health');
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { status: 'ok' });
    const d = await healthDetails(srv.baseUrl);
    assert.equal(d.status, 'ok');
    assert.equal(d.services.geminiLlm, 'fallback-engine');
    assert.ok(d.system.heapUsedMb > 0);
    assert.equal(typeof d.ai.calls, 'number');
  });
  test('readiness checks storage, ffmpeg and data stores', async () => {
    const r = await api('/api/ready');
    const d = await r.json();
    assert.equal(r.status, 200, JSON.stringify(d));
    assert.deepEqual(d.checks, { storage: true, ffmpeg: true, stores: true, memory: true }); // memory: Track C guard
  });
  test('config exposes feature flags only (no keys, model names or provider details)', async () => {
    const d = await (await api('/api/config')).json();
    // captcha: the public Turnstile site key when CAPTCHA is required, else null (never the secret; Track A)
    assert.deepEqual(d, { features: { ai: false, stockFootage: false, billing: 'disabled', captcha: null } });
  });
  test('security headers present, x-powered-by removed', async () => {
    const r = await api('/api/health');
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(r.headers.get('x-powered-by'), null);
    assert.ok(r.headers.get('x-request-id'));
  });
});

describe('authentication (P0 regression)', () => {
  test('protected endpoints require a verified token', async () => {
    for (const p of ['/api/projects', '/api/jobs', '/api/quota', '/api/user/subscription']) {
      assert.equal((await api(p)).status, 401, p);
    }
    assert.equal((await post('/api/generate-script', undefined, { topic: 'x' })).status, 401);
  });
  test('spoofed x-user-id header grants nothing', async () => {
    const r = await api('/api/projects', undefined, { headers: { 'x-user-id': 'admin' } });
    assert.equal(r.status, 401);
  });
  test('forged / tampered guest token rejected', async () => {
    assert.equal((await api('/api/projects', A.slice(0, -2) + 'xx')).status, 401);
    assert.equal((await api('/api/projects', 'guest.e30.AAAA')).status, 401);
  });
  test('valid Firebase ID token accepted; wrong audience rejected', async () => {
    const good = srv.signFirebaseToken({ sub: 'firebase-uid-1', email: 'u@example.com', email_verified: true });
    const me = await (await api('/api/auth/me', good)).json();
    assert.deepEqual(me, { success: true, userId: 'firebase-uid-1', kind: 'firebase', isAdmin: false });
    const bad = srv.signFirebaseToken({ sub: 'x', aud: 'someone-elses-project' });
    assert.equal((await api('/api/auth/me', bad)).status, 401);
  });
});

describe('projects: lifecycle and isolation', () => {
  test('create → read → update → duplicate → delete; other users get 404 everywhere', async () => {
    const create = await post('/api/projects', A, {
      title: 'Alice private',
      topic: 'Branding',
      creationMode: 'prompt',
      script: { hook: 'h', title: 't', description: 'd', hashtags: ['#shorts'], beats: [{ id: 'b1', text: 'Hi', visual_keywords: 'x', start_s: 0, end_s: 2, video_url: '' }] },
      userId: 'mallory-injected',
      isAdmin: true,
    });
    assert.equal(create.status, 200);
    const { project } = await create.json();
    assert.match(project.id, /^proj_/);
    assert.notEqual(project.userId, 'mallory-injected', 'client cannot choose owner');
    assert.equal(project.isAdmin, undefined, 'unknown fields dropped');

    assert.equal((await api(`/api/projects/${project.id}`, A)).status, 200);
    assert.equal((await api(`/api/projects/${project.id}`, M)).status, 404);
    assert.equal((await api(`/api/projects/${project.id}`, M, { method: 'DELETE' })).status, 404);
    assert.equal((await post('/api/projects', M, { id: project.id, title: 'pwned' })).status, 404);
    assert.equal((await post(`/api/projects/${project.id}/duplicate`, M, {})).status, 404);

    const mList = await (await api('/api/projects', M)).json();
    assert.deepEqual(mList.projects.map((p: any) => p.id), ['proj_sample_steve_jobs'], 'mallory sees only the sample');

    const upd = await (await post('/api/projects', A, { id: project.id, title: 'Alice renamed' })).json();
    assert.equal(upd.project.title, 'Alice renamed');
    assert.equal(upd.project.createdAt, project.createdAt);

    const dup = await (await post(`/api/projects/${project.id}/duplicate`, A, {})).json();
    assert.notEqual(dup.project.id, project.id);
    assert.equal((await api(`/api/projects/${dup.project.id}`, A, { method: 'DELETE' })).status, 200);
    assert.equal((await api(`/api/projects/${project.id}`, A, { method: 'DELETE' })).status, 200);
    assert.equal((await api(`/api/projects/${project.id}`, A)).status, 404);
  });

  test('sample project is readable, duplicable, but read-only', async () => {
    assert.equal((await api('/api/projects/proj_sample_steve_jobs', M)).status, 200);
    assert.equal((await post('/api/projects', M, { id: 'proj_sample_steve_jobs', title: 'x' })).status, 409);
    assert.equal((await api('/api/projects/proj_sample_steve_jobs', M, { method: 'DELETE' })).status, 400);
    const dup = await post('/api/projects/proj_sample_steve_jobs/duplicate', M, {});
    assert.equal(dup.status, 200);
    assert.equal((await dup.json()).project.isSample, undefined);
  });

  test('validation: missing title, bad id, bad beats, oversized, malformed JSON', async () => {
    assert.equal((await post('/api/projects', A, {})).status, 400);
    assert.equal((await post('/api/projects', A, { title: 'x', id: '../../etc' })).status, 400);
    assert.equal((await post('/api/projects', A, { title: 'x', script: { beats: 'no' } })).status, 400);
    assert.equal((await post('/api/projects', A, { title: 'x', captionStyle: { pad: 'A'.repeat(600_000) } })).status, 413);
    const bad = await api('/api/projects', A, { method: 'POST', body: '{bad', headers: { 'content-type': 'application/json' } });
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).error, 'Malformed JSON body');
  });

  test('storage files never contain temp leftovers', () => {
    assert.ok(!fs.readdirSync(srv.dataDir).some((f) => f.endsWith('.tmp')));
  });

  test('POST /api/projects/claim transfers guest projects to signed-in user and enforces isolation', async () => {
    const fb1 = srv.signFirebaseToken({ sub: 'firebase-claim-1', email: 'c1@example.com', email_verified: true });
    const fb2 = srv.signFirebaseToken({ sub: 'firebase-claim-2', email: 'c2@example.com', email_verified: true });

    // Unauthenticated and guest callers are rejected
    assert.equal((await post('/api/projects/claim', undefined, { guestToken: A })).status, 401);
    const guestAttempt = await post('/api/projects/claim', A, { guestToken: M });
    assert.equal(guestAttempt.status, 403);
    assert.equal((await guestAttempt.json()).code, 'sign_in_required');

    // Missing, forged, or non-guest tokens are rejected
    assert.equal((await post('/api/projects/claim', fb1, {})).status, 400);
    assert.equal((await post('/api/projects/claim', fb1, { guestToken: 'not-a-guest-token' })).status, 400);
    assert.equal((await post('/api/projects/claim', fb1, { guestToken: A.slice(0, -2) + 'xx' })).status, 400);
    const nonGuestTokenAttempt = await post('/api/projects/claim', fb1, { guestToken: fb2 });
    assert.equal(nonGuestTokenAttempt.status, 400);
    assert.equal((await nonGuestTokenAttempt.json()).code, 'invalid_guest_token');

    // Create one project as guest A and one as guest M
    const aProj = (await (await post('/api/projects', A, { title: 'Guest A Draft' })).json()).project;
    const mProj = (await (await post('/api/projects', M, { title: 'Guest M Draft' })).json()).project;

    // fb1 claims guest A's projects
    const claimRes = await post('/api/projects/claim', fb1, { guestToken: A });
    assert.equal(claimRes.status, 200);
    assert.deepEqual(await claimRes.json(), { success: true, claimed: 1 });

    // fb1 owns aProj, A no longer sees it, M's project is untouched, fb2 cannot access it
    const fb1Read = await api(`/api/projects/${aProj.id}`, fb1);
    assert.equal(fb1Read.status, 200);
    assert.equal((await fb1Read.json()).project.userId, 'firebase-claim-1');
    assert.equal((await api(`/api/projects/${aProj.id}`, A)).status, 404);
    assert.equal((await api(`/api/projects/${aProj.id}`, fb2)).status, 404);
    assert.equal((await api(`/api/projects/${mProj.id}`, fb1)).status, 404);
    assert.equal((await api(`/api/projects/${mProj.id}`, M)).status, 200);

    // Re-claiming is idempotent (0 claimed)
    const reclaimRes = await post('/api/projects/claim', fb2, { guestToken: A });
    assert.equal(reclaimRes.status, 200);
    assert.deepEqual(await reclaimRes.json(), { success: true, claimed: 0 });
  });
});

describe('render engine and job queue (real ffmpeg)', () => {
  // Track B: server renders need a signed-in account (guests get 403 sign_in_required, tests/render_queue.test.ts).
  let RA: string; // alice (signed in)
  let RM: string; // mallory (signed in)
  before(() => {
    RA = srv.signFirebaseToken({ sub: 'api-render-alice' });
    RM = srv.signFirebaseToken({ sub: 'api-render-mallory' });
  });

  test('direct render produces a playable MP4 with correct size; download supports ranges', async () => {
    const r = await post('/api/render/video', RA, {
      title: "E2E: it's 100% \\ok",
      duration: 3,
      resolution: '720p',
      beats: [
        { text: 'Hook: the brutal truth', start_s: 0, end_s: 1.5 },
        { text: "Don't stop", start_s: '1.5', end_s: 3 },
      ],
    });
    assert.equal(r.status, 200, await r.clone().text());
    const d = await r.json();
    assert.match(d.renderId, /^render_[a-f0-9]{32}$/);
    assert.ok(d.fileSize > 5000);
    assert.equal(d.resolution, '720x1280');

    const full = await api(d.downloadUrl);
    assert.equal(full.status, 200);
    const buf = Buffer.from(await full.arrayBuffer());
    assert.equal(buf.length, d.fileSize);
    assert.ok(buf.subarray(0, 32).includes(Buffer.from('ftyp')));

    const part = await api(d.downloadUrl, undefined, { headers: { Range: 'bytes=0-1023' } });
    assert.equal(part.status, 206);
    assert.equal((await part.arrayBuffer()).byteLength, 1024);
    assert.equal((await api(d.downloadUrl, undefined, { headers: { Range: 'bytes=99999999-' } })).status, 416);
    assert.equal((await api(d.downloadUrl, undefined, { headers: { Range: 'bytes=abc-' } })).status, 416);
    assert.equal((await api(`/api/render/probe/${d.renderId}`, RA)).status, 200);
  });

  test('path traversal on download is rejected', async () => {
    for (const id of ['..%2F..%2Fpackage', '..%2Fprojects', 'render_123']) {
      assert.equal((await api(`/api/render/download/${id}`)).status, 400, id);
    }
  });

  test('jobs: unsupported type rejected; owner-only access; cancel kills render; retry re-renders', async () => {
    assert.equal((await post('/api/jobs/create', RA, { type: 'test_task' })).status, 400);
    const created = await (await post('/api/jobs/create', RA, { type: 'render_video', payload: { duration: 30, resolution: '1080p', beats: [{ text: 'x', start_s: 0, end_s: 2 }] } })).json();
    const id = created.job.id;
    assert.equal((await api(`/api/jobs/${id}`, RM)).status, 404);
    assert.equal((await post(`/api/jobs/${id}/cancel`, RM, {})).status, 404);

    const cancelled = await (await post(`/api/jobs/${id}/cancel`, RA, {})).json();
    assert.equal(cancelled.job.status, 'cancelled');
    await new Promise((r) => setTimeout(r, 800));
    assert.equal((await (await api(`/api/jobs/${id}`, RA)).json()).job.status, 'cancelled', 'cancelled job must stay cancelled');
    assert.equal((await post(`/api/jobs/${id}/cancel`, RA, {})).status, 409);

    // Retry re-runs a REAL render (previously it faked "completed" after a timer).
    assert.equal((await post(`/api/jobs/${id}/retry`, RA, {})).status, 200);
    let job: any;
    for (let i = 0; i < 120; i++) {
      job = (await (await api(`/api/jobs/${id}`, RA)).json()).job;
      if (job.status === 'completed' || job.status === 'failed') break;
      await new Promise((r) => setTimeout(r, 500));
    }
    assert.equal(job.status, 'completed', JSON.stringify(job));
    const head = await api(job.result.downloadUrl, undefined, { headers: { Range: 'bytes=0-63' } });
    assert.equal(head.status, 206);
    assert.equal((await post(`/api/jobs/${id}/retry`, RA, {})).status, 409, 'completed jobs cannot be retried');

    const mine = await (await api('/api/jobs', RA)).json();
    assert.ok(mine.jobs.some((j: any) => j.id === id));
    assert.ok(!(await (await api('/api/jobs', RM)).json()).jobs.some((j: any) => j.id === id));
  });
});

describe('billing & quotas', () => {
  test('new users start on free plan; self-service upgrade is disabled without a payment provider', async () => {
    const sub = await (await api('/api/user/subscription', M)).json();
    assert.equal(sub.subscription.plan, 'free');
    assert.equal(sub.subscription.monthlyRenderMinutesUsed, 0);
    const up = await post('/api/user/subscription/upgrade', M, { plan: 'studio' });
    assert.equal(up.status, 501);
    assert.equal((await post('/api/user/subscription/upgrade', M, { plan: 'enterprise_unlimited' })).status, 400);
    const q = await (await api('/api/quota', M)).json();
    assert.equal(q.plan, 'free');
  });

  test('rate limiter ignores spoofed X-Forwarded-For (no TRUST_PROXY)', async () => {
    const T = await guestToken(srv.baseUrl);
    const codes: number[] = [];
    for (let i = 0; i < 18; i++) {
      const r = await api('/api/generate-script', T, { method: 'POST', body: JSON.stringify({ topic: 'sleep' }), headers: { 'x-forwarded-for': `9.9.9.${i}` } });
      codes.push(r.status);
    }
    assert.ok(codes.includes(429), `expected 429 within 18 calls, got ${codes.join(',')}`);
  });
});
