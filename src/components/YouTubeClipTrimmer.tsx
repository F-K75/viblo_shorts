import React, { useState } from 'react';
import {
  Youtube,
  Clock,
  Play,
  RotateCcw,
  Volume2,
  VolumeX,
  ExternalLink,
  Scissors,
  Check,
  Sparkles,
  MoveHorizontal,
  Flame,
  Subtitles,
  Smartphone,
  Tv,
} from 'lucide-react';
import { ShortScript, Beat, WordTiming } from '../types';

interface YouTubeClipTrimmerProps {
  script: ShortScript;
  currentTimestamp: number;
  allWords: WordTiming[];
  onSeek: (seconds: number) => void;
  onUpdateClipRange: (startSeconds: number, endSeconds: number) => void;
  onUpdateBeatText: (beatId: string, newText: string) => void;
  visualMode: 'youtube-crop' | 'youtube-fit';
  onChangeVisualMode: (mode: 'youtube-crop' | 'youtube-fit') => void;
  youtubeVolume: number;
  onChangeVolume: (vol: number) => void;
  isMuted: boolean;
  onToggleMute: () => void;
}

function formatTimecode(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 10);
  return `${m < 10 ? '0' : ''}${m}:${s < 10 ? '0' : ''}${s}.${ms}`;
}

