import { spawn } from 'child_process';
import { buildCleanSubprocessEnv, redactFilesystemPaths, type MediaEngineConfig } from './config.ts';
import { MediaEngineError } from './exceptions.ts';
import type {
  MediaManifest,
  QADimensionScores,
  QAMetrics,
  QAReport,
  QAScoreBand,
} from './models.ts';
import type { MediaProbe } from './probe.ts';
import type { ValidatedTimeline } from './timeline.ts';

function runDiagnosticFilter(
  ffmpegBin: string,
  protocolWhitelist: string,
  maxThreads: number,
  args: string[],
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ code: number | null; stderr: string }> {
  if (signal?.aborted) {
    return Promise.reject(new MediaEngineError('RENDER_TIMEOUT', 'QA evaluation cancelled', { recoverable: false }));
  }
  return new Promise((resolve, reject) => {
    const proc = spawn(
      ffmpegBin,
      ['-nostdin', '-threads', String(maxThreads), '-protocol_whitelist', protocolWhitelist, ...args],
      {
        shell: false,
        stdio: ['ignore', 'ignore', 'pipe'],
        env: buildCleanSubprocessEnv(),
      },
    );
    let stderr = '';
    let aborted = false;
    const timer = setTimeout(() => proc.kill('SIGKILL'), timeoutMs);
    const onAbort = () => {
      aborted = true;
      proc.kill('SIGKILL');
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    proc.stderr.on('data', (d: Buffer) => {
      if (stderr.length < 512_000) stderr += d.toString('utf8');
    });
    proc.on('error', (err) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(err);
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (aborted) {
        return reject(new MediaEngineError('RENDER_TIMEOUT', 'QA evaluation cancelled', { recoverable: false }));
      }
      resolve({ code, stderr });
    });
  });
}

export function scoreBandOf(score: number): QAScoreBand {
  if (score >= 90) return 'publish_ready';
  if (score >= 80) return 'minor_improvements';
  if (score >= 65) return 'revision_required';
  return 'reject_and_regenerate';
}

/**
 * Automated 5-dimension Media Quality Evaluation System (Section 8).
 * Runs independent FFprobe/stream verification PLUS real FFmpeg `blackdetect`, `freezedetect`, and `astats` filters
 * with scrubbed child process environments and AbortSignal cancellation propagation.
 */
export class MediaValidator {
  constructor(
    private readonly config: MediaEngineConfig,
    private readonly probe: MediaProbe,
  ) {}

