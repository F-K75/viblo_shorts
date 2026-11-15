import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  CaptionStyleConfig,
  PRESET_STYLES,
  VIRAL_FONTS,
} from '../../src/components/CaptionStyleConfig';
import type { CaptionStyle } from '../../src/types';

describe('CaptionStyleConfig component', () => {
  const baseStyle: CaptionStyle = PRESET_STYLES[0];
  const noopChange = (_updated: Partial<CaptionStyle>) => {};

  it('renders active caption style summary and preset tabs', () => {
    const html = renderToStaticMarkup(
      React.createElement(CaptionStyleConfig, {
        style: baseStyle,
        onChange: noopChange,
      }),
    );

    assert.match(html, /Kinetic Caption Engine/);
    assert.match(html, /Alex Hormozi/);
    assert.match(html, /32px/);
    assert.match(html, /Captions Active/);
    assert.match(html, /Presets/);
    assert.match(html, /Fine-Tune/);
    assert.match(html, /Audio Sync/);
    assert.match(html, /LIVE CAPTION PREVIEW/);
  });

  it('renders Captions Hidden state when showCaptions is false', () => {
    const hiddenStyle: CaptionStyle = {
      ...baseStyle,
      name: 'MrBeast Pop',
      fontSize: 35,
      showCaptions: false,
    };

    const html = renderToStaticMarkup(
      React.createElement(CaptionStyleConfig, {
        style: hiddenStyle,
        onChange: noopChange,
      }),
    );

    assert.match(html, /Captions Hidden/);
    assert.match(html, /MrBeast Pop/);
    assert.match(html, /35px/);
  });

  it('exports non-empty PRESET_STYLES and VIRAL_FONTS catalogs', () => {
    assert.ok(PRESET_STYLES.length >= 3);
    assert.ok(VIRAL_FONTS.length >= 5);
    assert.equal(PRESET_STYLES[0].id, 'hormozi');
  });
});

