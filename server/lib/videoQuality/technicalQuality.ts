import { expectedSpeechSpans, speechExpected } from './audioQuality.ts';
import { check, round, unmeasured } from './checks.ts';
import type { Check, MediaFacts, Timeline } from './models.ts';
import { overlapS, type ActivitySpan } from './speech.ts';
import type { Thresholds } from './thresholds.ts';

/**
 * Global offset between where speech SHOULD be (captions/script timing) and where it IS (measured speech):
 * the shift in [-maxS, +maxS] that maximises their overlap. Positive = the audio is late.
 */
export function speechOffset(expected: ActivitySpan[], heard: ActivitySpan[], maxS = 3, stepS = 0.05): { offsetS: number; gain: number; base: number } {
  const total = expected.reduce((s, e) => s + e.end - e.start, 0);
  if (!total || !heard.length) return { offsetS: 0, gain: 0, base: 0 };
  const at = (d: number) => overlapS(expected.map((e) => ({ start: e.start + d, end: e.end + d })), heard) / total;
  const base = at(0);
  let best = 0;
  let bestV = base;
  for (let d = -maxS; d <= maxS + 1e-9; d += stepS) {
    const v = at(d);
    if (v > bestV + 1e-9 || (Math.abs(v - bestV) < 1e-9 && Math.abs(d) < Math.abs(best))) {
      bestV = v;
      best = d;
    }
  }
  return { offsetS: round(best, 2), gain: round(bestV - base, 3), base: round(base, 3) };
}

/** Technical consistency (10 pts): timestamps, A/V alignment, frame timing regularity, audio format. */
export function evaluateTechnical(media: MediaFacts | null, timeline: Timeline | null, th: Thresholds): Check[] {
  if (!media || !media.video) return [unmeasured('technical', 'streams', 'No decodable streams to check.')];
  const checks: Check[] = [];
  const tm = media.analysis.timing;
  const a = media.audio;
  const vDur = media.durationS;
  if (a) {
    const drift = Math.abs(a.durationS - vDur);
    checks.push(check('technical', 'av_duration', drift <= th.maxAvDriftS, drift > 2 ? 'critical' : 'major', `Audio lasts ${round(a.durationS)} s, video ${round(vDur)} s (difference ${round(drift)} s).`,
      { audioS: round(a.durationS), videoS: round(vDur), driftS: round(drift) }, 'Audio and video lengths differ; re-export or remux.'));
    if (tm && tm.audioStartS !== null) {
      const off = Math.abs(tm.videoStartS - tm.audioStartS);
      checks.push(check('technical', 'av_start_offset', off <= 0.1, off > 1 ? 'critical' : 'major', `Streams start ${round(off, 3)} s apart (video ${tm.videoStartS} s, audio ${tm.audioStartS} s).`,
        { videoStartS: tm.videoStartS, audioStartS: tm.audioStartS }, 'Remux with aligned start times (the delivery conform resets timestamps).'));
    }
    const sig = media.analysis.audioSignal;
    if (timeline && speechExpected(timeline) && sig && !sig.digitalSilence && sig.speechSpans.length) {
      const exp = expectedSpeechSpans(timeline);
      const o = speechOffset(exp, sig.speechSpans);
      // Only call it an offset when shifting clearly explains the speech better than the current timing.
      const offset = Math.abs(o.offsetS) >= 0.3 && o.gain >= 0.1 ? o.offsetS : 0;
      checks.push(check('technical', 'av_sync', Math.abs(offset) <= 0.3, Math.abs(offset) > 1 ? 'critical' : 'major',
        offset ? `Speech is ${Math.abs(offset)} s ${offset > 0 ? 'later' : 'earlier'} than the captions/scenes expect it.` : 'Speech lines up with the caption and scene timing.',
        { offsetS: o.offsetS, overlapAtZero: o.base, overlapGain: o.gain, method: 'best overlap shift between caption spans and measured speech' },
        'Re-time captions/scenes to the voice track (or remove the audio delay) and export again.'));
    }
    const fmtOk = [44100, 48000].includes(a.sampleRate) && a.channels >= 1 && a.channels <= 2;
    checks.push(check('technical', 'audio_format', fmtOk, 'minor', `Audio ${a.sampleRate} Hz, ${a.channels} channel(s).`, { sampleRate: a.sampleRate, channels: a.channels },
      'Resample to 48 kHz stereo/mono (the delivery conform does this).'));
  }
  if (!tm) checks.push(unmeasured('technical', 'timestamps', 'Packet timestamps could not be read.'));
  else {
    checks.push(check('technical', 'timestamps', tm.nonMonotonicDts === 0, 'major', `${tm.nonMonotonicDts} out-of-order decode timestamp(s) in ${tm.packets} video packets.`,
      { nonMonotonicDts: tm.nonMonotonicDts, packets: tm.packets }, 'Remux the file (timestamps are corrupt).'));
    const fps = media.video.fps || th.spec.fps;
    const stall = tm.maxFrameGapS > Math.max(0.25, 4 / fps);
    checks.push(check('technical', 'frame_gaps', !stall, tm.maxFrameGapS > 1 ? 'major' : 'minor', `Largest gap between frames ${round(tm.maxFrameGapS, 3)} s.`,
      { maxFrameGapS: tm.maxFrameGapS }, 'The recorder stalled: re-export with the tab in the foreground.'));
    const cfr = Math.abs(tm.declaredFps - fps) <= 0.5 && tm.frameIntervalJitterMs <= 2;
    checks.push(check('technical', 'constant_frame_rate', cfr, 'minor', `Declared ${tm.declaredFps} fps, measured ${fps} fps, frame-interval jitter ${tm.frameIntervalJitterMs} ms.`,
      { declaredFps: tm.declaredFps, measuredFps: fps, jitterMs: tm.frameIntervalJitterMs }, 'Conform to a constant frame rate (done automatically on delivery).'));
  }
  if (timeline?.captions.enabled && timeline.captions.chunks.length) {
    const lastEnd = Math.max(...timeline.captions.chunks.map((c) => c.end_s));
    checks.push(check('technical', 'caption_bounds', lastEnd <= vDur + 0.25, 'major', `Last caption ends at ${round(lastEnd)} s; the video ends at ${round(vDur)} s.`,
      { lastCaptionEndS: round(lastEnd), videoS: round(vDur) }, 'Captions run past the end of the video: re-time them or extend the reel.'));
  }
  return checks;
}
