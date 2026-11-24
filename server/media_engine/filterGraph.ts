import path from 'path';
import type { MediaEngineConfig } from './config.ts';
import { MediaEngineError } from './exceptions.ts';
import type { TimelineSubtitleCue } from './models.ts';
import type { ValidatedTimeline } from './timeline.ts';

export interface FilterGraphPlan {
  inputFiles: string[];
  filterComplex: string;
  videoOutputLabel: string | null;
  audioOutputLabel: string | null;
}

/**
 * Escapes a local file path for safe inclusion inside an FFmpeg filter option (e.g. `subtitles=filename='...'`).
 * Rejects control characters and newlines outright.
 */
export function escapeFfmpegFilterPath(filePath: string): string {
  if (/[\u0000-\u001F\u007F]/.test(filePath)) {
    throw new MediaEngineError('FILTER_ERROR', 'Control characters are forbidden in FFmpeg filter paths');
  }
  return filePath
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'")
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;');
}

export function serializeCuesToSrt(cues: TimelineSubtitleCue[]): string {
  const fmt = (seconds: number): string => {
    const clamped = Math.max(0, seconds);
    const totalMs = Math.round(clamped * 1000);
    const ms = totalMs % 1000;
    const totalSec = Math.floor(totalMs / 1000);
    const s = totalSec % 60;
    const totalMin = Math.floor(totalSec / 60);
    const m = totalMin % 60;
    const h = Math.floor(totalMin / 60);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
  };

  return cues
    .map((cue, idx) => {
      const cleanText = cue.text
        .replace(/[\r\n]+/g, ' ')
        .replace(/[{}]/g, '') // Strip ASS override tags to prevent subtitle filter styling/script injection.
        .trim();
      return `${idx + 1}\n${fmt(cue.start)} --> ${fmt(cue.end)}\n${cleanText}\n`;
    })
    .join('\n');
}

/**
 * Deterministically compiles a `ValidatedTimeline` into an allowlisted FFmpeg `filter_complex` graph.
 * Never interpolates raw user filter expressions.
 */
