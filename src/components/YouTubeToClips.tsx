import React, { useState } from 'react';
import {
  Youtube,
  Sparkles,
  Flame,
  ArrowRight,
  Clock,
  Loader2,
  ChevronDown,
  ChevronUp,
  CheckCircle2,
  ExternalLink,
  Zap,
  LayoutGrid,
  List,
  Film,
} from 'lucide-react';
import { YouTubeVideoInfo, YouTubeClipCandidate } from '../types';
import { apiFetch } from '../utils/api';

interface YouTubeToClipsProps {
  onSelectClip: (clip: YouTubeClipCandidate, videoInfo: YouTubeVideoInfo) => Promise<void>;
  isProcessing: boolean;
}

const SAMPLE_VIDEOS = [
  {
    label: 'Steve Jobs 2005 Speech',
    url: 'https://www.youtube.com/watch?v=UF8uR6Z6KLc',
    note: 'Life, death, and passion',
  },
  {
    label: 'Huberman on Sleep & Focus',
    url: 'https://www.youtube.com/watch?v=nm1TxQj94ow',
    note: 'Neuroscience productivity hacks',
  },
  {
    label: 'Me at the zoo (First Video)',
    url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw',
    note: 'Internet history archive',
  },
];

export const YouTubeToClips: React.FC<YouTubeToClipsProps> = ({
  onSelectClip,
  isProcessing,
}) => {
  const [url, setUrl] = useState('');
  const [clipObjective, setClipObjective] = useState('Viral Hook & High Retention');
  const [transcript, setTranscript] = useState('');
  const [showTranscriptInput, setShowTranscriptInput] = useState(false);

  const [loading, setLoading] = useState(false);
  const [loadingStep, setLoadingStep] = useState('');
  const [error, setError] = useState<string | null>(null);

  const [videoInfo, setVideoInfo] = useState<YouTubeVideoInfo | null>(null);
  const [clipCandidates, setClipCandidates] = useState<YouTubeClipCandidate[]>([]);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [expandedClipId, setExpandedClipId] = useState<string | null>(null);
  const [viewLayout, setViewLayout] = useState<'grid' | 'list'>('grid');

  const handleAnalyze = async (targetUrl = url) => {
    const trimmed = targetUrl.trim();
    if (!trimmed) {
      setError('Please enter a YouTube video URL.');
      return;
    }

    setError(null);
    setLoading(true);
    setClipCandidates([]);

    try {
      setLoadingStep('Fetching YouTube video details...');
      const infoRes = await apiFetch('/api/youtube/info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: trimmed }),
      });

      if (!infoRes.ok) {
        throw new Error('Could not fetch YouTube video info. Check the URL and try again.');
      }

      const infoData: YouTubeVideoInfo = await infoRes.json();
      setVideoInfo(infoData);

      setLoadingStep('Gemini analyzing viral moments and high-retention hooks...');
      const genRes = await apiFetch('/api/youtube/generate-clips', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: trimmed,
          clipObjective,
          transcript: transcript.trim() || undefined,
        }),
      });

      const genData = await genRes.json();
      if (!genData.clips || genData.clips.length === 0) {
        throw new Error(genData.error || 'No clips could be identified for this video.');
      }

      setClipCandidates(genData.clips);
      if (genData.videoInfo) {
        setVideoInfo(genData.videoInfo);
      }
    } catch (err: any) {
      console.error('Failed to generate YouTube clips:', err);
      setError(err?.message || 'Failed to process YouTube video. Please try another link.');
    } finally {
      setLoading(false);
      setLoadingStep('');
    }
  };

  const handleChooseClip = async (clip: YouTubeClipCandidate) => {
    if (!videoInfo) return;
    setSelectedClipId(clip.id);
    await onSelectClip(clip, videoInfo);
  };

  return (
    <div className="space-y-5">
      {/* Input Console */}
      <div className="bg-[#0f141c] border border-white/8 rounded-2xl p-6 shadow-sm relative overflow-hidden">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-4 border-b border-white/8">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-base font-semibold text-white tracking-tight">YouTube to Shorts Engine</h2>
              <div className="flex items-center gap-1.5 text-xs text-neutral-400">
                <span aria-hidden="true">·</span>
                <span>OpusClip Architecture</span>
                <span aria-hidden="true">·</span>
                <span>Automatic CC Sync</span>
              </div>
            </div>
            <p className="text-xs text-neutral-400 mt-0.5">
              Paste long-form video or podcast URL. Gemini locates high-retention segments and extracts ready-to-render 9:16 vertical shorts.
            </p>
          </div>
        </div>

        {/* Input Form */}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            handleAnalyze();
          }}
          className="mt-4 space-y-4"
        >
          <div className="flex flex-col sm:flex-row gap-2.5">
            <div className="relative flex-1">
              <Youtube className="w-4 h-4 text-red-500 absolute left-3.5 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="Paste YouTube link (e.g. https://www.youtube.com/watch?v=... or youtu.be/...)"
                className="w-full pl-10 pr-3 py-3 bg-[#090c10] border border-white/10 focus:border-rose-500 rounded-xl text-xs sm:text-sm text-white placeholder-neutral-500 focus:outline-none transition shadow-inner font-medium"
              />
            </div>
            <button
              type="submit"
              disabled={loading || isProcessing || !url.trim()}
              className="px-6 py-3 bg-rose-600 hover:bg-rose-500 text-white font-semibold text-xs sm:text-sm rounded-xl transition flex items-center justify-center gap-2 disabled:opacity-50 shrink-0 shadow-sm"
            >
              {loading ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>Extracting Moments...</span>
                </>
              ) : (
                <>
                  <Sparkles className="w-4 h-4" />
                  <span>Extract Shorts</span>
                </>
              )}
            </button>
          </div>

          {/* Quick Samples */}
          <div className="flex flex-wrap items-center gap-2 text-xs text-neutral-400">
            <span className="text-[11px] text-neutral-500">Sample videos:</span>
            {SAMPLE_VIDEOS.map((sample) => (
              <button
                key={sample.url}
                type="button"
                onClick={() => {
                  setUrl(sample.url);
                  handleAnalyze(sample.url);
                }}
                className="px-2.5 py-1 rounded-lg bg-black/30 hover:bg-white/5 text-[11px] text-neutral-300 hover:text-white transition border border-white/6"
              >
                {sample.label}
              </button>
            ))}
          </div>

          {/* Configuration Options */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
            <div>
              <label className="block text-xs font-semibold text-white mb-1.5">Clip Strategy & Hook Angle</label>
              <select
                value={clipObjective}
                onChange={(e) => setClipObjective(e.target.value)}
                className="w-full bg-[#090c10] border border-white/10 rounded-xl px-3 py-2 text-xs text-neutral-200 focus:outline-none focus:border-rose-500"
              >
                <option value="Viral Hook & High Retention">Viral Hook & High Retention</option>
                <option value="Hard Truth / Contrarian Warning">Contrarian Warning / Reality Check</option>
                <option value="Actionable 3-Step Blueprint">Actionable Step-by-Step Blueprint</option>
                <option value="Emotional / Motivational Moment">Inspirational & High Energy</option>
              </select>
            </div>

            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-xs font-semibold text-white">Transcript / Subtitles (Optional)</label>
                <button
                  type="button"
                  onClick={() => setShowTranscriptInput(!showTranscriptInput)}
                  className="text-xs text-rose-400 hover:text-rose-300 flex items-center gap-1 transition"
                >
                  {showTranscriptInput ? 'Hide' : 'Paste manual CC'}
                  {showTranscriptInput ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                </button>
              </div>
              <p className="text-[11px] text-neutral-400">
                Gemini automatically fetches YouTube Audio CC. You can also paste custom transcripts.
              </p>
            </div>
          </div>

          {showTranscriptInput && (
            <div className="pt-2 space-y-1.5">
              <textarea
                value={transcript}
                onChange={(e) => setTranscript(e.target.value)}
                rows={3}
                placeholder={"0:00 Welcome back everyone\n0:04 Today we break down the formula..."}
                className="w-full bg-[#090c10] border border-white/10 rounded-xl p-3 text-xs text-neutral-300 placeholder-neutral-600 focus:outline-none focus:border-rose-500 font-mono leading-relaxed resize-none shadow-inner"
              />
            </div>
          )}
        </form>

        {/* Loading Progress */}
        {loading && (
          <div className="mt-4 p-3 rounded-xl bg-black/40 border border-rose-500/30 flex items-center gap-2.5">
            <Loader2 className="w-4 h-4 text-rose-500 animate-spin shrink-0" />
            <span className="text-xs text-rose-300">{loadingStep}</span>
          </div>
        )}

        {/* Error Notification */}
        {error && (
          <div className="mt-4 p-3 rounded-xl bg-red-950/40 border border-red-800/50 text-xs text-red-200">
            {error}
          </div>
        )}
      </div>

      {/* Video Preview Card */}
      {videoInfo && (
        <div className="bg-[#0f141c] border border-white/8 rounded-2xl p-4 flex items-center gap-4 shadow-sm">
          <div className="relative w-28 aspect-video rounded-lg overflow-hidden bg-black shrink-0 border border-white/8">
            <img
              src={videoInfo.thumbnailUrl}
              alt={videoInfo.title}
              className="w-full h-full object-cover"
            />
            <div className="absolute inset-0 bg-black/25 flex items-center justify-center">
              <Youtube className="w-5 h-5 text-white/90 drop-shadow" />
            </div>
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 text-xs text-neutral-400">
              <span className="font-semibold text-rose-400">Source Video</span>
              <span aria-hidden="true">·</span>
              <span className="truncate">{videoInfo.authorName}</span>
            </div>
            <h4 className="text-sm font-semibold text-white truncate mt-0.5" title={videoInfo.title}>
              {videoInfo.title}
            </h4>
            <a
              href={videoInfo.url}
              target="_blank"
              rel="noreferrer"
              className="text-[11px] text-neutral-400 hover:text-white inline-flex items-center gap-1 mt-1 transition"
            >
              <span>Watch on YouTube</span>
              <ExternalLink className="w-3 h-3" />
            </a>
          </div>
        </div>
      )}

      {/* Extracted Viral Clip Candidates */}
      {clipCandidates.length > 0 && (
        <div className="space-y-4 pt-2">
          {/* Section Header */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-2 border-b border-white/8">
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-semibold text-white">
                  Identified Viral Short Candidates ({clipCandidates.length})
                </h3>
                <div className="flex items-center gap-1 text-xs text-neutral-400">
                  <span aria-hidden="true">·</span>
                  <span>Ranked by retention probability</span>
                </div>
              </div>
            </div>

            {/* Layout Toggle */}
            <div className="flex items-center p-0.5 bg-black/40 border border-white/8 rounded-lg self-start sm:self-auto">
              <button
                type="button"
                onClick={() => setViewLayout('grid')}
                className={`p-1.5 rounded-md text-xs font-medium flex items-center gap-1 transition ${
                  viewLayout === 'grid' ? 'bg-[#1e2638] text-white shadow-sm' : 'text-neutral-400 hover:text-white'
                }`}
                title="Grid layout"
              >
                <LayoutGrid className="w-3.5 h-3.5" />
                <span className="text-[11px] hidden sm:inline">Grid</span>
              </button>
              <button
                type="button"
                onClick={() => setViewLayout('list')}
                className={`p-1.5 rounded-md text-xs font-medium flex items-center gap-1 transition ${
                  viewLayout === 'list' ? 'bg-[#1e2638] text-white shadow-sm' : 'text-neutral-400 hover:text-white'
                }`}
                title="List layout"
              >
                <List className="w-3.5 h-3.5" />
                <span className="text-[11px] hidden sm:inline">List</span>
              </button>
            </div>
          </div>

          {/* Candidates Grid / List */}
          <div
            className={
              viewLayout === 'grid'
                ? 'grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4'
                : 'space-y-3'
            }
          >
            {clipCandidates.map((clip, index) => {
              const isSelected = selectedClipId === clip.id;
              const isExpanded = expandedClipId === clip.id;
              const beatCount = clip.beats?.length || 0;
              const durationSec = Math.max(0, (clip.endSeconds || 0) - (clip.startSeconds || 0));

              return (
                <div
                  key={clip.id || index}
                  className={`bg-[#0f141c] border rounded-2xl p-5 flex flex-col justify-between transition ${
                    isSelected
                      ? 'border-rose-500 ring-2 ring-rose-500/20'
                      : 'border-white/8 hover:border-white/20'
                  }`}
                >
                  <div>
                    {/* Top Row: Rank & Metrics */}
                    <div className="flex items-center justify-between pb-3 border-b border-white/6 gap-2 text-xs">
                      <div className="flex items-center gap-2">
                        <span className="font-mono font-bold text-neutral-400">
                          0{index + 1}.
                        </span>
                        <span className="font-medium text-white">Candidate</span>
                      </div>

                      <div className="flex items-center gap-2 text-neutral-400 font-mono tabular-nums">
                        <span className="text-amber-400 font-semibold">Clip score {clip.viralScore}/100</span>
                        <span aria-hidden="true">·</span>
                        <span>{clip.approxStartTimestamp || '00:00'} ({durationSec}s)</span>
                      </div>
                    </div>

                    {/* Clip Title */}
                    <h4 className="text-sm font-semibold text-white tracking-tight mt-3">
                      {clip.clipTitle}
                    </h4>

                    {/* Hook Box */}
                    <div className="mt-3 p-3 rounded-xl bg-black/40 border border-white/6 space-y-1">
                      <span className="text-[10px] font-mono tracking-wider text-rose-400 block">
                        OPENING HOOK (0–3 SECONDS)
                      </span>
                      <p className="text-xs text-neutral-200 italic leading-relaxed">
                        &ldquo;{clip.hook}&rdquo;
                      </p>
                    </div>

                    {/* Reasoning */}
                    <p className="text-[11px] text-neutral-400 mt-2.5 leading-relaxed">
                      {clip.reasoning}
                    </p>

                    {/* Beats Summary */}
                    <div className="mt-3 pt-2.5 border-t border-white/6 flex items-center justify-between text-xs text-neutral-400">
                      <span>{beatCount} Visual Beats</span>
                      <button
                        type="button"
                        onClick={() => setExpandedClipId(isExpanded ? null : clip.id)}
                        className="text-xs text-rose-400 hover:text-rose-300 transition flex items-center gap-0.5"
                      >
                        {isExpanded ? 'Hide Beats' : 'View Script'}
                        {isExpanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                      </button>
                    </div>

                    {isExpanded && (
                      <div className="mt-2.5 p-3 rounded-xl bg-black/50 border border-white/6 space-y-2 max-h-44 overflow-y-auto">
                        {(clip.beats || []).map((beat, bIdx) => (
                          <div key={bIdx} className="text-xs space-y-0.5">
                            <span className="text-neutral-400 font-mono text-[10px] mr-1.5">[{bIdx + 1}]</span>
                            <span className="text-neutral-200">{beat.text}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Open in Studio Action */}
                  <div className="mt-4 pt-3 border-t border-white/6">
                    <button
                      type="button"
                      disabled={isProcessing}
                      onClick={() => handleChooseClip(clip)}
                      className="w-full py-2.5 px-4 rounded-xl text-xs font-semibold bg-rose-600 hover:bg-rose-500 text-white transition flex items-center justify-center gap-1.5 shadow-sm disabled:opacity-50"
                    >
                      {isProcessing && isSelected ? (
                        <>
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          <span>Preparing Short in Studio...</span>
                        </>
                      ) : (
                        <>
                          <span>Open in Studio & Edit</span>
                          <ArrowRight className="w-3.5 h-3.5" />
                        </>
                      )}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};
