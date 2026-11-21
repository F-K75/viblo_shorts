import { evaluateAudio } from './audioQuality.ts';
import { evaluateCaptions } from './captionQuality.ts';
import { evaluateExport } from './exportQuality.ts';
import type {
  AiCreativeReview,
  Check,
  DimensionKey,
  DimensionResult,
  Evaluation,
  GateStatus,
  MediaFacts,
  QualityAction,
  QualityClassification,
  RepairActionType,
  RepairRecommendation,
  Timeline,
} from './models.ts';
import { evaluatePacing, evaluateStorytelling, evaluateTechnical } from './sceneQuality.ts';
import { loadThresholds, type Thresholds } from './thresholds.ts';
import { evaluateVisual } from './visualQuality.ts';

const LABELS: Record<DimensionKey, string> = {
  audio: 'Audio quality',
  export: 'Video & export quality',
  visual: 'Visual quality',
  captions: 'Caption quality',
  storytelling: 'Storytelling & narrative',
  pacing: 'Pacing & engagement',
  technical: 'Technical consistency',
};

const PENALTY = { info: 0, minor: 0.12, major: 0.35, critical: 1 } as const;

/** 0..1 per dimension from its measured checks; null when nothing could be measured. */
function dimensionScore(checks: Check[]): number | null {
  const measured = checks.filter((c) => c.measured !== false);
  if (!measured.length) return null;
  const penalty = measured.filter((c) => !c.passed).reduce((s, c) => s + PENALTY[c.severity], 0);
  return Math.max(0, 1 - penalty);
}

