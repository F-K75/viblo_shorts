import { hookFeatures } from '../youtube.ts';
import type { Check, Recommendation, RepairAction, Timeline } from './models.ts';

/**
 * Turns failed checks into actionable recommendations. Deterministic, safe repairs are marked automatic:
 *   remux_conform  — the server re-encodes on delivery (codec, pixel format, CFR, faststart, loudness). Never upscales.
 *   rerecord       — the client records the timeline again, at most MAX_REMEDIATION times, only for recorder faults.
 * Everything creative (hook, scenes, voice, captions) is a recommendation the creator applies, then re-evaluates.
 */
const ACTION_BY_CHECK: Record<string, RepairAction> = {
  speech_source: 'regenerate_voiceover',
  audio_stream: 'regenerate_voiceover',
  audio_signal: 'regenerate_voiceover',
  speech_presence: 'regenerate_voiceover',
  voiceover_completeness: 'regenerate_voiceover',
  speech_music_balance: 'regenerate_voiceover',
  loudness: 'remux_conform',
  rms_level: 'remux_conform',
  clipping: 'remux_conform',
  audio_format: 'remux_conform',
  constant_frame_rate: 'remux_conform',
  video_codec: 'remux_conform',
  pixel_format: 'remux_conform',
  frame_rate: 'remux_conform',
  faststart: 'remux_conform',
  av_start_offset: 'remux_conform',
  audio_codec: 'remux_conform',
  timestamps: 'remux_conform',
  dimensions: 'rerender_resolution',
  aspect_ratio: 'rerender_resolution',
  render_resolution: 'rerender_resolution',
  duration: 'rerecord',
  frames_present: 'rerecord',
  video_stream: 'rerecord',
  file_readable: 'rerecord',
  file_integrity: 'rerecord',
  frozen_video: 'rerecord',
  frame_gaps: 'rerecord',
  dropped_frames: 'rerecord',
  av_duration: 'rerecord',
  effective_detail: 'retrieve_assets',
  sharpness: 'retrieve_assets',
  exposure: 'retrieve_assets',
  contrast: 'retrieve_assets',
  relevance: 'retrieve_assets',
  static_visuals: 'replace_scenes',
  scene_diversity: 'replace_scenes',
  repeated_shots: 'replace_scenes',
  asset_reuse: 'replace_scenes',
  visual_progression: 'replace_scenes',
  scenes_rendered: 'replace_scenes',
  black_frames: 'replace_scenes',
  continuity: 'replace_scenes',
  present: 'regroup_captions',
  coverage: 'regroup_captions',
  fragments: 'regroup_captions',
  orphans: 'regroup_captions',
  readable_duration: 'regroup_captions',
  overflow: 'regroup_captions',
  overlaps: 'realign_captions',
  timing_range: 'realign_captions',
  sync_start: 'realign_captions',
  sync_silence: 'realign_captions',
  speech_captioned: 'realign_captions',
  highlight_sync: 'realign_captions',
  word_timing: 'realign_captions',
  av_sync: 'realign_captions',
  caption_bounds: 'realign_captions',
  safe_area: 'reposition_captions',
  subject_clear: 'reposition_captions',
  hook: 'strengthen_hook',
  structure: 'strengthen_hook',
  progression: 'adjust_pacing',
  shot_pacing: 'adjust_pacing',
  shot_length: 'replace_scenes',
  speech_rate: 'adjust_pacing',
  dead_air: 'adjust_pacing',
  ending: 'improve_ending',
  cta: 'improve_ending',
};

const TITLES: Record<RepairAction, string> = {
  remux_conform: 'Re-encode for delivery',
  rerecord: 'Record the video again',
  regenerate_voiceover: 'Fix the voiceover',
  attach_source: 'Attach your own copy of the video',
  realign_captions: 'Re-align captions to the voice',
  regroup_captions: 'Regroup captions into readable phrases',
  reposition_captions: 'Move captions to a safe position',
  replace_scenes: 'Replace static or repeated scenes',
  retrieve_assets: 'Use better, more relevant footage',
  strengthen_hook: 'Strengthen the opening hook',
  adjust_pacing: 'Adjust the pacing',
  improve_ending: 'Improve the ending',
  rerender_resolution: 'Render again at the target resolution',
};
const AUTOMATIC = new Set<RepairAction>(['remux_conform', 'rerecord']);
const PRIORITY = { critical: 'critical', major: 'high', minor: 'medium', info: 'low' } as const;
const RANK = { critical: 0, high: 1, medium: 2, low: 3 } as const;

/** The best-hooking sentence of the script (question, number, bold claim), proposed as the opening line. */
export function proposeHook(timeline: Timeline | null): string | null {
  if (!timeline) return null;
  const sentences = timeline.scriptText.match(/[^.!?]+[.!?]+/g)?.map((s) => s.trim()).filter((s) => s.split(/\s+/).length >= 4) || [];
  if (!sentences.length) return null;
  const scored = sentences.map((s, i) => ({ s, i, v: hookFeatures(s).s }));
  const best = scored.reduce((a, b) => (b.v > a.v ? b : a));
  if (best.i === 0 || best.v <= scored[0].v) return null;
  return best.s;
}

export function recommend(problems: Check[], timeline: Timeline | null): Recommendation[] {
  const byAction = new Map<RepairAction, Recommendation>();
  const src = timeline?.audio.speechSource;
  for (const p of problems) {
    let action = ACTION_BY_CHECK[p.id];
    if (!action) continue;
    // A clip whose speaker cannot be recorded needs the footage itself, not another voice attempt.
    if (action === 'regenerate_voiceover' && src === 'youtube-embed') action = 'attach_source';
    if (action === 'retrieve_assets' && p.id === 'effective_detail' && timeline?.beats.some((b) => b.kind === 'image')) action = 'attach_source';
    const prio = PRIORITY[p.severity];
    const existing = byAction.get(action);
    if (existing) {
      existing.checks.push(p.id);
      if (RANK[prio] < RANK[existing.priority]) existing.priority = prio;
      if (p.suggestion && !existing.detail.includes(p.suggestion)) existing.detail += ` ${p.suggestion}`;
      continue;
    }
    byAction.set(action, { action, title: TITLES[action], detail: p.suggestion || p.message, automatic: AUTOMATIC.has(action), checks: [p.id], priority: prio });
  }
  // The speaker's voice is unreachable: attaching the footage is the real fix; narrating the transcript is the alternative.
  const attach = byAction.get('attach_source');
  if (attach && src === 'youtube-embed' && !byAction.has('regenerate_voiceover')) {
    byAction.set('regenerate_voiceover', {
      action: 'regenerate_voiceover',
      title: 'Or narrate the clip with a voiceover',
      detail: "Without your copy of the video, the transcript can be read by AI voice (or the basic offline voice) so the reel is not silent. The speaker's own voice and footage need the video file.",
      automatic: false,
      checks: [...attach.checks],
      priority: attach.priority,
    });
  }
  const hook = byAction.get('strengthen_hook');
  const proposal = proposeHook(timeline);
  if (hook && proposal) hook.detail += ` Proposed opening: "${proposal}"`;
  return [...byAction.values()].sort((a, b) => RANK[a.priority] - RANK[b.priority]);
}
