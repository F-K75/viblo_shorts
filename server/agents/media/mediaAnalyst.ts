import fs from 'fs';
import type { MediaAssetRecord, MediaManifest } from '../../media_engine/models.ts';
import type { MediaProbe } from '../../media_engine/probe.ts';
import type { MediaStorage } from '../../media_engine/storage.ts';
import type { MediaMetadataStore } from '../../media_engine/mediaStore.ts';

export interface AssetInspectionSummary {
  asset: MediaAssetRecord;
  manifest: MediaManifest;
  resolvedPath: string;
  subtitleContent?: string;
}

export interface MediaAnalysisReport {
  projectId: string;
  inspectedAt: string;
  assets: AssetInspectionSummary[];
  manifestsById: Record<string, MediaManifest>;
  resolvedPathsById: Record<string, string>;
  subtitleContentsById: Record<string, string>;
  videoAssets: AssetInspectionSummary[];
  audioAssets: AssetInspectionSummary[];
  imageAssets: AssetInspectionSummary[];
  subtitleAssets: AssetInspectionSummary[];
  totalAvailableVideoDuration: number;
  warnings: string[];
}

/**
 * Specialist Agent 1: Media Analyst
 * Skill binding: `ffmpeg-media-production` (STEP 1 & STEP 2: Inspect & Analyze)
 */
export class MediaAnalystAgent {
  readonly skillId = 'ffmpeg-media-production';

  constructor(
    private readonly probe: MediaProbe,
    private readonly storage: MediaStorage,
    private readonly metadataStore: MediaMetadataStore,
  ) {}

  async analyzeAssets(params: {
    projectId: string;
    tenantId: string;
    assets: MediaAssetRecord[];
  }): Promise<MediaAnalysisReport> {
    const summaries: AssetInspectionSummary[] = [];
    const manifestsById: Record<string, MediaManifest> = {};
    const resolvedPathsById: Record<string, string> = {};
    const subtitleContentsById: Record<string, string> = {};
    const warnings: string[] = [];

    for (const asset of params.assets) {
      const resolvedPath = await this.storage.resolveAuthorizedAssetPath(asset, params.tenantId);
      const manifest = asset.manifest ?? (await this.probe.inspectFile(resolvedPath, asset.id, asset.kind));
      if (!asset.manifest) {
        asset.manifest = manifest;
        await this.metadataStore.saveAsset(asset);
      }
      let subtitleContent: string | undefined;
      if (manifest.kind === 'subtitle') {
        subtitleContent = fs.readFileSync(resolvedPath, 'utf8');
        subtitleContentsById[asset.id] = subtitleContent;
      }
      manifestsById[asset.id] = manifest;
      resolvedPathsById[asset.id] = resolvedPath;
      for (const w of manifest.warnings) {
        warnings.push(`${asset.originalFilename}: ${w}`);
      }
      summaries.push({ asset, manifest, resolvedPath, subtitleContent });
    }

    const videoAssets = summaries.filter((s) => s.manifest.kind === 'video');
    const audioAssets = summaries.filter((s) => s.manifest.kind === 'audio');
    const imageAssets = summaries.filter((s) => s.manifest.kind === 'image');
    const subtitleAssets = summaries.filter((s) => s.manifest.kind === 'subtitle');
    const totalAvailableVideoDuration = Number(
      videoAssets.reduce((sum, v) => sum + v.manifest.durationSeconds, 0).toFixed(3),
    );

    return {
      projectId: params.projectId,
      inspectedAt: new Date().toISOString(),
      assets: summaries,
      manifestsById,
      resolvedPathsById,
      subtitleContentsById,
      videoAssets,
      audioAssets,
      imageAssets,
      subtitleAssets,
      totalAvailableVideoDuration,
      warnings,
    };
  }
}
