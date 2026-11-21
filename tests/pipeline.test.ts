import { sceneHeadline } from '../src/utils/exportCanvas.ts';
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  estimateWordTimings,
  assignBeatTimings,
  chunkWords,
  chunkCaptionPhrases,
  pickDistinctAssets,
  retimeBeatsToNarration,
  recalculateWordsFromBeats,
  autoAlignBeatTimelines,
  applyCaptionOffset,
  generateSrtFromBeats,
} from '../src/utils/pipeline.js';
import { Beat } from '../src/types.js';

test('Pipeline: estimateWordTimings computes accurate word cadence and pauses', () => {
  const text = 'Never give up on your dreams, because consistency always wins.';
  const words = estimateWordTimings(text, 1.0);

  assert.equal(words.length, 10, 'Should extract exactly 10 words');
  assert.equal(words[0].word, 'Never');
  assert.ok(words[0].start_s >= 0, 'First word start time should be >= 0');
  assert.ok(words[words.length - 1].end_s > words[0].start_s, 'Last word ends after first word starts');

  // Verify sequential monotonic ordering
  for (let i = 1; i < words.length; i++) {
    assert.ok(
      words[i].start_s >= words[i - 1].start_s,
      `Word ${i} (${words[i].word}) start time must be >= word ${i - 1} (${words[i - 1].word})`
    );
  }
});

test('Pipeline: estimateWordTimings scales accurately when targetDuration is specified', () => {
  const text = 'Here are five powerful habits that top creators use to maintain extreme productivity without burning out.';
  const shortTiming = estimateWordTimings(text, 1.0, 4.0);
  const normalTiming = estimateWordTimings(text, 1.0, 8.0);

  const shortTotal = shortTiming[shortTiming.length - 1].end_s;
  const normalTotal = normalTiming[normalTiming.length - 1].end_s;

  assert.ok(
    normalTotal > shortTotal,
    `Duration with 8s target (${normalTotal}s) must be greater than 4s target (${shortTotal}s)`
  );
});

test('Pipeline: applyCaptionOffset shifts timings without negative timestamps', () => {
  const text = 'Focus on the signal not the noise.';
  const initial = estimateWordTimings(text, 1.0);

  const shiftedForward = applyCaptionOffset(initial, 1.5);
  assert.equal(shiftedForward[0].start_s, parseFloat((initial[0].start_s + 1.5).toFixed(2)));

  const shiftedBackward = applyCaptionOffset(initial, -10.0);
  assert.equal(shiftedBackward[0].start_s, 0, 'Negative offset must clamp to 0s');
});

test('Pipeline: assignBeatTimings maps words into beats accurately', () => {
  const rawBeats = [
    { text: 'Your time is limited.', visual_keywords: 'clock time' },
    { text: 'So do not waste it living someone elses life.', visual_keywords: 'person walking' },
  ];
  const fullText = rawBeats.map((b) => b.text).join(' ');
  const words = estimateWordTimings(fullText, 1.0);

  const timedBeats = assignBeatTimings(rawBeats, words, 'https://example.com/video.mp4');

  assert.equal(timedBeats.length, 2);
  assert.equal(timedBeats[0].text, rawBeats[0].text);
  assert.equal(timedBeats[1].text, rawBeats[1].text);
  assert.ok(timedBeats[0].start_s < timedBeats[0].end_s);
  assert.ok(timedBeats[1].start_s >= timedBeats[0].start_s);
  assert.equal(timedBeats[0].video_url, 'https://example.com/video.mp4');
});

test('Pipeline: chunkWords chunks words into compact caption groups', () => {
  const text = 'Stop doing this immediately if you want to succeed';
  const words = estimateWordTimings(text, 1.0);
  const chunks = chunkWords(words, 2);

  assert.ok(chunks.length > 0);
  assert.ok(chunks[0].words.length <= 2);
  assert.equal(chunks[0].start_s, words[0].start_s);
});

