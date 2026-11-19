import { hookFeatures } from '../youtube.ts';
import { check, round, unmeasured } from './checks.ts';
import type { Check, MediaFacts, Timeline, TimelineBeat } from './models.ts';
import { repeatedShots, segmentShots, type Shot } from './similarity.ts';
import type { Thresholds } from './thresholds.ts';
import { tokens } from './captionQuality.ts';

const STOP = new Set('the a an and or but so of to in on at for with is are was be it this that you your i we they my our'.split(' '));
const CTA = /\b(comment|follow|subscribe|save|share|try (this|it)|tell me|drop a|link in|let me know|which one)\b/i;

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

/** Scene diversity: repetition, longest unchanged shot by scene type, distinct assets. */
export function evaluateDiversity(media: MediaFacts | null, timeline: Timeline | null, th: Thresholds): { checks: Check[]; shots: Shot[] } {
  const checks: Check[] = [];
  const dur = media?.durationS || timeline?.durationS || 0;
  const shots = media?.video ? segmentShots(dur, media.analysis.sceneCuts, media.analysis.frameHashes) : [];
  if (media?.video) {
    const reps = repeatedShots(shots);
    const ratio = shots.length ? reps.length / shots.length : 0;
    checks.push(check('diversity', 'repeated_shots', ratio <= th.maxRepeatRatio, ratio > 0.5 ? 'major' : 'minor',
      `${reps.length} of ${shots.length} shots repeat an earlier shot.`, { shots: shots.length, repeats: reps.slice(0, 10) },
      'Pick a different clip for repeated scenes (next search result or another query).'));
  }
  if (timeline) {
    const tShots = timelineShots(timeline.beats);
    const reused = tShots.filter((s, i) => !['source'].includes(String(s.kind)) && tShots.slice(0, Math.max(0, i - 1)).some((p) => p.asset === s.asset));
    checks.push(check('diversity', 'asset_reuse', reused.length === 0, reused.length > tShots.length / 3 ? 'major' : 'minor',
      `${reused.length} scene(s) reuse media already shown earlier.`, { reused: reused.slice(0, 10).map((s) => ({ at: round(s.start), asset: s.asset })) },
      'Choose distinct footage per scene.'));
    // Longest unchanged shot, by scene type. Media cuts (e.g. punch-ins) split timeline shots further.
    let worst: { kind: string; length: number; limit: number; start: number } | null = null;
    for (const s of tShots) {
      const kind = (s.kind || 'broll') as keyof Thresholds['maxShotS'];
      const limit = th.maxShotS[kind] ?? th.maxShotS.broll;
      const cutsInside = media?.video ? media.analysis.sceneCuts.filter((c) => c > s.start + 0.3 && c < s.end - 0.3) : [];
      const bounds = [s.start, ...cutsInside, s.end];
      for (let i = 0; i < bounds.length - 1; i++) {
        const len = bounds[i + 1] - bounds[i];
        if (len > limit && (!worst || len - limit > worst.length - worst.limit)) worst = { kind, length: round(len, 1), limit, start: round(bounds[i]) };
      }
    }
    // Graded: a little over the limit is minor; well over (1.5x+) is a major pacing defect.
    checks.push(check('diversity', 'shot_length', !worst, worst && worst.length > worst.limit * 1.5 ? 'major' : 'minor',
      worst ? `A ${worst.kind} shot runs ${worst.length} s unchanged at ${worst.start} s (limit ${worst.limit} s).` : 'No shot exceeds its length limit.',
      { worst }, worst?.kind === 'source' ? 'Add framing changes (punch-ins) at sentence boundaries or a B-roll cut-away.' : 'Split the scene or add a second shot.'));
  } else if (!media?.video) {
    checks.push(unmeasured('diversity', 'shots', 'No media or timeline to measure.'));
  }
  return { checks, shots };
}

