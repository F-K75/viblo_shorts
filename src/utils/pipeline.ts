import { Beat, CaptionChunk, WordTiming } from '../types';

/**
 * Calculates estimated natural speech word-level timestamps (~2.8 words/sec)
 * with slight pauses after punctuation marks, matching edge-tts cadence.
 */
export function estimateWordTimings(fullText: string, speechRateMultiplier = 1.0): WordTiming[] {
  const rawWords = fullText.trim().split(/\s+/).filter(Boolean);
  if (rawWords.length === 0) return [];

  const timings: WordTiming[] = [];
  let currentTime = 0.2; // slight initial breath pause

  for (const w of rawWords) {
    // word duration based on character length & speech rate
    const charFactor = Math.max(w.length * 0.05, 0.22);
    const hasPunctuation = /[.,!?;:]$/.test(w);
    const pause = hasPunctuation ? 0.35 : 0.08;
    const dur = (charFactor / speechRateMultiplier);

    timings.push({
      word: w,
      start_s: parseFloat(currentTime.toFixed(2)),
      end_s: parseFloat((currentTime + dur).toFixed(2)),
    });

    currentTime += dur + (pause / speechRateMultiplier);
  }

  return timings;
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

  for (let i = 0; i < words.length; i += wordsPerChunk) {
    const group = words.slice(i, i + wordsPerChunk);
    if (!group || group.length === 0) continue;

    chunks.push({
      text: group.map(w => w.word.toUpperCase().replace(/[.,!?;:]/g, '')).join(' '),
      start_s: group[0].start_s,
      end_s: group[group.length - 1].end_s,
      words: group,
    });
  }

  return chunks;
}
