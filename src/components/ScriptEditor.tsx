import React from 'react';
import { Sparkles, Video, Play, Edit3, Trash2, Plus, Clock } from 'lucide-react';
import { Beat } from '../types';

interface ScriptEditorProps {
  beats: Beat[];
  currentTimestamp: number;
  onUpdateBeat: (id: string, updates: Partial<Beat>) => void;
  onSelectBeatToChangeClip: (beat: Beat) => void;
  onSeekToBeat: (startTime: number) => void;
  onAddBeat: () => void;
  onDeleteBeat: (id: string) => void;
}

export const ScriptEditor: React.FC<ScriptEditorProps> = ({
  beats,
  currentTimestamp,
  onUpdateBeat,
  onSelectBeatToChangeClip,
  onSeekToBeat,
  onAddBeat,
  onDeleteBeat,
}) => {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="font-semibold text-white text-sm">Video Beats Timeline</h3>
          <p className="text-xs text-neutral-400">
            {beats.length} beats &bull; ~{beats.length > 0 ? beats[beats.length - 1].end_s.toFixed(1) : 0}s total
          </p>
        </div>
        <button
          onClick={onAddBeat}
          className="px-2.5 py-1.5 bg-neutral-800 hover:bg-neutral-700 text-xs font-medium text-white rounded-lg flex items-center gap-1.5 transition"
        >
          <Plus className="w-3.5 h-3.5" />
          Add Beat
        </button>
      </div>

      <div className="space-y-2.5">
        {beats.map((beat, index) => {
          const isActive = currentTimestamp >= beat.start_s && currentTimestamp < beat.end_s;
          const isHook = index === 0;

          return (
            <div
              key={beat.id}
              className={`relative rounded-xl border transition-all p-3.5 ${
                isActive
                  ? 'bg-neutral-900 border-rose-500 shadow-md ring-1 ring-rose-500/20'
                  : 'bg-neutral-900/70 border-neutral-800/90 hover:border-neutral-700'
              }`}
            >
              {/* Top status bar */}
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <span className="w-5 h-5 rounded-full bg-neutral-800 border border-neutral-700 text-[11px] font-mono font-semibold text-neutral-300 flex items-center justify-center">
                    {index + 1}
                  </span>
                  {isHook && (
                    <span className="px-2 py-0.5 rounded-md bg-rose-500/20 border border-rose-500/40 text-[11px] font-semibold text-rose-400 flex items-center gap-1">
                      <Sparkles className="w-3 h-3" />
                      HOOK (First 2-3s)
                    </span>
                  )}
                  <button
                    onClick={() => onSeekToBeat(beat.start_s)}
                    className="px-2 py-0.5 rounded bg-neutral-800 hover:bg-neutral-700 text-[11px] text-neutral-400 hover:text-white font-mono flex items-center gap-1 transition"
                    title="Jump to this beat in player"
                  >
                    <Clock className="w-3 h-3 text-neutral-500" />
                    {beat.start_s.toFixed(1)}s - {beat.end_s.toFixed(1)}s
                    <Play className="w-2.5 h-2.5 ml-0.5 fill-current" />
                  </button>
                </div>

                <div className="flex items-center gap-1">
                  {beats.length > 1 && (
                    <button
                      onClick={() => onDeleteBeat(beat.id)}
                      className="p-1 rounded text-neutral-500 hover:text-red-400 hover:bg-neutral-800 transition"
                      title="Delete beat"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              </div>

              {/* Beat Content */}
              <div className="grid grid-cols-1 md:grid-cols-[1fr_120px] gap-3">
                <div className="space-y-2">
                  <textarea
                    value={beat.text}
                    onChange={(e) => onUpdateBeat(beat.id, { text: e.target.value })}
                    rows={2}
                    className="w-full bg-neutral-950 border border-neutral-800 focus:border-rose-500 rounded-lg p-2 text-xs sm:text-sm text-neutral-200 placeholder-neutral-500 resize-none focus:outline-none transition leading-relaxed"
                    placeholder="Spoken voiceover text..."
                  />

                  <div className="flex items-center gap-1.5">
                    <span className="text-[11px] text-neutral-400 shrink-0">Stock Query:</span>
                    <input
                      type="text"
                      value={beat.visual_keywords}
                      onChange={(e) => onUpdateBeat(beat.id, { visual_keywords: e.target.value })}
                      className="flex-1 bg-neutral-950 border border-neutral-800 focus:border-rose-500 rounded-md px-2 py-1 text-xs text-neutral-300 placeholder-neutral-500 focus:outline-none"
                      placeholder="e.g. person typing laptop night"
                    />
                  </div>
                </div>

                {/* Stock clip card */}
                <div className="flex flex-col gap-1.5">
                  <div
                    onClick={() => onSelectBeatToChangeClip(beat)}
                    className="relative group rounded-lg overflow-hidden aspect-[9/16] bg-neutral-950 border border-neutral-800 hover:border-rose-500 cursor-pointer transition max-h-24 md:max-h-full"
                  >
                    {beat.video_url ? (
                      <video
                        src={beat.video_url}
                        poster={beat.thumbnail}
                        muted
                        playsInline
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <div className="w-full h-full flex flex-col items-center justify-center text-neutral-500 p-1">
                        <Video className="w-4 h-4 mb-1" />
                        <span className="text-[10px] text-center">No clip</span>
                      </div>
                    )}
                    <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 flex items-center justify-center transition">
                      <span className="text-[10px] font-medium text-white px-1.5 py-0.5 rounded bg-rose-600/90 flex items-center gap-1">
                        <Edit3 className="w-2.5 h-2.5" />
                        Change
                      </span>
                    </div>
                  </div>
                  <button
                    onClick={() => onSelectBeatToChangeClip(beat)}
                    className="w-full py-1 rounded bg-neutral-800 hover:bg-neutral-700 text-[10px] font-medium text-neutral-300 transition text-center"
                  >
                    Change Clip
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
