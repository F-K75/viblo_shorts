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
  isSubtitleFile,
  parseSubtitleFile,
  segmentsToTimedText,
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

// ---------------------------------------------------------------------------------------------
// Subtitle files (SRT / WebVTT) as transcript input
// ---------------------------------------------------------------------------------------------

/** Turns the talk fixture into an SRT / VTT file with the same cue timings. */
function fixtureAsSubtitles(kind: 'srt' | 'vtt'): string {
  const segs = parsePastedTranscriptToSegments(fs.readFileSync(new URL('./fixtures/talk.transcript.txt', import.meta.url), 'utf8'));
  const ts = (t: number, sep: string) => {
    const ms = Math.round(t * 1000);
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}${sep}${String(ms % 1000).padStart(3, '0')}`;
  };
  const cues = segs.map((s, i) =>
    kind === 'srt'
      ? `${i + 1}\r\n${ts(s.start_s, ',')} --> ${ts(s.end_s, ',')}\r\n${s.text}\r\n`
      : `${ts(s.start_s, '.')} --> ${ts(s.end_s, '.')} align:start position:0%\n<v Speaker>${s.text.replace(/&/g, '&amp;')}</v>\n`,
  );
  return kind === 'srt' ? cues.join('\r\n') : `WEBVTT\nKind: captions\n\nNOTE exported by an editor\n\n${cues.join('\n')}`;
}

test('parseSubtitleFile: SRT (CRLF, cue numbers, multi-line cues, markup)', () => {
  const srt = [
    '1', '00:00:01,000 --> 00:00:04,250', 'Why does your <i>to-do</i> list', 'never get done?', '',
    '2', '00:00:04,250 --> 00:00:07,000', '{\\an8}It&#39;s not because you are lazy.', '',
    '3', '01:02:03,500 --> 01:02:05,000', 'An hour in.', '',
  ].join('\r\n');
  assert.equal(isSubtitleFile(srt), true);
  assert.deepEqual(parseSubtitleFile(srt), [
    { start_s: 1, end_s: 4.25, text: 'Why does your to-do list never get done?' },
    { start_s: 4.25, end_s: 7, text: "It's not because you are lazy." },
    { start_s: 3723.5, end_s: 3725, text: 'An hour in.' },
  ]);
});

test('parseSubtitleFile: WebVTT (header, NOTE/STYLE, cue ids, settings, short timestamps, voice tags)', () => {
  const vtt = [
    'WEBVTT - my talk', '', 'STYLE', '::cue { color: yellow }', '', 'NOTE this is a comment', '',
    'intro-1', '00:01.500 --> 00:03.000 line:90%', '<v Ana>Hello there.</v>', '',
    '00:00:03.000 --> 00:00:05.000', '<c.yellow>Second</c> <00:00:04.000><c>line</c>', '',
    '00:05.000 --> 00:06.000', '[Music]', '',
  ].join('\n');
  assert.equal(isSubtitleFile(vtt), true);
  assert.deepEqual(parseSubtitleFile(vtt), [
    { start_s: 1.5, end_s: 3, text: 'Hello there.' },
    { start_s: 3, end_s: 5, text: 'Second line' },
  ]);
});

test('parseSubtitleFile: YouTube auto-caption VTT rolling lines and 10 ms bridge cues are not duplicated', () => {
  const vtt = [
    'WEBVTT', 'Kind: captions', 'Language: en', '',
    '00:00:00.000 --> 00:00:02.000', 'so the first thing', '',
    '00:00:02.000 --> 00:00:02.010', 'so the first thing', '',
    '00:00:02.010 --> 00:00:04.000', 'so the first thing', 'you need to know', '',
    '00:00:04.000 --> 00:00:06.000', 'you need to know', 'is this', '',
  ].join('\n');
  assert.deepEqual(parseSubtitleFile(vtt).map((s) => s.text), ['so the first thing', 'you need to know', 'is this']);
});

test('parsePastedTranscriptToSegments accepts SRT and VTT; clip picking matches the plain transcript', () => {
  const plain = parsePastedTranscriptToSegments(fs.readFileSync(new URL('./fixtures/talk.transcript.txt', import.meta.url), 'utf8'));
  for (const kind of ['srt', 'vtt'] as const) {
    const segs = parsePastedTranscriptToSegments(fixtureAsSubtitles(kind));
    assert.equal(segs.length, plain.length, kind);
    assert.deepEqual(segs.map((s) => s.text), plain.map((s) => s.text), kind);
    for (let i = 0; i < segs.length; i++) assert.ok(Math.abs(segs[i].start_s - plain[i].start_s) < 0.01, kind);
    assert.equal(pickTranscriptClips(segs)[0].title, 'Why does your to-do list never actually get done?', kind);
  }
  // Plain timed formats are not mistaken for subtitle files.
  assert.equal(isSubtitleFile('0:12 hello\n0:15 world'), false);
  assert.equal(isSubtitleFile('[0:12] hello'), false);
  assert.deepEqual(parseSubtitleFile('no cues here'), []);
});

test('segmentsToTimedText: compact "[m:ss.xx] text" lines that parse back to the same timings', () => {
  const text = segmentsToTimedText([{ start_s: 65.5, end_s: 70, text: 'Hi.' }, { start_s: 3, end_s: 4, text: 'Yo.' }]);
  assert.equal(text, '[1:05.50] Hi.\n[0:03.00] Yo.');
  assert.deepEqual(parsePastedTranscriptToSegments(text).map((s) => s.start_s), [65.5, 3]);
});
