import React, { useState } from 'react';
import { Type, Sparkles, Sliders, Clock, AlignCenter, Eye, EyeOff, Check, RotateCcw } from 'lucide-react';
import { CaptionStyle } from '../types';

interface CaptionStyleConfigProps {
  style: CaptionStyle;
  onChange: (updated: Partial<CaptionStyle>) => void;
  captionOffsetSeconds?: number;
  onChangeCaptionOffset?: (offset: number) => void;
}

export const VIRAL_FONTS = [
  { id: 'Montserrat', name: 'Montserrat', sub: 'Hormozi Kinetic', family: "'Montserrat', sans-serif", weight: '900' },
  { id: 'Bangers', name: 'Bangers', sub: 'MrBeast Explosive', family: "'Bangers', cursive", weight: '400' },
  { id: 'Poppins', name: 'Poppins', sub: 'TikTok Retention', family: "'Poppins', sans-serif", weight: '900' },
  { id: 'Anton', name: 'Anton', sub: 'Cinematic Punch', family: "'Anton', sans-serif", weight: '400' },
  { id: 'Russo One', name: 'Russo One', sub: 'Cyber / Gaming', family: "'Russo One', sans-serif", weight: '400' },
  { id: 'Luckiest Guy', name: 'Luckiest Guy', sub: 'Playful Cartoon', family: "'Luckiest Guy', cursive", weight: '400' },
  { id: 'Inter', name: 'Inter', sub: 'Vox / Editorial', family: "'Inter', sans-serif", weight: '800' },
  { id: 'Syne', name: 'Syne', sub: 'Luxury Display', family: "'Syne', sans-serif", weight: '800' },
];

export const PRESET_STYLES: CaptionStyle[] = [
  {
    id: 'hormozi',
    name: 'Alex Hormozi',
    fontFamily: 'Montserrat',
    fontWeight: '900',
    fontSize: 32,
    textColor: '#FFFFFF',
    highlightColor: '#FFE600',
    strokeColor: '#000000',
    strokeWidth: 5,
    positionY: 68,
    wordsPerChunk: 2,
    textTransform: 'uppercase',
    boxStyle: 'rounded-pill',
    badge: 'Hormozi Yellow',
  },
  {
    id: 'mrbeast',
    name: 'MrBeast Pop',
    fontFamily: 'Bangers',
    fontWeight: '400',
    fontSize: 35,
    textColor: '#FFFFFF',
    highlightColor: '#00F0FF',
    strokeColor: '#000000',
    strokeWidth: 6,
    positionY: 65,
    wordsPerChunk: 2,
    textTransform: 'uppercase',
    boxStyle: 'comic',
    rotation: -2,
    badge: 'Electric Cyan',
  },
  {
    id: 'tiktok-pop',
    name: 'TikTok Kinetic',
    fontFamily: 'Poppins',
    fontWeight: '900',
    fontSize: 29,
    textColor: '#FFFFFF',
    highlightColor: '#39FF88',
    strokeColor: '#000000',
    strokeWidth: 4,
    positionY: 68,
    wordsPerChunk: 3,
    textTransform: 'uppercase',
    boxStyle: 'rounded-pill',
    badge: 'Retention Lime',
  },
  {
    id: 'anton-headline',
    name: 'Anton Headline',
    fontFamily: 'Anton',
    fontWeight: '400',
    fontSize: 34,
    textColor: '#FFFFFF',
    highlightColor: '#FF2A55',
    strokeColor: '#000000',
    strokeWidth: 4,
    positionY: 70,
    wordsPerChunk: 3,
    textTransform: 'uppercase',
    boxStyle: 'rounded-pill',
    badge: 'Crimson Flare',
  },
  {
    id: 'russo-cyber',
    name: 'Cyberpunk Neon',
    fontFamily: 'Russo One',
    fontWeight: '400',
    fontSize: 30,
    textColor: '#FFFFFF',
    highlightColor: '#EC4899',
    strokeColor: '#000000',
    strokeWidth: 5,
    positionY: 66,
    wordsPerChunk: 2,
    textTransform: 'uppercase',
    boxStyle: 'glow',
    badge: 'Neon Pink',
  },
  {
    id: 'vox-minimal',
    name: 'Vox Minimalist',
    fontFamily: 'Inter',
    fontWeight: '800',
    fontSize: 26,
    textColor: '#FFFFFF',
    highlightColor: '#38BDF8',
    strokeColor: '#000000',
    strokeWidth: 3,
    positionY: 74,
    wordsPerChunk: 3,
    textTransform: 'none',
    boxStyle: 'minimal',
    badge: 'Clean Documentary',
  },
];

