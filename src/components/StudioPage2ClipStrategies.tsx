import React, { useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Flame,
  Scissors,
  Sparkles,
  Youtube,
  Tv,
  Smartphone,
  Volume2,
  VolumeX,
  Play,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock,
  Layers,
  FileVideo,
  ListOrdered,
} from 'lucide-react';
import { ShortScript, Beat, WordTiming, YouTubeClipCandidate, YouTubeVideoInfo, VisualSourceMode } from '../types';

interface StudioPage2ClipStrategiesProps {
  script: ShortScript;
  candidates: YouTubeClipCandidate[];
  videoInfo: YouTubeVideoInfo | null;
  currentTimestamp: number;
  allWords: WordTiming[];
  visualMode: VisualSourceMode;
  onChangeVisualMode: (mode: VisualSourceMode) => void;
  youtubeVolume: number;
  onChangeVolume: (vol: number) => void;
  isMuted: boolean;
  onToggleMute: () => void;
  onSeek: (seconds: number) => void;
  onUpdateClipRange: (startSeconds: number, endSeconds: number) => void;
  onUpdateBeatText: (beatId: string, newText: string) => void;
  onSelectCandidate: (candidate: YouTubeClipCandidate) => void;
  onBackToSource: () => void;
  onProceedToCanvas: () => void;
}

function formatTimecode(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 10);
  return `${m < 10 ? '0' : ''}${m}:${s < 10 ? '0' : ''}${s}.${ms}`;
}

