import { check, round, unmeasured } from './checks.ts';
import type { Check, MediaFacts, Timeline } from './models.ts';
import type { Thresholds } from './thresholds.ts';

const norm = (w: string) => w.toLowerCase().replace(/[^a-z0-9']/g, '').replace(/^'+|'+$/g, '');
export const tokens = (text: string) => String(text || '').split(/\s+/).map(norm).filter(Boolean);
const endsSentence = (t: string) => /[.!?]["')\]]?$/.test(t.trim());

/** Script words missing from the captions, in order (longest-common-subsequence alignment, so order matters). */
export function missingWords(script: string[], captions: string[]): string[] {
  const n = script.length;
  const m = captions.length;
  if (n * m > 4_000_000) {
    const counts = new Map<string, number>();
    for (const w of captions) counts.set(w, (counts.get(w) || 0) + 1);
    return script.filter((w) => {
      const c = counts.get(w) || 0;
      if (c > 0) {
        counts.set(w, c - 1);
        return false;
      }
      return true;
    });
  }
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = script[i] === captions[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const missing: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n) {
    if (j < m && script[i] === captions[j]) {
      i++;
      j++;
    } else if (j < m && dp[i][j + 1] >= dp[i + 1][j]) j++;
    else missing.push(script[i++]);
  }
  return missing;
}

/**
 * Caption quality evaluation (Weight: 15).
 * Evaluates transcript accuracy, word-level timing validity, phrase segmentation, readability,
 * mobile-safe positioning, line overflow, and highlight/speech synchronization.
 */
export function evaluateCaptions(media: MediaFacts | null, timeline: Timeline | null, th: Thresholds): Check[] {
  if (!timeline) return [unmeasured('captions', 'timeline', 'No timeline supplied, so captions could not be inspected.')];
  const { captions } = timeline;
  if (!captions.enabled) return [unmeasured('captions', 'disabled', 'Captions are disabled for this reel.')];
  const chunks = captions.chunks;
  const checks: Check[] = [];

  if (chunks.length === 0) {
    return [
      check(
        'captions',
        'present',
        false,
        'critical',
        'Captions are required/enabled, but zero caption segments were rendered.',
        { chunks: 0 },
        'Generate phrase-grouped captions from the voiceover transcript.',
      ),
    ];
  }

  // 1. Transcript accuracy / word coverage.
  const script = tokens(timeline.scriptText);
  const capWords = chunks.flatMap((c) => tokens(c.text));
  const missing = missingWords(script, capWords);
  const coverage = script.length ? 1 - missing.length / script.length : 1;
  checks.push(
    check(
      'captions',
      'coverage',
      coverage >= th.minCaptionCoverage,
      coverage < th.criticalCaptionCoverage ? 'critical' : 'major',
      `${Math.round(coverage * 100)}% of spoken script words appear in the captions.`,
      { scriptWords: script.length, captionWords: capWords.length, missing: missing.slice(0, 20), missingCount: missing.length },
      'Rebuild captions from the complete transcript so no words are dropped.',
    ),
  );

  // 2. Segment timing validity (overlaps, out-of-range, readability flash duration) + word-level timing integrity.
  let overlaps = 0;
  let outOfRange = 0;
  let flashes = 0;
  let invalidWordTimings = 0;
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    if (i > 0 && c.start_s < chunks[i - 1].end_s - 0.02) overlaps++;
    if (c.start_s < -0.01 || c.end_s > timeline.durationS + 0.25 || c.end_s <= c.start_s) outOfRange++;
    if (c.end_s - c.start_s < th.minChunkDurationS) flashes++;
    if (Array.isArray(c.wordTimings) && c.wordTimings.length > 0) {
      for (let wi = 0; wi < c.wordTimings.length; wi++) {
        const w = c.wordTimings[wi];
        if (w.end_s <= w.start_s || w.start_s < c.start_s - 0.05 || w.end_s > c.end_s + 0.05) invalidWordTimings++;
        if (wi > 0 && w.start_s < c.wordTimings[wi - 1].start_s - 0.02) invalidWordTimings++;
      }
    }
  }
  const overlapRatio = overlaps / chunks.length;
  checks.push(
    check(
      'captions',
      'overlaps',
      overlaps === 0,
      overlapRatio > 0.2 ? 'critical' : 'major',
      overlaps === 0 ? 'No overlapping caption segments.' : `${overlaps} caption segment(s) overlap the previous segment.`,
      { overlaps, chunks: chunks.length },
      'Re-align caption timestamps so each segment starts after the previous one finishes.',
    ),
  );
  checks.push(
    check(
      'captions',
      'timing_range',
      outOfRange === 0,
      outOfRange / chunks.length > 0.2 ? 'critical' : 'major',
      outOfRange === 0
        ? `All ${chunks.length} caption segments fit cleanly inside 0–${round(timeline.durationS)} s.`
        : `${outOfRange} caption segment(s) fall outside the reel duration (0–${round(timeline.durationS)} s) or have invalid duration.`,
      { outOfRange, durationS: round(timeline.durationS) },
      'Regenerate caption alignment to match the video timeline.',
    ),
  );
  if (invalidWordTimings > 0) {
    checks.push(
      check(
        'captions',
        'word_timing_sync',
        false,
        'major',
        `${invalidWordTimings} word-level highlight timestamp(s) are non-monotonic or outside their segment window.`,
        { invalidWordTimings },
        'Recalculate word-level timestamps cleanly from beat/audio durations.',
      ),
    );
  }
  checks.push(
    check(
      'captions',
      'readable_duration',
      flashes / chunks.length <= 0.1,
      'minor',
      `${flashes} caption(s) appear on screen for less than ${th.minChunkDurationS} s.`,
      { flashes, minChunkDurationS: th.minChunkDurationS },
      'Group words into natural phrases so viewers can read every caption comfortably.',
    ),
  );

  // 3. Phrase segmentation vs awkward fragments & single-word orphans.
  let fragments = 0;
  let orphans = 0;
  for (const c of chunks) {
    const complete = endsSentence(c.text) || /[,;:]$/.test(c.text.trim());
    if (c.words <= 2 && !complete) fragments++;
    if (c.words === 1 && !complete) orphans++;
  }
  const fragmentRatio = fragments / chunks.length;
  checks.push(
    check(
      'captions',
      'fragments',
      fragmentRatio <= th.maxFragmentRatio,
      fragmentRatio > 0.7 ? 'major' : 'minor',
      `${Math.round(fragmentRatio * 100)}% of captions are 1–2 word fragments stopping mid-phrase.`,
      { fragments, chunks: chunks.length, examples: chunks.filter((c) => c.words <= 2).slice(0, 6).map((c) => c.text) },
      'Switch to phrase caption grouping (natural clauses up to 2 lines) instead of 1–2 word bursts.',
    ),
  );
  checks.push(
    check(
      'captions',
      'orphans',
      orphans / chunks.length <= 0.05,
      'minor',
      `${orphans} single-word orphan caption(s).`,
      { orphans },
      'Merge dangling single words into the neighboring phrase.',
    ),
  );

  // 4. Line overflow (must stay <= maxLines).
  const maxLines = captions.maxLines ?? th.maxCaptionLines;
  const withLines = chunks.filter((c) => typeof c.lines === 'number');
  if (!withLines.length) {
    checks.push(unmeasured('captions', 'overflow', 'Rendered caption line counts were not reported.'));
  } else {
    const over = withLines.filter((c) => (c.lines as number) > maxLines).length;
    checks.push(
      check(
        'captions',
        'overflow',
        over === 0,
        'major',
        over === 0 ? `All captions fit cleanly within ${maxLines} line(s).` : `${over} caption(s) overflow past ${maxLines} lines.`,
        { over, maxLines },
        'Split long phrases at clause boundaries or slightly reduce caption font size.',
      ),
    );
  }

  // 5. Mobile-safe area positioning (avoids top UI, center face region, and bottom Shorts overlay).
  if (typeof captions.positionY === 'number') {
    const [yLo, yHi] = th.safeCaptionYRange;
    const safeOk = captions.positionY >= yLo && captions.positionY <= yHi;
    checks.push(
      check(
        'captions',
        'safe_positioning',
        safeOk,
        captions.positionY > 85 || captions.positionY < 20 ? 'major' : 'minor',
        safeOk
          ? `Captions sit at ${captions.positionY}% height (inside mobile-safe ${yLo}–${yHi}% zone).`
          : `Captions at ${captions.positionY}% height risk overlapping ${captions.positionY < yLo ? 'the speaker face / top UI' : 'the bottom YouTube Shorts / Reels title overlay'}.`,
        { positionY: captions.positionY, safeRange: th.safeCaptionYRange },
        `Move caption vertical position into the mobile-safe ${yLo}–${yHi}% band (recommended: 68%).`,
      ),
    );
  }

  // 6. Highlight & speech synchronization against measured exported audio.
  const speech = timeline.audio.narration || timeline.audio.sourceSpeech;
  if (media?.audio && speech) {
    const lead = media.analysis.silenceSegments.find((s) => s.start <= 0.05);
    const speechStart = lead ? lead.end : 0;
    const offset = chunks[0].start_s - speechStart;
    checks.push(
      check(
        'captions',
        'sync_start',
        Math.abs(offset) <= 0.6,
        'major',
        `First caption at ${round(chunks[0].start_s)} s vs detected speech onset at ${round(speechStart)} s (offset ${round(offset)} s).`,
        { captionStart: round(chunks[0].start_s), speechStart: round(speechStart), offset: round(offset) },
        'Adjust caption sync offset or re-time beats to the measured voiceover audio.',
      ),
    );
    const longSilences = media.analysis.silenceSegments.filter((s) => s.end - s.start >= 1.5);
    const shownInSilence = chunks.filter((c) => longSilences.some((s) => c.start_s >= s.start + 0.2 && c.end_s <= s.end - 0.2)).length;
    checks.push(
      check(
        'captions',
        'sync_silence',
        shownInSilence / chunks.length <= 0.1,
        'major',
        `${shownInSilence} caption(s) appear entirely during extended audio silence.`,
        { shownInSilence, longSilences: longSilences.slice(0, 6) },
        'Captions are running while voiceover is silent; regenerate voiceover alignment.',
      ),
    );
  } else if (speech) {
    checks.push(unmeasured('captions', 'sync', 'Speech synchronization check requires an exported audio stream.'));
  }

  return checks;
}
