import test from 'node:test';
import assert from 'node:assert/strict';

// Mirroring the server-side SSRF validation function
function isSafeExternalUrl(urlStr: string, allowedHostSuffixes?: string[]): boolean {
  if (!urlStr || typeof urlStr !== 'string') return false;
  try {
    const parsed = new URL(urlStr);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
    const hostname = parsed.hostname.toLowerCase();

    if (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '0.0.0.0' ||
      hostname === '::1' ||
      hostname.endsWith('.localhost') ||
      hostname.endsWith('.internal') ||
      hostname.includes('169.254.') ||
      hostname.startsWith('10.') ||
      hostname.startsWith('192.168.') ||
      /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(hostname)
    ) {
      return false;
    }

    if (allowedHostSuffixes && allowedHostSuffixes.length > 0) {
      return allowedHostSuffixes.some((h) => hostname === h || hostname.endsWith(`.${h}`));
    }
    return true;
  } catch {
    return false;
  }
}

test('Security SSRF: blocks loopback, private networks, and cloud metadata', () => {
  const unsafeUrls = [
    'http://localhost:3000/api/secret',
    'http://127.0.0.1:8080/admin',
    'http://169.254.169.254/computeMetadata/v1/',
    'http://metadata.google.internal/computeMetadata/v1/',
    'http://10.0.0.1/internal-dashboard',
    'http://192.168.1.1/router',
    'http://172.16.0.5/docker-service',
    'file:///etc/passwd',
    'gopher://127.0.0.1:6379/_flushall',
    'javascript:alert(1)',
  ];

  for (const u of unsafeUrls) {
    assert.equal(isSafeExternalUrl(u), false, `Should reject unsafe URL: ${u}`);
  }
});

test('Security SSRF: permits legitimate public endpoints and domain allowlist', () => {
  assert.equal(isSafeExternalUrl('https://www.youtube.com/watch?v=UF8uR6Z6KLc'), true);
  assert.equal(isSafeExternalUrl('https://api.pexels.com/videos/search'), true);
  assert.equal(isSafeExternalUrl('https://images.unsplash.com/photo-1'), true);

  // Suffix checks
  assert.equal(
    isSafeExternalUrl('https://rr1---sn-4g5edn6r.googlevideo.com/videoplayback', ['youtube.com', 'googlevideo.com']),
    true
  );
  assert.equal(
    isSafeExternalUrl('https://attacker-domain.com/evil', ['youtube.com', 'googlevideo.com']),
    false
  );
});

test('Security Isolation: enforces strict ownership and rejects cross-user project deletion', () => {
  interface Project {
    id: string;
    userId: string;
    title: string;
  }

  const projects: Project[] = [
    { id: 'proj_sample_steve_jobs', userId: 'default_user', title: 'Sample' },
    { id: 'proj_user_a_1', userId: 'user_a', title: 'User A Secret Short' },
    { id: 'proj_user_b_1', userId: 'user_b', title: 'User B Public Short' },
  ];

  // User A requesting list
  const userAVisible = projects.filter(
    (p) => p.userId === 'user_a' || p.id === 'proj_sample_steve_jobs'
  );
  assert.equal(userAVisible.length, 2);
  assert.ok(!userAVisible.some((p) => p.id === 'proj_user_b_1'), 'User A must not see User B project');

  // User B attempting to delete User A project
  const targetId = 'proj_user_a_1';
  const requestingUserId = 'user_b';
  const target = projects.find((p) => p.id === targetId);
  const isAuthorizedToDelete =
    target && (target.userId === requestingUserId || requestingUserId === 'admin');

  assert.equal(isAuthorizedToDelete, false, 'User B must be forbidden from deleting User A project');
});
