// LIVE provider tests — call the real Gemini API. Skipped unless GEMINI_API_KEY is set.
// Run: GEMINI_API_KEY=... npm run test:live
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, guestToken, type TestServer } from './helpers/server.ts';

const KEY = process.env.GEMINI_API_KEY?.trim();
const skip = !KEY ? 'GEMINI_API_KEY not set — live LLM tests skipped (NOT passed)' : false;

let srv: TestServer;
let T: string;
const post = async (p: string, body: unknown) =>
  (await fetch(`${srv.baseUrl}${p}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${T}` },
    body: JSON.stringify(body),
  })).json();

before(async () => {
  if (!KEY) return;
  srv = await startTestServer({ GEMINI_API_KEY: KEY });
  T = await guestToken(srv.baseUrl);
});
after(async () => srv?.stop());

test('LIVE: generate-script returns a real model script within limits', { skip, timeout: 90000 }, async () => {
  const d = await post('/api/generate-script', { topic: '3 habits to fall asleep faster' });
  assert.equal(d.isFallback, false, `fell back: ${d.fallbackMessage}`);
  assert.equal(d.source, 'gemini');
  assert.ok(d.beats.length >= 3 && d.beats.length <= 10);
  const words = d.beats.map((b: any) => b.text).join(' ').split(/\s+/).length;
  assert.ok(words >= 40 && words <= 180, `word count ${words} outside sane range`);
  assert.equal(d.beats[0].text.length > 0, true);
});

test('LIVE: generate-clips with transcript keeps captions verbatim', { skip, timeout: 90000 }, async () => {
  const transcript = Array.from({ length: 12 }, (_, i) => `0:${String(i * 5).padStart(2, '0')}\nSentence number ${i + 1} about focus.`).join('\n');
  const d = await post('/api/youtube/generate-clips', { url: 'https://youtu.be/UF8uR6Z6KLc', transcript });
  assert.equal(d.grounded, true);
  for (const c of d.clips) for (const b of c.beats) assert.ok(transcript.includes(b.text), `not verbatim: ${b.text}`);
});
