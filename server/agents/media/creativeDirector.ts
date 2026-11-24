import { cleanAndParseJSON, quoteUserInput } from '../../lib/llm.ts';
import type { TransitionKind } from '../../media_engine/config.ts';
import type { PresetId } from '../../media_engine/models.ts';
import { getExportPreset } from '../../media_engine/presets/index.ts';
import type { MediaAnalysisReport } from './mediaAnalyst.ts';

export interface PlannedClipSegment {
  assetId: string;
  sourceStart: number;
  sourceEnd: number;
  purpose: 'hook' | 'body' | 'payoff';
  transitionOut: TransitionKind;
}

export interface EditPlan {
  format: PresetId;
  pacing: 'fast' | 'balanced' | 'cinematic';
  targetDurationSeconds: number;
  segments: PlannedClipSegment[];
  musicVolume: number;
  voiceoverVolume: number;
  burnSubtitles: boolean;
  captionLines: string[];
  callToAction: string;
  generatedBy: 'gemini' | 'deterministic';
}

export type StructuredLlmGenerator = (prompt: string) => Promise<string | null>;

/**
 * Specialist Agent 2: Creative Director
 * Has capability awareness of `ffmpeg-media-production` but NO direct access to the FFmpeg execution interface
 * (enforcing Section 9 "Skill activation").
 */
export class CreativeDirectorAgent {
  readonly capabilityDescription =
    'Plans pacing, shot order, transitions, music ducking, and caption hooks within ExportPreset constraints.';

  constructor(private readonly llmGenerate?: StructuredLlmGenerator) {}

  async createEditPlan(params: {
    brief: string;
    format: PresetId;
    analysis: MediaAnalysisReport;
  }): Promise<EditPlan> {
    const preset = getExportPreset(params.format);
    const { analysis } = params;
    const briefLower = (params.brief || '').toLowerCase();

    const pacing: 'fast' | 'balanced' | 'cinematic' =
      /fast|energetic|viral|punchy|reel|short/.test(briefLower)
        ? 'fast'
        : /cinematic|slow|dramatic|luxury/.test(briefLower)
          ? 'cinematic'
          : 'balanced';

    if (this.llmGenerate && analysis.videoAssets.length > 0) {
      try {
        const assetSummary = analysis.videoAssets.map((v) => ({
          assetId: v.asset.id,
          duration: v.manifest.durationSeconds,
          aspectRatio: v.manifest.aspectRatio,
        }));
        const prompt = [
          'You are the Creative Director for Forge Media Studio.',
          `Target preset: ${preset.name} (${preset.width}x${preset.height}, max ${preset.maxDurationSeconds}s).`,
          `Available video assets: ${JSON.stringify(assetSummary)}`,
          `Creative brief: ${quoteUserInput('brief', params.brief.slice(0, 800))}`,
          'Return strict JSON with keys: captionLines (array of 2-5 short strings) and callToAction (string).',
        ].join('\n');
        const raw = await this.llmGenerate(prompt);
        if (raw) {
          const parsed = cleanAndParseJSON(raw);
          if (Array.isArray(parsed.captionLines) && parsed.captionLines.length > 0) {
            return this.buildDeterministicSegments({
              brief: params.brief,
              format: params.format,
              pacing,
              analysis,
              captionLines: parsed.captionLines.map((s: unknown) => String(s ?? '').trim().slice(0, 90)).filter(Boolean),
              callToAction: String(parsed.callToAction ?? 'Follow for more').slice(0, 60),
              generatedBy: 'gemini',
            });
          }
        }
      } catch {
        // Fall through deterministically so offline/degraded LLM never blocks media production.
      }
    }

    const sentences = (params.brief || 'Crafted in Forge Studio.')
      .split(/[.!?\n]+/)
      .map((s) => s.trim())
      .filter((s) => s.length >= 3)
      .slice(0, 4)
      .map((s) => s.slice(0, 80));

    return this.buildDeterministicSegments({
      brief: params.brief,
      format: params.format,
      pacing,
      analysis,
      captionLines: sentences.length > 0 ? sentences : ['Built with Forge Media Engine'],
      callToAction: 'Watch till the end',
      generatedBy: 'deterministic',
    });
  }

  private buildDeterministicSegments(opts: {
    brief: string;
    format: PresetId;
    pacing: 'fast' | 'balanced' | 'cinematic';
    analysis: MediaAnalysisReport;
    captionLines: string[];
    callToAction: string;
    generatedBy: 'gemini' | 'deterministic';
  }): EditPlan {
    const preset = getExportPreset(opts.format);
    const maxShotLen = opts.pacing === 'fast' ? 4 : opts.pacing === 'cinematic' ? 8 : 6;
    const segments: PlannedClipSegment[] = [];
    let accumulated = 0;

    for (let i = 0; i < opts.analysis.videoAssets.length; i++) {
      const v = opts.analysis.videoAssets[i];
      const remaining = preset.maxDurationSeconds - accumulated;
      if (remaining <= 0.5) break;
      const avail = Math.max(0.5, v.manifest.durationSeconds);
      const useDur = Number(Math.min(avail, maxShotLen, remaining).toFixed(3));
      const srcStart = avail > useDur + 0.5 ? 0.25 : 0;
      const srcEnd = Number(Math.min(avail, srcStart + useDur).toFixed(3));
      const isLast = i === opts.analysis.videoAssets.length - 1;
      segments.push({
        assetId: v.asset.id,
        sourceStart: Number(srcStart.toFixed(3)),
        sourceEnd: srcEnd,
        purpose: i === 0 ? 'hook' : isLast ? 'payoff' : 'body',
        transitionOut: isLast ? 'fade' : opts.analysis.videoAssets.length > 1 ? 'fade' : 'none',
      });
      accumulated += srcEnd - srcStart;
    }

    const hasVoiceover = opts.analysis.audioAssets.some((a) => /voice|vo|narration|speech/i.test(a.asset.originalFilename));

    return {
      format: opts.format,
      pacing: opts.pacing,
      targetDurationSeconds: Number(Math.max(1, accumulated || 5).toFixed(3)),
      segments,
      musicVolume: hasVoiceover ? 0.18 : 0.3,
      voiceoverVolume: 1.0,
      burnSubtitles: opts.analysis.subtitleAssets.length > 0 || /caption|subtitle|reel|short/i.test(opts.brief),
      captionLines: opts.captionLines,
      callToAction: opts.callToAction,
      generatedBy: opts.generatedBy,
    };
  }
}
