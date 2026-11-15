import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup, renderToString } from 'react-dom/server';
import { HomePage } from '../../src/components/HomePage';

describe('HomePage component', () => {
  const noop = () => {};

  it('renders brand header, hero headline, and primary CTAs', () => {
    const html = renderToStaticMarkup(
      React.createElement(HomePage, {
        onStartFree: noop,
        onSignIn: noop,
        onTrySample: noop,
      }),
    );

    assert.match(html, /Forge Studio/);
    assert.match(html, /Turn Long YouTube Videos Into/);
    assert.match(html, /Viral Shorts in Seconds/);
    assert.match(html, /Sign In/);
    assert.match(html, /Get Started Free/);
  });

  it('renders sample clips, features, and navigation anchors', () => {
    const html = renderToString(
      React.createElement(HomePage, {
        onStartFree: noop,
        onSignIn: noop,
        onTrySample: noop,
      }),
    );

    assert.match(html, /href="#features"/);
    assert.match(html, /href="#how-it-works"/);
    assert.match(html, /href="#samples"/);
    assert.match(html, /href="#pricing"/);
    assert.match(html, /Steve Jobs: Don&#x27;t Waste Your Time/);
    assert.match(html, /Huberman on Deep Sleep &amp; Focus/);
    assert.match(html, /Built Around the Original Video/);
    assert.match(html, /AI Viral Hook Detection/);
  });
});

