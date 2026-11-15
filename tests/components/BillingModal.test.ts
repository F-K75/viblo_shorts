import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { BillingModal } from '../../src/components/BillingModal';

describe('BillingModal component', () => {
  const noop = () => {};

  it('renders nothing when isOpen is false', () => {
    const html = renderToStaticMarkup(
      React.createElement(BillingModal, {
        isOpen: false,
        onClose: noop,
      }),
    );

    assert.equal(html, '');
  });

  it('renders plan tiers and usage meters when isOpen is true', () => {
    const html = renderToStaticMarkup(
      React.createElement(BillingModal, {
        isOpen: true,
        onClose: noop,
      }),
    );

    assert.match(html, /Creator Plans &amp; Usage Limits/);
    assert.match(html, /Daily AI Generation Quota/);
    assert.match(html, /0 \/ 50 calls/);
    assert.match(html, /Monthly Render Bandwidth/);
  });
});

