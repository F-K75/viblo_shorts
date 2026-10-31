import test from 'node:test';
import assert from 'node:assert/strict';

const BASE_URL = 'http://localhost:3000';

test('E2E API: Health check endpoint returns ok and readiness metrics', async () => {
  const res = await fetch(`${BASE_URL}/api/health`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.status, 'ok');
  assert.ok(data.uptimeSeconds >= 0);
  assert.ok(data.services);
  assert.ok(data.system.heapUsedMb > 0);
});

test('E2E API: Quota endpoint returns user tier and quota metrics', async () => {
  const res = await fetch(`${BASE_URL}/api/quota`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(['free', 'pro', 'studio'].includes(data.plan));
  assert.ok(data.dailyQuotaLimit > 0);
  assert.ok(typeof data.dailyQuotaRemaining === 'number');
});

test('E2E API: Idea-to-Video Script generation returns structured hook and beats', async () => {
  const res = await fetch(`${BASE_URL}/api/generate-script`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      topic: 'How to build deep focus and avoid procrastination',
      audience: 'students and developers',
      tone: 'direct, punchy, high energy',
    }),
  });

  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(data.hook && data.hook.length > 5, 'Hook must be non-empty');
  assert.ok(data.title && data.title.length > 5, 'Title must be non-empty');
  assert.ok(Array.isArray(data.beats) && data.beats.length >= 3, 'Must return at least 3 beats');
  assert.ok(Array.isArray(data.hashtags) && data.hashtags.length >= 2, 'Must return hashtags');

  // Verify beat structure
  for (const beat of data.beats) {
    assert.ok(beat.text && beat.text.length > 0, 'Beat text must not be empty');
    assert.ok(beat.visual_keywords && beat.visual_keywords.length > 0, 'Visual keywords must not be empty');
  }
});

test('E2E API: YouTube Info endpoint parses and resolves metadata', async () => {
  const res = await fetch(`${BASE_URL}/api/youtube/info`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: 'https://www.youtube.com/watch?v=UF8uR6Z6KLc',
    }),
  });

  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.videoId, 'UF8uR6Z6KLc');
  assert.ok(data.title && data.title.length > 0);
  assert.ok(data.thumbnailUrl && data.thumbnailUrl.includes('UF8uR6Z6KLc'));
});

test('E2E API: Multi-platform publishing pack generates SRT, VTT, and platform specs', async () => {
  const res = await fetch(`${BASE_URL}/api/publish/generate-pack`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: 'Master Focus in 60 Seconds',
      topic: 'Focus & Neuroplasticity',
      beats: [
        { text: 'Stop multitasking immediately.', start_s: 0.0, end_s: 3.5 },
        { text: 'Single-tasking expands working memory.', start_s: 3.5, end_s: 7.0 },
      ],
      platform: 'youtube',
    }),
  });

  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.success, true);
  assert.equal(data.pack.platform, 'youtube');
  assert.ok(data.pack.srtContent.includes('00:00:00,000 --> 00:00:03,500'));
  assert.ok(data.pack.vttContent.includes('WEBVTT'));
  assert.ok(data.pack.hashtags.includes('#shorts'));
});

