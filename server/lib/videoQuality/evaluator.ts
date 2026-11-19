import { evaluateAudio } from './audioQuality.ts';
import { evaluateCaptions } from './captionQuality.ts';
import { evaluateExport } from './exportQuality.ts';
import type { Check, DimensionKey, DimensionResult, Evaluation, GateStatus, MediaFacts, Timeline } from './models.ts';
import { evaluateDiversity, evaluateEditing, evaluateStory } from './sceneQuality.ts';
import { loadThresholds, type Thresholds } from './thresholds.ts';
import { evaluateVisual } from './visualQuality.ts';

const LABELS: Record<DimensionKey, string> = {
  captions: 'Caption accuracy & sync',
  visual: 'Visual quality',
  diversity: 'Scene diversity',
  story: 'Storytelling & relevance',
  audio: 'Audio quality',
  editing: 'Editing & pacing',
  export: 'Export integrity',
};
const PENALTY = { info: 0, minor: 0.1, major: 0.35, critical: 1 } as const;

/** 0..1 per dimension from its measured checks; null when nothing could be measured. */
function dimensionScore(checks: Check[]): number | null {
  const measured = checks.filter((c) => c.measured !== false);
  if (!measured.length) return null;
  const penalty = measured.filter((c) => !c.passed).reduce((s, c) => s + PENALTY[c.severity], 0);
  return Math.max(0, 1 - penalty);
}

/**
 * Runs every dimension, weights it, and applies the release gate:
 *  PASS              score >= passScore, no critical defect, every export check passes, and (by default) no major
 *                    defect anywhere: a reel with e.g. fragmented captions is not "done" just because it scores well
 *  NEEDS_IMPROVEMENT score >= improveScore and no critical defect (the problems and suggestions say what to fix)
 *  REJECTED          otherwise; ANY critical defect rejects regardless of score.
 * Dimensions that could not be measured are left out and the remaining weights are rescaled (reported in notes).
 */
export function evaluate(media: MediaFacts | null, timeline: Timeline | null, th: Thresholds = loadThresholds()): Evaluation {
  const exp = evaluateExport(media, timeline, th);
  const div = evaluateDiversity(media, timeline, th);
  const byDim: Record<DimensionKey, Check[]> = {
    captions: evaluateCaptions(media, timeline, th),
    visual: evaluateVisual(media, timeline, th),
    diversity: div.checks,
    story: evaluateStory(timeline),
    audio: evaluateAudio(media, timeline, th),
    editing: evaluateEditing(media, timeline, div.shots, th),
    export: exp.checks,
  };
  const notes: string[] = [
    'Storytelling is scored from measurable proxies (hook signals, scene roles, ending, keyword relevance), not a judgement of emotional impact.',
  ];
  const dimensions: DimensionResult[] = [];
  let weightUsed = 0;
  let points = 0;
  for (const key of Object.keys(LABELS) as DimensionKey[]) {
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
  const exportFailed = byDim.export.some((c) => !c.passed && c.measured !== false && c.severity !== 'minor');
  const anyMajor = failed.some((c) => c.severity === 'major');
  let status: GateStatus;
  if (critical.length) status = 'REJECTED';
  else if (total >= th.passScore && !exportFailed && !(th.passRequiresNoMajor && anyMajor)) status = 'PASS';
  else if (total >= th.improveScore) status = 'NEEDS_IMPROVEMENT';
  else status = 'REJECTED';
  const order = { critical: 0, major: 1, minor: 2, info: 3 } as const;
  const problems = failed.sort((a, b) => order[a.severity] - order[b.severity]);
  return {
    score: total,
    status,
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
