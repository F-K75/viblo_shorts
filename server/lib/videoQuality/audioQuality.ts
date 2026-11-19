import { check, round, unmeasured } from './checks.ts';
import type { Check, MediaFacts, Timeline } from './models.ts';
import type { Thresholds } from './thresholds.ts';

/** Audio presence, loudness, clipping, silence, audio/video alignment and (configured) speech/music balance. */
export function evaluateAudio(media: MediaFacts | null, timeline: Timeline | null, th: Thresholds): Check[] {
  const required = timeline?.audio.required ?? true;
  const speech = Boolean(timeline && (timeline.audio.narration || timeline.audio.sourceSpeech));
  const a = media?.audio;
  if (!media || !a) {
    return [check('audio', 'audio_present', !required, 'critical', required ? 'No audio track.' : 'No audio track (not required).', { required }, 'Enable music, AI voice or the source audio and export again.')];
  }
  const x = media.analysis;
  const checks: Check[] = [];
  const silent = x.meanVolumeDb !== null && x.meanVolumeDb < -60;
  checks.push(check('audio', 'audio_present', !(required && silent), 'critical',
    silent ? `The audio track is silent (mean ${x.meanVolumeDb} dB).` : `Audio present (mean ${x.meanVolumeDb ?? '?'} dB).`,
    { meanVolumeDb: x.meanVolumeDb }, 'The audio graph was not running during export; play the preview once, then export again.'));
  if (x.loudnessLufs === null) checks.push(unmeasured('audio', 'loudness', 'Loudness could not be measured.'));
  else {
    const [lo, hi] = th.loudnessRange;
    const ok = x.loudnessLufs >= lo && x.loudnessLufs <= hi;
    checks.push(check('audio', 'loudness', ok, x.loudnessLufs < lo - 15 ? 'major' : 'minor', `Integrated loudness ${x.loudnessLufs} LUFS (target ${lo} to ${hi}).`,
      { lufs: x.loudnessLufs, range: th.loudnessRange }, 'Normalise to about -14 LUFS (the delivery conform does this).'));
  }
  const clipped = (x.truePeakDb !== null && x.truePeakDb > th.maxTruePeakDb) || (x.clippedSamples ?? 0) > 100;
  checks.push(check('audio', 'clipping', !clipped, (x.clippedSamples ?? 0) > 1000 ? 'major' : 'minor',
    `True peak ${x.truePeakDb ?? '?'} dBFS, ${x.clippedSamples ?? 0} samples at full scale.`, { truePeakDb: x.truePeakDb, clippedSamples: x.clippedSamples },
    'Lower music/voice volume or limit the peaks.'));
  const silenceS = x.silenceSegments.reduce((s, g) => s + (g.end - g.start), 0);
  const silenceRatio = media.durationS ? silenceS / media.durationS : 0;
  checks.push(check('audio', 'silence', silenceRatio <= th.maxSilenceRatio || !speech, speech ? 'major' : 'minor',
    `${round(silenceS, 1)} s of silence (${Math.round(silenceRatio * 100)}%).`, { silenceS: round(silenceS), ratio: round(silenceRatio, 3), segments: x.silenceSegments.slice(0, 10) },
    'Narration or source audio is missing for part of the reel.'));
  const drift = Math.abs(a.durationS - media.durationS);
  checks.push(check('audio', 'av_alignment', drift <= th.maxAvDriftS, 'major', `Audio ${round(a.durationS)} s vs video ${round(media.durationS)} s.`,
    { audioS: round(a.durationS), videoS: round(media.durationS) }, 'Audio and video lengths differ; re-export.'));
  if (speech && timeline?.audio.music) {
    // Stems are not available after mixing, so this checks the configured mix rather than separating sources.
    const vol = timeline.audio.musicVolume ?? 0;
    checks.push(check('audio', 'speech_music_balance', vol <= 0.35, 'minor', `Music level ${Math.round(vol * 100)}% under speech (configured mix).`,
      { musicVolume: vol, basis: 'configured mix (stems are not separable after export)' }, 'Lower the background music under speech.'));
  }
  return checks;
}