test('E2E API: Project Lifecycle and User Isolation (Create, Fetch, Isolate, Duplicate, Delete)', async () => {
  const userA = `user_a_${Date.now()}`;
  const userB = `user_b_${Date.now()}`;
  const projectId = `proj_e2e_${Date.now()}`;

  // 1. User A creates a project
  const createRes = await fetch(`${BASE_URL}/api/projects`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-user-id': userA,
    },
    body: JSON.stringify({
      id: projectId,
      title: 'User A Private Short Project',
      topic: 'Personal Branding',
      creationMode: 'prompt',
      script: {
        hook: 'Never underestimate consistency.',
        title: 'Consistency Wins #shorts',
        description: 'Why consistency beats talent.',
        hashtags: ['#shorts', '#mindset'],
        beats: [
          { id: 'b1', text: 'Never underestimate consistency.', visual_keywords: 'workout', start_s: 0, end_s: 4, video_url: '' },
        ],
      },
      captionStyle: {
        id: 'hormozi',
        name: 'Hormozi',
        fontSize: 32,
        textColor: '#FFFFFF',
        highlightColor: '#FFE600',
        strokeColor: '#000000',
        strokeWidth: 4,
        positionY: 68,
        wordsPerChunk: 2,
      },
    }),
  });

  assert.equal(createRes.status, 200);
  const createdData = await createRes.json();
  assert.equal(createdData.project.id, projectId);
  assert.equal(createdData.project.userId, userA);

  // 2. User A fetches project -> succeeds
  const getResA = await fetch(`${BASE_URL}/api/projects/${projectId}`, {
    headers: { 'x-user-id': userA },
  });
  assert.equal(getResA.status, 200);

  // 3. User B fetches User A's private project -> 403 Forbidden!
  const getResB = await fetch(`${BASE_URL}/api/projects/${projectId}`, {
    headers: { 'x-user-id': userB },
  });
  assert.equal(getResB.status, 403, 'Cross-user access must be rejected with 403 Forbidden');

  // 4. User B attempts to delete User A's project -> 403 Forbidden!
  const deleteResB = await fetch(`${BASE_URL}/api/projects/${projectId}`, {
    method: 'DELETE',
    headers: { 'x-user-id': userB },
  });
  assert.equal(deleteResB.status, 403, 'Cross-user deletion must be rejected with 403 Forbidden');

  // 5. User A duplicates project
  const dupRes = await fetch(`${BASE_URL}/api/projects/${projectId}/duplicate`, {
    method: 'POST',
    headers: { 'x-user-id': userA },
  });
  assert.equal(dupRes.status, 200);
  const dupData = await dupRes.json();
  assert.ok(dupData.project.id !== projectId);
  assert.equal(dupData.project.userId, userA);

  // 6. Clean up: User A deletes duplicated project and original project
  const delDup = await fetch(`${BASE_URL}/api/projects/${dupData.project.id}`, {
    method: 'DELETE',
    headers: { 'x-user-id': userA },
  });
  assert.equal(delDup.status, 200);

  const delOrig = await fetch(`${BASE_URL}/api/projects/${projectId}`, {
    method: 'DELETE',
    headers: { 'x-user-id': userA },
  });
  assert.equal(delOrig.status, 200);
});

test('E2E API: Real Server-Side FFmpeg Video Rendering & Playable Media Download', async () => {
  // 1. Request real FFmpeg render
  const renderRes = await fetch(`${BASE_URL}/api/render/video`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: 'E2E Acceptance Video Test',
      duration: 3, // 3 seconds
      resolution: '720p',
      beats: [
        { text: 'Hook: The brutal truth about consistency.', start_s: 0.0, end_s: 1.5, visual_keywords: 'focus' },
        { text: 'Keep going and do not stop.', start_s: 1.5, end_s: 3.0, visual_keywords: 'victory' },
      ],
    }),
  });

  assert.equal(renderRes.status, 200);
  const renderData = await renderRes.json();
  assert.equal(renderData.success, true);
  assert.ok(renderData.renderId);
  assert.ok(renderData.fileSize > 5000, 'Rendered video file size must be > 5KB');
  assert.equal(renderData.format, 'mp4');

  // 2. Probe the rendered video artifact
  const probeRes = await fetch(`${BASE_URL}/api/render/probe/${renderData.renderId}`);
  assert.equal(probeRes.status, 200);
  const probeData = await probeRes.json();
  assert.equal(probeData.exists, true);
  assert.equal(probeData.mimeType, 'video/mp4');

  // 3. Download the video with Range streaming support
  const downloadRes = await fetch(`${BASE_URL}/api/render/download/${renderData.renderId}`, {
    headers: { Range: 'bytes=0-1023' },
  });
  assert.equal(downloadRes.status, 206, 'Should respond with 206 Partial Content for Range header');
  assert.equal(downloadRes.headers.get('content-type'), 'video/mp4');
  const buffer = await downloadRes.arrayBuffer();
  assert.equal(buffer.byteLength, 1024);
  const uint8 = new Uint8Array(buffer);
  const textDecoder = new TextDecoder();
  const headerText = textDecoder.decode(uint8.slice(0, 32));
  assert.ok(headerText.includes('ftyp'), 'Downloaded artifact must have valid ISO BMFF MP4 header');
});

test('E2E API: Background Job Lifecycle (create -> monitor -> cancel/retry)', async () => {
  // 1. Create a job
  const createRes = await fetch(`${BASE_URL}/api/jobs/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'test_task',
      payload: { test: true },
    }),
  });

  assert.equal(createRes.status, 200);
  const createData = await createRes.json();
  assert.equal(createData.success, true);
  const jobId = createData.job.id;

  // 2. Poll job status
  const getRes = await fetch(`${BASE_URL}/api/jobs/${jobId}`);
  assert.equal(getRes.status, 200);
  const getData = await getRes.json();
  assert.equal(getData.job.id, jobId);
  assert.ok(['queued', 'processing', 'completed'].includes(getData.job.status));

  // 3. Cancel the job (if not already completed) or test retry
  const retryRes = await fetch(`${BASE_URL}/api/jobs/${jobId}/retry`, {
    method: 'POST',
  });
  assert.equal(retryRes.status, 200);
  const retryData = await retryRes.json();
  assert.equal(retryData.job.status, 'queued');
});