/** Maps failed checks into actionable, structured repair recommendations with safe auto-repair flags. */
export function buildRecommendations(problems: Check[]): RepairRecommendation[] {
  const seen = new Set<string>();
  const out: RepairRecommendation[] = [];

  const mapCheck = (p: Check): { action: RepairActionType; auto: boolean; title: string } => {
    switch (p.id) {
      case 'audio_present':
      case 'speech_presence':
      case 'voiceover_completeness':
      case 'silence':
        return { action: 'regenerate_voiceover', auto: false, title: 'Regenerate or remux voiceover audio' };
      case 'av_alignment':
      case 'stream_timestamps':
        return { action: 'remux_audio', auto: true, title: 'Resync and remux audio/video streams' };
      case 'loudness':
      case 'rms_volume':
      case 'clipping':
      case 'video_codec':
      case 'pixel_format':
      case 'frame_rate':
      case 'audio_codec':
      case 'audio_format':
      case 'faststart':
      case 'video_bitrate':
        return { action: 'conform_encode', auto: true, title: 'Conform video/audio to delivery spec' };
      case 'dimensions':
      case 'aspect_ratio':
      case 'duration':
      case 'frames_present':
      case 'video_stream':
      case 'file_readable':
      case 'render_resolution':
        return { action: 'rerecord_export', auto: true, title: 'Re-render at target 1080×1920 resolution' };
      case 'fragments':
      case 'orphans':
      case 'readable_duration':
      case 'overflow':
        return { action: 'enable_phrase_captions', auto: true, title: 'Switch to phrase-grouped captions (≤ 2 lines)' };
      case 'safe_positioning':
        return { action: 'adjust_caption_safe_zone', auto: true, title: 'Move captions into mobile-safe zone (68%)' };
      case 'overlaps':
      case 'timing_range':
      case 'word_timing_sync':
      case 'sync_start':
      case 'sync_silence':
      case 'coverage':
      case 'present':
        return { action: 'realign_captions', auto: true, title: 'Regenerate and align caption timestamps' };
      case 'repeated_shots':
      case 'asset_reuse':
      case 'frozen_video':
      case 'scene_diversity':
      case 'black_frames':
      case 'continuity':
        return { action: 'diversify_visuals', auto: true, title: 'Replace static or repetitive visuals with varied scenes' };
      case 'visual_relevance':
      case 'relevance':
        return { action: 'retrieve_relevant_assets', auto: false, title: 'Retrieve visuals matching spoken narration' };
      case 'hook':
        return { action: 'strengthen_hook', auto: false, title: 'Strengthen the opening 3-second hook' };
      case 'shot_length':
      case 'shot_pacing':
      case 'speech_rate':
      default:
        return { action: 'adjust_pacing', auto: false, title: 'Adjust scene durations and visual pacing' };
    }
  };

  for (const p of problems) {
    const mapped = mapCheck(p);
    const dedupKey = `${mapped.action}:${p.id}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);
    out.push({
      id: `rec_${p.id}`,
      issueId: p.id,
      dimension: p.dimension,
      severity: p.severity,
      autoRepairable: mapped.auto,
      repairAction: mapped.action,
      title: mapped.title,
      description: p.suggestion || p.message,
      evidence: p.message,
    });
  }
  return out;
}

/**
 * Runs all 7 weighted dimensions (total weight = 100) and applies Forge Studio's Quality Gates:
 *  - 90–100: Excellent          -> Ready to publish
 *  - 80–89:  Good               -> Ready with minor warnings
 *  - 70–79:  Needs improvement  -> Revision recommended
 *  - < 70:   Poor               -> Regeneration required
 *
 * CRITICAL OVERRIDE: Any critical defect (silent audio, missing video/audio stream,
 * invalid resolution when 1080p is required, corrupted export, missing required captions)
 * ALWAYS forces classification = 'Poor', action = 'Regeneration required', status = 'REJECTED',
 * readyToPublish = false — regardless of how high the creative/storytelling score is.
 */
export function evaluate(
  media: MediaFacts | null,
  timeline: Timeline | null,
  th: Thresholds = loadThresholds(),
  aiReview?: AiCreativeReview,
): Evaluation {
  const exp = evaluateExport(media, timeline, th);
  const vis = evaluateVisual(media, timeline, th);
  const byDim: Record<DimensionKey, Check[]> = {
    audio: evaluateAudio(media, timeline, th),
    export: exp.checks,
    visual: vis.checks,
    captions: evaluateCaptions(media, timeline, th),
    storytelling: evaluateStorytelling(timeline, aiReview),
    pacing: evaluatePacing(media, timeline, vis.shots, th),
    technical: evaluateTechnical(media, timeline, th),
  };

  const notes: string[] = [];
  if (aiReview?.mode === 'ai_assisted') {
    notes.push(`Storytelling evaluated with hybrid deterministic checks + AI review (${aiReview.model}).`);
  } else {
    notes.push(
      aiReview?.summary ||
        'Storytelling evaluated with deterministic narrative checks (hook signals, scene roles, progression, ending, visual relevance).',
    );
  }

  const dimensions: DimensionResult[] = [];
  let weightUsed = 0;
  let points = 0;
  for (const key of Object.keys(LABELS) as DimensionKey[]) {
    const s = dimensionScore(byDim[key]);
    const weight = th.weights[key];
    if (s === null) {
      notes.push(`${LABELS[key]} could not be measured and was excluded from the weighted average.`);
    } else {
      weightUsed += weight;
      points += s * weight;
    }
    dimensions.push({
      key,
      label: LABELS[key],
      weight,
      score: s ?? 0,
      points: s === null ? 0 : Math.round(s * weight * 10) / 10,
      checks: byDim[key],
    });
  }

  const total = weightUsed ? Math.round((points / weightUsed) * 1000) / 10 : 0;
  const all = Object.values(byDim).flat();
  const failed = all.filter((c) => !c.passed && c.measured !== false);
  const critical = failed.filter((c) => c.severity === 'critical');
  const warnings = failed.filter((c) => c.severity !== 'critical');
  const exportFailed = byDim.export.some((c) => !c.passed && c.measured !== false && c.severity !== 'minor');
  const anyMajor = failed.some((c) => c.severity === 'major');

  const criticalOverride = critical.length > 0;
  let classification: QualityClassification;
  let action: QualityAction;
  let status: GateStatus;
  let readyToPublish: boolean;

  if (criticalOverride) {
    classification = 'Poor';
    action = 'Regeneration required';
    status = 'REJECTED';
    readyToPublish = false;
  } else if (total >= th.excellentScore && !exportFailed && !(th.passRequiresNoMajor && anyMajor)) {
    classification = 'Excellent';
    action = 'Ready to publish';
    status = 'PASS';
    readyToPublish = true;
  } else if (total >= th.goodScore && !exportFailed && !(th.passRequiresNoMajor && anyMajor)) {
    classification = 'Good';
    action = 'Ready with minor warnings';
    status = 'PASS';
    readyToPublish = true;
  } else if (total >= th.improveScore) {
    classification = 'Needs improvement';
    action = 'Revision recommended';
    status = 'NEEDS_IMPROVEMENT';
    readyToPublish = false;
  } else {
    classification = 'Poor';
    action = 'Regeneration required';
    status = 'REJECTED';
    readyToPublish = false;
  }

  const order = { critical: 0, major: 1, minor: 2, info: 3 } as const;
  const problems = failed.sort((a, b) => order[a.severity] - order[b.severity]);
  const recommendations = buildRecommendations(problems);

  return {
    score: total,
    classification,
    action,
    readyToPublish,
    criticalOverride,
    status,
    dimensions,
    criticalDefects: critical,
    warnings,
    problems,
    suggestions: [...new Set(problems.map((p) => p.suggestion).filter(Boolean) as string[])],
    recommendations,
    spec: exp.spec,
    ...(aiReview ? { aiReview } : {}),
    notes,
    evaluatedAt: new Date().toISOString(),
  };
}

export function evaluatePreflight(
  timeline: Timeline | null,
  th: Thresholds = loadThresholds(),
  aiReview?: AiCreativeReview,
): Evaluation {
  const exp = evaluateExport(null, timeline, th);
  const vis = evaluateVisual(null, timeline, th);
  // Preflight skips media-only checks (export container & audio waveform) and scores timeline-measurable dimensions honestly.
  const byDim: Record<DimensionKey, Check[]> = {
    audio: [
      {
        id: 'audio_preflight',
        dimension: 'audio',
        passed: timeline?.audio.required === false || Boolean(timeline?.audio.narration || timeline?.audio.sourceSpeech || timeline?.audio.music),
        severity: timeline?.audio.required === false ? 'info' : 'critical',
        measured: Boolean(timeline),
        message:
          timeline?.audio.required === false
            ? 'Silent export explicitly requested.'
            : timeline?.audio.narration || timeline?.audio.sourceSpeech || timeline?.audio.music
              ? 'Audio source configured; waveform & loudness will be verified on exported MP4.'
              : 'No voiceover, source audio, or music enabled — exported MP4 will be silent.',
        suggestion:
          timeline?.audio.required !== false && !(timeline?.audio.narration || timeline?.audio.sourceSpeech || timeline?.audio.music)
            ? 'Enable AI Voiceover, source audio, or background music before exporting.'
            : undefined,
        evidence: { audioConfig: timeline?.audio ?? null, mode: 'preflight' },
      },
    ],
    export: [],
    visual: vis.checks.filter((c) => c.id !== 'frames_present'),
    captions: evaluateCaptions(null, timeline, th),
    storytelling: evaluateStorytelling(timeline, aiReview),
    pacing: evaluatePacing(null, timeline, vis.shots, th),
    technical: [],
  };

  const notes: string[] = [
    'Preflight timeline check: audio waveform, encoding resolution, and black/frozen frame checks run on the exported MP4.',
  ];
  if (aiReview?.mode === 'ai_assisted') {
    notes.push(`Storytelling evaluated with hybrid deterministic checks + AI review (${aiReview.model}).`);
  }

  const dimensions: DimensionResult[] = [];
  let weightUsed = 0;
  let points = 0;
  for (const key of Object.keys(LABELS) as DimensionKey[]) {
    const s = dimensionScore(byDim[key]);
    const weight = th.weights[key];
    if (s !== null) {
      weightUsed += weight;
      points += s * weight;
    }
    dimensions.push({
      key,
      label: LABELS[key],
      weight,
      score: s ?? 0,
      points: s === null ? 0 : Math.round(s * weight * 10) / 10,
      checks: byDim[key],
    });
  }

  const total = weightUsed ? Math.round((points / weightUsed) * 1000) / 10 : 0;
  const all = Object.values(byDim).flat();
  const failed = all.filter((c) => !c.passed && c.measured !== false);
  const critical = failed.filter((c) => c.severity === 'critical');
  const warnings = failed.filter((c) => c.severity !== 'critical');
  const criticalOverride = critical.length > 0;

  let classification: QualityClassification;
  let action: QualityAction;
  let status: GateStatus;
  let readyToPublish: boolean;

  if (criticalOverride) {
    classification = 'Poor';
    action = 'Regeneration required';
    status = 'REJECTED';
    readyToPublish = false;
  } else if (total >= th.excellentScore) {
    classification = 'Excellent';
    action = 'Ready to publish';
    status = 'PASS';
    readyToPublish = true;
  } else if (total >= th.goodScore) {
    classification = 'Good';
    action = 'Ready with minor warnings';
    status = 'PASS';
    readyToPublish = true;
  } else if (total >= th.improveScore) {
    classification = 'Needs improvement';
    action = 'Revision recommended';
    status = 'NEEDS_IMPROVEMENT';
    readyToPublish = false;
  } else {
    classification = 'Poor';
    action = 'Regeneration required';
    status = 'REJECTED';
    readyToPublish = false;
  }

  const order = { critical: 0, major: 1, minor: 2, info: 3 } as const;
  const problems = failed.sort((a, b) => order[a.severity] - order[b.severity]);
  const recommendations = buildRecommendations(problems);

  return {
    score: total,
    classification,
    action,
    readyToPublish,
    criticalOverride,
    status,
    dimensions,
    criticalDefects: critical,
    warnings,
    problems,
    suggestions: [...new Set(problems.map((p) => p.suggestion).filter(Boolean) as string[])],
    recommendations,
    spec: exp.spec,
    ...(aiReview ? { aiReview } : {}),
    notes,
    evaluatedAt: new Date().toISOString(),
  };
}

export { loadThresholds };
export type { Thresholds };

