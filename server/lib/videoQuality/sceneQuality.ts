import { hookFeatures } from '../youtube.ts';
import { expectedSpeechSpans, speechExpected } from './audioQuality.ts';
import { tokens } from './captionQuality.ts';
import { check, round, unmeasured } from './checks.ts';
import type { Check, MediaFacts, Timeline, TimelineBeat } from './models.ts';
import type { Shot } from './similarity.ts';
import type { Thresholds } from './thresholds.ts';
import { timelineShots } from './visualQuality.ts';

export { timelineShots };

const STOP = new Set(
  'the a an and or but so of to in on at for with is are was be it this that you your i we they my our me us do does did not no if as just than then there their them its it\'s you\'re i\'m'.split(' '),
);
const CTA = /\b(comment|follow|subscribe|save|share|try (this|it)|tell me|drop a|link in|let me know|which one)\b/i;
const content = (text: string) => tokens(text).filter((w) => !STOP.has(w) && w.length > 2).map((w) => w.slice(0, 6));

export function inferRole(i: number, n: number, text: string): NonNullable<TimelineBeat['role']> {
  if (i === 0) return 'hook';
  if (i === n - 1) return CTA.test(text) ? 'cta' : 'progression';
  if (i === 1) return 'context';
  return i < n / 2 ? 'main' : 'progression';
}

/** When does the viewer first hear (or read) something? Measured speech first, then captions. */
function firstContentAt(media: MediaFacts | null, timeline: Timeline): { at: number; basis: string } {
  const sp = media?.analysis.audioSignal?.speechSpans;
  if (sp?.length) return { at: sp[0].start, basis: 'measured speech' };
  const c = timeline.captions.chunks[0];
  if (c) return { at: c.start_s, basis: 'first caption' };
  return { at: timeline.beats[0]?.start_s ?? 0, basis: 'first scene' };
}

/**
 * Storytelling (15 pts), deterministic part: hook within 3 s, narrative structure, information progression,
 * visual progression with the narration, keyword relevance, ending and CTA. Subjective judgement (is the hook
 * compelling? does it flow?) comes from the optional AI review, which must cite evidence.
 */