test('Pipeline: recalculateWordsFromBeats accurately updates word timestamps when beat is edited', () => {
  const beats: Beat[] = [
    {
      id: 'beat-1',
      text: 'First revelation hook',
      visual_keywords: 'focus',
      start_s: 0.0,
      end_s: 3.0,
      video_url: '',
    },
    {
      id: 'beat-2',
      text: 'Second core insight for the viewer',
      visual_keywords: 'inspiration',
      start_s: 3.0,
      end_s: 7.5,
      video_url: '',
    },
  ];

  const words = recalculateWordsFromBeats(beats);
  assert.equal(words.length, 9, 'Should have 3 + 6 = 9 words');

  // Verify first beat words are inside [0, 3]s
  const beat1Words = words.filter((w) => w.beatId === 'beat-1');
  assert.equal(beat1Words.length, 3);
  assert.ok(beat1Words[0].start_s >= 0.0);
  assert.ok(beat1Words[beat1Words.length - 1].end_s <= 3.0);

  // Verify second beat words are inside [3, 7.5]s
  const beat2Words = words.filter((w) => w.beatId === 'beat-2');
  assert.equal(beat2Words.length, 6);
  assert.ok(beat2Words[0].start_s >= 3.0);
  assert.ok(beat2Words[beat2Words.length - 1].end_s <= 7.5);
});

test('Pipeline: autoAlignBeatTimelines eliminates gaps and overlaps sequentially', () => {
  const overlappingBeats: Beat[] = [
    { id: 'b1', text: 'Sentence one with five words here', visual_keywords: 'a', start_s: 0, end_s: 10, video_url: '' },
    { id: 'b2', text: 'Sentence two with five more words', visual_keywords: 'b', start_s: 2, end_s: 8, video_url: '' },
  ];

  const aligned = autoAlignBeatTimelines(overlappingBeats, 12.0);
  assert.equal(aligned.length, 2);
  assert.equal(aligned[0].start_s, 0);
  assert.equal(aligned[0].end_s, aligned[1].start_s, 'Beat 2 must start exactly where Beat 1 ends');
  assert.equal(aligned[1].end_s, 12.0, 'Total duration should match target of 12.0s');
});

test('Pipeline: generateSrtFromBeats formats standard SRT timecodes', () => {
  const beats: Beat[] = [
    { id: 'b1', text: 'Welcome to Forge Studio', visual_keywords: 'a', start_s: 1.25, end_s: 4.5, video_url: '' },
    { id: 'b2', text: 'Create viral YouTube Shorts', visual_keywords: 'b', start_s: 4.5, end_s: 8.0, video_url: '' },
  ];

  const srt = generateSrtFromBeats(beats);
  assert.ok(srt.includes('1\n00:00:01,250 --> 00:00:04,500\nWelcome to Forge Studio'));
  assert.ok(srt.includes('2\n00:00:04,500 --> 00:00:08,000\nCreate viral YouTube Shorts'));
});

test('Pipeline: chunkWords never joins words across a sentence end, beat change or pause', () => {
  const w = (word: string, start_s: number, beatId = 'b1') => ({ word, start_s, end_s: start_s + 0.3, beatId });
  const chunks = chunkWords([w('not', 0), w('lazy.', 0.35), w('The', 0.7), w('real', 1.05), w('reason', 2.5), w('next', 2.85, 'b2')], 3);
  assert.deepEqual(chunks.map((c) => c.text), ['NOT LAZY', 'THE REAL', 'REASON', 'NEXT']);
});

