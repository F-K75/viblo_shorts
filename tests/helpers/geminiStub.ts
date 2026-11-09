// Minimal local stand-in for the Gemini REST API (generateContent). Lets integration tests exercise the
// REAL server code path for successful and failing model calls (quota charge/refund) without a key.
import http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * 'ok': valid output with usage (30 tokens). 'fail': HTTP 500 error from the provider. Review R2 additions:
 * 'garbage': HTTP 200 with usage (30 tokens) but unparseable output; 'zero': valid output reporting 0 tokens;
 * 'nousage': valid output without usage metadata.
 */
export type GeminiStubMode = 'ok' | 'fail' | 'garbage' | 'zero' | 'nousage';
export interface GeminiStub {
  baseUrl: string;
  mode: GeminiStubMode;
  /** Modes used for the next calls, one per call, before falling back to `mode`. */
  queue: GeminiStubMode[];
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
  const stub: GeminiStub = { baseUrl: '', mode: 'ok', queue: [], delayMs: 0, calls: 0, close: async () => {} };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', async () => {
      stub.calls++;
      const mode = stub.queue.length ? stub.queue.shift()! : stub.mode;
      if (stub.delayMs) await new Promise((r) => setTimeout(r, stub.delayMs));
      if (res.destroyed) return;
      res.setHeader('content-type', 'application/json');
      if (mode === 'fail') {
        res.statusCode = 500;
        return res.end(JSON.stringify({ error: { code: 500, message: 'stub internal error', status: 'INTERNAL' } }));
      }
      const text = mode === 'garbage' ? 'this is not json {' : JSON.stringify(UNIVERSAL);
      const usage =
        mode === 'nousage' ? undefined : mode === 'zero' ? { promptTokenCount: 0, candidatesTokenCount: 0, totalTokenCount: 0 } : { promptTokenCount: 10, candidatesTokenCount: 20, totalTokenCount: 30 };
      res.end(JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }], ...(usage ? { usageMetadata: usage } : {}) }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  stub.baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  stub.close = () => new Promise((r) => server.close(() => r()));
  return stub;
}
