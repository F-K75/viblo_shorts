import React, { useState, useEffect } from 'react';
import { useEscapeKey } from '../utils/useEscapeKey';
import {
  Share2,
  X,
  Youtube,
  Copy,
  Check,
  Download,
  FileText,
  Sparkles,
  Smartphone,
  ExternalLink,
  Layers,
  CheckCircle2,
} from 'lucide-react';
import { ShortScript, PublishingPlatform, PlatformPublishingPack } from '../types';
import { apiFetch } from '../utils/api';

interface PublishingPackModalProps {
  isOpen: boolean;
  onClose: () => void;
  script: ShortScript;
  topic: string;
}

export const PublishingPackModal: React.FC<PublishingPackModalProps> = ({
  isOpen,
  onClose,
  script,
  topic,
}) => {
  const [platform, setPlatform] = useState<PublishingPlatform>('youtube');
  const [pack, setPack] = useState<PlatformPublishingPack | null>(null);
  const [loading, setLoading] = useState(false);
  const [copiedField, setCopiedField] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      fetchPublishingPack(platform);
    }
  }, [isOpen, platform]);

  const fetchPublishingPack = async (targetPlatform: PublishingPlatform) => {
    setLoading(true);
    try {
      const res = await apiFetch('/api/publish/generate-pack', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: script.title,
          topic,
          beats: script.beats,
          platform: targetPlatform,
        }),
      });

      if (res.ok) {
        const data = await res.json();
        setPack(data.pack);
      }
    } catch (err) {
      console.error('Failed to load publishing pack:', err);
    } finally {
      setLoading(false);
    }
  };

  const copyToClipboard = (text: string, field: string) => {
    navigator.clipboard.writeText(text);
    setCopiedField(field);
    setTimeout(() => setCopiedField(null), 2500);
  };

  const downloadFile = (content: string, filename: string, mime: string) => {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  useEscapeKey(isOpen, onClose);

  if (!isOpen) return null;

  const sanitizedBase = script.title.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 30) || 'short';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md animate-in fade-in duration-200">
      <div className="relative w-full max-w-3xl bg-[#0d121c] border border-white/12 rounded-3xl p-6 sm:p-8 shadow-2xl overflow-hidden max-h-[90vh] flex flex-col">
        {/* Glow ambient background */}
        <div className="absolute top-0 right-1/4 w-80 h-80 bg-rose-600/10 blur-[120px] pointer-events-none rounded-full" />

        {/* Modal Header */}
        <div className="flex items-center justify-between pb-5 border-b border-white/8 relative z-10 shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-rose-500/10 border border-rose-500/20 flex items-center justify-center text-rose-400">
              <Share2 className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-xl font-bold text-white tracking-tight">Social Publishing Package</h2>
              <p className="text-xs text-neutral-400">Tailored metadata, viral tags, and subtitle tracks for every platform</p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="p-2 rounded-xl text-neutral-400 hover:text-white hover:bg-white/8 transition"
            title="Close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Platform Selector Segmented Control */}
        <div className="my-5 p-1 bg-[#141a26] border border-white/8 rounded-2xl grid grid-cols-3 gap-1 relative z-10 shrink-0 text-xs font-semibold">
          <button
            type="button"
            onClick={() => setPlatform('youtube')}
            className={`py-2.5 rounded-xl transition flex items-center justify-center gap-2 ${
              platform === 'youtube'
                ? 'bg-rose-600 text-white shadow-md'
                : 'text-neutral-400 hover:text-white'
            }`}
          >
            <Youtube className="w-4 h-4 fill-current" />
            <span>YouTube Shorts</span>
          </button>

          <button
            type="button"
            onClick={() => setPlatform('tiktok')}
            className={`py-2.5 rounded-xl transition flex items-center justify-center gap-2 ${
              platform === 'tiktok'
                ? 'bg-[#1e2738] text-cyan-300 shadow-md border border-cyan-500/30'
                : 'text-neutral-400 hover:text-white'
            }`}
          >
            <Smartphone className="w-4 h-4" />
            <span>TikTok</span>
          </button>

          <button
            type="button"
            onClick={() => setPlatform('instagram')}
            className={`py-2.5 rounded-xl transition flex items-center justify-center gap-2 ${
              platform === 'instagram'
                ? 'bg-gradient-to-r from-purple-600 to-pink-600 text-white shadow-md'
                : 'text-neutral-400 hover:text-white'
            }`}
          >
            <Sparkles className="w-4 h-4" />
            <span>Instagram Reels</span>
          </button>
        </div>

        {/* Content Body */}
        <div className="overflow-y-auto space-y-4 relative z-10 flex-1 pr-1">
          {/* Platform Recommendation Banner */}
          <div className="p-3.5 rounded-xl bg-white/4 border border-white/8 flex items-center justify-between text-xs text-neutral-300">
            <div>
              <span className="font-semibold text-white">Recommended Aspect & Length: </span>
              <span className="text-neutral-400">{pack?.aspectRatio} · {pack?.recommendedDuration}</span>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => pack?.srtContent && downloadFile(pack.srtContent, `${sanitizedBase}.srt`, 'text/plain')}
                className="px-2.5 py-1.5 rounded-lg bg-white/8 hover:bg-white/12 text-white text-[11px] font-medium flex items-center gap-1.5 transition"
                title="Download SRT subtitle track"
              >
                <Download className="w-3 h-3 text-rose-400" />
                <span>SRT</span>
              </button>
              <button
                type="button"
                onClick={() => pack?.vttContent && downloadFile(pack.vttContent, `${sanitizedBase}.vtt`, 'text/vtt')}
                className="px-2.5 py-1.5 rounded-lg bg-white/8 hover:bg-white/12 text-white text-[11px] font-medium flex items-center gap-1.5 transition"
                title="Download WebVTT subtitle track"
              >
                <Download className="w-3 h-3 text-indigo-400" />
                <span>VTT</span>
              </button>
            </div>
          </div>

          {/* Title Field */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-xs">
              <label className="text-neutral-400 font-medium">Platform Title / Hook</label>
              <button
                type="button"
                onClick={() => pack && copyToClipboard(pack.title, 'title')}
                className="text-[11px] text-rose-400 hover:underline flex items-center gap-1"
              >
                {copiedField === 'title' ? (
                  <>
                    <Check className="w-3 h-3 text-emerald-400" />
                    <span className="text-emerald-400">Copied!</span>
                  </>
                ) : (
                  <>
                    <Copy className="w-3 h-3" />
                    <span>Copy Title</span>
                  </>
                )}
              </button>
            </div>
            <div className="p-3 rounded-xl bg-[#141a26] border border-white/8 font-mono text-xs text-white">
              {pack?.title || script.title}
            </div>
          </div>

          {/* Description Field */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-xs">
              <label className="text-neutral-400 font-medium">Caption & Description</label>
              <button
                type="button"
                onClick={() => pack && copyToClipboard(pack.description, 'description')}
                className="text-[11px] text-rose-400 hover:underline flex items-center gap-1"
              >
                {copiedField === 'description' ? (
                  <>
                    <Check className="w-3 h-3 text-emerald-400" />
                    <span className="text-emerald-400">Copied!</span>
                  </>
                ) : (
                  <>
                    <Copy className="w-3 h-3" />
                    <span>Copy Description</span>
                  </>
                )}
              </button>
            </div>
            <div className="p-3 rounded-xl bg-[#141a26] border border-white/8 text-xs text-neutral-200 whitespace-pre-wrap leading-relaxed">
              {pack?.description || script.description}
            </div>
          </div>

          {/* Hashtags Field */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-xs">
              <label className="text-neutral-400 font-medium">Viral Tags</label>
              <button
                type="button"
                onClick={() => pack && copyToClipboard(pack.hashtags.join(' '), 'hashtags')}
                className="text-[11px] text-rose-400 hover:underline flex items-center gap-1"
              >
                {copiedField === 'hashtags' ? (
                  <>
                    <Check className="w-3 h-3 text-emerald-400" />
                    <span className="text-emerald-400">Copied!</span>
                  </>
                ) : (
                  <>
                    <Copy className="w-3 h-3" />
                    <span>Copy Tags</span>
                  </>
                )}
              </button>
            </div>
            <div className="flex flex-wrap gap-1.5 p-3 rounded-xl bg-[#141a26] border border-white/8">
              {(pack?.hashtags || script.hashtags).map((tag, idx) => (
                <span
                  key={idx}
                  className="px-2 py-0.5 rounded-lg bg-rose-500/10 border border-rose-500/20 text-rose-300 text-xs font-medium font-mono"
                >
                  {tag}
                </span>
              ))}
            </div>
          </div>
        </div>

        {/* Modal Footer */}
        <div className="pt-4 border-t border-white/8 flex items-center justify-between text-xs relative z-10 shrink-0">
          <span className="text-neutral-400">Formatted for 9:16 vertical video algorithms</span>
          <button
            type="button"
            onClick={() => {
              if (pack) {
                const fullText = `${pack.title}\n\n${pack.description}\n\n${pack.hashtags.join(' ')}`;
                copyToClipboard(fullText, 'all');
              }
            }}
            className="px-4 py-2 rounded-xl bg-white/10 hover:bg-white/15 text-white font-semibold flex items-center gap-1.5 transition"
          >
            {copiedField === 'all' ? (
              <>
                <Check className="w-3.5 h-3.5 text-emerald-400" />
                <span className="text-emerald-400">All Copied to Clipboard</span>
              </>
            ) : (
              <>
                <Copy className="w-3.5 h-3.5" />
                <span>Copy Entire Package</span>
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
};
