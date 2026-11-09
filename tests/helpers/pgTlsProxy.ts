// Review R4 test helper: a TLS-terminating proxy in front of a local PostgreSQL that has ssl = off. It speaks the
// PostgreSQL SSL negotiation (SSLRequest -> 'S' -> TLS handshake), decrypts, and forwards the plain protocol upstream.
// It records, per client connection, whether TLS was negotiated and the application_name from the startup message, so
// a test can prove that EVERY connection of an operation used TLS (Node's pg client and libpq tools such as psql).
//  * a client that sends a plaintext StartupMessage is recorded and disconnected (never forwarded), unless
//    forwardPlaintext is set (to simulate a server that accepts a downgraded client);
//  * stripTlsOn: 1-based connection numbers whose SSLRequest is answered 'N' (a server or attacker refusing TLS).
// Throwaway self-signed certificate (openssl); nothing is written outside a temp directory.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';

const SSL_REQUEST = 80877103;
const GSSENC_REQUEST = 80877104;

export interface ProxyConnection {
  n: number;
  tls: boolean;
  /** application_name from the StartupMessage, when one was seen. */
  app?: string;
  /** plaintext StartupMessage received (refused unless forwardPlaintext). */
  plaintext: boolean;
}

export interface PgTlsProxy {
  /** The upstream URL rewritten to the proxy (sslmode parameter removed). */
  url: string;
  connections: ProxyConnection[];
  close: () => Promise<void>;
}

const appName = (buf: Buffer) => /application_name\0([^\0]*)\0/.exec(buf.toString('latin1'))?.[1];

export async function startPgTlsProxy(upstreamUrl: string, opts: { stripTlsOn?: number[]; forwardPlaintext?: boolean } = {}): Promise<PgTlsProxy> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-tls-proxy-'));
  const keyFile = path.join(dir, 'key.pem');
  const certFile = path.join(dir, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyFile, '-out', certFile, '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });
  const key = fs.readFileSync(keyFile);
  const cert = fs.readFileSync(certFile);
  const up = new URL(upstreamUrl);
  const upstream = { host: up.hostname, port: Number(up.port || 5432) };
  const connections: ProxyConnection[] = [];
  const sockets = new Set<net.Socket>();

  const forward = (client: net.Socket | tls.TLSSocket, first: Buffer, rec: ProxyConnection) => {
    rec.app ??= appName(first);
    const server = net.connect(upstream);
    sockets.add(server);
    server.on('error', () => client.destroy());
    client.on('error', () => server.destroy());
    server.on('close', () => client.destroy());
    client.on('close', () => server.destroy());
    server.write(first);
    client.pipe(server);
    server.pipe(client);
  };

  const proxy = net.createServer((sock) => {
    sockets.add(sock);
    sock.on('error', () => {});
    const rec: ProxyConnection = { n: connections.length + 1, tls: false, plaintext: false };
    connections.push(rec);
    let buf = Buffer.alloc(0);
    const onData = (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      if (buf.length < 8) return;
      const len = buf.readUInt32BE(0);
      const code = buf.readUInt32BE(4);
      if (len === 8 && (code === SSL_REQUEST || code === GSSENC_REQUEST)) {
        buf = buf.subarray(8);
        if (code === GSSENC_REQUEST || opts.stripTlsOn?.includes(rec.n)) {
          sock.write('N'); // no encryption here; the client must decide whether to continue in plaintext
          if (buf.length) onData(Buffer.alloc(0));
          return;
        }
        sock.off('data', onData);
        sock.write('S');
        const secure = new tls.TLSSocket(sock, { isServer: true, key, cert });
        secure.on('error', () => sock.destroy());
        secure.once('secure', () => {
          rec.tls = true;
        });
        secure.once('data', (first: Buffer) => forward(secure, first, rec));
        return;
      }
      // a plaintext StartupMessage (or anything else that is not an encryption request)
      sock.off('data', onData);
      rec.plaintext = true;
      rec.app = appName(buf);
      if (opts.forwardPlaintext) forward(sock, buf, rec);
      else sock.destroy();
    };
    sock.on('data', onData);
  });
  await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
  const u = new URL(upstreamUrl);
  u.hostname = '127.0.0.1';
  u.port = String((proxy.address() as net.AddressInfo).port);
  u.searchParams.delete('sslmode');
  return {
    url: u.toString(),
    connections,
    close: () =>
      new Promise((r) => {
        for (const s of sockets) s.destroy();
        proxy.close(() => {
          fs.rmSync(dir, { recursive: true, force: true });
          r();
        });
      }),
  };
}