/** Storytelling proxies: hook, narrative roles, ending, visual relevance. Not a judgement of emotional impact. */
export function evaluateStory(timeline: Timeline | null): Check[] {
  if (!timeline || !timeline.beats.length) return [unmeasured('story', 'timeline', 'No scene plan to evaluate.')];
  const beats = timeline.beats;
  const n = beats.length;
  const checks: Check[] = [];
  const hook = hookFeatures(beats[0].text);
  checks.push(check('story', 'hook', hook.s >= 1, 'major', `Opening line: "${beats[0].text.slice(0, 80)}"`, { hookScore: hook.s, signals: hook.reasons },
    'Open with a question, a number or a bold claim in the first two seconds.'));
  const roles = beats.map((b, i) => b.role || inferRole(i, n, b.text));
  const has = (r: string) => roles.includes(r as any);
  const structureOk = n >= 3 && has('hook') && (has('main') || has('context')) && (has('cta') || has('progression'));
  checks.push(check('story', 'structure', structureOk, 'major', `${n} scene(s); roles: ${roles.join(' → ')}.`,
    { roles, inferred: beats.some((b) => !b.role) }, 'Plan hook → context → main point → progression → ending.'));
  const last = beats[n - 1];
  const strongEnd = /[.!?]["')\]]?$/.test(last.text.trim()) && last.end_s - last.start_s >= 1.2;
  checks.push(check('story', 'ending', strongEnd, 'minor', `Ending: "${last.text.slice(0, 80)}"`, { cta: CTA.test(last.text), lastSceneS: round(last.end_s - last.start_s) },
    'End on a complete sentence with a takeaway or call to action.'));
  // Relevance: do the visuals described for a scene relate to what is said? (keyword overlap; source footage is the speaker)
  const judged = beats.filter((b) => b.kind !== 'source' && b.visual_keywords);
  if (!judged.length) checks.push(unmeasured('story', 'relevance', 'Scenes show the source footage (the speaker), so visual relevance is inherent.'));
  else {
    const unrelated = judged.filter((b) => {
      const said = new Set(tokens(b.text).filter((w) => !STOP.has(w)).map((w) => w.slice(0, 5)));
      return !tokens(b.visual_keywords || '').some((w) => said.has(w.slice(0, 5)));
    });
    const ratio = unrelated.length / judged.length;
    checks.push(check('story', 'relevance', ratio <= 0.5, 'minor', `${unrelated.length} of ${judged.length} scenes have visuals with no word in common with what is said.`,
      { unrelated: unrelated.slice(0, 6).map((b) => ({ text: b.text.slice(0, 60), visual: b.visual_keywords })), method: 'keyword overlap (proxy)' },
      'Describe visuals using the scene\'s own nouns.'));
  }
  return checks;
}

/** Editing and pacing: shot length distribution, speech rate, mid-reel blackouts, transitions. */
export function evaluateEditing(media: MediaFacts | null, timeline: Timeline | null, shots: Shot[], th: Thresholds): Check[] {
  const checks: Check[] = [];
  const lengths = shots.length ? shots.map((s) => s.end - s.start) : timeline ? timelineShots(timeline.beats).map((s) => s.end - s.start) : [];
  if (!lengths.length) return [unmeasured('editing', 'shots', 'No shots to evaluate.')];
  const mean = lengths.reduce((a, b) => a + b, 0) / lengths.length;
  const [lo, hi] = th.idealShotS;
  const sourceOnly = timeline?.beats.every((b) => b.kind === 'source');
  checks.push(check('editing', 'shot_pacing', mean >= lo && mean <= (sourceOnly ? th.maxShotS.source : hi), 'minor',
    `Average shot ${round(mean, 1)} s over ${lengths.length} shot(s).`, { meanS: round(mean), shots: lengths.length, ideal: [lo, sourceOnly ? th.maxShotS.source : hi] },
    mean > hi ? 'Cut more often: change framing or footage every few seconds.' : 'Hold shots a little longer.'));
  if (timeline) {
    const words = tokens(timeline.scriptText).length;
    const wps = timeline.durationS ? words / timeline.durationS : 0;
    const [wlo, whi] = th.speechWpsRange;
    checks.push(check('editing', 'speech_rate', wps >= wlo && wps <= whi, 'minor', `${round(wps, 1)} words per second.`, { wps: round(wps), range: th.speechWpsRange },
      wps < wlo ? 'Tighten pauses; the reel drags.' : 'Too dense to read; shorten the script or extend the reel.'));
  }
  if (media?.video) {
    const mid = media.analysis.blackSegments.filter((b) => b.start > 0.3 && (Number.isFinite(b.end) ? b.end : media.durationS) < media.durationS - 0.3);
    checks.push(check('editing', 'continuity', mid.length === 0, 'major', `${mid.length} black gap(s) between scenes.`, { gaps: mid.slice(0, 6) }, 'A scene failed to load; replace its media.'));
  }
  checks.push(unmeasured('editing', 'transitions', 'Transitions are hard cuts throughout (consistent by construction).'));
  return checks;
}
