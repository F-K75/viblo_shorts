import { check, round, unmeasured } from './checks.ts';
import type { Check, MediaFacts, Timeline } from './models.ts';
import { overlapS } from './speech.ts';
import type { Thresholds } from './thresholds.ts';

const UNRECORDABLE = new Set(['youtube-embed', 'browser-tts', 'none']);

/** Does the viewer need to hear speech in this reel (voiceover script or a speaker's words)? */
export function speechExpected(t: Timeline | null): boolean {
  if (!t) return false;
  return t.audio.speechExpected ?? (t.audio.narration || t.audio.sourceSpeech);
}

/** Spans where speech should be heard: caption spans when captions exist, else the narrated beats. */
export function expectedSpeechSpans(t: Timeline): Array<{ start: number; end: number }> {
  const raw = t.captions.chunks.length
    ? t.captions.chunks.map((c) => ({ start: c.start_s, end: c.end_s }))
    : t.beats.map((b) => ({ start: b.start_s, end: b.end_s }));
  const sorted = raw.filter((s) => s.end > s.start).sort((a, b) => a.start - b.start);
  const merged: Array<{ start: number; end: number }> = [];
  for (const s of sorted) {
    const last = merged[merged.length - 1];
    if (last && s.start <= last.end + 0.3) last.end = Math.max(last.end, s.end);
    else merged.push({ ...s });
  }
  return merged;
}

/**
 * Plan-level audio checks (need only the timeline): is the speech the viewer should hear coming from a source that
 * the recorder can actually capture? Runs before rendering (precheck) and again with the file.
 */
export function evaluateAudioPlan(timeline: Timeline | null): Check[] {
  if (!timeline || !speechExpected(timeline)) return [];
  const src = timeline.audio.speechSource;
  if (!src) return [unmeasured('audio', 'speech_source', 'The speech source was not reported.')];
  const ok = !UNRECORDABLE.has(src);
  const why: Record<string, string> = {
    'youtube-embed': "The speaker's voice plays from the embedded YouTube player, which cannot be recorded into the video.",
    'browser-tts': 'The voiceover uses the browser\'s built-in speech, which plays through the speakers but cannot be recorded into the video.',
    none: 'The reel has spoken words (captions/script) but nothing is set to speak them.',
  };
  return [
    check('audio', 'speech_source', ok, 'critical', ok ? `Speech comes from a recordable source (${src}).` : why[src] || `Speech source "${src}" cannot be recorded.`,
      { speechSource: src, recordable: ok },
      src === 'youtube-embed' ? 'Attach your own copy of the video (or download the clip section), or switch the audio to AI voice narration.' : 'Use AI voice (or the offline voice) so the narration is recorded into the file.'),
  ];
}

