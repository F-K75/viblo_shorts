import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getTopic, getSafeThumbnail, isPlaceholderImage, FALLBACK_THUMBNAILS } from '../src/utils/visualPlaceholders.ts';

test('getTopic: matches word prefixes, not substrings inside other words', () => {
  assert.equal(getTopic('person sleeping in a dark bedroom'), 'sleep');
  assert.equal(getTopic('brain scan'), 'study'); // "ai" must not match inside "brain"
  assert.equal(getTopic('remember this'), 'default'); // "rem" must not match inside "remember"
  assert.equal(getTopic('REM cycles'), 'sleep');
  assert.equal(getTopic('workouts at the gym'), 'fitness');
  assert.equal(getTopic(''), 'default');
  assert.equal(getTopic(undefined), 'default');
});

test('placeholders carry no topic titles and are detected as placeholders', () => {
  const svg = decodeURIComponent(FALLBACK_THUMBNAILS.default);
  assert.ok(!/Morning Routine|High Impact Beat|Daily Ritual/.test(svg));
  assert.ok(isPlaceholderImage(getSafeThumbnail('sleep')));
  assert.ok(!isPlaceholderImage('https://images.pexels.com/photo.jpg'));
  assert.equal(getSafeThumbnail('x', 'https://images.pexels.com/photo.jpg'), 'https://images.pexels.com/photo.jpg');
});
