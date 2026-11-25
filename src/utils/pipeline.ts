import { ActiveCaptionState, Beat, CaptionChunk, CaptionModel, CaptionStyle, WordTiming } from '../types';

/**
 * Calculates estimated natural speech word-level timestamps (~2.8 words/sec)
 * with slight pauses after punctuation marks.
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

  const rawDurations: { word: string; dur: number; pause: number }[] = [];
  let rawTotalTime = 0.2;

  for (const w of rawWords) {
    const charFactor = Math.max(w.length * 0.05, 0.22);
    const hasPunctuation = /[.,!?;:]$/.test(w);
    const pause = hasPunctuation ? 0.35 : 0.08;
    const dur = charFactor / speechRateMultiplier;

    rawDurations.push({ word: w, dur, pause: pause / speechRateMultiplier });
    rawTotalTime += dur + (pause / speechRateMultiplier);
  }

  let scale = 1.0;
  if (targetDuration && targetDuration > 2.0 && rawTotalTime > 0.5) {
    const usableTarget = Math.max(targetDuration - 0.5, 1.5);
    scale = usableTarget / (rawTotalTime - 0.2);
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
    ...w,
    start_s: parseFloat(Math.max(0, w.start_s + offsetSeconds).toFixed(2)),
    end_s: parseFloat(Math.max(0.1, w.end_s + offsetSeconds).toFixed(2)),
  }));
}

/**
 * Formats a word for display while preserving expressive punctuation (? and !) and contractions,
 * removing only weak inline punctuation (commas, trailing periods, semicolons).
 */
export function formatCaptionDisplayWord(word: string, uppercase = true): string {
  const cleaned = word.replace(/[.,;:]+$/g, '').replace(/^[,.;:]+/g, '');
  return uppercase ? cleaned.toUpperCase() : cleaned;
}

/** Clamps caption vertical position into the mobile-safe band so HUD/controls/faces are never covered. */
export function clampCaptionPositionY(positionY: number, hasSpeakerFace = false): number {
  const lo = hasSpeakerFace ? 62 : 54;
  const hi = 78;
  return Math.min(hi, Math.max(lo, Number.isFinite(positionY) ? positionY : 68));
}

/**
 * Re-maps word-level timestamps to each beat.
 */
export function assignBeatTimings(
  beats: Array<Omit<Beat, 'id' | 'start_s' | 'end_s' | 'video_url'>>,
  words: WordTiming[],
  defaultVideoUrl = ''
): Beat[] {
  const wordCounts = beats.map((b) => b.text.trim().split(/\s+/).filter(Boolean).length);
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
        role: beat.role,
        start_s,
        end_s,
        video_url: defaultVideoUrl,
      });
    }
  } else {
    const totalDur = words.length > 0 ? words[words.length - 1].end_s : beats.length * 2.8;
    const perBeat = totalDur / Math.max(beats.length, 1);

    for (let i = 0; i < beats.length; i++) {
      const beat = beats[i];
      timedBeats.push({
        id: `beat-${i}-${Date.now()}`,
        text: beat.text,
        visual_keywords: beat.visual_keywords,
        role: beat.role,
        start_s: parseFloat((i * perBeat).toFixed(2)),
        end_s: parseFloat(((i + 1) * perBeat).toFixed(2)),
        video_url: defaultVideoUrl,
      });
    }
  }

  return timedBeats;
}

/**
 * Groups word-by-word boundary timestamps into fixed N-word bursts (when 'words' mode is explicitly chosen).
 */
