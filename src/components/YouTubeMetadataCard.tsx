import React, { useState } from 'react';
import { Copy, Check, Download, Youtube, Hash, FileText } from 'lucide-react';
import { ShortScript } from '../types';

interface YouTubeMetadataCardProps {
  script: ShortScript;
}

export const YouTubeMetadataCard: React.FC<YouTubeMetadataCardProps> = ({ script }) => {
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const copyToClipboard = (text: string, key: string) => {
    navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 2000);
  };

  const downloadJson = () => {
    const data = {
      title: script.title,
      description: script.description,
      hashtags: script.hashtags,
      beats: script.beats.map(b => ({
        text: b.text,
        visual_keywords: b.visual_keywords,
        start_s: b.start_s,
        end_s: b.end_s
      }))
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'short_metadata.json';
    a.click();
    URL.revokeObjectURL(url);
  };

  const allHashtags = script.hashtags.join(' ');
  const fullYouTubeUploadText = `${script.title}\n\n${script.description}\n\n${allHashtags}`;

  return (
    <div className="bg-neutral-900 border border-neutral-800 rounded-2xl p-5 shadow-sm space-y-4">
      <div className="flex items-center justify-between pb-3 border-b border-neutral-800">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-red-600/10 border border-red-500/20 flex items-center justify-center text-red-500">
            <Youtube className="w-4 h-4" />
          </div>
          <div>
            <h3 className="font-semibold text-white text-sm">YouTube Ready Metadata</h3>
            <p className="text-xs text-neutral-400">Ready to paste into YouTube Studio</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => copyToClipboard(fullYouTubeUploadText, 'all')}
            className="px-3 py-1.5 bg-neutral-800 hover:bg-neutral-700 text-xs font-medium text-white rounded-lg flex items-center gap-1.5 transition"
          >
            {copiedKey === 'all' ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
            Copy All
          </button>
          <button
            onClick={downloadJson}
            className="px-3 py-1.5 bg-neutral-800 hover:bg-neutral-700 text-xs font-medium text-white rounded-lg flex items-center gap-1.5 transition"
          >
            <Download className="w-3.5 h-3.5" />
            JSON
          </button>
        </div>
      </div>

      {/* Title */}
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <label className="text-xs font-medium text-neutral-300 flex items-center gap-1.5">
            <FileText className="w-3.5 h-3.5 text-neutral-400" />
            Title
          </label>
          <button
            onClick={() => copyToClipboard(script.title, 'title')}
            className="text-[11px] text-neutral-400 hover:text-white flex items-center gap-1 transition"
          >
            {copiedKey === 'title' ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
            {copiedKey === 'title' ? 'Copied' : 'Copy'}
          </button>
        </div>
        <div className="bg-neutral-950/80 border border-neutral-800 rounded-xl px-3 py-2 text-sm text-white font-medium">
          {script.title}
        </div>
      </div>

      {/* Description */}
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <label className="text-xs font-medium text-neutral-300">Description</label>
          <button
            onClick={() => copyToClipboard(script.description, 'desc')}
            className="text-[11px] text-neutral-400 hover:text-white flex items-center gap-1 transition"
          >
            {copiedKey === 'desc' ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
            {copiedKey === 'desc' ? 'Copied' : 'Copy'}
          </button>
        </div>
        <div className="bg-neutral-950/80 border border-neutral-800 rounded-xl px-3 py-2 text-xs text-neutral-300 leading-relaxed">
          {script.description}
        </div>
      </div>

      {/* Hashtags */}
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <label className="text-xs font-medium text-neutral-300 flex items-center gap-1">
            <Hash className="w-3.5 h-3.5 text-neutral-400" />
            Hashtags
          </label>
          <button
            onClick={() => copyToClipboard(allHashtags, 'tags')}
            className="text-[11px] text-neutral-400 hover:text-white flex items-center gap-1 transition"
          >
            {copiedKey === 'tags' ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
            {copiedKey === 'tags' ? 'Copied' : 'Copy'}
          </button>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {script.hashtags.map((tag, i) => (
            <span
              key={i}
              className="px-2.5 py-1 rounded-lg bg-neutral-800/80 border border-neutral-700/60 text-xs font-medium text-rose-300"
            >
              {tag.startsWith('#') ? tag : `#${tag}`}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
};
