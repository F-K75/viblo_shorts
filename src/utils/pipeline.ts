import { Beat, CaptionChunk, WordTiming } from '../types';

/**
 * Calculates estimated natural speech word-level timestamps (~2.8 words/sec)
 * with slight pauses after punctuation marks, matching edge-tts cadence.
 * If targetDuration is provided (e.g. from YouTube clip span), it dynamically scales
 * word durations so captions accurately span the exact length of the speaker's audio.
 */
export function estimateWordTimings(
  fullText: string,
  speechRateMultiplier = 1.0,
  targetDuration?: number
): WordTiming[] {
  const rawWords = fullText.trim().split(/\s+/).filter(Boolean);
  if (rawWords.length === 0) return [];

  // First pass: compute raw durations based on character length and punctuation pauses
  const rawDurations: { word: string; dur: number; pause: number }[] = [];
  let rawTotalTime = 0.2; // initial pause

  for (const w of rawWords) {
    const charFactor = Math.max(w.length * 0.05, 0.22);
    const hasPunctuation = /[.,!?;:]$/.test(w);
    const pause = hasPunctuation ? 0.35 : 0.08;
    const dur = charFactor / speechRateMultiplier;

    rawDurations.push({ word: w, dur, pause: pause / speechRateMultiplier });
    rawTotalTime += dur + (pause / speechRateMultiplier);
  }

  // Scale factor if targetDuration is specified (with headroom of 0.2s start and 0.3s end)
  let scale = 1.0;
  if (targetDuration && targetDuration > 2.0 && rawTotalTime > 0.5) {
    const usableTarget = Math.max(targetDuration - 0.5, 1.5);
    scale = usableTarget / (rawTotalTime - 0.2);
    // Keep scale within sensible speaking boundaries (0.5x to 2.2x)
    scale = Math.max(0.5, Math.min(scale, 2.2));
  }

  const timings: WordTiming[] = [];
  let currentTime = 0.2;

  for (const item of rawDurations) {
    const scaledDur = item.dur * scale;
    const scaledPause = item.pause * scale;

    timings.push({
      word: item.word,
      start_s: parseFloat(currentTime.toFixed(2)),
      end_s: parseFloat((currentTime + scaledDur).toFixed(2)),
    });

    currentTime += scaledDur + scaledPause;
  }

  return timings;
}

/**
 * Adjusts all word-level timings by an offset (positive shifts text later, negative shifts text earlier)
 */
export function applyCaptionOffset(words: WordTiming[], offsetSeconds: number): WordTiming[] {
  if (!offsetSeconds || offsetSeconds === 0) return words;
  return words.map((w) => ({
    word: w.word,
    start_s: parseFloat(Math.max(0, w.start_s + offsetSeconds).toFixed(2)),
    end_s: parseFloat(Math.max(0.1, w.end_s + offsetSeconds).toFixed(2)),
    beatId: w.beatId,
  }));
}

/**
 * Re-maps word-level timestamps to each beat, faithfully reproducing
 * assign_beat_timings from original utils.py
 */
export function assignBeatTimings(
  beats: Array<Omit<Beat, 'id' | 'start_s' | 'end_s' | 'video_url'>>,
  words: WordTiming[],
  defaultVideoUrl = ''
): Beat[] {
  const wordCounts = beats.map(b => b.text.trim().split(/\s+/).filter(Boolean).length);
  const totalExpected = wordCounts.reduce((acc, count) => acc + count, 0);

  const timedBeats: Beat[] = [];

  if (words.length >= totalExpected && totalExpected > 0) {
    let idx = 0;
    for (let i = 0; i < beats.length; i++) {
      const beat = beats[i];
      const count = wordCounts[i];
      const span = words.slice(idx, idx + count);
      idx += count;

      const prevEnd = timedBeats.length > 0 ? timedBeats[timedBeats.length - 1].end_s : 0;
      const start_s = span.length > 0 ? span[0].start_s : prevEnd;
      const end_s = span.length > 0 ? span[span.length - 1].end_s : start_s + 1.5;

      timedBeats.push({
        id: `beat-${i}-${Date.now()}`,
        text: beat.text,
        visual_keywords: beat.visual_keywords,
        start_s,
        end_s,
        video_url: defaultVideoUrl,
      });
    }
  } else {
    // Fallback: split total duration evenly across beats
    const totalDur = words.length > 0 ? words[words.length - 1].end_s : beats.length * 2.8;
    const perBeat = totalDur / Math.max(beats.length, 1);

    for (let i = 0; i < beats.length; i++) {
      const beat = beats[i];
      timedBeats.push({
        id: `beat-${i}-${Date.now()}`,
        text: beat.text,
        visual_keywords: beat.visual_keywords,
        start_s: parseFloat((i * perBeat).toFixed(2)),
        end_s: parseFloat(((i + 1) * perBeat).toFixed(2)),
        video_url: defaultVideoUrl,
      });
    }
  }

  return timedBeats;
}

/**
 * Groups word-by-word boundary timestamps into short caption chunks (2-4 words)
 * faithfully reproducing caption_renderer.py
 */