export const StudioPage2ClipStrategies: React.FC<StudioPage2ClipStrategiesProps> = ({
  script,
  candidates,
  videoInfo,
  currentTimestamp,
  allWords,
  visualMode,
  onChangeVisualMode,
  youtubeVolume,
  onChangeVolume,
  isMuted,
  onToggleMute,
  onSeek,
  onUpdateClipRange,
  onUpdateBeatText,
  onSelectCandidate,
  onBackToSource,
  onProceedToCanvas,
}) => {
  const clipStart = script.clipStartSeconds ?? 0;
  const clipEnd = script.clipEndSeconds ?? (clipStart + 30);
  const duration = Math.max(0.5, clipEnd - clipStart);

  const [expandedBeatId, setExpandedBeatId] = useState<string | null>(null);

  const handleNudgeStart = (delta: number) => {
    const nextStart = Math.max(0, parseFloat((clipStart + delta).toFixed(1)));
    if (nextStart < clipEnd - 2) {
      onUpdateClipRange(nextStart, clipEnd);
    }
  };

  const handleNudgeEnd = (delta: number) => {
    const nextEnd = Math.max(clipStart + 2, parseFloat((clipEnd + delta).toFixed(1)));
    onUpdateClipRange(clipStart, nextEnd);
  };

  const handleSetPresetDuration = (targetDuration: number) => {
    const nextEnd = parseFloat((clipStart + targetDuration).toFixed(1));
    onUpdateClipRange(clipStart, nextEnd);
  };

  return (
    <div className="space-y-8 animate-in fade-in duration-200">
      {/* Top Breadcrumb & Navigation Bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-white/8">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onBackToSource}
            className="px-3 py-1.5 rounded-xl bg-white/5 hover:bg-white/10 text-xs font-medium text-neutral-300 hover:text-white transition flex items-center gap-1.5 border border-white/8"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            <span>Back to Source</span>
          </button>

          <div>
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold text-rose-400 font-mono uppercase tracking-wider">
                Step 2 of 3
              </span>
              <span className="text-neutral-500" aria-hidden="true">·</span>
              <h1 className="text-base font-semibold text-white tracking-tight">
                Clip Strategies & Clip Trimmer
              </h1>
            </div>
          </div>
        </div>

        <button
          type="button"
          onClick={onProceedToCanvas}
          className="px-5 py-2.5 bg-rose-600 hover:bg-rose-500 text-white font-semibold text-xs sm:text-sm rounded-xl transition flex items-center justify-center gap-2 shadow-lg shadow-rose-950/40"
        >
          <span>Continue to Studio Canvas & Timeline</span>
          <ArrowRight className="w-4 h-4" />
        </button>
      </div>

      {/* SECTION 1: Clip Strategies & AI Viral Candidates */}
      <section className="bg-[#0f141c] border border-white/8 rounded-2xl p-6 shadow-sm space-y-5">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-3 border-b border-white/8">
          <div>
            <div className="flex items-center gap-2">
              <Flame className="w-4 h-4 text-amber-400" />
              <h2 className="text-base font-semibold text-white tracking-tight">
                AI Clip Strategies & Viral Candidates
              </h2>
            </div>
            <p className="text-xs text-neutral-400 mt-0.5">
              Ranked by retention probability and 3-second hook strength. Click any candidate to load its segment into the trimmer.
            </p>
          </div>

          <div className="text-xs font-mono text-neutral-400">
            {candidates.length > 0 ? `${candidates.length} Strategies Identified` : 'Default Viral Strategy'}
          </div>
        </div>

        {/* Candidates Cards */}
        {candidates.length > 0 ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {candidates.map((cand, idx) => {
              const isCurrent =
                cand.clipTitle === script.title ||
                (cand.startSeconds === script.clipStartSeconds && cand.endSeconds === script.clipEndSeconds);
              const candDuration = Math.max(0, (cand.endSeconds || 0) - (cand.startSeconds || 0));

              return (
                <div
                  key={cand.id || idx}
                  onClick={() => onSelectCandidate(cand)}
                  className={`p-4 rounded-xl border cursor-pointer transition-all flex flex-col justify-between text-left ${
                    isCurrent
                      ? 'bg-[#151d2c] border-rose-500 ring-2 ring-rose-500/20 shadow-md'
                      : 'bg-black/30 border-white/8 hover:border-white/20'
                  }`}
                >
                  <div className="space-y-3">
                    <div className="flex items-center justify-between text-xs">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-neutral-400 font-bold">0{idx + 1}.</span>
                        <span className="font-semibold text-white">{cand.clipTitle}</span>
                      </div>
                      <div className="flex items-center gap-1.5 px-2 py-0.5 rounded bg-amber-500/10 border border-amber-500/20 text-amber-300 font-mono text-[11px] font-bold">
                        <Flame className="w-3 h-3 text-amber-400" />
                        <span>{typeof cand.viralScore === "number" && cand.viralScore > 0 ? `${cand.viralScore}/100` : "Unscored"}</span>
                      </div>
                    </div>

                    {/* Hook Box */}
                    <div className="p-2.5 rounded-lg bg-black/50 border border-white/6 space-y-1">
                      <span className="text-[9px] font-mono tracking-wider text-rose-400 uppercase">
                        Opening Hook (0–3s)
                      </span>
                      <p className="text-xs text-neutral-200 italic line-clamp-2">
                        &ldquo;{cand.hook}&rdquo;
                      </p>
                    </div>

                    <p className="text-[11px] text-neutral-400 line-clamp-2 leading-relaxed">
                      {cand.reasoning}
                    </p>
                  </div>

                  <div className="mt-4 pt-3 border-t border-white/6 flex items-center justify-between text-xs">
                    <span className="font-mono text-neutral-400 text-[11px]">
                      {cand.approxStartTimestamp || '00:00'} ({candDuration}s)
                    </span>

                    {isCurrent ? (
                      <span className="text-emerald-400 text-xs font-semibold flex items-center gap-1">
                        <CheckCircle2 className="w-3.5 h-3.5" />
                        <span>Selected</span>
                      </span>
                    ) : (
                      <span className="text-neutral-400 group-hover:text-white text-xs">
                        Select Strategy →
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          /* Active Single Strategy Overview */
          <div className="p-4 rounded-xl bg-black/30 border border-white/6 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold text-white">Active Hook Strategy</span>
                <span className="text-[10px] font-mono text-emerald-400 bg-emerald-950/60 border border-emerald-500/30 px-1.5 py-0.5 rounded">
                  97/100 Virality
                </span>
              </div>
              <span className="font-mono text-xs text-neutral-400">{duration.toFixed(1)}s Target Duration</span>
            </div>

            <p className="text-xs text-neutral-200 italic bg-black/50 p-3 rounded-lg border border-white/6">
              &ldquo;{script.hook || script.beats[0]?.text}&rdquo;
            </p>

            <p className="text-[11px] text-neutral-400">
              {script.clipReasoning || 'High-retention philosophical reflection on purpose and truth.'}
            </p>
          </div>
        )}
      </section>

      {/* SECTION 2: Clip Trimmer & Audio CC Sync */}
      <section className="bg-[#0f141c] border border-white/8 rounded-2xl p-6 shadow-sm space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-3 border-b border-white/8">
          <div>
            <div className="flex items-center gap-2">
              <Scissors className="w-4 h-4 text-rose-400" />
              <h2 className="text-base font-semibold text-white tracking-tight">
                Clip Trimmer & Range Adjuster
              </h2>
            </div>
            <p className="text-xs text-neutral-400 mt-0.5">
              Fine-tune the exact start and end in-points. Audio and kinetic CC captions will adjust dynamically.
            </p>
          </div>

          <div className="flex items-center gap-2">
            <span className="text-xs text-neutral-400">Length:</span>
            {[15, 30, 45, 60].map((dur) => (
              <button
                key={dur}
                type="button"
                onClick={() => handleSetPresetDuration(dur)}
                className={`px-2.5 py-1 rounded-lg text-xs font-mono transition border ${
                  Math.round(duration) === dur
                    ? 'bg-rose-600 border-rose-500 text-white font-bold'
                    : 'bg-black/30 border-white/8 text-neutral-400 hover:text-white'
                }`}
              >
                {dur}s
              </button>
            ))}
          </div>
        </div>

        {/* Stepper Controllers */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {/* Start Point */}
          <div className="p-4 rounded-xl bg-[#090c10] border border-white/8 space-y-3">
            <div className="flex items-center justify-between text-xs text-neutral-400">
              <span>Start Timecode</span>
              <span className="font-mono text-white font-bold text-sm">{formatTimecode(clipStart)}</span>
            </div>
            <div className="grid grid-cols-4 gap-1.5 pt-1">
              <button
                type="button"
                onClick={() => handleNudgeStart(-1.0)}
                className="py-1.5 rounded bg-black/50 hover:bg-white/10 text-xs font-mono text-neutral-300 hover:text-white border border-white/6 transition text-center"
              >
                -1.0s
              </button>
              <button
                type="button"
                onClick={() => handleNudgeStart(-0.2)}
                className="py-1.5 rounded bg-black/50 hover:bg-white/10 text-xs font-mono text-neutral-300 hover:text-white border border-white/6 transition text-center"
              >
                -0.2s
              </button>
              <button
                type="button"
                onClick={() => handleNudgeStart(0.2)}
                className="py-1.5 rounded bg-black/50 hover:bg-white/10 text-xs font-mono text-neutral-300 hover:text-white border border-white/6 transition text-center"
              >
                +0.2s
              </button>
              <button
                type="button"
                onClick={() => handleNudgeStart(1.0)}
                className="py-1.5 rounded bg-black/50 hover:bg-white/10 text-xs font-mono text-neutral-300 hover:text-white border border-white/6 transition text-center"
              >
                +1.0s
              </button>
            </div>
          </div>

          {/* End Point */}
          <div className="p-4 rounded-xl bg-[#090c10] border border-white/8 space-y-3">
            <div className="flex items-center justify-between text-xs text-neutral-400">
              <span>End Timecode</span>
              <span className="font-mono text-white font-bold text-sm">{formatTimecode(clipEnd)}</span>
            </div>
            <div className="grid grid-cols-4 gap-1.5 pt-1">
              <button
                type="button"
                onClick={() => handleNudgeEnd(-1.0)}
                className="py-1.5 rounded bg-black/50 hover:bg-white/10 text-xs font-mono text-neutral-300 hover:text-white border border-white/6 transition text-center"
              >
                -1.0s
              </button>
              <button
                type="button"
                onClick={() => handleNudgeEnd(-0.2)}
                className="py-1.5 rounded bg-black/50 hover:bg-white/10 text-xs font-mono text-neutral-300 hover:text-white border border-white/6 transition text-center"
              >
                -0.2s
              </button>
              <button
                type="button"
                onClick={() => handleNudgeEnd(0.2)}
                className="py-1.5 rounded bg-black/50 hover:bg-white/10 text-xs font-mono text-neutral-300 hover:text-white border border-white/6 transition text-center"
              >
                +0.2s
              </button>
              <button
                type="button"
                onClick={() => handleNudgeEnd(1.0)}
                className="py-1.5 rounded bg-black/50 hover:bg-white/10 text-xs font-mono text-neutral-300 hover:text-white border border-white/6 transition text-center"
              >
                +1.0s
              </button>
            </div>
          </div>

          {/* Duration Status */}
          <div className="p-4 rounded-xl bg-[#090c10] border border-white/8 flex flex-col justify-between">
            <div className="flex items-center justify-between text-xs text-neutral-400">
              <span>Short Duration</span>
              <span className="text-emerald-400 font-mono text-[11px] font-semibold">9:16 Ready</span>
            </div>
            <div className="text-2xl font-mono font-bold text-white tabular-nums">
              {duration.toFixed(1)}s
            </div>
            <div className="text-[11px] text-neutral-500">
              Ideal YouTube Shorts range: 20s–50s
            </div>
          </div>
        </div>

        {/* Framing & Audio Controls */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2 border-t border-white/6 items-stretch">
          {/* Framing Mode */}
          <div className="flex flex-col justify-between p-3.5 rounded-xl bg-[#090c10] border border-white/8 space-y-2">
            <label className="text-xs font-semibold text-white block">9:16 Video Framing Format</label>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => onChangeVisualMode('youtube-crop')}
                className={`px-3 py-2 rounded-xl text-xs font-medium border flex items-center justify-center gap-1.5 transition ${
                  visualMode === 'youtube-crop'
                    ? 'bg-rose-500/10 border-rose-500/40 text-white font-semibold'
                    : 'bg-black/30 border-white/8 text-neutral-400 hover:text-white'
                }`}
              >
                <Smartphone className="w-3.5 h-3.5 text-rose-400" />
                <span>Vertical Crop (Fill)</span>
              </button>

              <button
                type="button"
                onClick={() => onChangeVisualMode('youtube-fit')}
                className={`px-3 py-2 rounded-xl text-xs font-medium border flex items-center justify-center gap-1.5 transition ${
                  visualMode === 'youtube-fit'
                    ? 'bg-rose-500/10 border-rose-500/40 text-white font-semibold'
                    : 'bg-black/30 border-white/8 text-neutral-400 hover:text-white'
                }`}
              >
                <Tv className="w-3.5 h-3.5 text-rose-400" />
                <span>Fit 16:9 (Letterbox)</span>
              </button>
            </div>
          </div>

          {/* Audio Volume Mixer */}
          <div className="flex flex-col justify-between p-3.5 rounded-xl bg-[#090c10] border border-white/8 space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="font-semibold text-white">Audio Track Volume</span>
              <span className="font-mono text-neutral-400 tabular-nums">
                {isMuted ? 'Muted' : `${Math.round(youtubeVolume * 100)}%`}
              </span>
            </div>
            <div className="flex items-center gap-2 p-1.5 bg-black/40 border border-white/6 rounded-xl h-[38px]">
              <button
                type="button"
                onClick={onToggleMute}
                className="p-1 rounded-lg text-neutral-400 hover:text-white transition"
                title={isMuted ? 'Unmute' : 'Mute'}
              >
                {isMuted ? <VolumeX className="w-4 h-4 text-red-400" /> : <Volume2 className="w-4 h-4 text-emerald-400" />}
              </button>
              <input
                type="range"
                min="0"
                max="1"
                step="0.05"
                value={isMuted ? 0 : youtubeVolume}
                onChange={(e) => onChangeVolume(parseFloat(e.target.value))}
                className="flex-1 h-1.5 bg-neutral-800 rounded appearance-none cursor-pointer accent-rose-500"
              />
            </div>
          </div>
        </div>

        {/* Verbatim CC Subtitles & Script Beat Inspector */}
        <div className="space-y-3 pt-2 border-t border-white/6">
          <div className="flex items-center justify-between text-xs">
            <div className="flex items-center gap-1.5 font-semibold text-white">
              <ListOrdered className="w-4 h-4 text-rose-400" />
              <span>Verbatim Audio CC Segments ({script.beats.length} beats)</span>
            </div>
            <span className="text-neutral-400 text-[11px]">Synced to video range</span>
          </div>

          <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
            {script.beats.map((beat, bIdx) => (
              <div
                key={beat.id || bIdx}
                className="p-3 rounded-xl bg-black/40 border border-white/6 hover:border-white/16 transition flex flex-col sm:flex-row sm:items-center justify-between gap-2"
              >
                <div className="flex items-start gap-2.5 min-w-0 flex-1">
                  <span className="text-[10px] font-mono text-rose-400 font-bold mt-0.5">
                    0{bIdx + 1}.
                  </span>
                  <div className="min-w-0 flex-1">
                    <input
                      type="text"
                      value={beat.text}
                      onChange={(e) => onUpdateBeatText(beat.id, e.target.value)}
                      className="w-full bg-transparent border-0 text-xs text-neutral-200 focus:text-white focus:outline-none focus:ring-1 focus:ring-rose-500 rounded px-1 -ml-1 font-medium"
                    />
                    <span className="text-[10px] font-mono text-neutral-500 block">
                      {beat.start_s.toFixed(1)}s – {beat.end_s.toFixed(1)}s
                    </span>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => onSeek(beat.start_s)}
                  className="px-2.5 py-1 rounded bg-black/50 hover:bg-white/10 text-neutral-300 hover:text-white text-xs font-mono flex items-center gap-1 self-start sm:self-auto border border-white/6 shrink-0"
                >
                  <Play className="w-3 h-3 text-rose-400 fill-current" />
                  <span>{beat.start_s.toFixed(1)}s</span>
                </button>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Bottom Action Footer */}
      <div className="flex flex-col sm:flex-row items-center justify-between gap-4 p-4 rounded-2xl bg-[#0f141c] border border-white/8">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center text-emerald-400">
            <CheckCircle2 className="w-4 h-4" />
          </div>
          <div>
            <div className="text-xs font-semibold text-white">Clip Trimmed & Synchronized</div>
            <div className="text-[11px] text-neutral-400">
              Ready for Canvas layout, kinetic typography, timeline editing, and Google Drive export.
            </div>
          </div>
        </div>

        <button
          type="button"
          onClick={onProceedToCanvas}
          className="w-full sm:w-auto px-6 py-3 bg-rose-600 hover:bg-rose-500 text-white font-semibold text-xs sm:text-sm rounded-xl transition flex items-center justify-center gap-2 shadow-lg shadow-rose-950/40"
        >
          <span>Continue to Studio Canvas & Timeline</span>
          <ArrowRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
};
