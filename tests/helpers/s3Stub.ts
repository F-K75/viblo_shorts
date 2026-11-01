// Minimal S3-compatible HTTP server (path-style): PutObject, GetObject, HeadObject, ListObjectsV2, DeleteObject.
// Lets tests drive the real @aws-sdk/client-s3 code path without cloud credentials. Auth is not checked.
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface S3Stub {
  endpoint: string;
  objects: Map<string, Buffer>; // key "bucket/key"
  close: () => Promise<void>;
}

const xmlEscape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Decodes `aws-chunked` bodies (in case a client streams with chunk signatures). */
function decodeAwsChunked(buf: Buffer): Buffer {
  const out: Buffer[] = [];
  let i = 0;
  while (i < buf.length) {
    const lineEnd = buf.indexOf('\r\n', i);
    if (lineEnd < 0) break;
    const size = parseInt(buf.subarray(i, lineEnd).toString().split(';')[0], 16);
    if (!size) break;
    out.push(buf.subarray(lineEnd + 2, lineEnd + 2 + size));
    i = lineEnd + 2 + size + 2;
  }
  return Buffer.concat(out);
}

export async function startS3Stub(): Promise<S3Stub> {
  const objects = new Map<string, Buffer>();
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (d) => chunks.push(d));
    req.on('end', () => {
      const url = new URL(req.url || '/', 'http://stub');
      const [, bucket, ...rest] = decodeURIComponent(url.pathname).split('/');
      const key = rest.join('/');
      const id = `${bucket}/${key}`;
      if (req.method === 'PUT') {
        let body: Buffer = Buffer.concat(chunks);
        if (String(req.headers['content-encoding'] || '').includes('aws-chunked') || String(req.headers['x-amz-content-sha256'] || '').startsWith('STREAMING-')) body = decodeAwsChunked(body);
        objects.set(id, body);
        res.setHeader('ETag', '"stub"');
        return res.end();
      }
      if (req.method === 'GET' && !key && url.searchParams.get('list-type') === '2') {
        const prefix = url.searchParams.get('prefix') || '';
        const keys = [...objects.keys()].filter((k) => k.startsWith(`${bucket}/${prefix}`)).map((k) => k.slice(bucket.length + 1)).sort();
        res.setHeader('content-type', 'application/xml');
        return res.end(
          `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>${bucket}</Name><Prefix>${xmlEscape(prefix)}</Prefix><KeyCount>${keys.length}</KeyCount><IsTruncated>false</IsTruncated>${keys
            .map((k) => `<Contents><Key>${xmlEscape(k)}</Key><Size>${objects.get(`${bucket}/${k}`)!.length}</Size></Contents>`)
            .join('')}</ListBucketResult>`,
        );
      }
      if (req.method === 'GET' || req.method === 'HEAD') {
        const obj = objects.get(id);
        if (!obj) {
          res.statusCode = 404;
          res.setHeader('content-type', 'application/xml');
          return res.end('<?xml version="1.0"?><Error><Code>NoSuchKey</Code><Message>not found</Message></Error>');
        }
        res.setHeader('content-length', String(obj.length));
        return res.end(req.method === 'HEAD' ? undefined : obj);
      }
      if (req.method === 'DELETE') {
        objects.delete(id);
        res.statusCode = 204;
        return res.end();
      }
      res.statusCode = 405;
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    objects,
    close: () => new Promise((r) => server.close(() => r())),
  };
}