test('Pipeline: phrase captions keep every word, end on clause/sentence boundaries, fit, and never orphan a word', () => {
  const text = 'Why does your to-do list never actually get done? It is not because you are lazy. The real reason is simple, and it changes everything.';
  const words = text.split(' ').map((word, i) => ({ word, start_s: i * 0.3, end_s: i * 0.3 + 0.25, beatId: 'b1' }));
  const chunks = chunkCaptionPhrases(words, { maxWords: 7, maxChars: 28 });
  assert.equal(chunks.flatMap((c) => c.words).length, words.length, 'no word dropped');
  assert.deepEqual(chunks.flatMap((c) => c.words.map((w) => w.word)), words.map((w) => w.word), 'order kept');
  for (const c of chunks) {
    assert.ok(c.words.length <= 8);
    const chars = c.words.map((w) => w.word).join(' ').length;
    assert.ok(chars <= Math.round(28 * 1.15), `fits: ${chars}`);
    assert.ok(!(c.words.length === 1 && !/[.!?,]$/.test(c.words[0].word)), `orphan: ${c.text}`);
  }
  assert.ok(chunks.some((c) => /DONE$/.test(c.text)) && chunks.every((c) => !/DONE IT/.test(c.text)), 'sentence end respected');
  const avg = words.length / chunks.length;
  assert.ok(avg >= 3, `phrases, not 2-word fragments (avg ${avg})`);
});

test('Pipeline: pickDistinctAssets never repeats a clip while unused results exist', () => {
  const r = (...urls: string[]) => urls.map((url) => ({ url }));
  assert.deepEqual(pickDistinctAssets([r('a', 'b'), r('a', 'b', 'c'), r('a', 'c'), []]), [0, 1, 1, -1]);
  // All results taken: reuse the least-used one, but not the clip shown immediately before.
  const picks = pickDistinctAssets([r('a'), r('b'), r('a', 'b')]);
  assert.deepEqual(picks, [0, 0, 0]);
  const urls = pickDistinctAssets([r('x', 'y'), r('x', 'y'), r('x', 'y')]).map((p, i) => [['x', 'y'], ['x', 'y'], ['x', 'y']][i][p]);
  assert.notEqual(urls[1], urls[2]);
});

test('Pipeline: retimeBeatsToNarration gives each beat its real voice length plus a pause, back to back', () => {
  const beats = [0, 1, 2].map((i) => ({ id: `b${i}`, text: `Line ${i}.`, visual_keywords: '', start_s: i * 2, end_s: i * 2 + 2, video_url: '' }));
  const out = retimeBeatsToNarration(beats, [3.1, null, 1.5], 0.25);
  assert.deepEqual(out.map((b) => [b.start_s, b.end_s]), [[0, 3.35], [3.35, 5.35], [5.35, 7.1]]);
});

describe('caption splits and offline scene headlines', () => {
  const timed = (text: string) => text.split(' ').map((word, i) => ({ word, start_s: i * 0.3, end_s: i * 0.3 + 0.25, beatId: 'b' }));
  test('a size-forced caption split never ends on a function word ("BRAIN FOG BY" | "SLEEP")', () => {
    const chunks = chunkCaptionPhrases(timed('Too little rest causes irreversible brain fog by the end of every single week'), { maxWords: 4, maxChars: 22 });
    const weak = /^(a|an|the|of|to|in|on|at|by|for|with|and|or|your)$/i;
    for (const c of chunks.slice(0, -1)) assert.doesNotMatch(c.words[c.words.length - 1].word, weak, c.text);
    assert.equal(chunks.flatMap((c) => c.words).length, 14, 'no word dropped');
  });
  test('scene headlines carry the scene\'s own key idea (numbers first, then a phrase)', () => {
    assert.equal(sceneHeadline('Keep your bedroom at 65 degrees Fahrenheit for deeper sleep.'), '65°F');
    assert.equal(sceneHeadline('Stop screens 30 minutes before bed.'), '30 MINUTES');
    assert.equal(sceneHeadline('Why does your to-do list never get done?'), 'TO-DO LIST');
    assert.equal(sceneHeadline('It is not because you are lazy.'), 'LAZY');
    assert.equal(sceneHeadline('During deep REM sleep your brain flushes out waste.'), 'DEEP REM');
  });
});