export function evaluateStory(media: MediaFacts | null, timeline: Timeline | null): Check[] {
  if (!timeline || !timeline.beats.length) return [unmeasured('story', 'timeline', 'No scene plan to evaluate.')];
  const beats = timeline.beats;
  const n = beats.length;
  const checks: Check[] = [];
  // Hook: the first 3 seconds must already deliver the opening line.
  const first = firstContentAt(media, timeline);
  const firstWords = beats.filter((b) => b.start_s < 3).map((b) => b.text).join(' ') || beats[0].text;
  const hook = hookFeatures(beats[0].text);
  const fast = first.at <= 1.0;
  checks.push(check('story', 'hook', hook.s >= 1 && fast, hook.s < 1 && !fast ? 'major' : 'minor',
    `First 3 s: "${firstWords.slice(0, 90)}" — content starts at ${round(first.at, 2)} s (${first.basis}); hook signals: ${hook.reasons.join(', ') || 'none'}.`,
    { hookScore: hook.s, signals: hook.reasons, contentStartS: round(first.at, 2), basis: first.basis },
    !fast ? 'Start speaking immediately: trim the silent/empty opening.' : 'Open with a question, a number or a bold claim in the first two seconds.'));
  const roles = beats.map((b, i) => b.role || inferRole(i, n, b.text));
  const has = (r: string) => roles.includes(r as never);
  const structureOk = n >= 3 && has('hook') && (has('main') || has('context')) && (has('cta') || has('progression'));
  checks.push(check('story', 'structure', structureOk, n < 2 ? 'major' : 'minor', `${n} scene(s); roles: ${roles.join(' → ')}.`,
    { roles, inferred: beats.some((b) => !b.role) }, 'Plan hook → context → main point → progression → ending.'));
  // Information progression: each scene should add new content words, not restate the previous ones.
  const seen = new Set<string>();
  const stale: Array<{ scene: number; text: string; newShare: number }> = [];
  beats.forEach((b, i) => {
    const words = content(b.text);
    const fresh = words.filter((w) => !seen.has(w));
    if (i > 0 && words.length >= 3 && fresh.length / words.length < 0.3) stale.push({ scene: i + 1, text: b.text.slice(0, 60), newShare: round(fresh.length / words.length) });
    words.forEach((w) => seen.add(w));
  });
  checks.push(check('story', 'progression', stale.length === 0, stale.length > n / 3 ? 'major' : 'minor',
    stale.length ? `${stale.length} scene(s) mostly repeat earlier words instead of adding information.` : 'Every scene adds new information.',
    { stale: stale.slice(0, 6) }, 'Cut or rewrite scenes that repeat the previous point.'));
  // Visual progression: the picture should move on as the narration does.
  const st = media?.analysis.stability;
  if (st && n >= 3 && (media?.durationS || 0) >= 10) {
    const ok = st.distinctVisuals >= 2;
    checks.push(check('story', 'visual_progression', ok, 'major',
      ok ? `Visuals change with the narration (${st.distinctVisuals} distinct pictures over ${n} scenes).` : `${n} scenes are narrated over a single unchanging picture: the visuals do not follow the story.`,
      { scenes: n, distinctVisuals: st.distinctVisuals }, 'Give each idea in the script its own visual.'));
  }
  const last = beats[n - 1];
  const strongEnd = /[.!?]["')\]]?$/.test(last.text.trim()) && last.end_s - last.start_s >= 1.2;
  checks.push(check('story', 'ending', strongEnd, 'minor', `Ending: "${last.text.slice(0, 80)}"`, { lastSceneS: round(last.end_s - last.start_s) },
    'End on a complete sentence with a takeaway.'));
  // CTA is appropriate for scripted shorts (narrated); a clip of someone's talk does not need one.
  const scripted = timeline.audio.narration && !timeline.audio.sourceSpeech;
  if (scripted) {
    const cta = CTA.test(last.text) || roles.includes('cta');
    checks.push(check('story', 'cta', cta, 'minor', cta ? 'Ends with a call to action.' : 'No call to action at the end.', { lastLine: last.text.slice(0, 80) },
      'Close with a short call to action (follow, comment, save).'));
  }
  // Relevance: do the visuals described for a scene relate to what is said? (keyword overlap; source footage is the speaker)
  const judged = beats.filter((b) => b.kind !== 'source' && b.visual_keywords);
  if (!judged.length) checks.push(unmeasured('story', 'relevance', beats.every((b) => b.kind === 'source') ? 'Scenes show the source footage (the speaker), so visual relevance is inherent.' : 'No visual descriptions to compare with the narration.'));
  else {
    const unrelated = judged.filter((b) => {
      const said = new Set(content(b.text).map((w) => w.slice(0, 5)));
      return !content(b.visual_keywords || '').some((w) => said.has(w.slice(0, 5)));
    });
    const ratio = unrelated.length / judged.length;
    checks.push(check('story', 'relevance', ratio <= 0.5, 'minor', `${unrelated.length} of ${judged.length} scenes have visuals with no word in common with what is said.`,
      { unrelated: unrelated.slice(0, 6).map((b) => ({ text: b.text.slice(0, 60), visual: b.visual_keywords })), method: 'keyword overlap (proxy)' },
      'Describe visuals using the scene\'s own nouns.'));
  }
  return checks;
}

/** Pacing & engagement (10 pts): shot cadence, speech rate, dead air, how fast the reel gets going, blackouts. */
export function evaluatePacing(media: MediaFacts | null, timeline: Timeline | null, shots: Shot[], th: Thresholds): Check[] {
  const checks: Check[] = [];
  const st = media?.analysis.stability;
  const lengths = st?.states.length
    ? st.states.map((s) => s.end - s.start)
    : shots.length
      ? shots.map((s) => s.end - s.start)
      : timeline
        ? timelineShots(timeline.beats).map((s) => s.end - s.start)
        : [];
  if (!lengths.length) return [unmeasured('pacing', 'shots', 'No shots to evaluate.')];
  const mean = lengths.reduce((a, b) => a + b, 0) / lengths.length;
  const [lo, hi] = th.idealShotS;
  const sourceOnly = timeline?.beats.every((b) => b.kind === 'source');
  const max = sourceOnly ? th.maxShotS.source : hi;
  checks.push(check('pacing', 'shot_pacing', mean >= lo && mean <= max, mean > max * 2 ? 'major' : 'minor',
    `Average visual change every ${round(mean, 1)} s over ${lengths.length} shot(s).`, { meanS: round(mean), shots: lengths.length, ideal: [lo, max], basis: st ? 'measured visual states' : 'scene plan' },
    mean > max ? 'Cut more often: change framing or footage every few seconds.' : 'Hold shots a little longer.'));
  if (timeline?.beats.length) {
    // Planned scene lengths (works before rendering): media cuts inside a scene (e.g. punch-ins) split it further.
    let worst: { kind: string; length: number; limit: number; start: number } | null = null;
    for (const s of timelineShots(timeline.beats)) {
      const kind = (s.kind || 'broll') as keyof Thresholds['maxShotS'];
      const limit = th.maxShotS[kind] ?? th.maxShotS.broll;
      const cutsInside = media?.video ? media.analysis.sceneCuts.filter((c) => c > s.start + 0.3 && c < s.end - 0.3) : [];
      const bounds = [s.start, ...cutsInside, s.end];
      for (let i = 0; i < bounds.length - 1; i++) {
        const len = bounds[i + 1] - bounds[i];
        if (len > limit && (!worst || len - limit > worst.length - worst.limit)) worst = { kind, length: round(len, 1), limit, start: round(bounds[i]) };
      }
    }
    checks.push(check('pacing', 'shot_length', !worst, worst && worst.length > worst.limit * 1.5 ? 'major' : 'minor',
      worst ? `A planned ${worst.kind} scene runs ${worst.length} s without a cut at ${worst.start} s (limit ${worst.limit} s).` : 'No planned scene exceeds its length limit.',
      { worst }, worst?.kind === 'source' ? 'Add framing changes (punch-ins) at sentence boundaries or a B-roll cut-away.' : 'Split the scene or add a second shot.'));
  }
  if (timeline) {
    const words = tokens(timeline.scriptText).length;
    const spoken = speechExpected(timeline) ? expectedSpeechSpans(timeline).reduce((s, x) => s + x.end - x.start, 0) : 0;
    const wps = words / Math.max(1, spoken || timeline.durationS);
    const [wlo, whi] = th.speechWpsRange;
    checks.push(check('pacing', 'speech_rate', wps >= wlo && wps <= whi, 'minor', `${round(wps, 1)} words per second of speech.`, { wps: round(wps), range: th.speechWpsRange },
      wps < wlo ? 'Tighten pauses; the reel drags.' : 'Too dense to follow; shorten the script or extend the reel.'));
    const sig = media?.analysis.audioSignal;
    if (sig && speechExpected(timeline) && !sig.digitalSilence && sig.activeSpans.length) {
      // Dead air: gaps in audible sound longer than 1.5 s between the first and last sound.
      const deadAir: Array<{ start: number; end: number }> = [];
      for (let i = 1; i < sig.activeSpans.length; i++) {
        const g = { start: sig.activeSpans[i - 1].end, end: sig.activeSpans[i].start };
        if (g.end - g.start >= 1.5) deadAir.push(g);
      }
      const total = deadAir.reduce((s, g) => s + g.end - g.start, 0);
      checks.push(check('pacing', 'dead_air', deadAir.length === 0, total > 4 ? 'major' : 'minor', `${deadAir.length} silent gap(s) of 1.5 s or more (${round(total, 1)} s).`,
        { gaps: deadAir.slice(0, 8) }, 'Remove the pauses or shorten the scenes around them.'));
    }
  }
  if (media?.video) {
    const mid = media.analysis.blackSegments.filter((b) => b.start > 0.3 && (Number.isFinite(b.end) ? b.end : media.durationS) < media.durationS - 0.3);
    checks.push(check('pacing', 'continuity', mid.length === 0, 'major', `${mid.length} black gap(s) between scenes.`, { gaps: mid.slice(0, 6) }, 'A scene failed to load; replace its media.'));
  }
  return checks;
}
