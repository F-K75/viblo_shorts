import { hookFeatures } from '../youtube.ts';
import { check, round, unmeasured } from './checks.ts';
import type { AiCreativeReview, Check, MediaFacts, Timeline, TimelineBeat } from './models.ts';
import type { Shot } from './similarity.ts';
import type { Thresholds } from './thresholds.ts';
import { tokens } from './captionQuality.ts';

const STOP = new Set('the a an and or but so of to in on at for with is are was be it this that you your i we they my our'.split(' '));
const CTA = /\b(comment|follow|subscribe|save|share|try (this|it)|tell me|drop a|link in|let me know|which one|start today|watch)\b/i;

/** Beats merged into visual shots: consecutive beats on the same asset are one continuous shot. */
export function timelineShots(beats: TimelineBeat[]): Array<{ start: number; end: number; asset: string; kind: TimelineBeat['kind'] }> {
  const out: Array<{ start: number; end: number; asset: string; kind: TimelineBeat['kind'] }> = [];
  for (const b of beats) {
    const asset = b.asset || `beat:${b.text}`;
    const last = out[out.length - 1];
    if (last && last.asset === asset && Math.abs(last.end - b.start_s) < 0.3) last.end = b.end_s;
    else out.push({ start: b.start_s, end: b.end_s, asset, kind: b.kind });
  }
  return out;
}

function inferRole(i: number, n: number, text: string): NonNullable<TimelineBeat['role']> {
  if (i === 0) return 'hook';
  if (i === n - 1) return CTA.test(text) ? 'cta' : 'progression';
  if (i === 1) return 'context';
  return i < n / 2 ? 'main' : 'progression';
}

/**
 * Storytelling and narrative evaluation (Weight: 15).
 * Combines deterministic structural checks (3-second hook, narrative role arc, information progression,
 * scene-to-script relevance, ending/CTA) with optional AI-assisted creative evaluation findings.
 */