export function chunkWords(words: WordTiming[], wordsPerChunk = 3): CaptionChunk[] {
  const chunks: CaptionChunk[] = [];
  const max = Math.max(1, wordsPerChunk);
  let group: WordTiming[] = [];
  const flush = () => {
    if (group.length === 0) return;
    chunks.push({
      text: group.map((w) => w.word.toUpperCase().replace(/[.,!?;:]/g, '')).join(' '),
      start_s: group[0].start_s,
      end_s: group[group.length - 1].end_s,
      words: group,
    });
    group = [];
  };

  words.forEach((w, i) => {
    const prev = words[i - 1];
    // Never join words across a sentence end, a beat change, or a real pause: "LAZY THE" reads badly.
    if (group.length > 0 && prev && (/[.!?]["')\]]?$/.test(prev.word) || prev.beatId !== w.beatId || w.start_s - prev.end_s > 0.5)) {
      flush();
    }
    group.push(w);
    if (group.length >= max) flush();
  });
  flush();
  return chunks;
}

/**
 * Recalculates word-level caption timestamps directly from each beat's text and audio CC window [start_s, end_s].
 * Whenever the user edits text, adjusts timestamps, or syncs audio CC in the beat timeline,
 * this ensures the player's animated captions and export canvas match the audio 100%.
 */
export function recalculateWordsFromBeats(beats: Beat[]): WordTiming[] {
  const allWords: WordTiming[] = [];

  for (let bIndex = 0; bIndex < beats.length; bIndex++) {
    const beat = beats[bIndex];
    const rawWords = (beat.text || '').trim().split(/\s+/).filter(Boolean);
    if (rawWords.length === 0) continue;

    const bStart = Math.max(0, beat.start_s || 0);
    const bEnd = Math.max(bStart + 0.4, beat.end_s || bStart + 2.5);
    const bDuration = bEnd - bStart;

    // Weight calculation based on syllables/character lengths and punctuation
    const weights: number[] = [];
    for (const w of rawWords) {
      const charWeight = Math.max(w.length * 0.05, 0.2);
      const hasPunctuation = /[.,!?;:]$/.test(w);
      const pauseWeight = hasPunctuation ? 0.35 : 0.08;
      weights.push(charWeight + pauseWeight);
    }
    const totalWeight = weights.reduce((acc, v) => acc + v, 0);

    let curTime = bStart;
    for (let i = 0; i < rawWords.length; i++) {
      const w = rawWords[i];
      const slotDuration = (weights[i] / totalWeight) * bDuration;
      const isLastWordInBeat = i === rawWords.length - 1;
      const speechSpan = isLastWordInBeat ? slotDuration * 0.95 : slotDuration * 0.85;

      const wStart = parseFloat(curTime.toFixed(2));
      const wEnd = parseFloat(Math.min(bEnd, curTime + speechSpan).toFixed(2));

      allWords.push({
        word: w,
        start_s: wStart,
        end_s: Math.max(wStart + 0.1, wEnd),
        beatId: beat.id,
      });

      curTime += slotDuration;
    }
  }

  return allWords;
}

/**
 * Automatically re-aligns all beat audio CC timestamps sequentially based on word counts.
 * Prevents overlaps and awkward gaps.
 */
export function autoAlignBeatTimelines(beats: Beat[], targetTotalDuration?: number): Beat[] {
  if (beats.length === 0) return [];

  // Calculate natural duration for each beat based on speech rate (~2.7 words/sec + pauses)
  const rawDurations = beats.map((b) => {
    const wordCount = (b.text || '').trim().split(/\s+/).filter(Boolean).length;
    return Math.max(1.8, wordCount * 0.36 + 0.3);
  });

  const sumRaw = rawDurations.reduce((acc, d) => acc + d, 0);
  let scale = 1.0;

  if (targetTotalDuration && targetTotalDuration > 2.0 && sumRaw > 0) {
    scale = targetTotalDuration / sumRaw;
  }

  let currentTime = 0;
  return beats.map((b, idx) => {
    const duration = parseFloat((rawDurations[idx] * scale).toFixed(2));
    const start_s = parseFloat(currentTime.toFixed(2));
    const end_s = parseFloat((currentTime + duration).toFixed(2));
    currentTime = end_s;

    return {
      ...b,
      start_s,
      end_s,
    };
  });
}

/**
 * Shifts all beats by a given delta in seconds
 */
export function shiftAllBeats(beats: Beat[], deltaSeconds: number): Beat[] {
  return beats.map((b) => ({
    ...b,
    start_s: parseFloat(Math.max(0, b.start_s + deltaSeconds).toFixed(2)),
    end_s: parseFloat(Math.max(0.2, b.end_s + deltaSeconds).toFixed(2)),
  }));
}

function formatSrtTimestamp(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

export function generateSrtFromBeats(beats: Beat[]): string {
  return beats
    .map((b, idx) => {
      const start = formatSrtTimestamp(b.start_s);
      const end = formatSrtTimestamp(b.end_s);
      return `${idx + 1}\n${start} --> ${end}\n${b.text.trim()}\n`;
    })
    .join('\n');
}


