import { check, round, unmeasured } from './checks.ts';
import type { Check, MediaFacts, Timeline } from './models.ts';
import type { Thresholds } from './thresholds.ts';
import { overlapS } from './speech.ts';

const norm = (w: string) => w.toLowerCase().replace(/[^a-z0-9']/g, '').replace(/^'+|'+$/g, '');
export const tokens = (text: string) => String(text || '').split(/\s+/).map(norm).filter(Boolean);
const endsSentence = (t: string) => /[.!?]["')\]]?$/.test(t.trim());

/** Script words missing from the captions, in order (longest-common-subsequence alignment, so order matters). */
export function missingWords(script: string[], captions: string[]): string[] {
  const n = script.length;
  const m = captions.length;
  if (n * m > 4_000_000) {
    // Very long reels: fall back to multiset comparison (bounded cost).
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
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = script[i] === captions[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
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

/** Caption accuracy and synchronisation, judged from the caption chunks the renderer drew. */
export function evaluateCaptions(media: MediaFacts | null, timeline: Timeline | null, th: Thresholds): Check[] {
  if (!timeline) return [unmeasured('captions', 'timeline', 'No timeline was supplied, so captions could not be checked.')];
  const { captions } = timeline;
  if (!captions.enabled) {
    if (captions.required) return [check('captions', 'present', false, 'critical', 'Captions are required for this reel but are turned off.', { required: true }, 'Turn captions on and export again.')];
    return [unmeasured('captions', 'disabled', 'Captions are turned off for this reel.')];
  }
  const chunks = captions.chunks;
  const checks: Check[] = [];
  if (chunks.length === 0) {
    return [check('captions', 'present', false, 'critical', 'Captions are enabled but none were rendered.', {}, 'Regenerate captions from the script.')];
  }
  const script = tokens(timeline.scriptText);
  const capWords = chunks.flatMap((c) => tokens(c.text));
  const missing = missingWords(script, capWords);
  const coverage = script.length ? 1 - missing.length / script.length : 1;
  checks.push(check('captions', 'coverage', coverage >= th.minCaptionCoverage, coverage < th.criticalCaptionCoverage ? 'critical' : 'major',
    `${Math.round(coverage * 100)}% of the script's words appear in the captions.`,
    { scriptWords: script.length, captionWords: capWords.length, missing: missing.slice(0, 20), missingCount: missing.length },
    'Rebuild captions from the full script text; never drop words to make them fit.'));

  let overlaps = 0;
  let outOfRange = 0;
  let flashes = 0;
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    if (i > 0 && c.start_s < chunks[i - 1].end_s - 0.02) overlaps++;
    if (c.start_s < -0.01 || c.end_s > timeline.durationS + 0.25 || c.end_s <= c.start_s) outOfRange++;
    if (c.end_s - c.start_s < th.minChunkDurationS) flashes++;
  }
  const overlapRatio = overlaps / chunks.length;
  checks.push(check('captions', 'overlaps', overlaps === 0, overlapRatio > 0.2 ? 'critical' : 'major', `${overlaps} caption(s) overlap the previous one.`, { overlaps }, 'Re-time captions so each starts after the previous ends.'));
  checks.push(check('captions', 'timing_range', outOfRange === 0, outOfRange / chunks.length > 0.2 ? 'critical' : 'major',
    `${outOfRange} caption(s) fall outside the reel (0-${round(timeline.durationS)} s) or have no duration.`, { outOfRange }, 'Re-time captions to the audio.'));
  checks.push(check('captions', 'readable_duration', flashes / chunks.length <= 0.1, 'minor',
    `${flashes} caption(s) are on screen for less than ${th.minChunkDurationS} s.`, { flashes }, 'Group words into phrases so each caption stays readable.'));

  // Fragments: short captions that stop mid-sentence ("WHY DOES" | "YOUR TO-DO").
  let fragments = 0;
  let orphans = 0;
  for (const c of chunks) {
    const complete = endsSentence(c.text) || /[,;:]$/.test(c.text.trim());
    if (c.words <= 2 && !complete) fragments++;
    if (c.words === 1 && !complete) orphans++;
  }
  const fragmentRatio = fragments / chunks.length;
  checks.push(check('captions', 'fragments', fragmentRatio <= th.maxFragmentRatio, fragmentRatio > 0.7 ? 'major' : 'minor',
    `${Math.round(fragmentRatio * 100)}% of captions are 1-2 word fragments that stop mid-phrase.`,
    { fragments, chunks: chunks.length, examples: chunks.filter((c) => c.words <= 2).slice(0, 6).map((c) => c.text) },
    'Use phrase captions (whole clauses, up to two lines) instead of fixed 2-word chunks.'));
  checks.push(check('captions', 'orphans', orphans / chunks.length <= 0.05, 'minor', `${orphans} single-word orphan caption(s).`, { orphans }, 'Merge single words into the neighbouring phrase.'));
  const withLines = chunks.filter((c) => typeof c.lines === 'number');
  if (!withLines.length) checks.push(unmeasured('captions', 'overflow', 'Line layout was not reported by the renderer.'));
  else {
    const over = withLines.filter((c) => (c.lines as number) > (captions.maxLines ?? th.maxCaptionLines)).length;
    checks.push(check('captions', 'overflow', over === 0, 'major', `${over} caption(s) need more than ${captions.maxLines ?? th.maxCaptionLines} lines.`, { over }, 'Split long phrases across captions at clause boundaries.'));
  }

  // Safe area: Shorts overlays cover the top bar, the bottom ~20% (title/channel) and the right edge (buttons).
  if (captions.box) {
    const b = captions.box;
    const sa = th.safeArea;
    const inside = b.top >= sa.top && b.bottom <= sa.bottom && b.left >= sa.side && b.right <= 1 - sa.side;
    checks.push(check('captions', 'safe_area', inside, b.bottom > 0.92 || b.top < 0.02 || b.left < 0 || b.right > 1 ? 'major' : 'minor',
      inside ? 'Captions stay inside the mobile safe area.' : `Caption box spans ${Math.round(b.top * 100)}–${Math.round(b.bottom * 100)}% of the height and ${Math.round(b.left * 100)}–${Math.round(b.right * 100)}% of the width; the safe area is ${Math.round(sa.top * 100)}–${Math.round(sa.bottom * 100)}% × ${Math.round(sa.side * 100)}–${Math.round((1 - sa.side) * 100)}%.`,
      { box: b, safeArea: sa }, 'Move captions up into the safe area (YouTube\'s title and buttons cover the bottom and right edge).'));
  } else checks.push(unmeasured('captions', 'safe_area', 'The renderer did not report the caption position.'));

  // Word timing provenance and the active-word highlight.
  const wt = captions.wordTiming;
  if (wt) {
    checks.push(check('captions', 'word_timing', wt !== 'estimated', 'minor',
      wt === 'aligned' ? 'Word timings are aligned to the real voice track.' : wt === 'transcript' ? "Word timings come from the speaker's transcript times." : 'Word timings are estimated from text length, not measured from the voice.',
      { wordTiming: wt }, 'Enable AI voice (narration is aligned word by word) or provide a timed transcript.'));
  }
  if (captions.words?.length) {
    const ws = captions.words;
    let bad = 0;
    for (let i = 0; i < ws.length; i++) {
      if (!(ws[i].end_s > ws[i].start_s) || (i > 0 && ws[i].start_s < ws[i - 1].start_s - 0.01)) bad++;
    }
    const outside = ws.filter((w) => !chunks.some((c) => w.start_s >= c.start_s - 0.05 && w.start_s <= c.end_s + 0.05)).length;
    checks.push(check('captions', 'highlight_sync', bad === 0 && outside / ws.length <= 0.02, bad / ws.length > 0.1 ? 'major' : 'minor',
      `${bad} word timing(s) out of order or empty; ${outside} highlighted word(s) fall outside their caption.`, { words: ws.length, invalid: bad, outsideCaption: outside },
      'Re-align the word timings so the highlight follows the voice.'));
  }

  // Sync with the measured audio: captions must appear while the words are being SPOKEN, not over silence.
  const speech = timeline.audio.speechExpected ?? (timeline.audio.narration || timeline.audio.sourceSpeech);
  const sig = media?.analysis.audioSignal;
  if (media?.audio && speech && sig && !sig.digitalSilence && sig.speechSpans.length) {
    const speechStart = sig.speechSpans[0].start;
    const offset = chunks[0].start_s - speechStart;
    checks.push(check('captions', 'sync_start', Math.abs(offset) <= 0.6, Math.abs(offset) > 1.5 ? 'critical' : 'major', `First caption at ${round(chunks[0].start_s)} s, speech starts at ${round(speechStart)} s.`,
      { captionStart: round(chunks[0].start_s), speechStart: round(speechStart), offset: round(offset) }, 'Shift captions to the speech (caption offset) or re-time them to the voice track.'));
    const capSpans = chunks.map((c) => ({ start: c.start_s, end: c.end_s }));
    // Generous tolerance: a caption is "during speech" if any of it overlaps speech (±0.2 s).
    const heard = sig.activeSpans.map((s) => ({ start: s.start - 0.2, end: s.end + 0.2 }));
    const inSilence = chunks.filter((c) => overlapS([{ start: c.start_s, end: c.end_s }], heard) < Math.min(0.15, (c.end_s - c.start_s) * 0.3));
    checks.push(check('captions', 'sync_silence', inSilence.length / chunks.length <= 0.1, inSilence.length / chunks.length > 0.4 ? 'critical' : 'major',
      `${inSilence.length} of ${chunks.length} caption(s) are shown while nothing is said.`, { examples: inSilence.slice(0, 6).map((c) => ({ text: c.text, at: round(c.start_s) })) },
      'Words are captioned during silence: the narration was cut short or the captions drift. Re-align captions to the voice.'));
    const speechS = sig.speechSpans.reduce((t, x) => t + x.end - x.start, 0);
    const captioned = overlapS(sig.speechSpans, capSpans);
    const ratio = speechS ? captioned / speechS : 1;
    checks.push(check('captions', 'speech_captioned', ratio >= 0.7, ratio < 0.4 ? 'major' : 'minor', `${Math.round(ratio * 100)}% of the measured speech has a caption on screen.`,
      { speechS: round(speechS, 1), captionedS: round(captioned, 1) }, 'Some speech has no caption: re-align captions to the voice track.'));
  } else if (speech && media?.audio && sig && !sig.digitalSilence) {
    checks.push(unmeasured('captions', 'sync', 'No speech-like audio was found to synchronise captions with (see Audio).'));
  } else if (speech && !media) {
    checks.push(unmeasured('captions', 'sync', 'Speech sync is checked on the exported file.'));
  }
  return checks;
}