export function evaluateStorytelling(timeline: Timeline | null, aiReview?: AiCreativeReview): Check[] {
  if (!timeline || !timeline.beats.length) {
    if (timeline && timeline.beats.length === 0) {
      return [
        check(
          'storytelling',
          'missing_scenes',
          false,
          'major',
          'No script scenes present to form a story.',
          { beatCount: 0 },
          'Generate or write at least 3 scenes (hook, core insight, payoff/CTA).',
        ),
      ];
    }
    return [unmeasured('storytelling', 'timeline', 'No scene plan supplied to evaluate narrative structure.')];
  }

  const beats = timeline.beats;
  const n = beats.length;
  const checks: Check[] = [];

  // 1. First 3-second hook strength.
  const hookBeat = beats[0];
  const hook = hookFeatures(hookBeat.text);
  const aiHook = aiReview?.mode === 'ai_assisted' ? aiReview.findings.find((f) => f.criterion === 'hook') : undefined;
  const hookPassed = aiHook ? aiHook.passed && hook.s >= 0.5 : hook.s >= 1;
  checks.push(
    check(
      'storytelling',
      'hook',
      hookPassed,
      'major',
      aiHook
        ? `Opening hook (${aiHook.score}/100): ${aiHook.explanation}`
        : `Opening hook (${round(hookBeat.end_s - hookBeat.start_s, 1)} s): "${hookBeat.text.slice(0, 80)}"`,
      {
        hookScore: aiHook ? aiHook.score : hook.s,
        signals: hook.reasons,
        openingDurationS: round(hookBeat.end_s - hookBeat.start_s, 1),
        ...(aiHook ? { aiEvidence: aiHook.evidence, aiModel: aiReview?.model } : {}),
      },
      aiHook?.suggestion || 'Strengthen the first 3 seconds with a bold claim, sharp question, or surprising contrast.',
    ),
  );

  // 2. Narrative continuity & role progression.
  const roles = beats.map((b, i) => b.role || inferRole(i, n, b.text));
  const has = (r: string) => roles.includes(r as any);
  const structureOk = n >= 3 && has('hook') && (has('main') || has('context')) && (has('cta') || has('progression'));
  const aiCont = aiReview?.mode === 'ai_assisted' ? aiReview.findings.find((f) => f.criterion === 'narrative_continuity') : undefined;
  checks.push(
    check(
      'storytelling',
      'structure',
      aiCont ? structureOk && aiCont.passed : structureOk,
      'major',
      aiCont
        ? `Narrative progression (${aiCont.score}/100): ${aiCont.explanation}`
        : `${n} scene(s) with arc: ${roles.join(' → ')}.`,
      {
        sceneCount: n,
        roles,
        inferred: beats.some((b) => !b.role),
        ...(aiCont ? { aiEvidence: aiCont.evidence, aiModel: aiReview?.model } : {}),
      },
      aiCont?.suggestion || 'Structure at least 3–5 scenes: hook → context → core point → progression → ending/CTA.',
    ),
  );

  // 3. Information progression (beats shouldn't repeat the same wording).
  const beatTokenSets = beats.map((b) => new Set(tokens(b.text).filter((w) => !STOP.has(w))));
  let redundantPairs = 0;
  for (let i = 1; i < beatTokenSets.length; i++) {
    const prev = beatTokenSets[i - 1];
    const cur = beatTokenSets[i];
    if (cur.size >= 3 && prev.size >= 3) {
      let overlap = 0;
      for (const w of cur) if (prev.has(w)) overlap++;
      if (overlap / cur.size >= 0.75) redundantPairs++;
    }
  }
  checks.push(
    check(
      'storytelling',
      'information_progression',
      redundantPairs === 0,
      'minor',
      redundantPairs === 0
        ? 'Each scene introduces new information without repeating the previous line.'
        : `${redundantPairs} adjacent scene pair(s) repeat almost the same wording.`,
      { redundantPairs, scenes: n },
      'Tighten repetitive lines so every beat advances the story.',
    ),
  );

  // 4. Ending quality & CTA presence.
  const last = beats[n - 1];
  const strongEnd = /[.!?]["')\]]?$/.test(last.text.trim()) && last.end_s - last.start_s >= 1.1;
  const aiEnd = aiReview?.mode === 'ai_assisted' ? aiReview.findings.find((f) => f.criterion === 'ending_cta') : undefined;
  checks.push(
    check(
      'storytelling',
      'ending',
      aiEnd ? strongEnd && aiEnd.passed : strongEnd,
      'minor',
      aiEnd
        ? `Ending & CTA (${aiEnd.score}/100): ${aiEnd.explanation}`
        : `Ending (${CTA.test(last.text) ? 'includes CTA' : 'takeaway'}): "${last.text.slice(0, 80)}"`,
      {
        ctaPresent: CTA.test(last.text),
        lastSceneS: round(last.end_s - last.start_s),
        ...(aiEnd ? { aiEvidence: aiEnd.evidence, aiModel: aiReview?.model } : {}),
      },
      aiEnd?.suggestion || 'Close on a crisp takeaway or call-to-action that rewards watching to the end.',
    ),
  );

  // 5. Scene-to-script creative relevance (AI finding if present, else deterministic keyword proxy).
  const aiRel = aiReview?.mode === 'ai_assisted' ? aiReview.findings.find((f) => f.criterion === 'visual_relevance') : undefined;
  const judged = beats.filter((b) => b.kind !== 'source' && b.visual_keywords);
  if (aiRel) {
    checks.push(
      check(
        'storytelling',
        'relevance',
        aiRel.passed,
        'minor',
        `Visual-to-script relevance (${aiRel.score}/100): ${aiRel.explanation}`,
        { aiEvidence: aiRel.evidence, aiModel: aiReview?.model },
        aiRel.suggestion || 'Match each scene visual to the exact concept being narrated.',
      ),
    );
  } else if (!judged.length) {
    checks.push(unmeasured('storytelling', 'relevance', 'Source-footage speaker scenes have inherent visual relevance.'));
  } else {
    const unrelated = judged.filter((b) => {
      const said = new Set(tokens(b.text).filter((w) => !STOP.has(w)).map((w) => w.slice(0, 5)));
      return !tokens(b.visual_keywords || '').some((w) => said.has(w.slice(0, 5)));
    });
    const ratio = unrelated.length / judged.length;
    checks.push(
      check(
        'storytelling',
        'relevance',
        ratio <= 0.5,
        'minor',
        `${unrelated.length} of ${judged.length} scenes have visual keywords with no overlap against narration.`,
        { unrelated: unrelated.slice(0, 6).map((b) => ({ text: b.text.slice(0, 60), visual: b.visual_keywords })), method: 'keyword_overlap' },
        'Describe visuals using the concrete subjects in each spoken sentence.',
      ),
    );
  }

  return checks;
}

/**
 * Pacing and engagement evaluation (Weight: 10).
 * Evaluates visual shot cadence, speech rate (words/sec), mid-reel blackout gaps, and scene pacing.
 */
export function evaluatePacing(media: MediaFacts | null, timeline: Timeline | null, shots: Shot[], th: Thresholds): Check[] {
  const checks: Check[] = [];
  const lengths = shots.length
    ? shots.map((s) => s.end - s.start)
    : timeline && timeline.beats.length
      ? timelineShots(timeline.beats).map((s) => s.end - s.start)
      : [];

  if (!lengths.length) return [unmeasured('pacing', 'shots', 'No shots or scenes available to evaluate pacing.')];

  const mean = lengths.reduce((a, b) => a + b, 0) / lengths.length;
  const [lo, hi] = th.idealShotS;
  const sourceOnly = Boolean(timeline?.beats.length && timeline.beats.every((b) => b.kind === 'source'));
  const maxMean = sourceOnly ? th.maxShotS.source : hi;
  checks.push(
    check(
      'pacing',
      'shot_pacing',
      mean >= lo && mean <= maxMean,
      mean > maxMean * 1.6 ? 'major' : 'minor',
      `Average shot length ${round(mean, 1)} s across ${lengths.length} shot(s) (ideal ${lo}–${maxMean} s).`,
      { meanS: round(mean), shots: lengths.length, ideal: [lo, maxMean] },
      mean > maxMean ? 'Tighten scene durations or add visual cuts every 2–5 seconds to maintain retention.' : 'Hold shots slightly longer so viewers can process each visual.',
    ),
  );

  if (timeline && timeline.durationS > 0) {
    const words = tokens(timeline.scriptText).length;
    const wps = words / timeline.durationS;
    const [wlo, whi] = th.speechWpsRange;
    checks.push(
      check(
        'pacing',
        'speech_rate',
        wps >= wlo && wps <= whi,
        'minor',
        `Speech cadence: ${round(wps, 1)} words/sec (ideal ${wlo}–${whi} words/sec).`,
        { wps: round(wps), words, durationS: round(timeline.durationS), range: th.speechWpsRange },
        wps < wlo ? 'Tighten pauses and trim filler; pacing feels slow.' : 'Script is too dense; trim words or extend scene durations.',
      ),
    );
  }

  if (media?.video) {
    const mid = media.analysis.blackSegments.filter(
      (b) => b.start > 0.3 && (Number.isFinite(b.end) ? b.end : media.durationS) < media.durationS - 0.3,
    );
    checks.push(
      check(
        'pacing',
        'continuity',
        mid.length === 0,
        'major',
        mid.length === 0 ? 'No mid-reel black gaps between scenes.' : `${mid.length} black gap(s) interrupt pacing between scenes.`,
        { gaps: mid.slice(0, 6) },
        'Replace broken scene media so transitions stay continuous.',
      ),
    );
  }

  return checks;
}

/**
 * Technical consistency evaluation (Weight: 10).
 * Evaluates effective distinct frame rate, bitrate adequacy, audio sample rate/channels,
 * and video/audio stream timestamp start alignment.
 */
export function evaluateTechnical(media: MediaFacts | null, timeline: Timeline | null, th: Thresholds): Check[] {
  if (!media || !media.video) {
    return [unmeasured('technical', 'streams', 'Technical consistency requires a valid video file.')];
  }
  const checks: Check[] = [];
  const targetFps = timeline?.target?.fps || th.spec.fps;

  // 1. Distinct/effective FPS (detects dropped/duplicated encoder frames).
  if (media.analysis.effectiveFps === null) {
    checks.push(unmeasured('technical', 'dropped_frames', 'Distinct frame rate could not be measured.'));
  } else {
    const ratio = media.analysis.effectiveFps / (targetFps || 30);
    checks.push(
      check(
        'technical',
        'dropped_frames',
        ratio >= th.minEffectiveFpsRatio,
        ratio < 0.3 ? 'major' : 'minor',
        `${media.analysis.effectiveFps} distinct fps (${Math.round(ratio * 100)}% of ${targetFps} fps target).`,
        { effectiveFps: media.analysis.effectiveFps, targetFps, ratio: round(ratio, 2) },
        'Keep the browser tab focused during export or switch to 720p on slower hardware.',
      ),
    );
  }

  // 2. Video bitrate adequacy (avoid severely starved low-bitrate mush on 1080p).
  if (media.video.bitrate) {
    const kbps = Math.round(media.video.bitrate / 1000);
    const minKbps = media.video.width >= 1000 ? th.minVideoBitrateKbps : Math.round(th.minVideoBitrateKbps * 0.5);
    checks.push(
      check(
        'technical',
        'video_bitrate',
        kbps >= minKbps,
        'minor',
        `Video bitrate: ${kbps} kbps (minimum ${minKbps} kbps).`,
        { kbps, minKbps },
        'Increase encoding bitrate or re-conform with CRF 18.',
      ),
    );
  }

  // 3. Audio sample rate & channel consistency.
  if (media.audio) {
    const srOk = media.audio.sampleRate >= th.spec.minAudioSampleRate && media.audio.channels >= 1;
    checks.push(
      check(
        'technical',
        'audio_format',
        srOk,
        'minor',
        `Audio stream: ${media.audio.sampleRate} Hz, ${media.audio.channels} ch.`,
        { sampleRate: media.audio.sampleRate, channels: media.audio.channels, minSampleRate: th.spec.minAudioSampleRate },
        'Conform audio to 48 kHz AAC for consistent cross-platform playback.',
      ),
    );
  }

  // 4. Stream PTS start-time consistency.
  if (media.audio) {
    const vStart = media.video.startTimeS ?? 0;
    const aStart = media.audio.startTimeS ?? 0;
    const offset = Math.abs(vStart - aStart);
    checks.push(
      check(
        'technical',
        'stream_timestamps',
        offset <= th.maxStreamStartOffsetS,
        'major',
        `Stream start timestamps: video ${round(vStart, 3)} s, audio ${round(aStart, 3)} s (offset ${round(offset, 3)} s).`,
        { videoStartS: round(vStart, 3), audioStartS: round(aStart, 3), offsetS: round(offset, 3) },
        'Remux with synchronized stream timestamps starting at 0.0 s.',
      ),
    );
  }

  return checks;
}
