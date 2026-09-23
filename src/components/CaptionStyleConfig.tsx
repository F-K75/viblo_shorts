import React from 'react';
import { Type, Palette, Layout, Sliders } from 'lucide-react';
import { CaptionStyle } from '../types';

interface CaptionStyleConfigProps {
  style: CaptionStyle;
  onChange: (updated: Partial<CaptionStyle>) => void;
}

const PRESET_STYLES: CaptionStyle[] = [
  {
    id: 'tiktok-pop',
    name: 'TikTok Pop',
    fontSize: 28,
    textColor: '#FFFFFF',
    highlightColor: '#39FF88', // viblo green from original config.py
    strokeColor: '#000000',
    strokeWidth: 4,
    positionY: 68,
    wordsPerChunk: 3,
  },
  {
    id: 'neon-cyber',
    name: 'Cyber Neon',
    fontSize: 30,
    textColor: '#FFFFFF',
    highlightColor: '#F43F5E', // neon rose
    strokeColor: '#000000',
    strokeWidth: 5,
    positionY: 65,
    wordsPerChunk: 2,
  },
  {
    id: 'yellow-beast',
    name: 'Viral Gold',
    fontSize: 32,
    textColor: '#FFFFFF',
    highlightColor: '#FACC15', // vibrant yellow
    strokeColor: '#000000',
    strokeWidth: 5,
    positionY: 70,
    wordsPerChunk: 3,
  },
  {
    id: 'clean-white',
    name: 'Minimal Clean',
    fontSize: 26,
    textColor: '#F5F5F5',
    highlightColor: '#38BDF8', // sky blue
    strokeColor: '#000000',
    strokeWidth: 3,
    positionY: 68,
    wordsPerChunk: 4,
  },
];

export const CaptionStyleConfig: React.FC<CaptionStyleConfigProps> = ({
  style,
  onChange,
}) => {
  return (
    <div className="bg-neutral-900 border border-neutral-800 rounded-2xl p-4 space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Type className="w-4 h-4 text-rose-500" />
          <h3 className="font-semibold text-white text-xs sm:text-sm">Caption Styling & Chunking</h3>
        </div>
      </div>

      {/* Presets */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        {PRESET_STYLES.map((preset) => {
          const isSelected = style.id === preset.id;
          return (
            <button
              key={preset.id}
              onClick={() => onChange(preset)}
              className={`p-2.5 rounded-xl border text-left transition-all ${
                isSelected
                  ? 'bg-neutral-800 border-rose-500 ring-1 ring-rose-500/20'
                  : 'bg-neutral-950/60 border-neutral-800 hover:border-neutral-700'
              }`}
            >
              <div className="text-xs font-semibold text-white mb-1">{preset.name}</div>
              <div className="flex items-center gap-1.5">
                <span
                  className="w-3.5 h-3.5 rounded-full border border-black/40"
                  style={{ backgroundColor: preset.highlightColor }}
                />
                <span className="text-[10px] text-neutral-400 font-mono">
                  {preset.wordsPerChunk}w / chunk
                </span>
              </div>
            </button>
          );
        })}
      </div>

      {/* Fine-tuning sliders */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-2 border-t border-neutral-800/80">
        <div>
          <label className="text-[11px] text-neutral-400 flex items-center justify-between mb-1">
            <span>Words per chunk</span>
            <span className="text-white font-mono">{style.wordsPerChunk}</span>
          </label>
          <input
            type="range"
            min="1"
            max="5"
            step="1"
            value={style.wordsPerChunk}
            onChange={(e) => onChange({ wordsPerChunk: parseInt(e.target.value, 10), id: 'custom' })}
            className="w-full h-1 bg-neutral-800 rounded appearance-none cursor-pointer accent-rose-500"
          />
        </div>

        <div>
          <label className="text-[11px] text-neutral-400 flex items-center justify-between mb-1">
            <span>Highlight Color</span>
            <span
              className="w-3 h-3 rounded-full border border-black"
              style={{ backgroundColor: style.highlightColor }}
            />
          </label>
          <div className="flex items-center gap-1.5">
            {['#39FF88', '#F43F5E', '#FACC15', '#38BDF8', '#A855F7', '#FF8C00'].map((color) => (
              <button
                key={color}
                onClick={() => onChange({ highlightColor: color, id: 'custom' })}
                className={`w-6 h-6 rounded-full border transition-transform ${
                  style.highlightColor === color ? 'scale-110 border-white ring-2 ring-white/20' : 'border-transparent'
                }`}
                style={{ backgroundColor: color }}
              />
            ))}
          </div>
        </div>

        <div>
          <label className="text-[11px] text-neutral-400 flex items-center justify-between mb-1">
            <span>Vertical Position</span>
            <span className="text-white font-mono">{style.positionY}%</span>
          </label>
          <input
            type="range"
            min="40"
            max="85"
            step="1"
            value={style.positionY}
            onChange={(e) => onChange({ positionY: parseInt(e.target.value, 10), id: 'custom' })}
            className="w-full h-1 bg-neutral-800 rounded appearance-none cursor-pointer accent-rose-500"
          />
        </div>
      </div>
    </div>
  );
};
