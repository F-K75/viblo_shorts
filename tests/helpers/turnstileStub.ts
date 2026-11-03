// A local stand-in for Cloudflare Turnstile's siteverify endpoint (tests only). It answers like the real API
// (https://developers.cloudflare.com/turnstile/get-started/server-side-validation/) and can be switched into
// failure modes. It deliberately does NOT reject duplicate tokens, so tests prove that the server's own
// single-use enforcement works (not Cloudflare's).
//
// Token conventions (the test chooses the outcome):
//   ok-*   success, correct hostname and action, fresh
//   bad-*  success: false (invalid-input-response)
//   host-* success, but hostname is not allowed
//   act-*  success, but action is not guest_mint
//   old-*  success, but challenge_ts is 10 minutes old
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export type StubMode = 'normal' | 'timeout' | '5xx' | 'malformed' | 'down';
export interface SiteverifyCall {
  secret: string;
  response: string;
  remoteip: string | undefined;
}

export async function startTurnstileStub(opts: { secret: string; hostname: string }) {
  let mode: StubMode = 'normal';
  const calls: SiteverifyCall[] = [];
  const sockets = new Set<import('node:net').Socket>();
  const handler = (req: http.IncomingMessage, res: http.ServerResponse) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      const params: Record<string, string> = {};
      if (String(req.headers['content-type']).includes('application/json')) Object.assign(params, JSON.parse(raw || '{}'));
      else for (const [k, v] of new URLSearchParams(raw)) params[k] = v;
      calls.push({ secret: params.secret, response: params.response, remoteip: params.remoteip });
      if (mode === 'timeout') return; // never answers
      if (mode === '5xx') {
        res.writeHead(502, { 'content-type': 'text/plain' });
        return res.end('bad gateway');
      }
      if (mode === 'malformed') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end('{not json');
      }
      const now = Date.now();
      const t = params.response || '';
      const body: Record<string, unknown> =
        params.secret !== opts.secret
          ? { success: false, 'error-codes': ['invalid-input-secret'] }
          : t.startsWith('ok-')
            ? { success: true, challenge_ts: new Date(now).toISOString(), hostname: opts.hostname, action: 'guest_mint', 'error-codes': [] }
            : t.startsWith('host-')
              ? { success: true, challenge_ts: new Date(now).toISOString(), hostname: 'evil.example', action: 'guest_mint', 'error-codes': [] }
              : t.startsWith('act-')
                ? { success: true, challenge_ts: new Date(now).toISOString(), hostname: opts.hostname, action: 'login', 'error-codes': [] }
                : t.startsWith('old-')
                  ? { success: true, challenge_ts: new Date(now - 600_000).toISOString(), hostname: opts.hostname, action: 'guest_mint', 'error-codes': [] }
                  : { success: false, 'error-codes': ['invalid-input-response'] };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    });
  };
  let server = http.createServer(handler);
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  const url = `http://127.0.0.1:${port}/turnstile/v0/siteverify`;
  const closeAll = () =>
    new Promise<void>((r) => {
      for (const s of sockets) s.destroy();
      server.close(() => r());
    });
  return {
    url,
    calls,
    setMode: async (m: StubMode) => {
      if (m === 'down' && mode !== 'down') await closeAll();
      if (mode === 'down' && m !== 'down') {
        server = http.createServer(handler);
        server.on('connection', (s) => {
          sockets.add(s);
          s.on('close', () => sockets.delete(s));
        });
        await new Promise<void>((r) => server.listen(port, '127.0.0.1', () => r()));
      }
      mode = m;
    },
    close: () => (mode === 'down' ? Promise.resolve() : closeAll()),
  };
}
