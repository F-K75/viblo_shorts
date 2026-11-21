import { check, round, unmeasured } from './checks.ts';
import type { Check, MediaFacts, Timeline } from './models.ts';
import type { Thresholds } from './thresholds.ts';

/**
 * Audio quality evaluation (Weight: 15).
 * IMPORTANT: An MP4 containing an audio stream NEVER automatically passes validation.
 * We verify decoded waveform RMS/peak levels, silence percentage, integrated loudness,
 * clipping, speech-band (300–3400 Hz) presence, voiceover completeness, and A/V sync.
 */
export function evaluateAudio(media: MediaFacts | null, timeline: Timeline | null, th: Thresholds): Check[] {
  const required = timeline?.audio.required ?? true;
  const speech = Boolean(timeline && (timeline.audio.narration || timeline.audio.sourceSpeech));
  const a = media?.audio;

  if (!media || !a) {
    return [
      check(
        'audio',
        'audio_present',
        !required,
        'critical',
        required
          ? 'No audio stream found in the exported video.'
          : 'No audio stream (not required for this project).',
        { required, hasAudioStream: false },
        'Enable voiceover, source audio, or background music and re-export.',
      ),
    ];
  }

  const x = media.analysis;
  const checks: Check[] = [];

  const silenceS = x.silenceSegments.reduce((s, g) => s + Math.max(0, g.end - g.start), 0);
  const audioDur = a.durationS || media.durationS || 0;
  const silenceRatio = audioDur > 0 ? Math.min(1, silenceS / audioDur) : 0;

  // Multi-signal silence detection: mean volume, peak amplitude, RMS level, and silence ratio.
  const meanSilent = x.meanVolumeDb !== null && x.meanVolumeDb <= th.silentMeanDb;
  const peakSilent = x.maxVolumeDb !== null && x.maxVolumeDb <= th.silentPeakDb;
  const ratioSilent = silenceRatio >= th.silentRatioCritical && audioDur >= 1.5;
  const isSilent = meanSilent || peakSilent || ratioSilent;

  checks.push(
    check(
      'audio',
      'audio_present',
      !(required && isSilent),
      'critical',
      isSilent
        ? `Audio stream exists (${a.codec}) but decoded signal is silent (mean ${x.meanVolumeDb ?? '?'} dB, peak ${x.maxVolumeDb ?? '?'} dB, ${Math.round(silenceRatio * 100)}% silent).`
        : `Audible waveform verified (mean ${x.meanVolumeDb ?? '?'} dB, peak ${x.maxVolumeDb ?? '?'} dB, RMS ${x.rmsDb ?? '?'} dB).`,
      {
        codec: a.codec,
        meanVolumeDb: x.meanVolumeDb,
        maxVolumeDb: x.maxVolumeDb,
        rmsDb: x.rmsDb,
        silenceRatio: round(silenceRatio, 3),
        clientMeasuredPeakDb: timeline?.audio.clientMeasuredPeakDb ?? null,
      },
      'Regenerate or remux voiceover/audio. Ensure the audio source is unmuted and playable before export.',
    ),
  );

  // RMS volume check (healthy dynamic floor/ceiling).
  if (x.rmsDb === null && x.meanVolumeDb === null) {
    checks.push(unmeasured('audio', 'rms_volume', 'RMS volume could not be measured.'));
  } else {
    const rms = x.rmsDb ?? x.meanVolumeDb!;
    const [rLo, rHi] = th.rmsRangeDb;
    const rmsOk = !isSilent && rms >= rLo && rms <= rHi;
    checks.push(
      check(
        'audio',
        'rms_volume',
        rmsOk,
        rms < rLo - 12 ? 'major' : 'minor',
        `Audio RMS level is ${round(rms, 1)} dBFS (healthy range ${rLo} to ${rHi} dBFS).`,
        { rmsDb: round(rms, 1), meanVolumeDb: x.meanVolumeDb, maxVolumeDb: x.maxVolumeDb, range: th.rmsRangeDb },
        rms < rLo ? 'Boost or normalize voiceover/music gain to -14 LUFS.' : 'Reduce overall audio gain to prevent listener fatigue.',
      ),
    );
  }

  // Integrated loudness (EBU R128 LUFS).
  if (x.loudnessLufs === null) {
    checks.push(unmeasured('audio', 'loudness', 'Integrated loudness (LUFS) could not be measured.'));
  } else {
    const [lo, hi] = th.loudnessRange;
    const ok = x.loudnessLufs >= lo && x.loudnessLufs <= hi;
    checks.push(
      check(
        'audio',
        'loudness',
        ok,
        x.loudnessLufs < lo - 15 ? 'major' : 'minor',
        `Integrated loudness ${round(x.loudnessLufs, 1)} LUFS (target ${lo} to ${hi} LUFS).`,
        { lufs: round(x.loudnessLufs, 1), range: th.loudnessRange },
        'Normalize loudness to -14 LUFS during export conform.',
      ),
    );
  }

  // Clipping & true peak ceiling.
  const clipped = (x.truePeakDb !== null && x.truePeakDb > th.maxTruePeakDb) || (x.clippedSamples ?? 0) > 100;
  checks.push(
    check(
      'audio',
      'clipping',
      !clipped,
      (x.clippedSamples ?? 0) > 1000 ? 'major' : 'minor',
      `True peak ${x.truePeakDb ?? '?'} dBFS, ${x.clippedSamples ?? 0} clipped sample(s).`,
      { truePeakDb: x.truePeakDb, clippedSamples: x.clippedSamples ?? 0, maxTruePeakDb: th.maxTruePeakDb },
      'Lower master volume or apply a -1.5 dBFS true-peak limiter.',
    ),
  );

  // Silence percentage check.
  const silenceOk = !isSilent && (silenceRatio <= th.maxSilenceRatio || !speech);
  checks.push(
    check(
      'audio',
      'silence',
      silenceOk,
      speech || isSilent ? 'major' : 'minor',
      `${round(silenceS, 1)} s of silence (${Math.round(silenceRatio * 100)}% of ${round(audioDur, 1)} s).`,
      { silenceS: round(silenceS), ratio: round(silenceRatio, 3), maxRatio: th.maxSilenceRatio, segments: x.silenceSegments.slice(0, 10) },
      'Voiceover or source audio has extended silent gaps; check TTS generation or source audio trim.',
    ),
  );

  // Speech-band energy presence (300–3400 Hz) when narration or source speech is expected.
  if (speech) {
    if (x.speechBandMeanDb === null) {
      checks.push(unmeasured('audio', 'speech_presence', 'Voice-band (300–3400 Hz) signal could not be measured.'));
    } else {
      const speechOk = !isSilent && x.speechBandMeanDb > th.speechBandMinDb;
      checks.push(
        check(
          'audio',
          'speech_presence',
          speechOk,
          'major',
          speechOk
            ? `Voice-band energy (300–3400 Hz) detected at ${round(x.speechBandMeanDb, 1)} dB.`
            : `Voice-band (300–3400 Hz) energy is too weak (${round(x.speechBandMeanDb, 1)} dB < ${th.speechBandMinDb} dB): speech may be missing or unintelligible.`,
          { speechBandMeanDb: round(x.speechBandMeanDb, 1), minDb: th.speechBandMinDb },
          'Regenerate neural TTS voiceover or verify source speaker audio track is active.',
        ),
      );
    }
  }

  // Audio-video synchronization: both duration match AND stream start_time offset.
  const videoDur = media.video?.durationS ?? media.durationS;
  const durationDrift = Math.abs(a.durationS - videoDur);
  const startOffset = Math.abs((a.startTimeS ?? 0) - (media.video?.startTimeS ?? 0));
  const avOk = durationDrift <= th.maxAvDriftS && startOffset <= th.maxStreamStartOffsetS;
  checks.push(
    check(
      'audio',
      'av_alignment',
      avOk,
      durationDrift > th.maxAvDriftS * 2 || startOffset > th.maxStreamStartOffsetS * 2 ? 'major' : 'minor',
      `Audio ${round(a.durationS)} s vs video ${round(videoDur)} s (drift ${round(durationDrift)} s, PTS offset ${round(startOffset, 3)} s).`,
      { audioS: round(a.durationS), videoS: round(videoDur), durationDriftS: round(durationDrift), startOffsetS: round(startOffset, 3) },
      'Remux or re-export with synchronized audio/video timestamps.',
    ),
  );

  // Voiceover completeness: if speech is enabled, audio should cover the full script timeline without cutting off early.
  if (speech && timeline && timeline.durationS > 0) {
    const activeSpeechS = Math.max(0, a.durationS - silenceS);
    const coverageRatio = timeline.durationS > 0 ? a.durationS / timeline.durationS : 1;
    const completeOk = !isSilent && coverageRatio >= 0.85 && activeSpeechS >= Math.min(1.5, timeline.durationS * 0.4);
    checks.push(
      check(
        'audio',
        'voiceover_completeness',
        completeOk,
        'major',
        completeOk
          ? `Voiceover covers ${Math.round(Math.min(100, coverageRatio * 100))}% of timeline (${round(activeSpeechS, 1)} s active audio).`
          : `Voiceover appears incomplete (${round(activeSpeechS, 1)} s active audio for a ${round(timeline.durationS, 1)} s script).`,
        { activeAudioS: round(activeSpeechS, 1), timelineS: round(timeline.durationS, 1), coverageRatio: round(coverageRatio, 2) },
        'Pre-fetch all voiceover lines and re-time beats to actual spoken durations before exporting.',
      ),
    );
  }

  // Speech vs background music mix balance (configured mix; post-mix stems aren't separable).
  if (speech && timeline?.audio.music) {
    const vol = timeline.audio.musicVolume ?? 0;
    checks.push(
      check(
        'audio',
        'speech_music_balance',
        vol <= 0.35,
        'minor',
        `Background music level is ${Math.round(vol * 100)}% under speech.`,
        { musicVolume: vol, basis: 'configured mix' },
        'Duck background music below 35% when narration or speaker audio is present.',
      ),
    );
  }

  return checks;
}