export function buildTimelineFilterGraph(
  validated: ValidatedTimeline,
  config: MediaEngineConfig,
  stagedSubtitlePath?: string | null,
): FilterGraphPlan {
  const { spec, derivedDurationSeconds, manifests, resolvedAssetPaths } = validated;
  const { width, height } = spec.resolution;
  const fps = spec.fps;

  const inputFiles: string[] = [];
  const inputIndexByAssetId = new Map<string, number>();

  const registerInput = (assetId: string): number => {
    const existing = inputIndexByAssetId.get(assetId);
    if (existing !== undefined) return existing;
    const localPath = resolvedAssetPaths[assetId];
    if (!localPath) {
      throw new MediaEngineError('ASSET_ERROR', `Missing resolved path for asset ${assetId}`);
    }
    const idx = inputFiles.length;
    inputFiles.push(localPath);
    inputIndexByAssetId.set(assetId, idx);
    return idx;
  };

  for (const clip of spec.tracks.video) registerInput(clip.asset_id);
  for (const ov of spec.tracks.overlays ?? []) registerInput(ov.asset_id);
  for (const aud of spec.tracks.audio) registerInput(aud.asset_id);

  const chains: string[] = [];
  let videoOutputLabel: string | null = null;

  // ---- VIDEO GRAPH ----
  if (spec.tracks.video.length > 0) {
    chains.push(
      `color=c=black:s=${width}x${height}:r=${fps}:d=${derivedDurationSeconds.toFixed(3)},format=yuv420p[vbase0]`,
    );
    let currentBase = 'vbase0';

    spec.tracks.video.forEach((clip, idx) => {
      const inIdx = registerInput(clip.asset_id);
      const manifest = manifests[clip.asset_id];
      const clipDur = Number((clip.end - clip.start).toFixed(3));
      const fadeDur = Math.min(clip.transition_duration ?? 0.5, Math.max(0.1, clipDur * 0.4));

      const scaleFilter =
        clip.fit_mode === 'contain'
          ? `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black,setsar=1`
          : `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1`;

      const clipStages: string[] = [];
      if (manifest.kind === 'image') {
        clipStages.push(
          `[${inIdx}:v]loop=loop=-1:size=1:start=0,trim=duration=${clipDur.toFixed(3)},setpts=PTS-STARTPTS,fps=${fps}`,
        );
      } else {
        clipStages.push(
          `[${inIdx}:v]trim=start=${clip.source_start.toFixed(3)}:end=${clip.source_end.toFixed(3)},setpts=PTS-STARTPTS,fps=${fps}`,
        );
      }
      clipStages.push(scaleFilter);
      clipStages.push('format=yuva420p');

      if (clip.transition_in && clip.transition_in !== 'none') {
        clipStages.push(`fade=t=in:st=0:d=${fadeDur.toFixed(3)}:alpha=1`);
      }
      if (clip.transition_out && clip.transition_out !== 'none') {
        const fadeOutStart = Math.max(0, clipDur - fadeDur);
        const nextClip = spec.tracks.video[idx + 1];
        const overlapsNext = Boolean(nextClip && nextClip.start < clip.end - 0.01);
        const nextHasAlphaFadeIn = Boolean(overlapsNext && nextClip?.transition_in && nextClip.transition_in !== 'none');
        // When overlapping a clip that already alpha-fades in on top, keep the lower clip opaque so the cross-dissolve
        // blends `alpha*Clip1 + (1-alpha)*Clip0` without dipping toward the black canvas at the midpoint.
        if (!nextHasAlphaFadeIn) {
          clipStages.push(
            `fade=t=out:st=${fadeOutStart.toFixed(3)}:d=${fadeDur.toFixed(3)}${overlapsNext ? ':alpha=1' : ''}`,
          );
        }
      }

      clipStages.push(`setpts=PTS+${clip.start.toFixed(3)}/TB[vclip${idx}]`);
      chains.push(clipStages.join(','));

      const nextBase = `vbase${idx + 1}`;
      chains.push(
        `[${currentBase}][vclip${idx}]overlay=x=0:y=0:eof_action=pass:enable='between(t,${clip.start.toFixed(3)},${clip.end.toFixed(3)})'[${nextBase}]`,
      );
      currentBase = nextBase;
    });

    // Optional image/logo overlays
    (spec.tracks.overlays ?? []).forEach((ov, idx) => {
      const inIdx = registerInput(ov.asset_id);
      const ovDur = Number((ov.end - ov.start).toFixed(3));
      const alphaStage =
        ov.opacity !== undefined && ov.opacity < 1
          ? `,colorchannelmixer=aa=${ov.opacity.toFixed(2)}`
          : '';
      chains.push(
        `[${inIdx}:v]scale=${ov.width}:${ov.height},format=yuva420p${alphaStage},trim=duration=${ovDur.toFixed(3)},setpts=PTS+${ov.start.toFixed(3)}/TB[vov${idx}]`,
      );
      const nextBase = `vovbase${idx + 1}`;
      chains.push(
        `[${currentBase}][vov${idx}]overlay=x=${ov.x}:y=${ov.y}:eof_action=pass:enable='between(t,${ov.start.toFixed(3)},${ov.end.toFixed(3)})'[${nextBase}]`,
      );
      currentBase = nextBase;
    });

    // Optional burned subtitles (safe generated SRT in job staging directory)
    if (stagedSubtitlePath) {
      const escapedSubPath = escapeFfmpegFilterPath(stagedSubtitlePath);
      const fontDirOpt = config.bundledFontPath
        ? `:fontsdir='${escapeFfmpegFilterPath(path.dirname(config.bundledFontPath))}'`
        : '';
      const subTrack = validated.subtitleTracks.find((t) => t.burnIn);
      const fontSize = Math.max(12, Math.min(72, Math.round((subTrack?.fontSize ?? 36) * 0.55)));
      const marginV = Math.max(20, Math.min(300, Math.round((subTrack?.marginV ?? 140) * 0.35)));
      const forceStyle = `FontName=Poppins,FontSize=${fontSize},PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=2,Alignment=2,MarginV=${marginV}`;
      const subOut = 'vsubbed';
      chains.push(
        `[${currentBase}]subtitles=filename='${escapedSubPath}'${fontDirOpt}:force_style='${forceStyle}'[${subOut}]`,
      );
      currentBase = subOut;
    }

    chains.push(`[${currentBase}]format=${spec.export.pixel_format}[vout]`);
    videoOutputLabel = '[vout]';
  }

  // ---- AUDIO GRAPH ----
  const audioMixLabels: string[] = [];

  // 1. Source audio from video clips (unless muted or silent)
  spec.tracks.video.forEach((clip, idx) => {
    const manifest = manifests[clip.asset_id];
    const clipVol = clip.volume ?? 1;
    if (clip.mute_source_audio || clipVol <= 0 || !manifest.hasAudio) return;
    const inIdx = registerInput(clip.asset_id);
    const delayMs = Math.max(0, Math.round(clip.start * 1000));
    const label = `avclip${idx}`;
    const stages = [
      `[${inIdx}:a]atrim=start=${clip.source_start.toFixed(3)}:end=${clip.source_end.toFixed(3)}`,
      'asetpts=PTS-STARTPTS',
      'aresample=44100',
      'aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo',
      `volume=${clipVol.toFixed(3)}`,
    ];
    if (delayMs > 0) {
      stages.push(`adelay=${delayMs}|${delayMs}`);
    }
    chains.push(`${stages.join(',')}[${label}]`);
    audioMixLabels.push(`[${label}]`);
  });

  // 2. Explicit audio tracks (music, voiceover, SFX)
  let requestLoudnorm = false;
  spec.tracks.audio.forEach((track, idx) => {
    if (track.volume <= 0) return;
    const inIdx = registerInput(track.asset_id);
    const srcStart = track.source_start ?? 0;
    const srcEnd = track.source_end ?? srcStart + (track.end - track.start);
    const playDur = Math.max(0.05, srcEnd - srcStart);
    const delayMs = Math.max(0, Math.round(track.start * 1000));
    const label = `atrk${idx}`;

    const stages = [
      `[${inIdx}:a]atrim=start=${srcStart.toFixed(3)}:end=${srcEnd.toFixed(3)}`,
      'asetpts=PTS-STARTPTS',
      'aresample=44100',
      'aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo',
      `volume=${track.volume.toFixed(3)}`,
    ];
    if (track.fade_in && track.fade_in > 0) {
      stages.push(`afade=t=in:st=0:d=${Math.min(track.fade_in, playDur).toFixed(3)}`);
    }
    if (track.fade_out && track.fade_out > 0) {
      const st = Math.max(0, playDur - track.fade_out);
      stages.push(`afade=t=out:st=${st.toFixed(3)}:d=${Math.min(track.fade_out, playDur).toFixed(3)}`);
    }
    if (delayMs > 0) {
      stages.push(`adelay=${delayMs}|${delayMs}`);
    }
    if (track.normalize_loudness) {
      requestLoudnorm = true;
    }
    chains.push(`${stages.join(',')}[${label}]`);
    audioMixLabels.push(`[${label}]`);
  });

  // Always include a silent bed spanning the full derived duration so outputs always have continuous stereo AAC audio.
  chains.push(
    `anullsrc=channel_layout=stereo:sample_rate=44100,atrim=duration=${derivedDurationSeconds.toFixed(3)}[asilent]`,
  );

  let audioOutputLabel: string | null = null;
  if (audioMixLabels.length === 0) {
    audioOutputLabel = '[asilent]';
  } else {
    const allInputs = ['[asilent]', ...audioMixLabels];
    const mixRawLabel = requestLoudnorm ? 'amixed_raw' : 'aout';
    // normalize=0 preserves explicit track gain ratios instead of dividing volume by input count.
    chains.push(
      `${allInputs.join('')}amix=inputs=${allInputs.length}:duration=first:dropout_transition=0:normalize=0,alimiter=limit=0.95[${mixRawLabel}]`,
    );
    if (requestLoudnorm) {
      chains.push(`[amixed_raw]loudnorm=I=-16:TP=-1.5:LRA=11[aout]`);
    }
    audioOutputLabel = '[aout]';
  }

  return {
    inputFiles,
    filterComplex: chains.join(';'),
    videoOutputLabel,
    audioOutputLabel,
  };
}
