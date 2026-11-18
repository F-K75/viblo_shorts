// Unit tests for the REAL YouTube parsing code (server/lib/youtube.ts).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractYouTubeId,
  parseXmlCaptions,
  parsePastedTranscriptToSegments,
  parseTimestampToSeconds,
  estimateWordTimeline,
  estimateSentenceBeats,
  pickTranscriptClips,
} from '../server/lib/youtube.ts';
import fs from 'node:fs';

test('extractYouTubeId: all valid link formats', () => {
  const id = 'UF8uR6Z6KLc';
  for (const input of [
    `https://www.youtube.com/watch?v=${id}`,
    `https://youtube.com/watch?v=${id}&t=15s`,
    `https://youtu.be/${id}`,
    `https://youtu.be/${id}?si=abc`,
    `https://www.youtube.com/shorts/${id}`,
    `https://m.youtube.com/watch?v=${id}`,
    `https://www.youtube.com/embed/${id}`,
    `https://www.youtube.com/live/${id}`,
    `www.youtube.com/watch?v=${id}`,
    id,
    `<https://www.youtube.com/watch?v=${id}>`,
    `https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3D${id}`,
  ]) {
    assert.equal(extractYouTubeId(input), id, input);
  }
});

test('extractYouTubeId: rejects non-YouTube input (regression: topics became bogus ids)', () => {
  for (const input of [
    '',
    'not_a_url',
    '5 productivity habits that work', // previously returned "productivit"
    'productivity',
    'https://vimeo.com/123456789',
    'https://google.com/search?q=test&v=UF8uR6Z6KLc',
    'https://youtube.com.evil.com/watch?v=UF8uR6Z6KLc',
    'https://www.youtube.com/watch?v=short',
  ]) {
    assert.equal(extractYouTubeId(input), null, input);
  }
});

test('parseXmlCaptions: srv3 and classic formats, entities, noise filtering', () => {
  const srv3 = '<timedtext><body><p t="1500" d="2000"><s>Hello</s><s> world</s></p><p t="4000" d="500">[Music]</p><p t="5000" d="1000">It&#39;s &amp; done</p></body></timedtext>';
  assert.deepEqual(parseXmlCaptions(srv3), [
    { start_s: 1.5, end_s: 3.5, text: 'Hello world' },
    { start_s: 5, end_s: 6, text: "It's & done" },
  ]);
  const classic = '<transcript><text start="0.5" dur="1.25">Stay hungry</text><text start="2" dur="1">stay &quot;foolish&quot;</text></transcript>';
  assert.deepEqual(parseXmlCaptions(classic), [
    { start_s: 0.5, end_s: 1.75, text: 'Stay hungry' },
    { start_s: 2, end_s: 3, text: 'stay "foolish"' },
  ]);
  assert.deepEqual(parseXmlCaptions('garbage'), []);
});

test('parsePastedTranscriptToSegments: YouTube "Show transcript" and inline formats', () => {
  const panel = '0:01\nThank you.\n0:03\nI am honored to be with you\n1:05\ntoday.';
  const segs = parsePastedTranscriptToSegments(panel);
  assert.equal(segs.length, 3);
  assert.deepEqual(segs[0], { start_s: 1, end_s: 3, text: 'Thank you.' });
  assert.equal(segs[2].start_s, 65);

  const inline = '[0:10 - 0:14] First line\n0:20: Second line';
  const s2 = parsePastedTranscriptToSegments(inline);
  assert.deepEqual(s2[0], { start_s: 10, end_s: 14, text: 'First line' });
  assert.equal(s2[1].start_s, 20);
  assert.deepEqual(parsePastedTranscriptToSegments('just words no times'), []);
});

test('parseTimestampToSeconds', () => {
  assert.equal(parseTimestampToSeconds('01:30'), 90);
  assert.equal(parseTimestampToSeconds('1:02:03'), 3723);
  assert.equal(parseTimestampToSeconds('12.5'), 12.5);
  assert.equal(parseTimestampToSeconds(undefined, 7), 7);
  assert.equal(parseTimestampToSeconds('abc', 3), 3);
});

test('estimateWordTimeline: monotonic, within duration, labelled estimate inputs', () => {
  const words = estimateWordTimeline('Stay hungry, stay foolish. Always.', 6, 2);
  assert.equal(words.length, 5);
  for (let i = 1; i < words.length; i++) assert.ok(words[i].start_s >= words[i - 1].end_s - 1e-9);
  assert.ok(words[0].start_s >= 2);
  assert.ok(words[words.length - 1].end_s <= 8.01);
  assert.deepEqual(estimateWordTimeline('', 5), []);
});

test('estimateSentenceBeats: splits sentences and covers full duration', () => {
  const beats = estimateSentenceBeats('One two three. Four five! Six?', 12);
  assert.equal(beats.length, 3);
  assert.equal(beats[0].start_s, 0);
  assert.ok(Math.abs(beats[2].end_s - 12) < 0.05);
});

test('pickTranscriptClips: finds the strongest self-contained moments, skips intro/outro/tangents', () => {
  const segs = parsePastedTranscriptToSegments(fs.readFileSync(new URL('./fixtures/talk.transcript.txt', import.meta.url), 'utf8'));
  assert.equal(segs.length, 31);
  const clips = pickTranscriptClips(segs);
  assert.equal(clips.length, 3);
  const firstLine = (c: (typeof clips)[number]) => segs[c.startIdx].text;
  assert.deepEqual(clips.map(firstLine).sort(), [
    'Here is the simple rule that changed everything for me.',
    'The biggest mistake people make is writing tasks as vague nouns.',
    'Why does your to-do list never actually get done?',
  ]);
  assert.equal(firstLine(clips[0]), 'Why does your to-do list never actually get done?'); // best first
  for (const c of clips) {
    const d = c.end_s - c.start_s;
    assert.ok(d >= 18 && d <= 50, `duration ${d}`);
    assert.match(segs[c.endIdx].text, /[.!?]$/, 'ends on a full sentence');
    const text = segs.slice(c.startIdx, c.endIdx + 1).map((s) => s.text).join(' ');
    assert.doesNotMatch(text, /subscribe|welcome back|office setup|Thank you so much/);
    assert.ok(c.score >= 0 && c.score <= 100);
  }
  // no overlaps
  const sorted = [...clips].sort((a, b) => a.start_s - b.start_s);
  for (let i = 1; i < sorted.length; i++) assert.ok(sorted[i].start_s >= sorted[i - 1].end_s);
});

test('pickTranscriptClips: unpunctuated auto-captions and tiny inputs', () => {
  assert.deepEqual(pickTranscriptClips([]), []);
  const auto = Array.from({ length: 40 }, (_, i) => ({ start_s: i * 2, end_s: i * 2 + 2, text: `word ${i} and some more spoken words here` }));
  const clips = pickTranscriptClips(auto);
  assert.ok(clips.length >= 1 && clips.length <= 3);
  for (const c of clips) assert.ok(c.end_s - c.start_s >= 18 && c.end_s - c.start_s <= 50);
});