export function chunkWords(words: WordTiming[], wordsPerChunk = 3): CaptionChunk[] {
  const chunks: CaptionChunk[] = [];
  const max = Math.max(1, wordsPerChunk);
  let group: WordTiming[] = [];
  const flush = () => {
    if (group.length === 0) return;
    chunks.push({
      text: group.map((w) => formatCaptionDisplayWord(w.word, true)).join(' '),
      start_s: group[0].start_s,
      end_s: group[group.length - 1].end_s,
      words: group,
      beatId: group[0].beatId,
    });
    group = [];
  };

  words.forEach((w, i) => {
    const prev = words[i - 1];
    if (group.length > 0 && prev && (/[.!?]["')\]]?$/.test(prev.word) || prev.beatId !== w.beatId || w.start_s - prev.end_s > 0.5)) {
      flush();
    }
    group.push(w);
    if (group.length >= max) flush();
  });
  flush();
  return chunks;
}

const SENTENCE_END = /[.!?]["')\]]?$/;
const CLAUSE_END = /[,;:\u2014-]["')\]]?$/;
const CONNECTIVES = new Set(['and', 'but', 'so', 'because', 'or', 'which', 'that', 'when', 'while', 'if', 'then', 'before', 'after', 'until', 'like']);
/** Words that should never sit stranded as the final dangling word of a mid-sentence caption phrase. */
const DANGLING_TAIL = new Set([
  'the', 'a', 'an', 'to', 'of', 'in', 'on', 'for', 'with', 'at', 'by', 'from',
  'is', 'are', 'was', 'were', 'your', 'my', 'our', 'their', 'this', 'these', 'those', "don't", 'never', 'not',
]);

/**
 * Phrase captions (Caption Intelligence):
 * - Groups words into natural semantic phrases aligned to sentence/clause boundaries, beat boundaries, and speech pauses.
 * - Never splits meaningful phrases arbitrarily or leaves dangling articles/prepositions at the end of a segment.
 * - Merges orphan single words into neighbours in the same sentence/beat.
 * - Preserves expressive punctuation (? and !) while dropping trailing commas/periods.
 * - Never drops a word.
 */
export function chunkCaptionPhrases(
  words: WordTiming[],
  opts: { maxWords?: number; maxChars?: number; fits?: (words: string[]) => boolean; uppercase?: boolean } = {},
): CaptionChunk[] {
  const maxWords = Math.max(1, opts.maxWords ?? 6);
  const maxChars = Math.max(6, opts.maxChars ?? 28);
  const upper = opts.uppercase !== false;
  const groups: WordTiming[][] = [];
  let group: WordTiming[] = [];
  const chars = (g: WordTiming[]) => g.reduce((n, w) => n + w.word.length, 0) + Math.max(0, g.length - 1);
  const fitsWith = (g: WordTiming[], extra: WordTiming) =>
    opts.fits ? opts.fits([...g, extra].map((x) => x.word)) : chars(g) + 1 + extra.word.length <= maxChars;

  words.forEach((w, i) => {
    const prev = words[i - 1];
    const hardBreak = prev && (SENTENCE_END.test(prev.word) || prev.beatId !== w.beatId || w.start_s - prev.end_s > 0.5);
    const softBreak = prev && (CLAUSE_END.test(prev.word) || (CONNECTIVES.has(w.word.toLowerCase().replace(/[^a-z']/g, '')) && group.length >= 3));
    const tooBig = group.length >= maxWords || (group.length > 0 && !fitsWith(group, w));
    if (group.length && (hardBreak || softBreak || tooBig)) {
      groups.push(group);
      group = [];
    }
    group.push(w);
  });
  if (group.length) groups.push(group);

  // Pass 1: Move dangling function words (e.g. "THE", "TO", "YOUR") to the start of the next phrase when in the same clause/beat.
  for (let i = 0; i < groups.length - 1; i++) {
    const cur = groups[i];
    const next = groups[i + 1];
    if (cur.length < 3 || next.length === 0) continue;
    const tail = cur[cur.length - 1];
    const cleanTail = tail.word.toLowerCase().replace(/[^a-z']/g, '');
    const sameFlow =
      !SENTENCE_END.test(tail.word) &&
      !CLAUSE_END.test(tail.word) &&
      tail.beatId === next[0].beatId &&
      next[0].start_s - tail.end_s <= 0.45;
    if (sameFlow && DANGLING_TAIL.has(cleanTail)) {
      const candidate = [tail, ...next];
      const nextFits =
        candidate.length <= maxWords + 1 &&
        (opts.fits ? opts.fits(candidate.map((x) => x.word)) : chars(candidate) <= Math.round(maxChars * 1.12));
      if (nextFits) {
        cur.pop();
        next.unshift(tail);
      }
    }
  }

  // Pass 2: Merge orphan single words into their neighbour in the same sentence/beat.
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    if (g.length !== 1 || groups.length === 1) continue;
    const w = g[0];
    const prev = groups[i - 1];
    const next = groups[i + 1];
    const samePrev = prev && !SENTENCE_END.test(prev[prev.length - 1].word) && prev[prev.length - 1].beatId === w.beatId;
    const sameNext = next && !SENTENCE_END.test(w.word) && next[0].beatId === w.beatId;
    const fits = (h: WordTiming[]) =>
      h.length + 1 <= maxWords + 1 && (opts.fits ? opts.fits([...h, w].map((x) => x.word)) : chars(h) + 1 + w.word.length <= Math.round(maxChars * 1.15));
    if (samePrev && fits(prev)) {
      prev.push(w);
      groups.splice(i--, 1);
    } else if (sameNext && fits(next)) {
      next.unshift(w);
      groups.splice(i--, 1);
    }
  }

  return groups.map((g) => ({
    text: g.map((w) => formatCaptionDisplayWord(w.word, upper)).join(' '),
    start_s: g[0].start_s,
    end_s: g[g.length - 1].end_s,
    words: g,
    beatId: g[0].beatId,
  }));
}

/**
 * Recalculates word-level caption timestamps directly from each beat's text and audio CC window [start_s, end_s].
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
 * Builds the explicit 4-layer Caption Intelligence model:
 * 1. fullTranscript (verbatim voiceover script)
 * 2. segments (phrase-grouped caption chunks)
 * 3. words (individual words linked to segmentIndex & wordIndex)
 * 4. active highlighted word lookup via getActiveCaptionState()
 */
export function buildCaptionModel(
  words: WordTiming[],
  style: Pick<CaptionStyle, 'grouping' | 'wordsPerChunk' | 'fontSize' | 'textTransform'>,
  opts: { maxChars?: number; fits?: (words: string[]) => boolean } = {},
): CaptionModel {
  const fullTranscript = words.map((w) => w.word).join(' ').trim();
  const uppercase = style.textTransform !== 'none';
  const rawSegments =
    style.grouping === 'words'
      ? chunkWords(words, style.wordsPerChunk || 3)
      : chunkCaptionPhrases(words, {
          maxWords: 6,
          maxChars: opts.maxChars ?? 28,
          fits: opts.fits,
          uppercase,
        });

  const indexedWords: WordTiming[] = [];
  const segments: CaptionChunk[] = rawSegments.map((seg, segIdx) => {
    const segWords = seg.words.map((w, wIdx) => {
      const indexed: WordTiming = { ...w, segmentIndex: segIdx, wordIndex: wIdx };
      indexedWords.push(indexed);
      return indexed;
    });
    return { ...seg, words: segWords };
  });

  return { fullTranscript, segments, words: indexedWords };
}

/** Resolves the active caption segment AND active highlighted word at playback time `t`. */
export function getActiveCaptionState(model: CaptionModel, t: number): ActiveCaptionState {
  const segIdx = model.segments.findIndex((c) => t >= c.start_s - 0.1 && t <= c.end_s + 0.15);
  if (segIdx < 0) {
    return { segment: null, segmentIndex: -1, activeWord: null, activeWordIndexInSegment: -1 };
  }
  const segment = model.segments[segIdx];
  let activeWordIdx = segment.words.findIndex((w) => t >= w.start_s - 0.04 && t <= w.end_s + 0.08);
  if (activeWordIdx < 0) {
    // Keep the most recently spoken word in the active segment highlighted during tiny inter-word gaps
    for (let i = segment.words.length - 1; i >= 0; i--) {
      if (t >= segment.words[i].start_s) {
        activeWordIdx = i;
        break;
      }
    }
  }
  return {
    segment,
    segmentIndex: segIdx,
    activeWord: activeWordIdx >= 0 ? segment.words[activeWordIdx] : null,
    activeWordIndexInSegment: activeWordIdx,
  };
}

/**
 * Automatically re-aligns all beat audio CC timestamps sequentially based on word counts.
 * Prevents overlaps and awkward gaps.
 */
export function autoAlignBeatTimelines(beats: Beat[], targetTotalDuration?: number): Beat[] {
  if (beats.length === 0) return [];

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

/**
 * Scene-level media selection without repetition: for each beat pick the best-ranked result that no other beat uses;
 * deduplicates by `url || thumbnail` so image-only fallback entries are also never repeated across scenes.
 */
export function pickDistinctAssets<T extends { url?: string; thumbnail?: string }>(resultsPerBeat: T[][]): number[] {
  const keyOf = (r: T | undefined) => r?.url || r?.thumbnail || '';
  const used = new Map<string, number>();
  const chosen: number[] = [];
  resultsPerBeat.forEach((results, b) => {
    const prevKey = b > 0 && chosen[b - 1] >= 0 ? keyOf(resultsPerBeat[b - 1][chosen[b - 1]]) : '';
    // First prefer an unused asset that has a playable video URL, then any unused asset (video or thumbnail)
    let pick = results.findIndex((r) => r.url && !used.has(r.url));
    if (pick < 0) pick = results.findIndex((r) => keyOf(r) && !used.has(keyOf(r)));
    if (pick < 0 && results.length) {
      let best = Infinity;
      results.forEach((r, i) => {
        const k = keyOf(r);
        const n = (used.get(k) || 0) + (k && k === prevKey ? 1000 : 0);
        if (n < best) {
          best = n;
          pick = i;
        }
      });
    }
    chosen.push(pick);
    const k = pick >= 0 ? keyOf(results[pick]) : '';
    if (k) used.set(k, (used.get(k) || 0) + 1);
  });
  return chosen;
}

/**
 * Re-times beats to the real narration: each beat lasts as long as its spoken audio plus a short pause, so a line is
 * never cut off by the next one and captions follow the voice instead of an estimate. Beats without a measured
 * duration keep their own length.
 */
export function retimeBeatsToNarration(beats: Beat[], durationsS: Array<number | null>, pauseS = 0.25): Beat[] {
  let t = 0;
  return beats.map((b, i) => {
    const own = Math.max(0.5, (b.end_s || 0) - (b.start_s || 0));
    const d = durationsS[i];
    const len = d && d > 0 ? d + pauseS : own;
    const out = { ...b, start_s: +t.toFixed(2), end_s: +(t + len).toFixed(2) };
    t += len;
    return out;
  });
}
