import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { YouTubeMetadataCard } from '../../src/components/YouTubeMetadataCard';
import type { ShortScript } from '../../src/types';

describe('YouTubeMetadataCard component', () => {
  const sampleScript: ShortScript = {
    hook: 'This one habit changes everything',
    title: 'Why 99% Miss This Focus Trick',
    description: 'Deep work starts with eliminating context switches.',
    hashtags: ['#shorts', '#productivity', '#focus'],
    viralScore: 92,
    beats: [
      {
        id: 'beat-1',
        text: 'Stop checking notifications in the first hour.',
        visual_keywords: 'person working focus desk',
        start_s: 0,
        end_s: 5,
        video_url: 'https://example.com/clip.mp4',
      },
    ],
  };

  it('renders script title, description, and hashtags', () => {
    const html = renderToStaticMarkup(
      React.createElement(YouTubeMetadataCard, {
        script: sampleScript,
        topic: 'Productivity',
      }),
    );

    assert.match(html, /Why 99% Miss This Focus Trick/);
    assert.match(html, /Deep work starts with eliminating context switches\./);
    assert.match(html, /#shorts/);
    assert.match(html, /#productivity/);
    assert.match(html, /#focus/);
  });
});

