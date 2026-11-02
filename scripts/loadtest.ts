// Simple concurrent load test against an isolated server instance (no external deps).
// Usage: npm run test:load  (env: CONCURRENCY=20 REQUESTS=400)
// Note: per-IP rate limits apply, so all traffic from one machine shares limits; the script reports 429s
// separately so latency figures only include served requests.
import { startTestServer, guestToken, healthDetails } from '../tests/helpers/server.ts';

const CONCURRENCY = Number(process.env.CONCURRENCY || 20);
const REQUESTS = Number(process.env.REQUESTS || 400);

function pct(arr: number[], p: number) {
  if (arr.length === 0) return NaN;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

async function run(name: string, n: number, fn: (i: number) => Promise<Response>) {
  const lat: number[] = [];
  const codes: Record<number, number> = {};
  let next = 0;
  const started = performance.now();
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, n) }, async () => {
      while (next < n) {
        const i = next++;
        const t0 = performance.now();
        const r = await fn(i);
        await r.arrayBuffer();
        codes[r.status] = (codes[r.status] || 0) + 1;
        if (r.status < 400) lat.push(performance.now() - t0);
      }
    }),
  );
  const secs = (performance.now() - started) / 1000;
  console.log(
    `${name.padEnd(28)} n=${String(n).padStart(4)} rps=${(n / secs).toFixed(0).padStart(5)} ` +
      `p50=${pct(lat, 50).toFixed(1)}ms p95=${pct(lat, 95).toFixed(1)}ms p99=${pct(lat, 99).toFixed(1)}ms codes=${JSON.stringify(codes)}`,
  );
}

const srv = await startTestServer();
try {
  const tokens = await Promise.all(Array.from({ length: 5 }, () => guestToken(srv.baseUrl)));
  const auth = (i: number) => ({ authorization: `Bearer ${tokens[i % tokens.length]}`, 'content-type': 'application/json' });
  const mem0 = (await healthDetails(srv.baseUrl)).system;

  await run('GET /api/health', REQUESTS, () => fetch(`${srv.baseUrl}/api/health`));
  await run('POST /api/projects (save)', 60, (i) =>
    fetch(`${srv.baseUrl}/api/projects`, {
      method: 'POST',
      headers: auth(i),
      body: JSON.stringify({ title: `Load ${i}`, script: { beats: Array.from({ length: 6 }, (_, b) => ({ id: `b${b}`, text: 'Some beat text here', start_s: b * 4, end_s: b * 4 + 4 })) } }),
    }),
  );
  await run('GET /api/projects (list)', 120, (i) => fetch(`${srv.baseUrl}/api/projects`, { headers: auth(i) }));
  await run('POST /api/generate-script', 15, (i) =>
    fetch(`${srv.baseUrl}/api/generate-script`, { method: 'POST', headers: auth(i), body: JSON.stringify({ topic: `topic ${i}` }) }),
  );
  const t0 = performance.now();
  const r = await fetch(`${srv.baseUrl}/api/render/video`, {
    method: 'POST',
    headers: auth(0),
    body: JSON.stringify({ title: 'Load', duration: 15, resolution: '1080p', beats: [{ text: 'hello', start_s: 0, end_s: 3 }] }),
  });
  console.log(`render 15s@1080p              status=${r.status} wall=${(performance.now() - t0).toFixed(0)}ms`);
  const mem1 = (await healthDetails(srv.baseUrl)).system;
  console.log(`server rss: ${mem0.rssMb}MB -> ${mem1.rssMb}MB, heapUsed ${mem0.heapUsedMb}MB -> ${mem1.heapUsedMb}MB`);
} finally {
  await srv.stop();
}
