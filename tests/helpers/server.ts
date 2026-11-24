// Boots the real server (server.ts) in an isolated child process: random port, temp DATA_DIR,
// test Firebase signing certs. Integration tests talk to it over HTTP exactly like the browser does.
import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createTestDatabase, type TestDb } from './pg.ts';

/** Backend under test: TEST_STORAGE_BACKEND=postgres runs every test server on its own fresh PostgreSQL database. */
export const TEST_BACKEND: 'json' | 'postgres' = process.env.TEST_STORAGE_BACKEND === 'postgres' ? 'postgres' : 'json';

export const FIREBASE_TEST_PROJECT = 'forge-test-project';

export interface TestServer {
  baseUrl: string;
  dataDir: string;
  signFirebaseToken: (claims: Record<string, unknown>) => string;
  stop: () => Promise<void>;
  logs: () => string;
  /** Present when the server runs on PostgreSQL (fresh database per server unless DATABASE_URL was passed in). */
  databaseUrl?: string;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

const TEST_SIGNING_KEYS = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
/** Diagnostics credential for /api/health/details in tests (R-12: details are not public). */
export const HEALTH_TOKEN = crypto.randomBytes(24).toString('hex');
export const healthDetails = async (baseUrl: string) =>
  (await fetch(`${baseUrl}/api/health/details`, { headers: { authorization: `Bearer ${HEALTH_TOKEN}` } })).json() as Promise<any>;

export async function startTestServer(extraEnv: Record<string, string> = {}): Promise<TestServer> {
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-test-data-'));
  // One signing key per test process: like production (all instances trust Google's certs), every test server
  // accepts every test token, so multi-instance tests can send one user's token to any instance.
  const { privateKey, publicKey } = TEST_SIGNING_KEYS;
  const kid = 'integration-kid';
  const certsFile = path.join(dataDir, 'test-certs.json');
  fs.writeFileSync(certsFile, JSON.stringify({ [kid]: publicKey.export({ type: 'spki', format: 'pem' }) }));

  let testDb: TestDb | null = null;
  const env: Record<string, string> = { ...extraEnv };
  if (TEST_BACKEND === 'postgres' && env.DATABASE_URL === undefined && env.STORAGE_BACKEND !== 'json') {
    testDb = await createTestDatabase({ migrate: false }); // the server applies migrations itself, as in production
    await testDb.pool.end();
    env.DATABASE_URL = testDb.url;
  }
  let output = '';
  const child: ChildProcess = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], {
    cwd: path.resolve(import.meta.dirname, '..', '..'),
    env: {
      ...process.env,
      PATH: `${process.env.PATH || ''}:/tmp/ffmpeg-bin`,
      NODE_ENV: 'test',
      PORT: String(port),
      DATA_DIR: dataDir,
      SESSION_SECRET: crypto.randomBytes(32).toString('hex'),
      FIREBASE_PROJECT_ID: FIREBASE_TEST_PROJECT,
      FIREBASE_CERTS_FILE: certsFile,
      GEMINI_API_KEY: '',
      PEXELS_API_KEY: '',
      HEALTH_DETAILS_TOKEN: HEALTH_TOKEN,
      // Track A: existing tests mint many guests from 127.0.0.1. Generous guest budgets unless a test sets its own
      // (tests/guest_protection.test.ts sets them explicitly where it tests them).
      GUEST_MINT_PER_IP_PER_HOUR: '100000',
      GUEST_MINT_PER_SUBNET_PER_HOUR: '100000',
      GUEST_MINT_PER_DEVICE_PER_DAY: '100000',
      // Test servers use small connection pools. The full PostgreSQL suite runs test files in parallel and, with
      // Track A's tests added, reached 98 of the database's 100 connections at the production default (10 per
      // server) and stalled (measured on d7ad0ce). Production keeps its default; a test can still set its own value.
      DATABASE_POOL_MAX: '4',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout!.on('data', (d) => (output += d));
  child.stderr!.on('data', (d) => (output += d));

  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30000;
  let healthy = false;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Server exited early:\n${output}`);
    try {
      const r = await fetch(`${baseUrl}/api/health`);
      if (r.ok) {
        healthy = true;
        break;
      }
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!healthy) {
    child.kill('SIGKILL');
    throw new Error(`Server did not become healthy within 30 s:\n${output}`);
  }

  const signFirebaseToken = (claims: Record<string, unknown>) => {
    const now = Math.floor(Date.now() / 1000);
    const payload = {
      aud: FIREBASE_TEST_PROJECT,
      iss: `https://securetoken.google.com/${FIREBASE_TEST_PROJECT}`,
      iat: now - 5,
      exp: now + 3600,
      ...claims,
    };
    const h = Buffer.from(JSON.stringify({ alg: 'RS256', kid })).toString('base64url');
    const p = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const s = crypto.createSign('RSA-SHA256').update(`${h}.${p}`).sign(privateKey).toString('base64url');
    return `${h}.${p}.${s}`;
  };

  return {
    baseUrl,
    dataDir,
    signFirebaseToken,
    logs: () => output,
    databaseUrl: env.DATABASE_URL || undefined,
    stop: async () => {
      child.kill('SIGTERM');
      await new Promise((r) => {
        if (child.exitCode !== null) return r(null);
        child.once('exit', r);
        setTimeout(() => {
          child.kill('SIGKILL');
          r(null);
        }, 5000);
      });
      fs.rmSync(dataDir, { recursive: true, force: true });
      if (testDb) await testDb.drop().catch(() => {});
    },
  };
}

export async function guestToken(baseUrl: string): Promise<string> {
  const r = await fetch(`${baseUrl}/api/auth/guest`, { method: 'POST' });
  if (!r.ok) throw new Error(`guest token failed: ${r.status}`);
  return (await r.json()).token;
}
