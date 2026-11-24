import React, { useState, useEffect, useRef } from 'react';
import {
  Upload,
  Film,
  Music,
  Subtitles,
  Sparkles,
  Play,
  Square,
  ShieldCheck,
  AlertTriangle,
  CheckCircle2,
  Download,
  RefreshCw,
  Sliders,
} from 'lucide-react';
import { apiFetch, apiErrorMessage } from '../utils/api';

export interface StudioMediaAsset {
  id: string;
  kind: 'video' | 'audio' | 'image' | 'subtitle';
  originalFilename: string;
  sizeBytes: number;
  manifest?: {
    durationSeconds: number;
    width: number | null;
    height: number | null;
    fps: number | null;
    videoCodec: string | null;
    audioCodec: string | null;
    aspectRatio: string | null;
    warnings: string[];
  };
}

export interface StudioTimelineSpec {
  project_id: string;
  format: string;
  resolution: { width: number; height: number };
  fps: number;
  duration_seconds: number;
  tracks: {
    video: Array<{
      id?: string;
      asset_id: string;
      start: number;
      end: number;
      source_start: number;
      source_end: number;
      transition_out?: string;
    }>;
    audio: Array<{
      id?: string;
      asset_id: string;
      role?: string;
      start: number;
      end: number;
      volume: number;
    }>;
    subtitles: Array<{
      id?: string;
      asset_id?: string;
      start?: number;
      end?: number;
      text?: string;
      cues?: Array<{ start: number; end: number; text: string }>;
    }>;
  };
}

export interface StudioQAReport {
  job_id: string;
  total_score: number;
  band: string;
  passed: boolean;
  revision_required: boolean;
  dimensions: {
    technical_integrity: number;
    visual_quality: number;
    audio_quality: number;
    editing_quality: number;
    creative_compliance: number;
  };
  warnings: string[];
  failures: string[];
  repair_actions: string[];
}

export interface MediaStudioWorkspaceProps {
  initialAssets?: StudioMediaAsset[];
  initialTimeline?: StudioTimelineSpec | null;
  initialQaReport?: StudioQAReport | null;
}

const PRESET_OPTIONS = [
  { id: 'instagram_reel', label: 'Instagram Reel (1080×1920 · 30fps)' },
  { id: 'youtube_short', label: 'YouTube Short (1080×1920 · 30fps)' },
  { id: 'youtube_1080p', label: 'YouTube 1080p (1920×1080 · 30fps)' },
  { id: 'youtube_4k', label: 'YouTube 4K (3840×2160 · H.265)' },
  { id: 'square_social', label: 'Square Social (1080×1080 · 30fps)' },
  { id: 'landscape_ad', label: 'Landscape Ad (1920×1080 · 30fps)' },
];

