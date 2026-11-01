// Boots the real server (server.ts) in an isolated child process: random port, temp DATA_DIR,
// test Firebase signing certs. Integration tests talk to it over HTTP exactly like the browser does.
import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

export const FIREBASE_TEST_PROJECT = 'forge-test-project';

export interface TestServer {
  baseUrl: string;
  dataDir: string;
  signFirebaseToken: (claims: Record<string, unknown>) => string;
  stop: () => Promise<void>;
  logs: () => string;
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

export async function startTestServer(extraEnv: Record<string, string> = {}): Promise<TestServer> {
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-test-data-'));
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = 'integration-kid';
  const certsFile = path.join(dataDir, 'test-certs.json');
  fs.writeFileSync(certsFile, JSON.stringify({ [kid]: publicKey.export({ type: 'spki', format: 'pem' }) }));

  let output = '';
  const child: ChildProcess = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], {
    cwd: path.resolve(import.meta.dirname, '..', '..'),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(port),
      DATA_DIR: dataDir,
      SESSION_SECRET: crypto.randomBytes(32).toString('hex'),
      FIREBASE_PROJECT_ID: FIREBASE_TEST_PROJECT,
      FIREBASE_CERTS_FILE: certsFile,
      GEMINI_API_KEY: '',
      PEXELS_API_KEY: '',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout!.on('data', (d) => (output += d));
  child.stderr!.on('data', (d) => (output += d));

  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Server exited early:\n${output}`);
    try {
      const r = await fetch(`${baseUrl}/api/health`);
      if (r.ok) break;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 200));
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
    },
  };
}

export async function guestToken(baseUrl: string): Promise<string> {
  const r = await fetch(`${baseUrl}/api/auth/guest`, { method: 'POST' });
  if (!r.ok) throw new Error(`guest token failed: ${r.status}`);
  return (await r.json()).token;
}