export const YouTubeClipTrimmer: React.FC<YouTubeClipTrimmerProps> = ({
  script,
  currentTimestamp,
  allWords,
  onSeek,
  onUpdateClipRange,
  onUpdateBeatText,
  visualMode,
  onChangeVisualMode,
  youtubeVolume,
  onChangeVolume,
  isMuted,
  onToggleMute,
}) => {
  const clipStart = script.clipStartSeconds ?? 0;
  const clipEnd = script.clipEndSeconds ?? (clipStart + 30);
  const duration = Math.max(0.5, clipEnd - clipStart);

  const [editingBeatId, setEditingBeatId] = useState<string | null>(null);

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
    <div className="space-y-5">
      {/* Clip Overview Card */}
      <section className="bg-[#0f141c] border border-white/8 rounded-2xl p-6 shadow-sm space-y-5">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between pb-4 border-b border-white/8 gap-4">
          <div>
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
              <h2 className="text-base font-semibold text-white tracking-tight">
                YouTube Clip Trimmer & Audio Sync
              </h2>
              <div className="flex items-center gap-1.5 text-xs text-neutral-400">
                <span aria-hidden="true">·</span>
                <span className="font-mono text-emerald-400 font-medium">100% Original YouTube Video & Audio</span>
              </div>
            </div>
            <p className="text-xs text-neutral-400 mt-1">
              Trim the exact segment of this YouTube video for your 9:16 Short. No external clips or synthetic voices added.
            </p>
          </div>

          {/* YouTube Video Link */}
          {script.sourceYouTubeId && (
            <a
              href={`https://www.youtube.com/watch?v=${script.sourceYouTubeId}`}
              target="_blank"
              rel="noreferrer"
              className="px-3 py-1.5 rounded-lg bg-black/40 hover:bg-black/60 border border-white/8 text-neutral-300 hover:text-white text-xs font-medium flex items-center gap-1.5 transition self-start sm:self-auto shrink-0"
            >
              <Youtube className="w-3.5 h-3.5 text-red-500" />
              <span>Watch on YouTube</span>
              <ExternalLink className="w-3 h-3 text-neutral-500" />
            </a>
          )}
        </div>

        {/* Source Video Banner */}
        <div className="p-3.5 rounded-xl bg-black/40 border border-white/6 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-9 h-9 rounded-lg bg-red-600/10 border border-red-500/20 flex items-center justify-center shrink-0">
              <Youtube className="w-5 h-5 text-red-500" />
            </div>
            <div className="min-w-0">
              <div className="text-[11px] text-neutral-400">
                Source Channel: <strong className="text-white font-medium">{script.sourceYouTubeAuthor || 'YouTube Creator'}</strong>
              </div>
              <div className="text-xs font-semibold text-white truncate mt-0.5">
                {script.sourceYouTubeTitle || script.title}
              </div>
            </div>
          </div>

          {script.viralScore && (
            <div className="hidden sm:flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-amber-500/10 border border-amber-500/20 text-amber-300 text-xs font-mono font-bold shrink-0">
              <Flame className="w-3.5 h-3.5 text-amber-400" />
              <span>Clip score {script.viralScore}/100</span>
            </div>
          )}
        </div>

        {/* Trimmer Controls */}
        <div className="p-4 rounded-xl bg-black/30 border border-white/6 space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Scissors className="w-4 h-4 text-rose-400" />
              <span className="text-xs font-semibold text-white">Clip Segment Window</span>
            </div>

            {/* Quick Duration Shortcuts */}
            <div className="flex items-center gap-1.5 text-xs">
              <span className="text-[11px] text-neutral-500">Quick Length:</span>
              {[15, 30, 45, 60].map((dur) => (
                <button
                  key={dur}
                  type="button"
                  onClick={() => handleSetPresetDuration(dur)}
                  className={`px-2 py-0.5 rounded text-[11px] font-mono transition border ${
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

          {/* Time Range Steppers */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {/* Start Time */}
            <div className="p-3 rounded-xl bg-[#090c10] border border-white/8 space-y-2">
              <div className="flex items-center justify-between text-xs text-neutral-400">
                <span>Start Time in Video</span>
                <span className="font-mono text-white font-bold">{formatTimecode(clipStart)}</span>
              </div>
              <div className="flex items-center justify-between gap-1 pt-1">
                <button
                  type="button"
                  onClick={() => handleNudgeStart(-1.0)}
                  className="px-2 py-1 rounded bg-black/50 hover:bg-white/10 text-xs font-mono text-neutral-300 hover:text-white border border-white/6 transition"
                >
                  -1.0s
                </button>
                <button
                  type="button"
                  onClick={() => handleNudgeStart(-0.2)}
                  className="px-2 py-1 rounded bg-black/50 hover:bg-white/10 text-xs font-mono text-neutral-300 hover:text-white border border-white/6 transition"
                >
                  -0.2s
                </button>
                <button
                  type="button"
                  onClick={() => handleNudgeStart(0.2)}
                  className="px-2 py-1 rounded bg-black/50 hover:bg-white/10 text-xs font-mono text-neutral-300 hover:text-white border border-white/6 transition"
                >
                  +0.2s
                </button>
                <button
                  type="button"
                  onClick={() => handleNudgeStart(1.0)}
                  className="px-2 py-1 rounded bg-black/50 hover:bg-white/10 text-xs font-mono text-neutral-300 hover:text-white border border-white/6 transition"
                >
                  +1.0s
                </button>
              </div>
            </div>

            {/* End Time */}
            <div className="p-3 rounded-xl bg-[#090c10] border border-white/8 space-y-2">
              <div className="flex items-center justify-between text-xs text-neutral-400">
                <span>End Time in Video</span>
                <span className="font-mono text-white font-bold">{formatTimecode(clipEnd)}</span>
              </div>
              <div className="flex items-center justify-between gap-1 pt-1">
                <button
                  type="button"
                  onClick={() => handleNudgeEnd(-1.0)}
                  className="px-2 py-1 rounded bg-black/50 hover:bg-white/10 text-xs font-mono text-neutral-300 hover:text-white border border-white/6 transition"
                >
                  -1.0s
                </button>
                <button
                  type="button"
                  onClick={() => handleNudgeEnd(-0.2)}
                  className="px-2 py-1 rounded bg-black/50 hover:bg-white/10 text-xs font-mono text-neutral-300 hover:text-white border border-white/6 transition"
                >
                  -0.2s
                </button>
                <button
                  type="button"
                  onClick={() => handleNudgeEnd(0.2)}
                  className="px-2 py-1 rounded bg-black/50 hover:bg-white/10 text-xs font-mono text-neutral-300 hover:text-white border border-white/6 transition"
                >
                  +0.2s
                </button>
                <button
                  type="button"
                  onClick={() => handleNudgeEnd(1.0)}
                  className="px-2 py-1 rounded bg-black/50 hover:bg-white/10 text-xs font-mono text-neutral-300 hover:text-white border border-white/6 transition"
                >
                  +1.0s
                </button>
              </div>
            </div>

            {/* Total Duration */}
            <div className="p-3 rounded-xl bg-[#090c10] border border-white/8 flex flex-col justify-between">
              <div className="text-xs text-neutral-400">Short Duration</div>
              <div className="text-xl font-mono font-bold text-white tabular-nums">
                {duration.toFixed(1)}s
              </div>
              <div className="text-[11px] text-neutral-500">
                Ideal YouTube Shorts length (25–45s)
              </div>
            </div>
          </div>

          {/* Visual Framing & Audio Settings */}
          <div className="pt-2 border-t border-white/6 grid grid-cols-1 sm:grid-cols-2 gap-4">
            {/* 9:16 Framing Toggle */}
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-white block">9:16 Video Framing Format</label>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => onChangeVisualMode('youtube-crop')}
                  className={`px-3 py-2 rounded-xl text-xs font-medium border flex items-center justify-center gap-1.5 transition ${
                    visualMode === 'youtube-crop'
                      ? 'bg-rose-500/10 border-rose-500/40 text-white font-semibold'
                      : 'bg-[#090c10] border-white/8 text-neutral-400 hover:text-white'
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
                      : 'bg-[#090c10] border-white/8 text-neutral-400 hover:text-white'
                  }`}
                >
                  <Tv className="w-3.5 h-3.5 text-rose-400" />
                  <span>Fit 16:9 (Letterbox)</span>
                </button>
              </div>
            </div>

            {/* Original YouTube Audio Mixer */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs">
                <span className="font-semibold text-white">Original YouTube Audio</span>
                <span className="font-mono text-neutral-400 tabular-nums">
                  {isMuted ? 'Muted' : `${Math.round(youtubeVolume * 100)}%`}
                </span>
              </div>
              <div className="flex items-center gap-2 p-1.5 bg-[#090c10] border border-white/8 rounded-xl">
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
        </div>
      </section>

      {/* Verbatim Audio CC Subtitles List */}
      <section className="bg-[#0f141c] border border-white/8 rounded-2xl p-6 shadow-sm space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between pb-3 border-b border-white/8 gap-2">
          <div>
            <div className="flex items-center gap-2">
              <Subtitles className="w-4 h-4 text-rose-400" />
              <h3 className="text-base font-semibold text-white tracking-tight">
                Verbatim YouTube Audio Subtitles ({script.beats.length})
              </h3>
            </div>
            <p className="text-xs text-neutral-400 mt-0.5">
              Spoken words extracted directly from the video audio. Displayed as animated kinetic captions in the Short.
            </p>
          </div>

          <div className="text-xs font-mono text-neutral-400 tabular-nums">
            Playhead: <strong className="text-white font-mono">{currentTimestamp.toFixed(1)}s</strong> / {duration.toFixed(1)}s
          </div>
        </div>

        {/* Subtitle segments */}
        <div className="space-y-2.5">
          {script.beats.map((beat, idx) => {
            const isActive = currentTimestamp >= beat.start_s && currentTimestamp < beat.end_s;
            const isEditing = editingBeatId === beat.id;
            const beatDuration = Math.max(0, beat.end_s - beat.start_s);

            return (
              <div
                key={beat.id || idx}
                className={`p-3.5 rounded-xl border transition-all ${
                  isActive
                    ? 'bg-[#141b27] border-rose-500 shadow-md ring-1 ring-rose-500/20'
                    : 'bg-[#090c10] border-white/8 hover:border-white/16'
                }`}
              >
                <div className="flex items-center justify-between pb-2 border-b border-white/6 text-xs gap-2">
                  <div className="flex items-center gap-2">
                    <span className="font-mono font-bold text-neutral-400">0{idx + 1}.</span>
                    <span className="font-mono text-neutral-400 tabular-nums">
                      {beat.start_s.toFixed(1)}s – {beat.end_s.toFixed(1)}s ({beatDuration.toFixed(1)}s)
                    </span>
                    {isActive && (
                      <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-rose-500/20 text-rose-300 border border-rose-500/30">
                        Speaking Now
                      </span>
                    )}
                  </div>

                  <button
                    type="button"
                    onClick={() => onSeek(beat.start_s)}
                    className="px-2.5 py-1 rounded bg-black/40 hover:bg-black/70 text-xs font-mono text-neutral-300 hover:text-white flex items-center gap-1 border border-white/6 transition"
                  >
                    <Play className="w-3 h-3 text-rose-400 fill-current" />
                    <span>Jump</span>
                  </button>
                </div>

                <div className="mt-2.5">
                  <textarea
                    rows={2}
                    value={beat.text}
                    onChange={(e) => onUpdateBeatText(beat.id, e.target.value)}
                    className="w-full bg-black/30 border border-white/8 focus:border-rose-500 rounded-lg p-2.5 text-xs sm:text-sm text-neutral-100 placeholder-neutral-500 resize-none focus:outline-none transition leading-relaxed"
                    placeholder="Spoken words in this audio segment..."
                  />
                </div>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
};
