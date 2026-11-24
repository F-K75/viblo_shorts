import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { ensureGoldenMediaFixtures, type GoldenMediaFixtures } from './helpers/mediaFixtures.ts';
import { startTestServer, guestToken, type TestServer } from './helpers/server.ts';

const SESSION_SECRET = crypto.randomBytes(32).toString('hex');

async function waitFor<T>(fn: () => Promise<T | null | false | undefined>, timeoutMs = 45_000, pollMs = 200): Promise<T> {
  const start = Date.now();
  for (;;) {
    const val = await fn();
    if (val) return val as T;
    if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting for media workflow completion');
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

describe('Forge Media Engine — End-to-End API, Specialist Agents, Repair Loop & Tenant Security', () => {
  let srv: TestServer;
  let fixtures: GoldenMediaFixtures;

  before(async () => {
    fixtures = ensureGoldenMediaFixtures();
    srv = await startTestServer({
      BACKUP_INTERVAL_HOURS: '0',
      SESSION_SECRET,
      JOB_HEARTBEAT_MS: '150',
      PATH: `/tmp/ffmpeg-bin:${process.env.PATH || ''}`,
    });
  });

  after(async () => {
    if (srv) await srv.stop();
  });

  const authHeaders = (token: string, extra: Record<string, string> = {}) => ({
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
    ...extra,
  });

  test('uploads assets, runs multi-agent timeline planning, renders vertical Reel with music + VO + subtitles, validates QA, and serves Range MP4', async () => {
    const userToken = srv.signFirebaseToken({ sub: 'creator-e2e-1' });

    // 1. Register landscape clip, portrait clip, voiceover WAV, music MP3, and SRT subtitles
    const uploadAsset = async (filePath: string, filename: string) => {
      const b64 = fs.readFileSync(filePath).toString('base64');
      const r = await fetch(`${srv.baseUrl}/api/v1/media/assets`, {
        method: 'POST',
        headers: authHeaders(userToken),
        body: JSON.stringify({ filename, contentBase64: b64 }),
      });
      assert.equal(r.status, 201);
      const body = await r.json();
      assert.ok(body.asset?.id);
      assert.ok(body.asset?.manifest);
      return body.asset;
    };

    const clipLandscape = await uploadAsset(fixtures.sampleLandscape, 'drone_intro.mp4');
    const clipPortrait = await uploadAsset(fixtures.samplePortrait, 'speaker_main.mp4');
    const voWav = await uploadAsset(fixtures.sampleAudioWav, 'voiceover_narration.wav');
    const musicMp3 = await uploadAsset(fixtures.sampleMusicMp3, 'upbeat_music.mp3');
    const subSrt = await uploadAsset(fixtures.sampleSubtitlesSrt, 'captions.srt');

    // 2. Create project with auto_plan=true (invokes MediaAnalyst + CreativeDirector + VideoEditor + AudioEngineer + SubtitleAgent)
    const projRes = await fetch(`${srv.baseUrl}/api/v1/media/projects`, {
      method: 'POST',
      headers: authHeaders(userToken),
      body: JSON.stringify({
        title: 'Launch Reel',
        brief: 'Fast energetic Instagram Reel combining our intro and speaker with captions and music.',
        format: 'instagram_reel',
        asset_ids: [clipLandscape.id, clipPortrait.id, voWav.id, musicMp3.id, subSrt.id],
        auto_plan: true,
      }),
    });
    assert.equal(projRes.status, 201);
    const { project } = await projRes.json();
    assert.equal(project.timelineVersion, 1);
    assert.equal(project.timeline.tracks.video.length, 2);
    assert.equal(project.timeline.tracks.audio.length, 2);
    assert.equal(project.timeline.tracks.subtitles.length, 1);

    // 3. Submit idempotent render request (verify deduplication with same Idempotency-Key)
    const idemKey = 'idem-launch-reel-v1';
    const renderRes1 = await fetch(`${srv.baseUrl}/api/v1/media/render`, {
      method: 'POST',
      headers: authHeaders(userToken, { 'Idempotency-Key': idemKey }),
      body: JSON.stringify({
        project_id: project.id,
        timeline_version: project.timelineVersion,
        preset: 'instagram_reel',
        quality_profile: 'standard',
      }),
    });
    assert.equal(renderRes1.status, 202);
    const job1 = await renderRes1.json();
    assert.ok(job1.job_id);

    const renderRes2 = await fetch(`${srv.baseUrl}/api/v1/media/render`, {
      method: 'POST',
      headers: authHeaders(userToken, { 'Idempotency-Key': idemKey }),
      body: JSON.stringify({
        project_id: project.id,
        timeline_version: project.timelineVersion,
        preset: 'instagram_reel',
      }),
    });
    assert.equal(renderRes2.status, 200);
    const job2 = await renderRes2.json();
    assert.equal(job2.job_id, job1.job_id);
    assert.equal(job2.deduplicated, true);

    // 4. Wait for completion and verify Output Contract + QA report + Range streaming
    const finished = await waitFor(async () => {
      const r = await fetch(`${srv.baseUrl}/api/v1/media/jobs/${job1.job_id}`, {
        headers: authHeaders(userToken),
      });
      const data = await r.json();
      return data.status === 'completed' || data.status === 'failed' ? data : null;
    });

    assert.equal(finished.status, 'completed', JSON.stringify(finished));
    const contract = finished.result.output_contract;
    assert.equal(contract.status, 'completed');
    assert.equal(contract.resolution, '1080x1920');
    assert.equal(contract.codec, 'h264');
    assert.ok(contract.qa_score >= 85, `expected QA score >= 85, got ${contract.qa_score}`);
    assert.equal(contract.revision_required, false);

    // Retrieve dedicated QA endpoint
    const qaRes = await fetch(`${srv.baseUrl}/api/v1/media/jobs/${job1.job_id}/qa`, {
      headers: authHeaders(userToken),
    });
    assert.equal(qaRes.status, 200);
    const { qa_report } = await qaRes.json();
    assert.equal(qa_report.total_score, contract.qa_score);

    // Retrieve artifact metadata + Range download (HTTP 206)
    const artRes = await fetch(`${srv.baseUrl}/api/v1/media/artifacts/${contract.artifact_id}`, {
      headers: authHeaders(userToken),
    });
    assert.equal(artRes.status, 200);
    const { artifact } = await artRes.json();
    assert.ok(artifact.sizeBytes > 5000);

    const dlRange = await fetch(`${srv.baseUrl}${artifact.downloadUrl}`, {
      headers: { Range: 'bytes=0-1023' },
    });
    assert.equal(dlRange.status, 206);
    assert.equal((await dlRange.arrayBuffer()).byteLength, 1024);
  });

  test('executes automated QA repair loop when submitted timeline has an unintended black-frame gap', async () => {
    const userToken = srv.signFirebaseToken({ sub: 'creator-repair-1' });
    const b64 = fs.readFileSync(fixtures.samplePortrait).toString('base64');
    const up = await (
      await fetch(`${srv.baseUrl}/api/v1/media/assets`, {
        method: 'POST',
        headers: authHeaders(userToken),
        body: JSON.stringify({ filename: 'clip.mp4', contentBase64: b64 }),
      })
    ).json();

    const proj = await (
      await fetch(`${srv.baseUrl}/api/v1/media/projects`, {
        method: 'POST',
        headers: authHeaders(userToken),
        body: JSON.stringify({
          title: 'Gapped Project',
          brief: 'Test automated QA repair',
          format: 'instagram_reel',
          asset_ids: [up.asset.id],
        }),
      })
    ).json();

    // Intentionally leave a 2.5s black gap between two 1s clips -> first pass triggers blackdetect & gap QA failure (< 80) -> repaired!
    const putRes = await fetch(`${srv.baseUrl}/api/v1/media/projects/${proj.project.id}/timeline`, {
      method: 'PUT',
      headers: authHeaders(userToken),
      body: JSON.stringify({
        format: 'instagram_reel',
        resolution: { width: 1080, height: 1920 },
        fps: 30,
        duration_seconds: 4.5,
        tracks: {
          video: [
            { asset_id: up.asset.id, start: 0, end: 1.0, source_start: 0, source_end: 1.0 },
            { asset_id: up.asset.id, start: 3.5, end: 4.5, source_start: 1.0, source_end: 2.0 },
          ],
          audio: [],
          subtitles: [],
        },
        export: {
          container: 'mp4',
          video_codec: 'libx264',
          audio_codec: 'aac',
          pixel_format: 'yuv420p',
          video_bitrate: '8M',
        },
      }),
    });
    assert.equal(putRes.status, 200);

    const renderRes = await fetch(`${srv.baseUrl}/api/v1/media/render`, {
      method: 'POST',
      headers: authHeaders(userToken),
      body: JSON.stringify({ project_id: proj.project.id, quality_profile: 'draft' }),
    });
    assert.equal(renderRes.status, 202);
    const { job_id } = await renderRes.json();

    const finished = await waitFor(async () => {
      const r = await fetch(`${srv.baseUrl}/api/v1/media/jobs/${job_id}`, { headers: authHeaders(userToken) });
      const d = await r.json();
      return d.status === 'completed' || d.status === 'failed' ? d : null;
    });

    assert.equal(finished.status, 'completed', JSON.stringify(finished));
    assert.equal(finished.result.repaired, true, 'orchestrator must trigger automated repair pass');
    assert.ok(finished.result.qa_score >= 90, `repaired render QA score should be >= 90, got ${finished.result.qa_score}`);
    assert.ok(Math.abs(finished.result.duration - 2.0) < 0.25, 'repaired timeline snapped two 1s clips to 2.0s');
  });

  test('enforces cross-tenant isolation and blocks guest renders', async () => {
    const owner = srv.signFirebaseToken({ sub: 'tenant-owner-x' });
    const other = srv.signFirebaseToken({ sub: 'tenant-other-y' });
    const guest = await guestToken(srv.baseUrl);

    const up = await (
      await fetch(`${srv.baseUrl}/api/v1/media/assets`, {
        method: 'POST',
        headers: authHeaders(owner),
        body: JSON.stringify({ filename: 'captions.srt', textContent: '1\n00:00:00,100 --> 00:00:01,500\nHello\n' }),
      })
    ).json();

    // Intruder cannot read or probe owner's asset (uniform 404 prevents cross-tenant ID enumeration)
    const getIntrude = await fetch(`${srv.baseUrl}/api/v1/media/assets/${up.asset.id}`, {
      headers: authHeaders(other),
    });
    assert.equal(getIntrude.status, 404);

    const probeIntrude = await fetch(`${srv.baseUrl}/api/v1/media/probe`, {
      method: 'POST',
      headers: authHeaders(other),
      body: JSON.stringify({ asset_id: up.asset.id }),
    });
    assert.equal(probeIntrude.status, 404);

    // Guest is refused across upload, probe, and render with 403 sign_in_required
    const guestUpload = await fetch(`${srv.baseUrl}/api/v1/media/assets`, {
      method: 'POST',
      headers: authHeaders(guest),
      body: JSON.stringify({ filename: 'guest.srt', textContent: '1\n00:00:00,100 --> 00:00:01,000\nNo\n' }),
    });
    assert.equal(guestUpload.status, 403);

    const guestProbe = await fetch(`${srv.baseUrl}/api/v1/media/probe`, {
      method: 'POST',
      headers: authHeaders(guest),
      body: JSON.stringify({ asset_id: up.asset.id }),
    });
    assert.equal(guestProbe.status, 403);

    const guestRender = await fetch(`${srv.baseUrl}/api/v1/media/render`, {
      method: 'POST',
      headers: authHeaders(guest),
      body: JSON.stringify({ project_id: 'media_001' }),
    });
    assert.equal(guestRender.status, 403);
  });

  test('supports preset override at render time (e.g. youtube_4k project rendered as instagram_reel updates export codec)', async () => {
    const userToken = srv.signFirebaseToken({ sub: 'creator-preset-override' });
    const b64 = fs.readFileSync(fixtures.sample1080p).toString('base64');
    const up = await (
      await fetch(`${srv.baseUrl}/api/v1/media/assets`, {
        method: 'POST',
        headers: authHeaders(userToken),
        body: JSON.stringify({ filename: 'clip1080.mp4', contentBase64: b64 }),
      })
    ).json();

    const projRes = await fetch(`${srv.baseUrl}/api/v1/media/projects`, {
      method: 'POST',
      headers: authHeaders(userToken),
      body: JSON.stringify({
        title: '4K Master',
        brief: 'Master 4K timeline overridden to Square Social at render time',
        format: 'youtube_4k',
        asset_ids: [up.asset.id],
        auto_plan: true,
      }),
    });
    assert.equal(projRes.status, 201);
    const { project } = await projRes.json();
    assert.equal(project.timeline.export.video_codec, 'libx265');

    // Override preset to instagram_reel (which requires libx264, 1080x1920)
    const renderRes = await fetch(`${srv.baseUrl}/api/v1/media/render`, {
      method: 'POST',
      headers: authHeaders(userToken),
      body: JSON.stringify({
        project_id: project.id,
        preset: 'instagram_reel',
        quality_profile: 'draft',
      }),
    });
    assert.equal(renderRes.status, 202);
    const { job_id } = await renderRes.json();
    const done = await waitFor(async () => {
      const r = await fetch(`${srv.baseUrl}/api/v1/media/jobs/${job_id}`, { headers: authHeaders(userToken) });
      const d = await r.json();
      return d.status === 'completed' || d.status === 'failed' ? d : null;
    });
    assert.equal(done.status, 'completed', JSON.stringify(done));
    assert.equal(done.result.resolution, '1080x1920');
    assert.equal(done.result.codec, 'h264');
  });
});
