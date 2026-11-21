import { evaluateAudio, evaluateAudioPlan } from './audioQuality.ts';
import { evaluateCaptions } from './captionQuality.ts';
import { evaluateExport } from './exportQuality.ts';
import type { AiReview, Check, Classification, DimensionKey, DimensionResult, Evaluation, GateStatus, MediaFacts, Timeline } from './models.ts';
import { recommend } from './repairs.ts';
import { evaluatePacing, evaluateStory } from './sceneQuality.ts';
import { evaluateTechnical } from './technicalQuality.ts';
import { loadThresholds, type Thresholds } from './thresholds.ts';
import { evaluateVisual } from './visualQuality.ts';

export const LABELS: Record<DimensionKey, string> = {
  audio: 'Audio quality',
  export: 'Video & export quality',
  visual: 'Visual quality',
  captions: 'Captions',
  story: 'Storytelling & narrative',
  pacing: 'Pacing & engagement',
  technical: 'Technical consistency',
};
const ORDER: DimensionKey[] = ['audio', 'export', 'visual', 'captions', 'story', 'pacing', 'technical'];
const PENALTY = { info: 0, minor: 0.1, major: 0.35, critical: 1 } as const;
export const ACTIONS: Record<Classification, string> = {
  EXCELLENT: 'Ready to publish',
  GOOD: 'Ready with minor warnings',
  NEEDS_IMPROVEMENT: 'Revision recommended',
  POOR: 'Regeneration required',
};
const LEGACY: Record<Classification, GateStatus> = { EXCELLENT: 'PASS', GOOD: 'PASS', NEEDS_IMPROVEMENT: 'NEEDS_IMPROVEMENT', POOR: 'REJECTED' };

/** 0..1 per dimension from its measured checks; null when nothing could be measured. */
function dimensionScore(checks: Check[]): number | null {
  const measured = checks.filter((c) => c.measured !== false);
  if (!measured.length) return null;
  const penalty = measured.filter((c) => !c.passed).reduce((s, c) => s + PENALTY[c.severity], 0);
  return Math.max(0, 1 - penalty);
}

/**
 * Score bands → classification, with overrides that no score can buy back:
 *   any CRITICAL defect                          → POOR (regeneration required), whatever the score
 *   any MAJOR defect (unless QUALITY_PASS_ALLOW_MAJOR) → at best NEEDS_IMPROVEMENT ("Good" means minor warnings only)
 */
export function classify(score: number, criticals: number, majors: number, th: Thresholds): Classification {
  if (criticals > 0) return 'POOR';
  let c: Classification = score >= Math.max(th.excellentScore, th.passScore) ? 'EXCELLENT' : score >= th.passScore ? 'GOOD' : score >= th.improveScore ? 'NEEDS_IMPROVEMENT' : 'POOR';
  if (majors > 0 && th.passRequiresNoMajor && (c === 'EXCELLENT' || c === 'GOOD')) c = 'NEEDS_IMPROVEMENT';
  return c;
}

export interface EvaluateOptions {
  /** 'plan' = before rendering: only checks that need no media file (precheck). */
  mode?: 'file' | 'plan';
  /** Extra checks (e.g. evidence-backed AI storytelling judgements) merged into their dimensions. */
  extraChecks?: Check[];
  aiReview?: AiReview;
  aiNote?: string;
}

/**
 * Runs every dimension (weights: audio 15, export 15, visual 20, captions 15, story 15, pacing 10, technical 10),
 * scores it from measured checks only (unmeasurable dimensions are left out and the rest rescaled — reported in
 * notes), classifies with critical/major overrides, and turns problems into recommendations.
 */
export function evaluate(media: MediaFacts | null, timeline: Timeline | null, th: Thresholds = loadThresholds(), opts: EvaluateOptions = {}): Evaluation {
  const plan = opts.mode === 'plan';
  const exp = evaluateExport(plan ? null : media, timeline, th);
  const vis = evaluateVisual(plan ? null : media, timeline, th);
  const byDim: Record<DimensionKey, Check[]> = {
    audio: plan ? evaluateAudioPlan(timeline) : evaluateAudio(media, timeline, th),
    export: plan ? [] : exp.checks,
    visual: vis.checks,
    captions: evaluateCaptions(plan ? null : media, timeline, th),
    story: evaluateStory(plan ? null : media, timeline),
    pacing: evaluatePacing(plan ? null : media, timeline, vis.shots, th),
    technical: plan ? [] : evaluateTechnical(media, timeline, th),
  };
  for (const c of opts.extraChecks || []) byDim[c.dimension]?.push(c);
  const notes: string[] = [
    'Technical properties (signal, resolution, timing, layout) are measured from the file; storytelling uses measurable proxies' +
      (opts.aiReview ? ' plus an AI review that must quote the script as evidence.' : '.'),
  ];
  if (opts.aiNote) notes.push(opts.aiNote);
  if (plan) notes.push('Pre-render check: only the plan was evaluated. The exported file is measured after rendering.');
  const dimensions: DimensionResult[] = [];
  let weightUsed = 0;
  let points = 0;
  for (const key of ORDER) {
    const s = dimensionScore(byDim[key]);
    const weight = th.weights[key];
    if (s === null) notes.push(`${LABELS[key]} could not be measured and was left out of the score.`);
    else {
      weightUsed += weight;
      points += s * weight;
    }
    dimensions.push({ key, label: LABELS[key], weight, score: s ?? 0, points: s === null ? 0 : Math.round(s * weight * 10) / 10, checks: byDim[key] });
  }
  const total = weightUsed ? Math.round((points / weightUsed) * 1000) / 10 : 0;
  const all = Object.values(byDim).flat();
  const failed = all.filter((c) => !c.passed && c.measured !== false);
  const critical = failed.filter((c) => c.severity === 'critical');
  const majors = failed.filter((c) => c.severity === 'major').length;
  const classification = classify(total, critical.length, majors, th);
  const order = { critical: 0, major: 1, minor: 2, info: 3 } as const;
  const problems = failed.sort((a, b) => order[a.severity] - order[b.severity]);
  return {
    score: total,
    classification,
    action: ACTIONS[classification],
    readyToPublish: classification === 'EXCELLENT' || classification === 'GOOD',
    status: LEGACY[classification],
    recommendations: recommend(problems, timeline),
    ...(opts.aiReview ? { aiReview: opts.aiReview } : {}),
    dimensions,
    criticalDefects: critical,
    problems,
    suggestions: [...new Set(problems.map((p) => p.suggestion).filter(Boolean) as string[])],
    spec: exp.spec,
    notes,
    evaluatedAt: new Date().toISOString(),
  };
}

export { loadThresholds };
export type { Thresholds };
