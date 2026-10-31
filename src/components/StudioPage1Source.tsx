import React, { useState } from 'react';
import {
  Wand2,
  Youtube,
  Sparkles,
  RefreshCw,
  Settings,
  ChevronDown,
  ChevronUp,
  Clock,
  ArrowRight,
  Flame,
  Film,
  Zap,
  AlertCircle,
  X,
} from 'lucide-react';
import { YouTubeVideoInfo, YouTubeClipCandidate } from '../types';

interface StudioPage1SourceProps {
  creationMode: 'youtube' | 'prompt';
  onChangeCreationMode: (mode: 'youtube' | 'prompt') => void;
  topic: string;
  onChangeTopic: (topic: string) => void;
  audience: string;
  onChangeAudience: (aud: string) => void;
  tone: string;
  onChangeTone: (tone: string) => void;
  isProcessing: boolean;
  processingStep: string;
  onGenerateFromPrompt: (customTopic?: string) => Promise<void>;
  onAnalyzeYouTubeUrl: (url: string, objective: string, transcript?: string) => Promise<void>;
  sampleVideos: Array<{ label: string; url: string; note: string }>;
  quickTopics: string[];
  errorMessage?: string | null;
  onClearError?: () => void;
}

export const StudioPage1Source: React.FC<StudioPage1SourceProps> = ({
  creationMode,
  onChangeCreationMode,
  topic,
  onChangeTopic,
  audience,
  onChangeAudience,
  tone,
  onChangeTone,
  isProcessing,
  processingStep,
  onGenerateFromPrompt,
  onAnalyzeYouTubeUrl,
  sampleVideos,
  quickTopics,
  errorMessage,
  onClearError,
}) => {
  const [youtubeUrl, setYoutubeUrl] = useState('');
  const [clipObjective, setClipObjective] = useState('Viral Hook & High Retention');
  const [transcript, setTranscript] = useState('');
  const [showTranscript, setShowTranscript] = useState(false);
  const [showAdvancedPrompt, setShowAdvancedPrompt] = useState(false);
  const [targetDuration, setTargetDuration] = useState<30 | 45 | 60>(30);

  const handlePromptSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!topic.trim() || isProcessing) return;
    onGenerateFromPrompt();
  };

  const handleYouTubeSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!youtubeUrl.trim() || isProcessing) return;
    onAnalyzeYouTubeUrl(youtubeUrl, clipObjective, transcript.trim() || undefined);
  };

  return (
    <div className="space-y-8 animate-in fade-in duration-200">
      {/* Page Title & Mission */}
      <div className="text-center max-w-2xl mx-auto space-y-2">
        <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-rose-500/10 border border-rose-500/20 text-rose-300 text-xs font-medium">
          <Sparkles className="w-3.5 h-3.5 text-rose-400" />
          <span>Step 1 of 3: Source & Idea Provider</span>
        </div>
        <h1 className="text-2xl sm:text-3xl font-bold text-white tracking-tight">
          Where should your Short begin?
        </h1>
        <p className="text-xs sm:text-sm text-neutral-400">
          Start from a simple topic idea or paste a YouTube video. Forge Studio will craft retention hooks, script beats, and clip strategies.
        </p>
      </div>

      {/* Mode Switcher Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 max-w-3xl mx-auto">
        {/* Option A: YouTube Link */}
        <button
          type="button"
          onClick={() => onChangeCreationMode('youtube')}
          className={`p-5 rounded-2xl border text-left transition-all relative overflow-hidden group ${
            creationMode === 'youtube'
              ? 'bg-[#151c28] border-rose-500 ring-2 ring-rose-500/20 shadow-lg'
              : 'bg-[#0f141c] border-white/8 hover:border-white/20'
          }`}
        >
          <div className="flex items-center justify-between">
            <div className="w-10 h-10 rounded-xl bg-red-600/15 border border-red-500/20 flex items-center justify-center text-red-500 group-hover:scale-105 transition-transform">
              <Youtube className="w-5 h-5 fill-current" />
            </div>
            {creationMode === 'youtube' && (
              <span className="px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider bg-rose-500/20 text-rose-300 border border-rose-500/30">
                Active Source
              </span>
            )}
          </div>
          <h2 className="text-sm font-semibold text-white mt-4 tracking-tight">
            YouTube Video to Clips
          </h2>
          <p className="text-xs text-neutral-400 mt-1 leading-relaxed">
            Extract viral moments from podcasts, keynotes, or long-form videos with original video & CC audio.
          </p>
        </button>

        {/* Option B: Idea Prompt */}
        <button
          type="button"
          onClick={() => onChangeCreationMode('prompt')}
          className={`p-5 rounded-2xl border text-left transition-all relative overflow-hidden group ${
            creationMode === 'prompt'
              ? 'bg-[#151c28] border-rose-500 ring-2 ring-rose-500/20 shadow-lg'
              : 'bg-[#0f141c] border-white/8 hover:border-white/20'
          }`}
        >
          <div className="flex items-center justify-between">
            <div className="w-10 h-10 rounded-xl bg-amber-500/15 border border-amber-500/20 flex items-center justify-center text-amber-400 group-hover:scale-105 transition-transform">
              <Wand2 className="w-5 h-5" />
            </div>
            {creationMode === 'prompt' && (
              <span className="px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider bg-rose-500/20 text-rose-300 border border-rose-500/30">
                Active Source
              </span>
            )}
          </div>
          <h2 className="text-sm font-semibold text-white mt-4 tracking-tight">
            Idea Prompt to Short
          </h2>
          <p className="text-xs text-neutral-400 mt-1 leading-relaxed">
            Generate a full high-retention script, AI voiceover, kinetic captions, and stock footage from scratch.
          </p>
        </button>
      </div>

      {/* Main Console Box */}
      <div className="max-w-3xl mx-auto bg-[#0f141c] border border-white/8 rounded-2xl p-6 sm:p-8 shadow-xl">
        {creationMode === 'youtube' ? (
          /* YouTube Link Provider Console */
          <form onSubmit={handleYouTubeSubmit} className="space-y-6">
            {errorMessage && (
              <div className="p-4 rounded-xl bg-red-950/40 border border-red-500/40 space-y-2.5 animate-in fade-in">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2 text-xs font-semibold text-red-300">
                    <AlertCircle className="w-4 h-4 text-red-400 shrink-0" />
                    <span>Unable to Process YouTube Link</span>
                  </div>
                  {onClearError && (
                    <button
                      type="button"
                      onClick={onClearError}
                      className="text-neutral-400 hover:text-white p-0.5 rounded transition"
                      title="Dismiss error"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
                <p className="text-xs text-neutral-300 leading-relaxed">
                  {errorMessage}
                </p>
                <div className="pt-1 text-[11px] text-neutral-400 space-y-1.5">
                  <span className="font-medium text-white block">Try one of these verified viral speech samples:</span>
                  <div className="flex flex-wrap gap-1.5 w-full">
                    {sampleVideos.map((sample) => (
                      <button
                        key={sample.url}
                        type="button"
                        onClick={() => {
                          setYoutubeUrl(sample.url);
                          onClearError?.();
                          onAnalyzeYouTubeUrl(sample.url, clipObjective);
                        }}
                        className="px-2.5 py-1 rounded-lg bg-red-900/30 hover:bg-red-800/40 border border-red-500/30 text-xs text-red-200 hover:text-white transition flex items-center gap-1.5"
                      >
                        <Youtube className="w-3 h-3 text-red-400 shrink-0" />
                        <span>{sample.label}</span>
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-xs font-semibold text-white flex items-center gap-1.5">
                  <Youtube className="w-4 h-4 text-red-500" />
                  <span>YouTube Video URL or Topic</span>
                </label>
                <span className="text-[11px] text-neutral-400">Podcasts, interviews, speeches</span>
              </div>
              <div className="flex flex-col sm:flex-row gap-2">
                <input
                  type="text"
                  value={youtubeUrl}
                  onChange={(e) => {
                    setYoutubeUrl(e.target.value);
                    if (errorMessage && onClearError) onClearError();
                  }}
                  placeholder="Paste YouTube link (e.g. https://www.youtube.com/watch?v=UF8uR6Z6UeI or youtu.be/...)"
                  className="flex-1 px-4 py-3 bg-[#090c10] border border-white/10 focus:border-rose-500 rounded-xl text-xs sm:text-sm text-white placeholder-neutral-500 focus:outline-none transition shadow-inner font-medium"
                />
                <button
                  type="submit"
                  disabled={isProcessing || !youtubeUrl.trim()}
                  className="px-5 py-3 bg-rose-600 hover:bg-rose-500 text-white font-semibold text-xs rounded-xl transition flex items-center justify-center gap-1.5 disabled:opacity-50 shadow-sm shrink-0"
                >
                  {isProcessing ? (
                    <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <>
                      <span>Analyze</span>
                      <ArrowRight className="w-3.5 h-3.5" />
                    </>
                  )}
                </button>
              </div>
            </div>

            {/* Quick Sample Clips */}
            <div className="space-y-2">
              <span className="text-[11px] text-neutral-400 font-medium block">
                Or try one of these viral speech samples:
              </span>
              <div className="flex flex-wrap gap-2">
                {sampleVideos.map((sample) => (
                  <button
                    key={sample.url}
                    type="button"
                    onClick={() => {
                      setYoutubeUrl(sample.url);
                      onAnalyzeYouTubeUrl(sample.url, clipObjective);
                    }}
                    className="px-3 py-1.5 rounded-xl bg-black/40 hover:bg-white/5 border border-white/6 text-xs text-neutral-300 hover:text-white transition flex items-center gap-2"
                  >
                    <Youtube className="w-3.5 h-3.5 text-red-500 shrink-0" />
                    <span className="font-medium">{sample.label}</span>
                    <span className="text-[10px] text-neutral-500 hidden sm:inline">({sample.note})</span>
                  </button>
                ))}
              </div>
            </div>

            {/* Strategy Objective Drawer */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2 border-t border-white/6">
              <div>
                <label className="text-xs font-semibold text-white block mb-1.5">
                  Target Hook & Strategy
                </label>
                <select
                  value={clipObjective}
                  onChange={(e) => setClipObjective(e.target.value)}
                  className="w-full bg-[#090c10] border border-white/10 rounded-xl px-3 py-2.5 text-xs text-neutral-200 focus:outline-none focus:border-rose-500"
                >
                  <option value="Viral Hook & High Retention">Viral Hook & High Retention (0-3s Grab)</option>
                  <option value="Contrarian Warning / Reality Check">Contrarian Warning / Reality Check</option>
                  <option value="Actionable Step-by-Step Blueprint">Actionable Step-by-Step Blueprint</option>
                  <option value="Inspirational & High Energy">Inspirational & High Energy Moment</option>
                </select>
              </div>

              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-xs font-semibold text-white">Manual CC Transcript</label>
                  <button
                    type="button"
                    onClick={() => setShowTranscript(!showTranscript)}
                    className="text-xs text-rose-400 hover:text-rose-300 transition"
                  >
                    {showTranscript ? 'Hide' : 'Add custom CC'}
                  </button>
                </div>
                <p className="text-[11px] text-neutral-400">
                  Forge Studio automatically pulls YouTube audio captions, but you can also paste custom text.
                </p>
              </div>
            </div>

            {showTranscript && (
              <textarea
                value={transcript}
                onChange={(e) => setTranscript(e.target.value)}
                rows={3}
                placeholder="Paste transcript or timed subtitles here..."
                className="w-full bg-[#090c10] border border-white/10 rounded-xl p-3 text-xs text-white placeholder-neutral-600 focus:outline-none focus:border-rose-500 font-mono resize-none"
              />
            )}

            {/* Big Action Button */}
            <button
              type="submit"
              disabled={isProcessing || !youtubeUrl.trim()}
              className="w-full py-3.5 bg-rose-600 hover:bg-rose-500 disabled:opacity-50 text-white font-semibold text-xs sm:text-sm rounded-xl transition flex items-center justify-center gap-2 shadow-lg shadow-rose-950/40"
            >
              {isProcessing ? (
                <>
                  <RefreshCw className="w-4 h-4 animate-spin" />
                  <span>{processingStep || 'Gemini analyzing viral moments...'}</span>
                </>
              ) : (
                <>
                  <Sparkles className="w-4 h-4" />
                  <span>Generate Clip Strategies & Proceed to Trimmer →</span>
                </>
              )}
            </button>
          </form>
        ) : (
          /* Idea Prompt Console */
          <form onSubmit={handlePromptSubmit} className="space-y-6">
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-xs font-semibold text-white flex items-center gap-1.5">
                  <Wand2 className="w-4 h-4 text-rose-400" />
                  <span>Topic, Thesis, or Video Angle</span>
                </label>
                <button
                  type="button"
                  onClick={() => setShowAdvancedPrompt(!showAdvancedPrompt)}
                  className="text-xs text-neutral-400 hover:text-white flex items-center gap-1 transition"
                >
                  <Settings className="w-3.5 h-3.5" />
                  <span>{showAdvancedPrompt ? 'Hide Tone' : 'Audience & Tone'}</span>
                  {showAdvancedPrompt ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                </button>
              </div>

              <div className="flex flex-col sm:flex-row gap-2">
                <input
                  type="text"
                  value={topic}
                  onChange={(e) => onChangeTopic(e.target.value)}
                  placeholder="e.g. 5 productivity habits that actually work"
                  className="flex-1 px-4 py-3 bg-[#090c10] border border-white/10 focus:border-rose-500 rounded-xl text-xs sm:text-sm text-white placeholder-neutral-500 focus:outline-none transition shadow-inner font-medium"
                />
                <button
                  type="submit"
                  disabled={isProcessing || !topic.trim()}
                  className="px-5 py-3 bg-rose-600 hover:bg-rose-500 text-white font-semibold text-xs rounded-xl transition flex items-center justify-center gap-1.5 disabled:opacity-50 shadow-sm shrink-0"
                >
                  {isProcessing ? (
                    <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <>
                      <span>Draft</span>
                      <ArrowRight className="w-3.5 h-3.5" />
                    </>
                  )}
                </button>
              </div>
            </div>

            {/* Quick Inspiration Chips */}
            <div className="space-y-2">
              <span className="text-[11px] text-neutral-400 font-medium block">
                Popular prompt frameworks:
              </span>
              <div className="flex flex-wrap gap-2">
                {quickTopics.map((t, idx) => (
                  <button
                    key={idx}
                    type="button"
                    onClick={() => {
                      onChangeTopic(t);
                      onGenerateFromPrompt(t);
                    }}
                    className="px-2.5 py-1 rounded-lg bg-black/40 hover:bg-white/5 border border-white/6 text-[11px] text-neutral-300 hover:text-white transition"
                  >
                    {t}
                  </button>
                ))}
              </div>
            </div>

            {/* Advanced Audience & Tone Drawer */}
            {showAdvancedPrompt && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 p-4 rounded-xl bg-black/40 border border-white/6">
                <div>
                  <label className="text-xs font-semibold text-white block mb-1">Target Audience</label>
                  <input
                    type="text"
                    value={audience}
                    onChange={(e) => onChangeAudience(e.target.value)}
                    placeholder="e.g. ambitious founders, young professionals"
                    className="w-full px-3 py-2 bg-[#090c10] border border-white/10 rounded-lg text-xs text-white placeholder-neutral-500 focus:outline-none focus:border-rose-500"
                  />
                </div>
                <div>
                  <label className="text-xs font-semibold text-white block mb-1">Tone & Pacing</label>
                  <input
                    type="text"
                    value={tone}
                    onChange={(e) => onChangeTone(e.target.value)}
                    placeholder="e.g. punchy, direct, Hormozi-style"
                    className="w-full px-3 py-2 bg-[#090c10] border border-white/10 rounded-lg text-xs text-white placeholder-neutral-500 focus:outline-none focus:border-rose-500"
                  />
                </div>
              </div>
            )}

            {/* Big Action Button */}
            <button
              type="submit"
              disabled={isProcessing || !topic.trim()}
              className="w-full py-3.5 bg-rose-600 hover:bg-rose-500 disabled:opacity-50 text-white font-semibold text-xs sm:text-sm rounded-xl transition flex items-center justify-center gap-2 shadow-lg shadow-rose-950/40"
            >
              {isProcessing ? (
                <>
                  <RefreshCw className="w-4 h-4 animate-spin" />
                  <span>{processingStep || 'Gemini crafting script beats...'}</span>
                </>
              ) : (
                <>
                  <Sparkles className="w-4 h-4" />
                  <span>Generate Script & Proceed to Clip Strategies →</span>
                </>
              )}
            </button>
          </form>
        )}

        {/* Live Processing Notice */}
        {isProcessing && (
          <div className="mt-4 p-3.5 rounded-xl bg-black/60 border border-rose-500/30 text-rose-300 text-xs flex items-center gap-2.5">
            <RefreshCw className="w-4 h-4 animate-spin text-rose-400 shrink-0" />
            <span className="font-medium">{processingStep || 'Processing your request...'}</span>
          </div>
        )}
      </div>
    </div>
  );
};
