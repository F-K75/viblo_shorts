import React, { useState, useEffect } from 'react';
import { Search, X, Check, Film, Loader2 } from 'lucide-react';
import { Beat } from '../types';
import { getSafeThumbnail } from '../utils/visualPlaceholders';

interface StockPickerModalProps {
  beat: Beat | null;
  isOpen: boolean;
  onClose: () => void;
  onSelectClip: (beatId: string, videoUrl: string, thumbnail?: string) => void;
}

const QUICK_FILTERS = [
  { label: 'Work & Code', query: 'laptop keyboard code typing developer tech' },
  { label: 'Time & Habit', query: 'clock timer morning wake up routine' },
  { label: 'Morning Coffee', query: 'pouring coffee steam mug morning desk' },
  { label: 'City & Motion', query: 'vertical street walking city skyline lights' },
  { label: 'Gym & Energy', query: 'gym workout fitness weights athletic training' },
  { label: 'Wealth & Success', query: 'counting cash dollar money investing finance' },
  { label: 'Study & Reading', query: 'notebook writing book notes library study' },
];

export const StockPickerModal: React.FC<StockPickerModalProps> = ({
  beat,
  isOpen,
  onClose,
  onSelectClip,
}) => {
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [clips, setClips] = useState<any[]>([]);

  useEffect(() => {
    if (beat && isOpen) {
      setQuery(beat.visual_keywords);
      searchVideos(beat.visual_keywords);
    }
  }, [beat, isOpen]);

  const searchVideos = async (searchQuery: string) => {
    if (!searchQuery.trim()) return;
    setLoading(true);
    try {
      const res = await fetch('/api/stock-footage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: searchQuery }),
      });
      const data = await res.json();
      setClips(data.results || []);
    } catch (e) {
      console.error('Failed to search stock footage:', e);
    } finally {
      setLoading(false);
    }
  };

  if (!isOpen || !beat) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-md p-4 animate-in fade-in duration-150">
      <div className="bg-[#0f141c] border border-white/10 rounded-2xl max-w-3xl w-full max-h-[85vh] flex flex-col shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="p-4 sm:p-5 border-b border-white/8 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-rose-500/10 border border-rose-500/20 flex items-center justify-center text-rose-400">
              <Film className="w-4 h-4" />
            </div>
            <div>
              <h3 className="font-semibold text-white text-sm">Select B-Roll Stock Footage</h3>
              <p className="text-xs text-neutral-400 truncate max-w-md">
                Beat: &ldquo;{beat.text}&rdquo;
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-neutral-400 hover:text-white hover:bg-neutral-800 transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Search bar & Quick Filters */}
        <div className="p-4 border-b border-white/8 bg-black/30 space-y-3">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              searchVideos(query);
            }}
            className="flex gap-2"
          >
            <div className="relative flex-1">
              <Search className="w-4 h-4 absolute left-3 top-3 text-neutral-400" />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search vertical video keywords (e.g. coffee, typing, clock, workout)..."
                className="w-full bg-[#090c10] border border-white/10 focus:border-rose-500 rounded-xl pl-9 pr-3 py-2 text-xs text-white placeholder-neutral-500 focus:outline-none transition shadow-inner"
              />
            </div>
            <button
              type="submit"
              disabled={loading}
              className="px-4 py-2 bg-rose-600 hover:bg-rose-500 text-white font-medium text-xs rounded-xl transition flex items-center gap-1.5 shrink-0"
            >
              {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Search className="w-3.5 h-3.5" />}
              <span>Search</span>
            </button>
          </form>

          {/* Quick Category Chips */}
          <div className="flex items-center gap-1.5 overflow-x-auto pb-1 text-xs">
            {QUICK_FILTERS.map((cat, idx) => (
              <button
                key={idx}
                onClick={() => {
                  setQuery(cat.query);
                  searchVideos(cat.query);
                }}
                className="px-2.5 py-1 rounded-lg bg-black/40 hover:bg-white/10 text-neutral-400 hover:text-white border border-white/6 whitespace-nowrap text-[11px] transition"
              >
                {cat.label}
              </button>
            ))}
          </div>
        </div>

        {/* Video Grid */}
        <div className="p-4 sm:p-5 overflow-y-auto flex-1">
          {loading ? (
            <div className="py-16 text-center text-neutral-400 flex flex-col items-center gap-2">
              <Loader2 className="w-6 h-6 animate-spin text-rose-500" />
              <span className="text-xs">Curating high-retention vertical footage...</span>
            </div>
          ) : clips.length > 0 ? (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
              {clips.map((clip, index) => {
                const isCurrent = beat.video_url === clip.url;
                const safeThumb = getSafeThumbnail(query, clip.thumbnail);

                return (
                  <div
                    key={index}
                    onClick={() => {
                      onSelectClip(beat.id, clip.url, safeThumb);
                      onClose();
                    }}
                    className={`group relative rounded-xl overflow-hidden border cursor-pointer transition ${
                      isCurrent
                        ? 'border-rose-500 ring-2 ring-rose-500/40'
                        : 'border-white/8 hover:border-white/20'
                    }`}
                  >
                    <div className="aspect-[9/16] bg-black/60 relative overflow-hidden">
                      <img
                        src={safeThumb}
                        alt="Stock preview"
                        referrerPolicy="no-referrer"
                        className="w-full h-full object-cover group-hover:scale-105 transition duration-300"
                        onError={(e) => {
                          (e.target as HTMLElement).style.display = 'none';
                        }}
                      />
                      <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-black/20" />

                      {clip.duration && (
                        <div className="absolute bottom-2 left-2 text-[10px] font-mono text-neutral-300 bg-black/70 px-1.5 py-0.5 rounded backdrop-blur-xs tabular-nums">
                          {clip.duration}s
                        </div>
                      )}

                      {isCurrent && (
                        <div className="absolute top-2 right-2 bg-rose-600 text-white p-1 rounded-md shadow-md">
                          <Check className="w-3.5 h-3.5" />
                        </div>
                      )}

                      <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition bg-black/40">
                        <span className="px-3 py-1.5 rounded-lg bg-rose-600 text-white font-semibold text-xs shadow-lg">
                          Select Clip
                        </span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="py-16 text-center text-neutral-400">
              <p className="text-xs">No clips found for this query.</p>
              <button
                onClick={() => searchVideos('focus desk coffee')}
                className="mt-2 text-xs text-rose-400 hover:text-rose-300 underline"
              >
                Browse general productivity clips
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