  async evaluateRenderedVideo(params: {
    jobId: string;
    projectId: string;
    artifactId?: string;
    outputPath: string;
    validatedTimeline: ValidatedTimeline;
    expectAudioActivity?: boolean;
    signal?: AbortSignal;
  }): Promise<{ manifest: MediaManifest; report: QAReport }> {
    const { jobId, projectId, artifactId, outputPath, validatedTimeline, signal } = params;
    const { spec, derivedDurationSeconds } = validatedTimeline;

    if (signal?.aborted) {
      throw new MediaEngineError('RENDER_TIMEOUT', 'QA evaluation cancelled', { recoverable: false });
    }

    // 1. Independent stream & container probe
    let outputManifest: MediaManifest;
    try {
      outputManifest = await this.probe.inspectFile(outputPath, artifactId ?? 'artifact_staged', 'video');
    } catch (err) {
      throw new MediaEngineError(
        'OUTPUT_CORRUPTION',
        `Rendered output failed independent probe validation: ${redactFilesystemPaths((err as Error)?.message || String(err))}`,
        { cause: err },
      );
    }

    if (!outputManifest.hasVideo) {
      throw new MediaEngineError('OUTPUT_CORRUPTION', 'Rendered video output contains no decodable video stream');
    }

    // 2. Run automated FFmpeg QA passes in parallel: blackdetect + freezedetect + astats
    const [blackRes, freezeRes, audioRes] = await Promise.all([
      runDiagnosticFilter(
        this.config.ffmpegBin,
        this.config.protocolWhitelist,
        this.config.maxThreads,
        ['-i', outputPath, '-vf', 'blackdetect=d=0.5:pix_th=0.10', '-an', '-f', 'null', '-'],
        this.config.qaTimeoutMs,
        signal,
      ),
      runDiagnosticFilter(
        this.config.ffmpegBin,
        this.config.protocolWhitelist,
        this.config.maxThreads,
        ['-i', outputPath, '-vf', 'freezedetect=n=-50dB:d=2', '-an', '-f', 'null', '-'],
        this.config.qaTimeoutMs,
        signal,
      ),
      outputManifest.hasAudio
        ? runDiagnosticFilter(
            this.config.ffmpegBin,
            this.config.protocolWhitelist,
            this.config.maxThreads,
            ['-i', outputPath, '-af', 'astats=metadata=1:reset=0', '-vn', '-f', 'null', '-'],
            this.config.qaTimeoutMs,
            signal,
          )
        : Promise.resolve({ code: 0, stderr: '' }),
    ]);

    const blackIntervals: Array<{ start: number; end: number; duration: number }> = [];
    for (const m of blackRes.stderr.matchAll(/black_start:([0-9.]+)\s+black_end:([0-9.]+)\s+black_duration:([0-9.]+)/g)) {
      blackIntervals.push({ start: Number(m[1]), end: Number(m[2]), duration: Number(m[3]) });
    }
    const totalBlackDuration = Number(blackIntervals.reduce((s, i) => s + i.duration, 0).toFixed(3));

    const freezeIntervals: Array<{ start: number; end: number; duration: number }> = [];
    const freezeStarts = [...freezeRes.stderr.matchAll(/freeze_start:\s*([0-9.]+)/g)].map((m) => Number(m[1]));
    const freezeDurs = [...freezeRes.stderr.matchAll(/freeze_duration:\s*([0-9.]+)/g)].map((m) => Number(m[1]));
    const freezeEnds = [...freezeRes.stderr.matchAll(/freeze_end:\s*([0-9.]+)/g)].map((m) => Number(m[1]));
    for (let i = 0; i < freezeStarts.length; i++) {
      const start = freezeStarts[i];
      const duration = freezeDurs[i] ?? Math.max(0, (freezeEnds[i] ?? outputManifest.durationSeconds) - start);
      const end = freezeEnds[i] ?? start + duration;
      freezeIntervals.push({ start, end, duration });
    }
    const totalFreezeDuration = Number(freezeIntervals.reduce((s, i) => s + i.duration, 0).toFixed(3));

    const peakMatches = [...audioRes.stderr.matchAll(/Peak level dB:\s*(-?[0-9.]+|-inf)/g)];
    const rmsMatches = [...audioRes.stderr.matchAll(/RMS level dB:\s*(-?[0-9.]+|-inf)/g)];
    const parseDb = (raw: string | undefined): number | null => {
      if (!raw) return null;
      if (raw === '-inf') return -120;
      const n = Number(raw);
      return Number.isFinite(n) ? n : null;
    };
    const audioPeakDb = peakMatches.length > 0 ? parseDb(peakMatches[peakMatches.length - 1][1]) : null;
    const audioRmsDb = rmsMatches.length > 0 ? parseDb(rmsMatches[rmsMatches.length - 1][1]) : null;

    const decodeErrors =
      (blackRes.code !== 0 ? 1 : 0) +
      ([...blackRes.stderr.matchAll(/Error while decoding|corrupt decoded frame/gi)].length);

    const durationDrift = Math.abs(outputManifest.durationSeconds - derivedDurationSeconds);
    const vDur = outputManifest.videoStreams[0]?.durationSeconds ?? outputManifest.durationSeconds;
    const aDur = outputManifest.audioStreams[0]?.durationSeconds ?? outputManifest.durationSeconds;
    const avSyncDrift = outputManifest.hasAudio ? Math.abs(vDur - aDur) : 0;

    const timelineExpectedAudio =
      params.expectAudioActivity ??
      (spec.tracks.audio.some((a) => a.volume > 0) ||
        spec.tracks.video.some((v) => !v.mute_source_audio && (v.volume ?? 1) > 0 && validatedTimeline.manifests[v.asset_id]?.hasAudio));

    const audioClippingDetected = audioPeakDb !== null && audioPeakDb > -0.2;
    const audioSilentDetected = audioRmsDb !== null && audioRmsDb <= -75;

    let subtitleTimingErrors = 0;
    for (const st of validatedTimeline.subtitleTracks) {
      for (const cue of st.cues) {
        if (cue.end > derivedDurationSeconds + 0.25 || cue.start < 0 || cue.end - cue.start < 0.15) {
          subtitleTimingErrors++;
        }
      }
    }

    const warnings: string[] = [...validatedTimeline.warnings];
    const failures: string[] = [];
    const repairActions: string[] = [];

    // ---- Score Dimension 1: Technical Integrity (max 25) ----
    let technical = 25;
    if (decodeErrors > 0) {
      technical -= 15;
      failures.push(`Detected ${decodeErrors} stream decode error(s)`);
      repairActions.push('reencode_clean_keyframes');
    }
    if (outputManifest.width !== spec.resolution.width || outputManifest.height !== spec.resolution.height) {
      technical -= 12;
      failures.push(
        `Output resolution ${outputManifest.width}x${outputManifest.height} does not match target ${spec.resolution.width}x${spec.resolution.height}`,
      );
      repairActions.push('enforce_resolution_scale_crop');
    }
    if (outputManifest.fps !== null && Math.abs(outputManifest.fps - spec.fps) > 1.5) {
      technical -= 5;
      warnings.push(`Output FPS (${outputManifest.fps}) drifted from target (${spec.fps})`);
    }
    if (durationDrift > 0.6) {
      technical -= 8;
      failures.push(`Output duration (${outputManifest.durationSeconds}s) drifted from timeline (${derivedDurationSeconds}s)`);
      repairActions.push('recompute_timeline_trim_bounds');
    }
    if (totalBlackDuration >= 0.5) {
      const blackRatio = totalBlackDuration / Math.max(1, derivedDurationSeconds);
      const deduction = Math.min(18, Math.ceil(blackRatio * 28));
      technical -= deduction;
      failures.push(`Detected ${totalBlackDuration.toFixed(2)}s of black frames across ${blackIntervals.length} interval(s)`);
      repairActions.push('close_timeline_gaps_or_trim_black_leader');
    }
    technical = Math.max(0, technical);

    // ---- Score Dimension 2: Visual Quality (max 25) ----
    let visual = 25;
    if (outputManifest.pixelFormat !== 'yuv420p') {
      visual -= 6;
      warnings.push(`Pixel format is ${outputManifest.pixelFormat} instead of yuv420p`);
    }
    if (totalFreezeDuration >= 2.0) {
      const freezePenalty = Math.min(18, Math.ceil((totalFreezeDuration / Math.max(1, derivedDurationSeconds)) * 25));
      visual -= freezePenalty;
      failures.push(`Detected ${totalFreezeDuration.toFixed(2)}s of frozen video frames`);
      repairActions.push('trim_static_footage_or_increase_cut_cadence');
    }
    visual = Math.max(0, visual);

    // ---- Score Dimension 3: Audio Quality (max 20) ----
    let audio = 20;
    if (!outputManifest.hasAudio) {
      audio -= 12;
      failures.push('Rendered output is missing an audio track');
      repairActions.push('inject_stereo_aac_track');
    } else {
      if (audioClippingDetected) {
        audio -= 10;
        failures.push(`Audio clipping detected (peak ${audioPeakDb?.toFixed(1)} dB)`);
        repairActions.push('enable_loudnorm_and_reduce_gain');
      }
      if (timelineExpectedAudio && audioSilentDetected) {
        audio -= 12;
        failures.push('Rendered audio track is unexpectedly silent despite active timeline audio');
        repairActions.push('restore_audio_mix_gain');
      }
      if (avSyncDrift > 0.35) {
        audio -= 6;
        warnings.push(`Audio/video stream duration drift of ${avSyncDrift.toFixed(2)}s`);
      }
    }
    audio = Math.max(0, audio);

    // ---- Score Dimension 4: Editing Quality (max 20) ----
    let editing = 20;
    const avgClipLength =
      spec.tracks.video.length > 0 ? derivedDurationSeconds / spec.tracks.video.length : derivedDurationSeconds;
    if (avgClipLength > 25 && (spec.format === 'instagram_reel' || spec.format === 'youtube_short')) {
      editing -= 4;
      warnings.push(`Average shot length (${avgClipLength.toFixed(1)}s) is slow for short-form vertical pacing`);
    }
    if (validatedTimeline.warnings.some((w) => /gap of/i.test(w))) {
      editing -= 8;
      failures.push('Unfilled visual gap between clips caused timeline discontinuity');
      repairActions.push('snap_sequential_clips');
    }
    editing = Math.max(0, editing);

    // ---- Score Dimension 5: Creative Compliance (max 10) ----
    let creative = 10;
    if (subtitleTimingErrors > 0) {
      creative -= Math.min(6, subtitleTimingErrors * 2);
      warnings.push(`${subtitleTimingErrors} subtitle cue(s) required timing boundary adjustment`);
      repairActions.push('realign_subtitle_timestamps');
    }
    if (
      (spec.format === 'instagram_reel' || spec.format === 'youtube_short') &&
      outputManifest.aspectRatio !== '9:16'
    ) {
      creative -= 6;
      failures.push(`Expected 9:16 vertical aspect ratio for ${spec.format}, got ${outputManifest.aspectRatio}`);
      repairActions.push('enforce_vertical_preset');
    }
    creative = Math.max(0, creative);

    const dimensions: QADimensionScores = {
      technical_integrity: technical,
      visual_quality: visual,
      audio_quality: audio,
      editing_quality: editing,
      creative_compliance: creative,
    };

    const totalScore =
      dimensions.technical_integrity +
      dimensions.visual_quality +
      dimensions.audio_quality +
      dimensions.editing_quality +
      dimensions.creative_compliance;

    const band = scoreBandOf(totalScore);
    const passed = totalScore >= 80 && decodeErrors === 0;
    const revisionRequired = totalScore < 80;

    const metrics: QAMetrics = {
      black_frame_intervals: blackIntervals,
      total_black_duration: totalBlackDuration,
      freeze_intervals: freezeIntervals,
      total_freeze_duration: totalFreezeDuration,
      audio_peak_db: audioPeakDb,
      audio_rms_db: audioRmsDb,
      audio_clipping_detected: audioClippingDetected,
      audio_silent_detected: audioSilentDetected,
      decode_errors: decodeErrors,
      expected_duration_seconds: derivedDurationSeconds,
      actual_duration_seconds: outputManifest.durationSeconds,
      duration_drift_seconds: Number(durationDrift.toFixed(3)),
      av_sync_drift_seconds: Number(avSyncDrift.toFixed(3)),
      subtitle_timing_errors: subtitleTimingErrors,
    };

    const report: QAReport = {
      job_id: jobId,
      project_id: projectId,
      ...(artifactId ? { artifact_id: artifactId } : {}),
      total_score: totalScore,
      band,
      passed,
      revision_required: revisionRequired,
      dimensions,
      metrics,
      warnings,
      failures,
      repair_actions: Array.from(new Set(repairActions)),
      evaluated_at: new Date().toISOString(),
    };

    return { manifest: outputManifest, report };
  }
}
