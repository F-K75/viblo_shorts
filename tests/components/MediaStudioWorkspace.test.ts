import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MediaStudioWorkspace } from '../../src/components/MediaStudioWorkspace';

describe('MediaStudioWorkspace component', () => {
  it('renders KPI cards, multi-track timeline lanes (VIDEO 1, AUDIO, SUBTITLES), and 5-dimension QA scorecard', () => {
    const html = renderToStaticMarkup(
      React.createElement(MediaStudioWorkspace, {
        initialAssets: [
          {
            id: 'asset_11111111111111111111111111111111',
            kind: 'video',
            originalFilename: 'hero_clip.mp4',
            sizeBytes: 250_000,
            manifest: {
              durationSeconds: 15,
              width: 1080,
              height: 1920,
              fps: 30,
              videoCodec: 'h264',
              audioCodec: 'aac',
              aspectRatio: '9:16',
              warnings: [],
            },
          },
          {
            id: 'asset_22222222222222222222222222222222',
            kind: 'audio',
            originalFilename: 'bg_music.mp3',
            sizeBytes: 90_000,
          },
        ],
        initialTimeline: {
          project_id: 'mproj_000000000000000000000001',
          format: 'instagram_reel',
          resolution: { width: 1080, height: 1920 },
          fps: 30,
          duration_seconds: 30,
          tracks: {
            video: [
              {
                asset_id: 'asset_11111111111111111111111111111111',
                start: 0,
                end: 15,
                source_start: 0,
                source_end: 15,
                transition_out: 'fade',
              },
            ],
            audio: [
              {
                asset_id: 'asset_22222222222222222222222222222222',
                role: 'music',
                start: 0,
                end: 30,
                volume: 0.25,
              },
            ],
            subtitles: [{ start: 0.5, end: 4.0, text: 'Hook line' }],
          },
        },
        initialQaReport: {
          job_id: 'render_123',
          total_score: 92,
          band: 'publish_ready',
          passed: true,
          revision_required: false,
          dimensions: {
            technical_integrity: 25,
            visual_quality: 24,
            audio_quality: 18,
            editing_quality: 16,
            creative_compliance: 9,
          },
          warnings: [],
          failures: [],
          repair_actions: [],
        },
      }),
    );

    assert.match(html, /Forge Media Studio/);
    assert.match(html, /02/); // 2 assets
    assert.match(html, /00:30/); // 30s timeline
    assert.match(html, /92\/100/); // QA score
    assert.match(html, /VIDEO 1/);
    assert.match(html, /AUDIO/);
    assert.match(html, /SUBTITLES/);
    assert.match(html, /Technical Integrity/);
    assert.match(html, /25\/25/);
    assert.match(html, /publish ready/);
  });
});
