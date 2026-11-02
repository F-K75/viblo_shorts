// TCP proxy that can simulate a database outage: down() drops every connection and refuses new ones,
// up() accepts again on the same port. Works the same locally and in CI (no control of the DB process needed).
import net from 'node:net';

export interface TcpProxy {
  port: number;
  down: () => Promise<void>;
  up: () => Promise<void>;
  close: () => Promise<void>;
}

export async function startTcpProxy(targetHost: string, targetPort: number): Promise<TcpProxy> {
  const sockets = new Set<net.Socket>();
  let server: net.Server | null = null;
  let port = 0;
  const listen = () =>
    new Promise<void>((resolve, reject) => {
      server = net.createServer((client) => {
        const upstream = net.connect(targetPort, targetHost);
        sockets.add(client);
        sockets.add(upstream);
        const drop = () => {
          client.destroy();
          upstream.destroy();
          sockets.delete(client);
          sockets.delete(upstream);
        };
        client.on('error', drop).on('close', drop);
        upstream.on('error', drop).on('close', drop);
        client.pipe(upstream);
        upstream.pipe(client);
      });
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        port = (server!.address() as net.AddressInfo).port;
        resolve();
      });
    });
  const stop = () =>
    new Promise<void>((resolve) => {
      for (const s of sockets) s.destroy();
      sockets.clear();
      if (!server) return resolve();
      server.close(() => resolve());
      server = null;
    });
  await listen();
  return { port, down: stop, up: listen, close: stop };
}