function formatMmSs(seconds: number): string {
  const total = Math.max(0, Math.round(seconds || 0));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export const MediaStudioWorkspace: React.FC<MediaStudioWorkspaceProps> = ({
  initialAssets = [],
  initialTimeline = null,
  initialQaReport = null,
}) => {
  const [assets, setAssets] = useState<StudioMediaAsset[]>(initialAssets);
  const [selectedAssetIds, setSelectedAssetIds] = useState<string[]>(initialAssets.map((a) => a.id));
  const [projectTitle, setProjectTitle] = useState('Forge Social Campaign');
  const [creativeBrief, setCreativeBrief] = useState(
    'Fast energetic vertical edit combining footage with clean fades, balanced background music, and crisp burned captions.',
  );
  const [preset, setPreset] = useState('instagram_reel');
  const [qualityProfile, setQualityProfile] = useState<'draft' | 'standard' | 'high'>('high');
  const [projectId, setProjectId] = useState<string | null>(initialTimeline?.project_id ?? null);
  const [timelineVersion, setTimelineVersion] = useState<number>(initialTimeline ? 1 : 0);
  const [timeline, setTimeline] = useState<StudioTimelineSpec | null>(initialTimeline);

  const [isUploading, setIsUploading] = useState(false);
  const [isPlanning, setIsPlanning] = useState(false);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [jobStatus, setJobStatus] = useState<string | null>(null);
  const [jobStage, setJobStage] = useState<string>('');
  const [jobProgress, setJobProgress] = useState<number>(0);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [qaReport, setQaReport] = useState<StudioQAReport | null>(initialQaReport);
  const [repairedNotice, setRepairedNotice] = useState<string | null>(null);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  const pollTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (initialAssets.length > 0) return;
    apiFetch('/api/v1/media/assets')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (Array.isArray(d?.assets) && d.assets.length > 0) {
          setAssets(d.assets);
          setSelectedAssetIds(d.assets.map((a: StudioMediaAsset) => a.id));
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    return () => {
      if (pollTimerRef.current !== null) window.clearInterval(pollTimerRef.current);
    };
  }, []);

  const uploadFiles = async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    setIsUploading(true);
    setErrorBanner(null);
    try {
      const uploaded: StudioMediaAsset[] = [];
      for (const file of Array.from(fileList)) {
        const buf = await file.arrayBuffer();
        const bytes = new Uint8Array(buf);
        let binary = '';
        for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
        const contentBase64 = window.btoa(binary);
        const res = await apiFetch('/api/v1/media/assets', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            filename: file.name,
            mimeType: file.type || undefined,
            contentBase64,
          }),
        });
        if (!res.ok) {
          throw new Error(await apiErrorMessage(res, `Failed to upload ${file.name}`));
        }
        const data = await res.json();
        if (data.asset) uploaded.push(data.asset);
      }
      if (uploaded.length > 0) {
        setAssets((prev) => [...uploaded, ...prev]);
        setSelectedAssetIds((prev) => Array.from(new Set([...uploaded.map((u) => u.id), ...prev])));
      }
    } catch (err: unknown) {
      setErrorBanner(err instanceof Error ? err.message : 'Asset upload failed');
    } finally {
      setIsUploading(false);
    }
  };

  const handlePlanTimeline = async () => {
    if (selectedAssetIds.length === 0) {
      setErrorBanner('Upload and select at least one media asset before building a timeline.');
      return;
    }
    setIsPlanning(true);
    setErrorBanner(null);
    try {
      const res = projectId
        ? await apiFetch(`/api/v1/media/projects/${projectId}/plan`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              brief: creativeBrief,
              format: preset,
              asset_ids: selectedAssetIds,
            }),
          })
        : await apiFetch('/api/v1/media/projects', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              title: projectTitle,
              brief: creativeBrief,
              format: preset,
              asset_ids: selectedAssetIds,
              auto_plan: true,
            }),
          });
      if (!res.ok) {
        throw new Error(await apiErrorMessage(res, 'Failed to generate media timeline'));
      }
      const data = await res.json();
      setProjectId(data.project.id);
      setTimeline(data.project.timeline);
      setTimelineVersion(data.project.timelineVersion);
    } catch (err: unknown) {
      setErrorBanner(err instanceof Error ? err.message : 'Timeline planning failed');
    } finally {
      setIsPlanning(false);
    }
  };

  const startPollingJob = (jobId: string) => {
    if (pollTimerRef.current !== null) window.clearInterval(pollTimerRef.current);
    pollTimerRef.current = window.setInterval(async () => {
      try {
        const res = await apiFetch(`/api/v1/media/jobs/${jobId}`);
        if (!res.ok) return;
        const data = await res.json();
        setJobStatus(data.status);
        setJobProgress(data.progress ?? 0);
        setJobStage(data.stage ?? data.status);

        if (data.status === 'completed' || data.status === 'failed' || data.status === 'cancelled') {
          if (pollTimerRef.current !== null) {
            window.clearInterval(pollTimerRef.current);
            pollTimerRef.current = null;
          }
          if (data.status === 'completed' && data.result) {
            setPreviewUrl(data.result.downloadUrl ?? null);
            if (data.result.repaired && Array.isArray(data.result.applied_fixes)) {
              setRepairedNotice(data.result.applied_fixes.join(' · '));
            }
            const qaRes = await apiFetch(`/api/v1/media/jobs/${jobId}/qa`);
            if (qaRes.ok) {
              const qaBody = await qaRes.json();
              setQaReport(qaBody.qa_report ?? null);
            }
          } else if (data.status === 'failed') {
            setErrorBanner(data.error || 'Media render failed validation');
          }
        }
      } catch {
        // transient network poll error
      }
    }, 800);
  };

  const handleStartRender = async () => {
    if (!projectId) {
      setErrorBanner('Plan or create a project timeline before starting a render.');
      return;
    }
    setErrorBanner(null);
    setRepairedNotice(null);
    setQaReport(null);
    try {
      const res = await apiFetch('/api/v1/media/render', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': `${projectId}-v${timelineVersion}-${preset}-${qualityProfile}-${Date.now()}`,
        },
        body: JSON.stringify({
          project_id: projectId,
          timeline_version: timelineVersion,
          preset,
          quality_profile: qualityProfile,
        }),
      });
      if (!res.ok) {
        throw new Error(await apiErrorMessage(res, 'Render submission rejected'));
      }
      const data = await res.json();
      setActiveJobId(data.job_id);
      setJobStatus(data.status);
      setJobProgress(data.progress ?? 0);
      setJobStage(data.stage ?? 'initializing');
      startPollingJob(data.job_id);
    } catch (err: unknown) {
      setErrorBanner(err instanceof Error ? err.message : 'Unable to submit render job');
    }
  };

  const handleCancelRender = async () => {
    if (!activeJobId) return;
    try {
      const res = await apiFetch(`/api/v1/media/jobs/${activeJobId}/cancel`, { method: 'POST' });
      if (res.ok) {
        setJobStatus('cancelled');
        setJobStage('cancelled');
      }
    } catch {
      // ignore
    }
  };

  const toggleSelectAsset = (id: string) => {
    setSelectedAssetIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const totalDuration = timeline?.duration_seconds ?? 0;

  return (
    <div className="space-y-6">
      {/* Workspace Header & KPI Summary */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="md:col-span-1 rounded-2xl border border-white/10 bg-white/[0.03] p-4">
          <div className="text-xs font-mono uppercase tracking-wider text-rose-400">Forge Media Engine</div>
          <h2 className="mt-1 text-lg font-bold text-white">Forge Media Studio</h2>
          <p className="mt-1 text-xs text-neutral-400">
            Deterministic FFmpeg multi-track rendering &amp; 100-point automated QA
          </p>
        </div>

        <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 flex items-center justify-between">
          <div>
            <div className="text-xs text-neutral-400">Authorized Assets</div>
            <div className="text-2xl font-bold font-mono text-white">{String(assets.length).padStart(2, '0')}</div>
          </div>
          <Film className="w-6 h-6 text-rose-400" />
        </div>

        <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 flex items-center justify-between">
          <div>
            <div className="text-xs text-neutral-400">Derived Timeline</div>
            <div className="text-2xl font-bold font-mono text-white">{formatMmSs(totalDuration)}</div>
          </div>
          <Sliders className="w-6 h-6 text-sky-400" />
        </div>

        <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 flex items-center justify-between">
          <div>
            <div className="text-xs text-neutral-400">QA Scorecard</div>
            <div className="text-2xl font-bold font-mono text-emerald-400">
              {qaReport ? `${qaReport.total_score}/100` : '—'}
            </div>
          </div>
          <ShieldCheck className="w-6 h-6 text-emerald-400" />
        </div>
      </div>

      {errorBanner && (
        <div role="alert" className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-xs text-rose-200 flex items-center justify-between">
          <span>{errorBanner}</span>
          <button type="button" onClick={() => setErrorBanner(null)} className="text-rose-300 hover:text-white">
            ✕
          </button>
        </div>
      )}

      {repairedNotice && (
        <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-xs text-emerald-200 flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-400" />
          <span>Automated QA Repair Applied: {repairedNotice}</span>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Left Column: Asset Bin & Creative Brief */}
        <div className="lg:col-span-4 space-y-5">
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setIsDragging(true);
            }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setIsDragging(false);
              void uploadFiles(e.dataTransfer.files);
            }}
            className={`rounded-2xl border-2 border-dashed p-5 text-center transition ${
              isDragging ? 'border-rose-500 bg-rose-500/10' : 'border-white/15 bg-white/[0.02]'
            }`}
          >
            <Upload className="w-6 h-6 text-rose-400 mx-auto mb-2" />
            <p className="text-xs font-semibold text-white">Drop footage, WAV/MP3 audio, PNG logos, or SRT captions</p>
            <p className="text-[11px] text-neutral-400 mt-1">Inspected automatically with FFprobe stream checks</p>
            <label className="mt-3 inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl bg-white/10 hover:bg-white/15 text-xs font-medium text-white cursor-pointer transition">
              <span>{isUploading ? 'Inspecting...' : 'Select Media Files'}</span>
              <input
                type="file"
                multiple
                accept=".mp4,.mov,.mkv,.webm,.mp3,.wav,.m4a,.aac,.jpg,.jpeg,.png,.webp,.srt,.vtt"
                onChange={(e) => void uploadFiles(e.target.files)}
                className="hidden"
              />
            </label>
          </div>

          {/* Probed Assets List */}
          <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-4 space-y-2.5 max-h-64 overflow-y-auto">
            <div className="text-xs font-semibold text-neutral-300 uppercase tracking-wider">Media Manifest Bin</div>
            {assets.length === 0 ? (
              <p className="text-xs text-neutral-500 py-3">No assets uploaded yet.</p>
            ) : (
              assets.map((asset) => {
                const checked = selectedAssetIds.includes(asset.id);
                return (
                  <label
                    key={asset.id}
                    className={`flex items-start gap-2.5 p-2.5 rounded-xl border text-xs cursor-pointer transition ${
                      checked ? 'border-rose-500/40 bg-rose-500/10' : 'border-white/8 bg-black/30'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleSelectAsset(asset.id)}
                      className="mt-0.5 accent-rose-500"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="font-medium text-white truncate">{asset.originalFilename}</div>
                      <div className="text-[11px] text-neutral-400 font-mono mt-0.5">
                        {asset.kind.toUpperCase()}
                        {asset.manifest?.width ? ` · ${asset.manifest.width}×${asset.manifest.height}` : ''}
                        {asset.manifest?.durationSeconds ? ` · ${asset.manifest.durationSeconds.toFixed(1)}s` : ''}
                        {asset.manifest?.videoCodec ? ` · ${asset.manifest.videoCodec}` : ''}
                      </div>
                    </div>
                  </label>
                );
              })
            )}
          </div>

          {/* Creative Brief & Preset Controls */}
          <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-4 space-y-3">
            <div>
              <label className="block text-xs font-medium text-neutral-300 mb-1">Project Title</label>
              <input
                type="text"
                value={projectTitle}
                onChange={(e) => setProjectTitle(e.target.value)}
                className="w-full rounded-xl bg-black/40 border border-white/10 px-3 py-2 text-xs text-white"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-neutral-300 mb-1">Export Preset</label>
              <select
                value={preset}
                onChange={(e) => setPreset(e.target.value)}
                className="w-full rounded-xl bg-black/40 border border-white/10 px-3 py-2 text-xs text-white"
              >
                {PRESET_OPTIONS.map((opt) => (
                  <option key={opt.id} value={opt.id}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-neutral-300 mb-1">Creative Brief</label>
              <textarea
                rows={3}
                value={creativeBrief}
                onChange={(e) => setCreativeBrief(e.target.value)}
                className="w-full rounded-xl bg-black/40 border border-white/10 px-3 py-2 text-xs text-white"
              />
            </div>

            <button
              type="button"
              onClick={() => void handlePlanTimeline()}
              disabled={isPlanning}
              className="w-full py-2.5 px-4 rounded-xl bg-rose-600 hover:bg-rose-500 disabled:opacity-50 text-xs font-semibold text-white flex items-center justify-center gap-2 transition"
            >
              <Sparkles className="w-4 h-4" />
              <span>{isPlanning ? 'Agents Planning Timeline...' : 'Plan Multi-Track Timeline'}</span>
            </button>
          </div>
        </div>

        {/* Center/Right Column: Multi-Track Timeline, Preview & QA Scorecard */}
        <div className="lg:col-span-8 space-y-5">
          {/* Render Bar */}
          <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-4 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <label className="text-xs text-neutral-400">Quality Profile:</label>
              <select
                value={qualityProfile}
                onChange={(e) => setQualityProfile(e.target.value as 'draft' | 'standard' | 'high')}
                className="rounded-lg bg-black/40 border border-white/10 px-2.5 py-1.5 text-xs text-white"
              >
                <option value="draft">Draft (Ultrafast)</option>
                <option value="standard">Standard</option>
                <option value="high">High (Publish)</option>
              </select>
              {timelineVersion > 0 && (
                <span className="text-[11px] font-mono text-neutral-400">Timeline v{timelineVersion}</span>
              )}
            </div>

            <div className="flex items-center gap-2">
              {jobStatus === 'queued' || jobStatus === 'processing' ? (
                <button
                  type="button"
                  onClick={() => void handleCancelRender()}
                  className="px-3.5 py-2 rounded-xl bg-amber-600 hover:bg-amber-500 text-xs font-semibold text-white flex items-center gap-1.5"
                >
                  <Square className="w-3.5 h-3.5" />
                  <span>Cancel Render</span>
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => void handleStartRender()}
                  disabled={!timeline}
                  className="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-xs font-semibold text-white flex items-center gap-1.5"
                >
                  <Play className="w-3.5 h-3.5" />
                  <span>Render with FFmpeg Engine</span>
                </button>
              )}
            </div>
          </div>

          {/* Live Render Progress */}
          {activeJobId && (
            <div className="rounded-2xl border border-white/10 bg-black/30 p-4 space-y-2">
              <div className="flex items-center justify-between text-xs">
                <span className="font-medium text-white flex items-center gap-1.5">
                  <RefreshCw className={`w-3.5 h-3.5 ${jobStatus === 'processing' ? 'animate-spin text-rose-400' : 'text-emerald-400'}`} />
                  <span>Stage: {jobStage || jobStatus}</span>
                </span>
                <span className="font-mono text-neutral-300">{jobProgress}%</span>
              </div>
              <div className="w-full h-2 rounded-full bg-white/10 overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-rose-500 to-emerald-500 transition-all duration-300"
                  style={{ width: `${Math.max(2, Math.min(100, jobProgress))}%` }}
                />
              </div>
            </div>
          )}

          {/* Multi-Track Timeline Inspector */}
          <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-neutral-300">Timeline Tracks</h3>
              {timeline && (
                <span className="text-[11px] font-mono text-neutral-400">
                  {timeline.resolution.width}×{timeline.resolution.height} · {timeline.fps}fps
                </span>
              )}
            </div>

            <div className="space-y-2.5 text-xs">
              {/* VIDEO 1 */}
              <div className="rounded-xl bg-black/40 border border-white/8 p-3">
                <div className="flex items-center gap-1.5 font-mono text-[11px] text-rose-400 mb-2">
                  <Film className="w-3.5 h-3.5" />
                  <span>VIDEO 1</span>
                </div>
                {timeline && timeline.tracks.video.length > 0 ? (
                  <div className="flex flex-wrap gap-2">
                    {timeline.tracks.video.map((clip, i) => (
                      <div key={clip.id ?? i} className="px-3 py-1.5 rounded-lg bg-rose-500/15 border border-rose-500/30 text-rose-100 font-mono text-[11px]">
                        Clip {i + 1}: {clip.start.toFixed(1)}s–{clip.end.toFixed(1)}s
                        {clip.transition_out ? ` · ${clip.transition_out}` : ''}
                      </div>
                    ))}
                  </div>
                ) : (
                  <span className="text-neutral-500">No video clips arranged yet</span>
                )}
              </div>

              {/* AUDIO */}
              <div className="rounded-xl bg-black/40 border border-white/8 p-3">
                <div className="flex items-center gap-1.5 font-mono text-[11px] text-sky-400 mb-2">
                  <Music className="w-3.5 h-3.5" />
                  <span>AUDIO</span>
                </div>
                {timeline && timeline.tracks.audio.length > 0 ? (
                  <div className="flex flex-wrap gap-2">
                    {timeline.tracks.audio.map((aud, i) => (
                      <div key={aud.id ?? i} className="px-3 py-1.5 rounded-lg bg-sky-500/15 border border-sky-500/30 text-sky-100 font-mono text-[11px]">
                        {(aud.role || 'audio').toUpperCase()}: {aud.start.toFixed(1)}s–{aud.end.toFixed(1)}s · vol {(aud.volume * 100).toFixed(0)}%
                      </div>
                    ))}
                  </div>
                ) : (
                  <span className="text-neutral-500">Source clip audio / stereo AAC bed</span>
                )}
              </div>

              {/* SUBTITLES */}
              <div className="rounded-xl bg-black/40 border border-white/8 p-3">
                <div className="flex items-center gap-1.5 font-mono text-[11px] text-amber-400 mb-2">
                  <Subtitles className="w-3.5 h-3.5" />
                  <span>SUBTITLES</span>
                </div>
                {timeline && timeline.tracks.subtitles.length > 0 ? (
                  <div className="text-amber-100 font-mono text-[11px]">
                    {timeline.tracks.subtitles.length} active caption track(s) configured for safe-zone burn-in
                  </div>
                ) : (
                  <span className="text-neutral-500">No burned subtitle tracks</span>
                )}
              </div>
            </div>
          </div>

          {/* Preview + 5-Dimension QA Report */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            <div className="rounded-2xl border border-white/10 bg-black/50 p-4 space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-neutral-300">Video Preview</h3>
                {previewUrl && (
                  <a
                    href={previewUrl}
                    download
                    className="inline-flex items-center gap-1 text-xs text-emerald-400 hover:text-emerald-300"
                  >
                    <Download className="w-3.5 h-3.5" />
                    <span>Download MP4</span>
                  </a>
                )}
              </div>
              {previewUrl ? (
                <video src={previewUrl} controls className="w-full max-h-80 rounded-xl bg-black" />
              ) : (
                <div className="h-52 rounded-xl border border-white/8 flex items-center justify-center text-xs text-neutral-500">
                  Validated video preview appears here after render
                </div>
              )}
            </div>

            <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-4 space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-neutral-300">5-Dimension QA Report</h3>
                {qaReport && (
                  <span
                    className={`px-2 py-0.5 rounded-md text-[11px] font-mono ${
                      qaReport.passed ? 'bg-emerald-500/15 text-emerald-300' : 'bg-amber-500/15 text-amber-300'
                    }`}
                  >
                    {qaReport.band.replace(/_/g, ' ')}
                  </span>
                )}
              </div>

              {qaReport ? (
                <div className="space-y-2 text-xs">
                  <div className="flex justify-between text-neutral-300">
                    <span>Technical Integrity</span>
                    <span className="font-mono">{qaReport.dimensions.technical_integrity}/25</span>
                  </div>
                  <div className="flex justify-between text-neutral-300">
                    <span>Visual Quality</span>
                    <span className="font-mono">{qaReport.dimensions.visual_quality}/25</span>
                  </div>
                  <div className="flex justify-between text-neutral-300">
                    <span>Audio Quality</span>
                    <span className="font-mono">{qaReport.dimensions.audio_quality}/20</span>
                  </div>
                  <div className="flex justify-between text-neutral-300">
                    <span>Editing Quality</span>
                    <span className="font-mono">{qaReport.dimensions.editing_quality}/20</span>
                  </div>
                  <div className="flex justify-between text-neutral-300">
                    <span>Creative Compliance</span>
                    <span className="font-mono">{qaReport.dimensions.creative_compliance}/10</span>
                  </div>
                  {qaReport.failures.length > 0 && (
                    <div className="pt-2 border-t border-white/10 space-y-1 text-amber-300 text-[11px]">
                      {qaReport.failures.map((f, i) => (
                        <div key={i} className="flex items-start gap-1.5">
                          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                          <span>{f}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                <p className="text-xs text-neutral-500 py-8 text-center">
                  Automated FFmpeg blackdetect, freezedetect, and astats metrics populate after rendering.
                </p>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
