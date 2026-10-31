import test from 'node:test';
import assert from 'node:assert/strict';

// YouTube extraction logic mirroring production server.ts
function extractYouTubeId(url: string): string | null {
  if (!url || typeof url !== 'string') return null;
  let str = url.trim();
  str = str.replace(/^[<"'\s(\[]+|[>"'\s)\]]+$/g, '');

  if (/^[a-zA-Z0-9_-]{11}$/.test(str)) {
    return str;
  }

  try {
    if (str.includes('%')) {
      str = decodeURIComponent(str);
    }
  } catch {}

  try {
    const fullUrl = str.startsWith('http://') || str.startsWith('https://') ? str : `https://${str}`;
    const parsed = new URL(fullUrl);
    const vParam = parsed.searchParams.get('v');
    if (vParam && /^[a-zA-Z0-9_-]{11}$/.test(vParam)) {
      return vParam;
    }
    const pathParts = parsed.pathname.split('/').filter(Boolean);
    if (pathParts.length >= 2 && ['shorts', 'live', 'embed', 'v'].includes(pathParts[0])) {
      const candidate = pathParts[1];
      if (/^[a-zA-Z0-9_-]{11}$/.test(candidate)) {
        return candidate;
      }
    }
    if (parsed.hostname.includes('youtu.be') && pathParts.length >= 1) {
      const candidate = pathParts[0];
      if (/^[a-zA-Z0-9_-]{11}$/.test(candidate)) {
        return candidate;
      }
    }
  } catch {}

  const regexPatterns = [
    /(?:[?&]v=|youtu\.be\/|\/(?:shorts|live|embed|v|vi)\/)([a-zA-Z0-9_-]{11})/i,
    /(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?|shorts|live)\/|.*[?&]v=)|youtu\.be\/)([^"&?/\s]{11})/i,
    /([a-zA-Z0-9_-]{11})/,
  ];

  for (const pat of regexPatterns) {
    const match = str.match(pat);
    if (match && match[1] && /^[a-zA-Z0-9_-]{11}$/.test(match[1])) {
      return match[1];
    }
  }

  return null;
}

test('YouTube: extracts 11-char ID from all valid link formats', () => {
  const cases = [
    { input: 'https://www.youtube.com/watch?v=UF8uR6Z6KLc', expected: 'UF8uR6Z6KLc' },
    { input: 'https://youtube.com/watch?v=UF8uR6Z6KLc&t=15s', expected: 'UF8uR6Z6KLc' },
    { input: 'https://youtu.be/UF8uR6Z6KLc', expected: 'UF8uR6Z6KLc' },
    { input: 'https://www.youtube.com/shorts/UF8uR6Z6KLc', expected: 'UF8uR6Z6KLc' },
    { input: 'https://m.youtube.com/watch?v=UF8uR6Z6KLc', expected: 'UF8uR6Z6KLc' },
    { input: 'https://www.youtube.com/embed/UF8uR6Z6KLc', expected: 'UF8uR6Z6KLc' },
    { input: 'UF8uR6Z6KLc', expected: 'UF8uR6Z6KLc' },
    { input: '<https://www.youtube.com/watch?v=UF8uR6Z6KLc>', expected: 'UF8uR6Z6KLc' },
  ];

  for (const c of cases) {
    const res = extractYouTubeId(c.input);
    assert.equal(res, c.expected, `Failed for input: ${c.input}`);
  }
});

test('YouTube: handles malformed and invalid inputs gracefully', () => {
  assert.equal(extractYouTubeId(''), null);
  assert.equal(extractYouTubeId('not_a_url'), null);
  assert.equal(extractYouTubeId('https://vimeo.com/123456789'), null);
  assert.equal(extractYouTubeId('https://google.com/search?q=test'), null);
});
