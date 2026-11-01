// Minimal local stand-in for the Gemini REST API (generateContent). Lets integration tests exercise the
// REAL server code path for successful and failing model calls (quota charge/refund) without a key.
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface GeminiStub {
  baseUrl: string;
  mode: 'ok' | 'fail';
  delayMs: number;
  calls: number;
  close: () => Promise<void>;
}

// One JSON object that satisfies every text endpoint's schema (script, hooks, rewrite, metadata).
const UNIVERSAL = {
  hook: 'Stub hook line',
  title: 'Stub title',
  description: 'Stub description',
  hashtags: ['#shorts', '#stub'],
  beats: [
    { text: 'Stub beat one text here.', visual_keywords: 'city street' },
    { text: 'Stub beat two text here.', visual_keywords: 'coffee cup' },
  ],
  hooks: [{ hook: 'Stub hook', style: 'stub', visual_keywords: 'desk' }],
  text: 'Stub rewritten line',
  visual_keywords: 'desk',
  titles: ['Stub title #shorts'],
};

export async function startGeminiStub(): Promise<GeminiStub> {
  const stub: GeminiStub = { baseUrl: '', mode: 'ok', delayMs: 0, calls: 0, close: async () => {} };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', async () => {
      stub.calls++;
      if (stub.delayMs) await new Promise((r) => setTimeout(r, stub.delayMs));
      res.setHeader('content-type', 'application/json');
      if (stub.mode === 'fail') {
        res.statusCode = 500;
        return res.end(JSON.stringify({ error: { code: 500, message: 'stub internal error', status: 'INTERNAL' } }));
      }
      res.end(
        JSON.stringify({
          candidates: [{ content: { role: 'model', parts: [{ text: JSON.stringify(UNIVERSAL) }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20, totalTokenCount: 30 },
        }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  stub.baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  stub.close = () => new Promise((r) => server.close(() => r()));
  return stub;
}
