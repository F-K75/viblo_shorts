import React, { useState } from 'react';
import { Copy, Check, Download, Youtube, Sparkles, RefreshCw, Layers, CheckCircle2 } from 'lucide-react';
import { ShortScript } from '../types';
import { apiFetch, apiErrorMessage } from '../utils/api';

interface YouTubeMetadataCardProps {
  script: ShortScript;
  topic?: string;
  onUpdateMetadata?: (updates: { title?: string; description?: string; hashtags?: string[] }) => void;
}

export const YouTubeMetadataCard: React.FC<YouTubeMetadataCardProps> = ({ script, topic, onUpdateMetadata }) => {
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [isOptimizing, setIsOptimizing] = useState(false);
  const [optimizeError, setOptimizeError] = useState<string | null>(null);
  const [titleOptions, setTitleOptions] = useState<string[]>([]);
  const [showTitlePicker, setShowTitlePicker] = useState(false);

  const copyToClipboard = (text: string, key: string) => {
    navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 2000);
  };

  const handleOptimizeWithGemini = async () => {
    setIsOptimizing(true);
    setOptimizeError(null);
    try {
      const res = await apiFetch('/api/gemini/optimize-metadata', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          topic: topic || script.title,
          beats: script.beats,
        }),
      });
      if (!res.ok) {
        throw new Error(await apiErrorMessage(res, 'Failed to optimize metadata with Gemini'));
      }
      const data = await res.json();
      if (data.titles && Array.isArray(data.titles) && data.titles.length > 0) {
        setTitleOptions(data.titles);
        setShowTitlePicker(true);
      }
      if (onUpdateMetadata) {
        onUpdateMetadata({
          title: data.titles?.[0] || script.title,
          description: data.description || script.description,
          hashtags: data.hashtags || script.hashtags,
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to optimize metadata with Gemini';
      console.error('Failed to optimize metadata with Gemini:', err);
      setOptimizeError(msg);
    } finally {
      setIsOptimizing(false);
    }
  };

  const downloadJson = () => {
    const data = {
      title: script.title,
      description: script.description,
      hashtags: script.hashtags,
      viralScore: script.viralScore,
      beats: script.beats.map((b) => ({
        text: b.text,
        visual_keywords: b.visual_keywords,
        start_s: b.start_s,
        end_s: b.end_s,
      })),
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `forge_metadata_${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const allHashtags = script.hashtags.join(' ');
  const fullYouTubeUploadText = `${script.title}\n\n${script.description}\n\n${allHashtags}`;

  return (
    <section className="bg-[#0f141c] border border-white/8 rounded-2xl p-6 shadow-sm space-y-5">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between pb-4 border-b border-white/8 gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-base font-semibold text-white tracking-tight">YouTube Studio Publishing Pack</h2>
            <div className="flex items-center gap-1.5 text-xs text-neutral-400">
              <span aria-hidden="true">·</span>
              <span>CTR Optimized</span>
              {script.viralScore && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="font-mono tabular-nums text-amber-400 font-medium">Clip score {script.viralScore}/100</span>
                </>
              )}
            </div>
          </div>
          <p className="text-xs text-neutral-400 mt-0.5">
            {script.sourceYouTubeTitle
              ? `Extracted from "${script.sourceYouTubeTitle}"`
              : 'Algorithmic titles, description, and hashtags designed for high click-through rates'}
          </p>
        </div>

        {/* Pro Action Buttons */}
        <div className="flex items-center gap-2">
          <button
            onClick={handleOptimizeWithGemini}
            disabled={isOptimizing}
            className="px-3 py-1.5 rounded-lg bg-rose-600/10 hover:bg-rose-600/20 text-rose-300 border border-rose-500/25 text-xs font-medium flex items-center gap-1.5 transition disabled:opacity-50"
          >
            {isOptimizing ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
            <span>Gemini Optimize</span>
          </button>

          <button
            onClick={downloadJson}
            className="px-3 py-1.5 rounded-lg bg-black/40 hover:bg-black/60 border border-white/8 text-neutral-300 hover:text-white text-xs font-medium flex items-center gap-1.5 transition"
            title="Download JSON Project Metadata"
          >
            <Download className="w-3.5 h-3.5" />
            <span>Export JSON</span>
          </button>

          <button
            onClick={() => copyToClipboard(fullYouTubeUploadText, 'full')}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition ${
              copiedKey === 'full'
                ? 'bg-emerald-600 text-white'
                : 'bg-white text-neutral-900 hover:bg-neutral-100 shadow-sm'
            }`}
          >
            {copiedKey === 'full' ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
            <span>{copiedKey === 'full' ? 'Copied All!' : 'Copy All'}</span>
          </button>
        </div>
      </div>

      {optimizeError && (
        <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/25 text-xs text-rose-300">
          {optimizeError}
        </div>
      )}

      {/* Grid: Left (Metadata Fields) & Right (Mobile Simulation Card) */}
      <div className="grid grid-cols-1 xl:grid-cols-[1fr_280px] gap-6">
        {/* Left Column: Form Fields */}
        <div className="space-y-4">
          {/* Title Field with Alternative Picker */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-xs font-semibold text-white">YouTube Short Title</label>
              <div className="flex items-center gap-2">
                <span className="text-[11px] text-neutral-400 font-mono tabular-nums">
                  {script.title.length}/100 chars
                </span>
                <button
                  onClick={() => copyToClipboard(script.title, 'title')}
                  className="text-xs text-neutral-400 hover:text-white flex items-center gap-1 transition"
                >
                  {copiedKey === 'title' ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                  <span>{copiedKey === 'title' ? 'Copied' : 'Copy'}</span>
                </button>
              </div>
            </div>

            <input
              type="text"
              value={script.title}
              onChange={(e) => onUpdateMetadata && onUpdateMetadata({ title: e.target.value })}
              className="w-full bg-[#090c10] border border-white/10 focus:border-rose-500 rounded-xl px-3.5 py-2.5 text-xs sm:text-sm text-white focus:outline-none transition shadow-inner font-medium"
            />

            {/* Title Options generated by Gemini */}
            {showTitlePicker && titleOptions.length > 0 && (
              <div className="mt-2.5 p-3 rounded-xl bg-black/40 border border-white/6 space-y-2">
                <span className="text-[11px] text-neutral-400 block font-medium">Alternative High-CTR Variants:</span>
                <div className="space-y-1.5">
                  {titleOptions.map((t, idx) => (
                    <div
                      key={idx}
                      onClick={() => onUpdateMetadata && onUpdateMetadata({ title: t })}
                      className="p-2 rounded-lg bg-black/30 hover:bg-white/5 border border-white/4 text-xs text-neutral-200 hover:text-white flex items-center justify-between cursor-pointer transition"
                    >
                      <span className="truncate pr-2">{t}</span>
                      {script.title === t ? (
                        <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                      ) : (
                        <span className="text-[10px] text-neutral-500 hover:text-neutral-300 shrink-0">Use</span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Description Field */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-xs font-semibold text-white">Video Description</label>
              <button
                onClick={() => copyToClipboard(script.description, 'desc')}
                className="text-xs text-neutral-400 hover:text-white flex items-center gap-1 transition"
              >
                {copiedKey === 'desc' ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                <span>{copiedKey === 'desc' ? 'Copied' : 'Copy'}</span>
              </button>
            </div>
            <textarea
              rows={3}
              value={script.description}
              onChange={(e) => onUpdateMetadata && onUpdateMetadata({ description: e.target.value })}
              className="w-full bg-[#090c10] border border-white/10 focus:border-rose-500 rounded-xl p-3 text-xs sm:text-sm text-white focus:outline-none transition resize-none shadow-inner leading-relaxed"
            />
          </div>

          {/* Hashtags Field */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-xs font-semibold text-white">Viral Hashtags</label>
              <button
                onClick={() => copyToClipboard(allHashtags, 'tags')}
                className="text-xs text-neutral-400 hover:text-white flex items-center gap-1 transition"
              >
                {copiedKey === 'tags' ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                <span>{copiedKey === 'tags' ? 'Copied' : 'Copy'}</span>
              </button>
            </div>
            <div className="flex flex-wrap gap-1.5 p-2.5 rounded-xl bg-[#090c10] border border-white/10 min-h-[44px]">
              {script.hashtags.map((tag, idx) => (
                <span
                  key={idx}
                  className="px-2 py-0.5 rounded bg-black/40 text-neutral-300 font-mono text-xs border border-white/6"
                >
                  {tag}
                </span>
              ))}
            </div>
          </div>
        </div>

        {/* Right Column: YouTube Mobile Feed Preview Simulation */}
        <div className="p-4 rounded-xl bg-black/50 border border-white/6 flex flex-col justify-between space-y-3">
          <div>
            <div className="flex items-center gap-2 mb-3">
              <Youtube className="w-4 h-4 text-red-500" />
              <span className="text-xs font-semibold text-white">YouTube Shorts Feed Preview</span>
            </div>

            <div className="space-y-2">
              <p className="text-xs font-semibold text-white line-clamp-2 leading-snug">
                {script.title}
              </p>
              <p className="text-[11px] text-neutral-400 line-clamp-3 leading-relaxed">
                {script.description}
              </p>
              <div className="text-[11px] text-blue-400 font-mono line-clamp-1">
                {allHashtags}
              </div>
            </div>
          </div>

          <div className="pt-3 border-t border-white/6 flex items-center justify-between text-[11px] text-neutral-500">
            <span>Verified YouTube Format</span>
            <span className="font-mono tabular-nums">9:16 Feed</span>
          </div>
        </div>
      </div>
    </section>
  );
};