/** Audio quality from the DECODED signal: an audio stream that carries zeros is silence, not audio. */
export function evaluateAudio(media: MediaFacts | null, timeline: Timeline | null, th: Thresholds): Check[] {
  const speech = speechExpected(timeline);
  // Silence is a failure unless the creator explicitly asked for it: a derived "no audio source enabled" flag is a
  // symptom (the failed reel had music off and an unrecordable voice), never a justification.
  const required = !timeline?.audio.silentIntended;
  const checks: Check[] = [...evaluateAudioPlan(timeline)];
  const a = media?.audio;
  if (!media) return checks;
  if (!a) {
    checks.push(check('audio', 'audio_stream', !required, 'critical', required ? 'The video has no audio track.' : 'No audio track (none required).', { required, speech },
      'Export again with narration, source audio or music enabled.'));
    return checks;
  }
  const x = media.analysis;
  const sig = x.audioSignal;
  // 1. Is there any signal at all? (stream presence never counts as audio)
  const silent = sig ? sig.digitalSilence || sig.peakDb === null || sig.peakDb < -60 : x.meanVolumeDb !== null && x.meanVolumeDb < -60;
  checks.push(check('audio', 'audio_signal', !(required && silent), 'critical',
    silent
      ? `The audio track is silent: ${sig?.digitalSilence ? 'every decoded sample is zero' : `peak ${sig?.peakDb ?? x.meanVolumeDb} dBFS`} for ${round(a.durationS, 1)} s.${required ? '' : ' (No audio was required.)'}`
      : `Audio signal present (peak ${sig?.peakDb ?? '?'} dBFS, RMS ${sig?.rmsDb ?? '?'} dBFS).`,
    { peakDb: sig?.peakDb ?? null, rmsDb: sig?.rmsDb ?? null, digitalSilence: sig?.digitalSilence ?? null, meanVolumeDb: x.meanVolumeDb, streamCodec: a.codec, required },
    speech ? 'Nothing audible was recorded. Regenerate the voiceover with a recordable voice, or attach the source video, then export again.' : 'Enable music or a voiceover and export again.'));
  if (silent) return checks; // every other audio measurement on digital silence is noise

  // 2. Level, peaks, loudness.
  if (sig?.rmsDb !== null && sig?.rmsDb !== undefined) {
    checks.push(check('audio', 'rms_level', sig.rmsDb >= th.minRmsDb, sig.rmsDb < th.minRmsDb - 15 ? 'major' : 'minor', `Average (RMS) level ${sig.rmsDb} dBFS (minimum ${th.minRmsDb}).`,
      { rmsDb: sig.rmsDb, peakDb: sig.peakDb }, 'Raise the voice/music level; the conform step normalises loudness to -14 LUFS.'));
  }
  if (x.loudnessLufs === null) checks.push(unmeasured('audio', 'loudness', 'Loudness could not be measured.'));
  else {
    const [lo, hi] = th.loudnessRange;
    const ok = x.loudnessLufs >= lo && x.loudnessLufs <= hi;
    checks.push(check('audio', 'loudness', ok, x.loudnessLufs < lo - 15 ? 'major' : 'minor', `Integrated loudness ${x.loudnessLufs} LUFS (target ${lo} to ${hi}).`,
      { lufs: x.loudnessLufs, range: th.loudnessRange }, 'Normalise to about -14 LUFS (done automatically by the delivery conform).'));
  }
  const clipped = (x.truePeakDb !== null && x.truePeakDb > th.maxTruePeakDb) || (x.clippedSamples ?? 0) > 100;
  checks.push(check('audio', 'clipping', !clipped, (x.clippedSamples ?? 0) > 1000 ? 'major' : 'minor',
    `True peak ${x.truePeakDb ?? '?'} dBFS, ${x.clippedSamples ?? 0} samples at full scale.`, { truePeakDb: x.truePeakDb, clippedSamples: x.clippedSamples },
    'Lower music/voice volume or limit the peaks.'));

  // 3. Speech: present, and covering the moments it should (voiceover completeness).
  if (speech && timeline) {
    if (!sig) checks.push(unmeasured('audio', 'speech_presence', 'Speech activity could not be measured.'));
    else {
      const expected = expectedSpeechSpans(timeline);
      const expS = expected.reduce((s, e) => s + (e.end - e.start), 0);
      const heard = overlapS(expected, sig.speechSpans);
      const coverage = expS > 0 ? heard / expS : 0;
      checks.push(check('audio', 'speech_presence', sig.speechRatio >= 0.05, 'critical',
        sig.speechRatio >= 0.05
          ? `Speech-like audio in ${Math.round(sig.speechRatio * 100)}% of the reel (syllabic modulation ${sig.modulationIndex}).`
          : `Audio is present but contains no speech-like sound (modulation ${sig.modulationIndex}); the voice is missing.`,
        { speechRatio: sig.speechRatio, activeRatio: sig.activeRatio, modulationIndex: sig.modulationIndex, method: sig.method },
        'The narration did not make it into the file: regenerate or remux the voiceover.'));
      checks.push(check('audio', 'voiceover_completeness', coverage >= th.minVoiceoverCoverage, coverage < 0.3 ? 'major' : 'minor',
        `Speech heard during ${Math.round(coverage * 100)}% of the time captions/script say someone is speaking.`,
        { coverage: round(coverage, 3), expectedS: round(expS, 1), heardS: round(heard, 1), expected: expected.slice(0, 8), speechSpans: sig.speechSpans.slice(0, 12) },
        'Parts of the voiceover are missing or cut off: regenerate the narration for those lines.'));
    }
  }
  if (speech && timeline?.audio.music) {
    // Stems are not available after mixing, so this checks the configured mix rather than separating sources.
    const vol = timeline.audio.musicVolume ?? 0;
    checks.push(check('audio', 'speech_music_balance', vol <= 0.35, 'minor', `Music level ${Math.round(vol * 100)}% under speech (configured mix).`,
      { musicVolume: vol, basis: 'configured mix (stems are not separable after export)' }, 'Lower the background music under speech.'));
  }
  return checks;
}
