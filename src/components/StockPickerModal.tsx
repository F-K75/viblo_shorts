import React, { useState, useEffect } from 'react';
import { Search, X, Check, Film, Loader2 } from 'lucide-react';
import { Beat } from '../types';

interface StockPickerModalProps {
  beat: Beat | null;
  isOpen: boolean;
  onClose: () => void;
  onSelectClip: (beatId: string, videoUrl: string, thumbnail?: string) => void;
}

export const StockPickerModal: React.FC<StockPickerModalProps> = ({
  beat,
  isOpen,
  onClose,
  onSelectClip,
}) => {
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [clips, setClips] = useState<any[]>([]);
  const [source, setSource] = useState<string>('');

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
      setSource(data.source || 'library');
    } catch (e) {
      console.error('Failed to search stock footage:', e);
    } finally {
      setLoading(false);
    }
  };

  if (!isOpen || !beat) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
      <div className="bg-neutral-900 border border-neutral-800 rounded-2xl max-w-2xl w-full max-h-[85vh] flex flex-col shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="p-4 border-b border-neutral-800 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Film className="w-5 h-5 text-rose-500" />
            <div>
              <h3 className="font-semibold text-white text-base">Select Stock Footage</h3>
              <p className="text-xs text-neutral-400">
                For beat: &ldquo;{beat.text.slice(0, 40)}...&rdquo;
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-lg text-neutral-400 hover:text-white hover:bg-neutral-800 transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Search bar */}
        <div className="p-4 border-b border-neutral-800 bg-neutral-950/50">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              searchVideos(query);
            }}
            className="flex gap-2"
          >
            <div className="relative flex-1">
              <Search className="w-4 h-4 text-neutral-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search vertical video keywords..."
                className="w-full pl-9 pr-3 py-2 bg-neutral-900 border border-neutral-700 rounded-xl text-sm text-white placeholder-neutral-500 focus:outline-none focus:border-rose-500"
              />
            </div>
            <button
              type="submit"
              disabled={loading}
              className="px-4 py-2 bg-rose-600 hover:bg-rose-500 text-white text-sm font-medium rounded-xl transition disabled:opacity-50 flex items-center gap-2"
            >
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Search'}
            </button>
          </form>
          {source === 'pexels' ? (
            <span className="inline-block mt-2 text-[11px] text-emerald-400">
              ● Connected to live Pexels Video API
            </span>
          ) : (
            <span className="inline-block mt-2 text-[11px] text-neutral-400">
              ● Royalty-free vertical HD video library
            </span>
          )}
        </div>

        {/* Video Grid */}
        <div className="p-4 overflow-y-auto flex-1 grid grid-cols-2 sm:grid-cols-3 gap-3">
          {loading ? (
            <div className="col-span-full py-16 flex flex-col items-center justify-center text-neutral-400">
              <Loader2 className="w-8 h-8 animate-spin text-rose-500 mb-2" />
              <p className="text-sm">Fetching vertical footage...</p>
            </div>
          ) : clips.length === 0 ? (
            <div className="col-span-full py-12 text-center text-neutral-500">
              No stock video found for &quot;{query}&quot;. Try generic keywords like &quot;laptop&quot;, &quot;city&quot;, &quot;clock&quot;.
            </div>
          ) : (
            clips.map((clip, idx) => {
              const isSelected = beat.video_url === clip.url;
              return (
                <div
                  key={clip.id || idx}
                  onClick={() => {
                    onSelectClip(beat.id, clip.url, clip.thumbnail);
                    onClose();
                  }}
                  className={`group relative rounded-xl overflow-hidden aspect-[9/16] bg-neutral-800 border-2 cursor-pointer transition-all hover:scale-[1.02] ${
                    isSelected ? 'border-rose-500 ring-2 ring-rose-500/30' : 'border-neutral-800 hover:border-neutral-600'
                  }`}
                >
                  <video
                    src={clip.url}
                    poster={clip.thumbnail}
                    muted
                    loop
                    playsInline
                    onMouseEnter={(e) => (e.target as HTMLVideoElement).play()}
                    onMouseLeave={(e) => {
                      const v = e.target as HTMLVideoElement;
                      v.pause();
                      v.currentTime = 0;
                    }}
                    className="w-full h-full object-cover"
                  />
                  {clip.duration && (
                    <span className="absolute top-2 right-2 px-1.5 py-0.5 rounded bg-black/70 text-[10px] text-white font-mono">
                      {Math.round(clip.duration)}s
                    </span>
                  )}
                  {isSelected && (
                    <div className="absolute top-2 left-2 bg-rose-600 text-white p-1 rounded-full">
                      <Check className="w-3.5 h-3.5" />
                    </div>
                  )}
                  <div className="absolute inset-x-0 bottom-0 p-2 bg-gradient-to-t from-black/80 via-black/40 to-transparent text-[11px] text-white flex items-center justify-between opacity-0 group-hover:opacity-100 transition">
                    <span>Click to select</span>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
};