const HIGHLIGHT_PALETTE = [
  { hex: '#FFE600', name: 'Hormozi Gold' },
  { hex: '#00F0FF', name: 'Electric Cyan' },
  { hex: '#39FF88', name: 'Vibrant Lime' },
  { hex: '#FF2A55', name: 'Coral Flare' },
  { hex: '#EC4899', name: 'Hot Pink' },
  { hex: '#FB923C', name: 'Sunburst Orange' },
  { hex: '#A855F7', name: 'Electric Violet' },
  { hex: '#FFFFFF', name: 'Pure White' },
];

export const CaptionStyleConfig: React.FC<CaptionStyleConfigProps> = ({
  style,
  onChange,
  captionOffsetSeconds = 0,
  onChangeCaptionOffset,
}) => {
  const [activeTab, setActiveTab] = useState<'presets' | 'typography' | 'sync'>('presets');
  const showCaptions = style.showCaptions !== false;

  return (
    <section className="bg-[#0f141c] border border-white/8 rounded-2xl p-6 shadow-sm">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-white/8">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-base font-semibold text-white tracking-tight">Kinetic Caption Engine</h2>
            <div className="flex items-center gap-1.5 text-xs text-neutral-400">
              <span aria-hidden="true">·</span>
              <span>{style.name}</span>
              <span aria-hidden="true">·</span>
              <span className="font-mono tabular-nums">{style.fontSize}px</span>
            </div>
          </div>
          <p className="text-xs text-neutral-400 mt-0.5">
            Word-by-word animated captions proven to maximize viewer retention on YouTube Shorts
          </p>
        </div>

        {/* Global Visibility & Segmented Tabs */}
        <div className="flex items-center gap-2">
          <button
            onClick={() => onChange({ showCaptions: !showCaptions })}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5 border transition ${
              showCaptions
                ? 'bg-rose-500/10 border-rose-500/30 text-rose-300 hover:bg-rose-500/20'
                : 'bg-neutral-900 border-white/8 text-neutral-400 hover:text-white'
            }`}
          >
            {showCaptions ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
            <span>{showCaptions ? 'Captions Active' : 'Captions Hidden'}</span>
          </button>

          {/* Segmented Mode Selector */}
          <div className="flex items-center p-1 bg-black/40 border border-white/8 rounded-lg">
            <button
              onClick={() => setActiveTab('presets')}
              className={`px-3 py-1 text-xs font-medium rounded-md transition ${
                activeTab === 'presets' ? 'bg-[#1e2638] text-white shadow-sm' : 'text-neutral-400 hover:text-white'
              }`}
            >
              Presets
            </button>
            <button
              onClick={() => setActiveTab('typography')}
              className={`px-3 py-1 text-xs font-medium rounded-md transition ${
                activeTab === 'typography' ? 'bg-[#1e2638] text-white shadow-sm' : 'text-neutral-400 hover:text-white'
              }`}
            >
              Fine-Tune
            </button>
            <button
              onClick={() => setActiveTab('sync')}
              className={`px-3 py-1 text-xs font-medium rounded-md transition ${
                activeTab === 'sync' ? 'bg-[#1e2638] text-white shadow-sm' : 'text-neutral-400 hover:text-white'
              }`}
            >
              Audio Sync
            </button>
          </div>
        </div>
      </div>

      {/* Live Kinetic Caption Preview Banner */}
      <div className="mt-4 p-4 rounded-xl bg-black/50 border border-white/6 flex flex-col items-center justify-center min-h-[96px] relative overflow-hidden">
        <span className="text-[10px] text-neutral-500 absolute top-2 left-3 font-mono tracking-wider">
          LIVE CAPTION PREVIEW
        </span>

        {showCaptions ? (
          <div
            className="flex items-center justify-center gap-2 select-none transition-all duration-150"
            style={{
              fontFamily: style.fontFamily || 'Montserrat',
              fontWeight: style.fontWeight || '900',
              textTransform: style.textTransform || 'uppercase',
              transform: style.rotation ? `rotate(${style.rotation}deg)` : undefined,
            }}
          >
            <div
              className="px-3.5 py-1.5 rounded-lg flex items-center gap-2"
              style={{
                backgroundColor: style.boxStyle === 'rounded-pill' ? 'rgba(0,0,0,0.75)' : 'transparent',
              }}
            >
              <span
                style={{
                  fontSize: `${Math.min(style.fontSize, 30)}px`,
                  color: style.textColor,
                  WebkitTextStroke: `${Math.min(style.strokeWidth || 4, 4)}px ${style.strokeColor || '#000000'}`,
                  paintOrder: 'stroke fill',
                }}
              >
                UNSTOPPABLE
              </span>
              <span
                style={{
                  fontSize: `${Math.min(style.fontSize, 30)}px`,
                  color: style.highlightColor,
                  WebkitTextStroke: `${Math.min(style.strokeWidth || 4, 4)}px ${style.strokeColor || '#000000'}`,
                  paintOrder: 'stroke fill',
                }}
              >
                RETENTION
              </span>
            </div>
          </div>
        ) : (
          <span className="text-xs text-neutral-500">Captions are disabled in the overlay</span>
        )}
      </div>

      {/* Tab 1: Viral Presets Grid */}
      {activeTab === 'presets' && (
        <div className="mt-5 space-y-4">
          <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-3">
            {PRESET_STYLES.map((preset) => {
              const isSelected = style.id === preset.id;
              return (
                <button
                  key={preset.id}
                  onClick={() => onChange(preset)}
                  className={`text-left p-3 rounded-xl border transition flex flex-col justify-between ${
                    isSelected
                      ? 'bg-rose-500/10 border-rose-500/40 shadow-sm'
                      : 'bg-black/25 border-white/6 hover:border-white/20 hover:bg-black/40'
                  }`}
                >
                  <div className="flex items-center justify-between mb-2">
                    <span
                      className="w-3 h-3 rounded-full border border-black/40"
                      style={{ backgroundColor: preset.highlightColor }}
                    />
                    {isSelected && <Check className="w-3.5 h-3.5 text-rose-400" />}
                  </div>

                  <span className="text-xs font-semibold text-white block truncate">{preset.name}</span>
                  <span className="text-[11px] text-neutral-400 block mt-0.5 truncate">{preset.badge}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Tab 2: Fine-Tuning Typography & Appearance */}
      {activeTab === 'typography' && (
        <div className="mt-5 grid grid-cols-1 md:grid-cols-2 gap-5">
          {/* Left Column: Font Family & Highlighting */}
          <div className="space-y-4">
            <div>
              <label className="text-xs font-semibold text-white block mb-1.5">Viral Font Family</label>
              <div className="grid grid-cols-2 gap-2">
                {VIRAL_FONTS.map((font) => {
                  const isSelected = (style.fontFamily || 'Montserrat') === font.id;
                  return (
                    <button
                      key={font.id}
                      onClick={() =>
                        onChange({
                          fontFamily: font.id,
                          fontWeight: font.weight,
                        })
                      }
                      className={`text-left px-3 py-2 rounded-lg border text-xs transition flex items-center justify-between ${
                        isSelected
                          ? 'bg-rose-500/10 border-rose-500/40 text-white font-semibold'
                          : 'bg-black/25 border-white/6 text-neutral-300 hover:border-white/15'
                      }`}
                    >
                      <span className="truncate">{font.name}</span>
                      <span className="text-[10px] text-neutral-400 font-normal">{font.sub}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Kinetic Highlight Color Swatches */}
            <div>
              <label className="text-xs font-semibold text-white block mb-1.5">
                Active Word Highlight Accent
              </label>
              <div className="flex flex-wrap items-center gap-2">
                {HIGHLIGHT_PALETTE.map((color) => {
                  const isCurrent = style.highlightColor.toLowerCase() === color.hex.toLowerCase();
                  return (
                    <button
                      key={color.hex}
                      onClick={() => onChange({ highlightColor: color.hex })}
                      title={color.name}
                      className={`w-7 h-7 rounded-lg transition transform flex items-center justify-center border ${
                        isCurrent
                          ? 'scale-110 border-white ring-2 ring-rose-500/40'
                          : 'border-white/20 hover:scale-105'
                      }`}
                      style={{ backgroundColor: color.hex }}
                    >
                      {isCurrent && (
                        <Check
                          className="w-3.5 h-3.5"
                          style={{
                            color: color.hex === '#FFFFFF' || color.hex === '#FFE600' ? '#000000' : '#FFFFFF',
                          }}
                        />
                      )}
                    </button>
                  );
                })}
                <input
                  type="color"
                  value={style.highlightColor}
                  onChange={(e) => onChange({ highlightColor: e.target.value })}
                  title="Custom Hex Color"
                  className="w-7 h-7 rounded-lg bg-transparent border border-white/20 cursor-pointer"
                />
              </div>
            </div>
          </div>

          {/* Right Column: Size, Pacing, and Screen Position */}
          <div className="space-y-4">
            {/* Words Per Chunk */}
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-xs font-semibold text-white">Words Per Animated Line</label>
                <span className="text-xs text-neutral-400 font-mono tabular-nums">
                  {style.wordsPerChunk} {style.wordsPerChunk === 1 ? 'word' : 'words'}
                </span>
              </div>
              <div className="grid grid-cols-3 gap-2">
                {[1, 2, 3].map((count) => (
                  <button
                    key={count}
                    onClick={() => onChange({ wordsPerChunk: count })}
                    className={`py-2 rounded-lg text-xs font-medium border text-center transition ${
                      style.wordsPerChunk === count
                        ? 'bg-rose-500/10 border-rose-500/40 text-white font-semibold'
                        : 'bg-black/25 border-white/6 text-neutral-400 hover:text-white'
                    }`}
                  >
                    {count} {count === 1 ? 'Word' : 'Words'}
                  </button>
                ))}
              </div>
            </div>

            {/* Font Size Slider */}
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-xs font-semibold text-white">Font Size</label>
                <span className="text-xs text-neutral-400 font-mono tabular-nums">{style.fontSize}px</span>
              </div>
              <input
                type="range"
                min="20"
                max="46"
                step="1"
                value={style.fontSize}
                onChange={(e) => onChange({ fontSize: parseInt(e.target.value, 10) })}
                className="w-full h-1.5 bg-neutral-800 rounded-lg cursor-pointer"
              />
            </div>

            {/* Vertical Position Slider */}
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-xs font-semibold text-white">Vertical Position from Top</label>
                <span className="text-xs text-neutral-400 font-mono tabular-nums">{style.positionY}%</span>
              </div>
              <input
                type="range"
                min="35"
                max="82"
                step="1"
                value={style.positionY}
                onChange={(e) => onChange({ positionY: parseInt(e.target.value, 10) })}
                className="w-full h-1.5 bg-neutral-800 rounded-lg cursor-pointer"
              />
              <p className="text-[11px] text-neutral-400 mt-1">
                65%–72% sits ideally above YouTube Shorts bottom title overlay and below top menu.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Tab 3: Audio CC Synchronization Offset */}
      {activeTab === 'sync' && (
        <div className="mt-5 space-y-4">
          <div className="p-4 rounded-xl bg-black/30 border border-white/6 space-y-3">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
              <div>
                <span className="text-xs font-semibold text-white block">Kinetic Word Offset</span>
                <span className="text-[11px] text-neutral-400">
                  Nudge caption timing earlier or later to lock into spoken words with millisecond precision
                </span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="text-xs font-mono font-semibold text-rose-300 tabular-nums">
                  {captionOffsetSeconds > 0 ? `+${captionOffsetSeconds.toFixed(2)}s` : `${captionOffsetSeconds.toFixed(2)}s`}
                </span>
                <button
                  onClick={() => onChangeCaptionOffset && onChangeCaptionOffset(0)}
                  className="px-2 py-1 rounded bg-neutral-800 hover:bg-neutral-700 text-[10px] text-neutral-300 flex items-center gap-1 transition"
                  title="Reset offset to 0.00s"
                >
                  <RotateCcw className="w-2.5 h-2.5" />
                  <span>Reset</span>
                </button>
              </div>
            </div>

            {/* Fine adjustment slider */}
            <input
              type="range"
              min="-1.5"
              max="1.5"
              step="0.05"
              value={captionOffsetSeconds}
              onChange={(e) => onChangeCaptionOffset && onChangeCaptionOffset(parseFloat(e.target.value))}
              className="w-full h-1.5 bg-neutral-800 rounded-lg cursor-pointer"
            />

            {/* Quick Nudge Buttons */}
            <div className="flex items-center justify-between text-xs pt-1">
              <button
                onClick={() => onChangeCaptionOffset && onChangeCaptionOffset(parseFloat((captionOffsetSeconds - 0.1).toFixed(2)))}
                className="px-3 py-1.5 rounded-lg bg-black/40 hover:bg-black/60 border border-white/8 text-neutral-300 hover:text-white transition font-mono tabular-nums"
              >
                -100ms (Earlier)
              </button>
              <span className="text-[11px] text-neutral-500">Fine-tune in 100ms increments</span>
              <button
                onClick={() => onChangeCaptionOffset && onChangeCaptionOffset(parseFloat((captionOffsetSeconds + 0.1).toFixed(2)))}
                className="px-3 py-1.5 rounded-lg bg-black/40 hover:bg-black/60 border border-white/8 text-neutral-300 hover:text-white transition font-mono tabular-nums"
              >
                +100ms (Later)
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
};
