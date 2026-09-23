import React, { useRef, useEffect, useState, useMemo } from 'react';
import {
  Play,
  Pause,
  RotateCcw,
  Volume2,
  VolumeX,
  Music,
  Download,
  Sliders,
  Sparkles,
  Maximize2,
  Loader2
} from 'lucide-react';
import { Beat, CaptionStyle, WordTiming } from '../types';
import { chunkWords } from '../utils/pipeline';
import { audioManager } from '../utils/audio';

interface ShortsPlayerProps {
  beats: Beat[];
  allWords: WordTiming[];
  captionStyle: CaptionStyle;
  currentTimestamp: number;
  isPlaying: boolean;
  onSeek: (time: number) => void;
  onTogglePlay: () => void;
  onReset: () => void;
  voiceName: string;
  musicEnabled: boolean;
  musicVolume: number;
  onToggleMusic: () => void;
  onMusicVolumeChange: (vol: number) => void;
}

export const ShortsPlayer: React.FC<ShortsPlayerProps> = ({
  beats,
  allWords,
  captionStyle,
  currentTimestamp,
  isPlaying,
  onSeek,
  onTogglePlay,
  onReset,
  voiceName,
  musicEnabled,
  musicVolume,
  onToggleMusic,
  onMusicVolumeChange,
}) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const [isExporting, setIsExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);

  const totalDuration = useMemo(() => {
    if (beats.length === 0) return 30;
    return Math.max(...beats.map(b => b.end_s), 10);
  }, [beats]);

  // Find active beat
  const activeBeat = useMemo(() => {
    if (beats.length === 0) return null;
    const found = beats.find(b => currentTimestamp >= b.start_s && currentTimestamp < b.end_s);
    return found || beats[beats.length - 1];
  }, [beats, currentTimestamp]);

  // Compute caption chunks
  const captionChunks = useMemo(() => {
    return chunkWords(allWords, captionStyle.wordsPerChunk);
  }, [allWords, captionStyle.wordsPerChunk]);

  // Find active caption chunk
  const activeChunk = useMemo(() => {
    return captionChunks.find(c => currentTimestamp >= c.start_s && currentTimestamp <= c.end_s);
  }, [captionChunks, currentTimestamp]);

  // Sync HTML5 video playback
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    if (activeBeat && video.src !== activeBeat.video_url && activeBeat.video_url) {
      video.src = activeBeat.video_url;
      video.load();
      video.currentTime = Math.max(0, currentTimestamp - activeBeat.start_s);
      if (isPlaying) {
        video.play().catch(() => {});
      }
    } else if (video && Math.abs(video.currentTime - (currentTimestamp - (activeBeat?.start_s || 0))) > 0.4) {
      video.currentTime = Math.max(0, currentTimestamp - (activeBeat?.start_s || 0));
    }

    if (isPlaying) {
      video.play().catch(() => {});
    } else {
      video.pause();
    }
  }, [activeBeat, isPlaying]);

  // Video Export Handler using Canvas + MediaRecorder
  const handleExportVideo = async () => {
    if (beats.length === 0 || isExporting) return;
    setIsExporting(true);
    setExportProgress(0);

    const canvas = document.createElement('canvas');
    canvas.width = 1080;
    canvas.height = 1920;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      setIsExporting(false);
      return;
    }

    try {
      const stream = canvas.captureStream(30);
      let recorder: MediaRecorder;
      const mimeTypes = ['video/webm;codecs=vp9', 'video/webm', 'video/mp4'];
      const supportedMime = mimeTypes.find(m => MediaRecorder.isTypeSupported(m)) || 'video/webm';

      recorder = new MediaRecorder(stream, {
        mimeType: supportedMime,
        videoBitsPerSecond: 8000000,
      });

      const chunks: Blob[] = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      };

      const exportPromise = new Promise<Blob>((resolve) => {
        recorder.onstop = () => {
          resolve(new Blob(chunks, { type: supportedMime }));
        };
      });

      recorder.start();

      // Preload video elements for all beats
      const videoElements: HTMLVideoElement[] = beats.map((b) => {
        const v = document.createElement('video');
        v.crossOrigin = 'anonymous';
        v.src = b.video_url;
        v.muted = true;
        v.loop = true;
        return v;
      });

      await Promise.all(videoElements.map(v => new Promise((res) => {
        v.onloadeddata = res;
        v.onerror = res;
        setTimeout(res, 2000);
      })));

      videoElements.forEach(v => v.play().catch(() => {}));

      const fps = 30;
      const totalFrames = Math.floor(totalDuration * fps);
      const dt = 1 / fps;

      for (let frame = 0; frame < totalFrames; frame++) {
        const t = frame * dt;
        setExportProgress(Math.round((frame / totalFrames) * 100));

        // Find active beat and video element
        const bIndex = beats.findIndex(b => t >= b.start_s && t < b.end_s);
        const activeIdx = bIndex !== -1 ? bIndex : 0;
        const currentV = videoElements[activeIdx];

        // Draw background video cover 1080x1920
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, 1080, 1920);

        if (currentV && currentV.videoWidth) {
          const vw = currentV.videoWidth;
          const vh = currentV.videoHeight;
          const targetRatio = 1080 / 1920;
          const srcRatio = vw / vh;

          let sx = 0, sy = 0, sw = vw, sh = vh;
          if (srcRatio > targetRatio) {
            sw = vh * targetRatio;
            sx = (vw - sw) / 2;
          } else {
            sh = vw / targetRatio;
            sy = (vh - sh) / 2;
          }
          ctx.drawImage(currentV, sx, sy, sw, sh, 0, 0, 1080, 1920);
        }

        // Draw active caption chunk
        const chunk = captionChunks.find(c => t >= c.start_s && t <= c.end_s);
        if (chunk) {
          ctx.save();
          ctx.font = `800 ${captionStyle.fontSize * 1.5}px 'Poppins', Impact, sans-serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';

          const textY = 1920 * (captionStyle.positionY / 100);
          const wordsInChunk = chunk.words;

          // Measure total width to center words with individual highlight
          const wordMetrics = wordsInChunk.map(w => ({
            word: w.word.toUpperCase().replace(/[.,!?;:]/g, ''),
            width: ctx.measureText(w.word.toUpperCase().replace(/[.,!?;:]/g, '') + ' ').width,
            isActive: t >= w.start_s && t <= w.end_s,
          }));

          const totalTextWidth = wordMetrics.reduce((acc, m) => acc + m.width, 0);
          let currentX = (1080 - totalTextWidth) / 2;

          // Draw dark background box for readability
          ctx.fillStyle = 'rgba(0,0,0,0.65)';
          const padX = 35;
          const padY = 20;
          const boxH = captionStyle.fontSize * 2.1;
          ctx.beginPath();
          ctx.roundRect(
            (1080 - totalTextWidth) / 2 - padX,
            textY - boxH / 2,
            totalTextWidth + padX * 2,
            boxH,
            24
          );
          ctx.fill();

          // Draw words
          wordMetrics.forEach((item) => {
            const wordCenterX = currentX + item.width / 2;

            // Stroke
            ctx.strokeStyle = captionStyle.strokeColor || '#000000';
            ctx.lineWidth = captionStyle.strokeWidth * 2;
            ctx.strokeText(item.word, wordCenterX, textY);

            // Fill
            ctx.fillStyle = item.isActive
              ? captionStyle.highlightColor
              : captionStyle.textColor;
            ctx.fillText(item.word, wordCenterX, textY);

            currentX += item.width;
          });

          ctx.restore();
        }

        // yield to keep browser responsive
        if (frame % 10 === 0) {
          await new Promise(r => setTimeout(r, 10));
        }
      }

      recorder.stop();
      videoElements.forEach(v => v.pause());

      const blob = await exportPromise;
      const downloadUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = downloadUrl;
      a.download = `viblo_short_${Date.now()}.${supportedMime.includes('mp4') ? 'mp4' : 'webm'}`;
      a.click();
      URL.revokeObjectURL(downloadUrl);
    } catch (err) {
      console.error('Video export error:', err);
    } finally {
      setIsExporting(false);
      setExportProgress(0);
    }
  };

  return (
    <div className="flex flex-col items-center">
      {/* 9:16 Vertical Screen Frame */}
      <div
        ref={containerRef}
        className="relative w-full max-w-[340px] sm:max-w-[360px] aspect-[9/16] rounded-3xl overflow-hidden shadow-2xl bg-black border-4 border-neutral-800 ring-1 ring-neutral-700/50 select-none group"
      >
        {/* Background video element */}
        <video
          ref={videoRef}
          muted
          loop
          playsInline
          className="w-full h-full object-cover pointer-events-none"
        />

        {/* Subtle top & bottom shadow gradient for contrast */}
        <div className="absolute inset-x-0 top-0 h-28 bg-gradient-to-b from-black/70 to-transparent pointer-events-none" />
        <div className="absolute inset-x-0 bottom-0 h-36 bg-gradient-to-t from-black/85 via-black/40 to-transparent pointer-events-none" />

        {/* Top Short Info Overlay */}
        <div className="absolute top-4 inset-x-4 flex items-center justify-between pointer-events-none">
          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-black/60 backdrop-blur-md border border-white/10 text-[11px] font-semibold text-white">
            <Sparkles className="w-3.5 h-3.5 text-rose-400" />
            Viblo 9:16 Shorts
          </div>
          <div className="px-2 py-0.5 rounded-full bg-black/60 backdrop-blur-md text-[11px] font-mono text-neutral-300">
            {currentTimestamp.toFixed(1)}s / {totalDuration.toFixed(1)}s
          </div>
        </div>

        {/* Active Beat Keyword pill */}
        {activeBeat && (
          <div className="absolute top-14 left-4 pointer-events-none">
            <span className="px-2 py-1 rounded-md bg-black/70 backdrop-blur-md border border-white/10 text-[10px] text-neutral-300 font-medium">
              🎬 {activeBeat.visual_keywords}
            </span>
          </div>
        )}

        {/* Active Synced Caption Chunk Burned-in Display */}
        {activeChunk && (
          <div
            className="absolute inset-x-4 pointer-events-none transition-all"
            style={{ top: `${captionStyle.positionY}%`, transform: 'translateY(-50%)' }}
          >
            <div className="flex flex-wrap items-center justify-center gap-1.5 px-4 py-2.5 rounded-2xl bg-black/75 backdrop-blur-sm border border-white/10 shadow-2xl mx-auto max-w-[90%]">
              {activeChunk.words.map((w, idx) => {
                const isWordActive = currentTimestamp >= w.start_s && currentTimestamp <= w.end_s;
                return (
                  <span
                    key={idx}
                    className="font-caption font-extrabold uppercase tracking-tight transition-transform duration-75 text-center"
                    style={{
                      fontSize: `${captionStyle.fontSize}px`,
                      color: isWordActive ? captionStyle.highlightColor : captionStyle.textColor,
                      textShadow: `
                        -2px -2px 0 ${captionStyle.strokeColor},
                        2px -2px 0 ${captionStyle.strokeColor},
                        -2px 2px 0 ${captionStyle.strokeColor},
                        2px 2px 0 ${captionStyle.strokeColor},
                        0 4px 10px rgba(0,0,0,0.8)
                      `,
                      transform: isWordActive ? 'scale(1.08)' : 'scale(1)',
                    }}
                  >
                    {w.word.replace(/[.,!?;:]/g, '')}
                  </span>
                );
              })}
            </div>
          </div>
        )}

        {/* Floating Quick Play / Pause Button in Center on hover */}
        <button
          onClick={onTogglePlay}
          className="absolute inset-0 flex items-center justify-center bg-black/20 opacity-0 group-hover:opacity-100 transition-opacity"
        >
          <div className="w-14 h-14 rounded-full bg-rose-600/90 text-white flex items-center justify-center shadow-lg transform transition hover:scale-110">
            {isPlaying ? <Pause className="w-6 h-6 fill-current" /> : <Play className="w-6 h-6 fill-current ml-1" />}
          </div>
        </button>

        {/* Progress Bar Inside Video */}
        <div className="absolute bottom-0 inset-x-0 h-1.5 bg-neutral-900/80">
          <div
            className="h-full bg-rose-500 transition-all"
            style={{ width: `${(currentTimestamp / totalDuration) * 100}%` }}
          />
        </div>
      </div>

      {/* Timeline Controls & Audio Settings */}
      <div className="w-full max-w-[360px] mt-4 space-y-3">
        {/* Timeline Scrubber */}
        <div className="space-y-1">
          <input
            type="range"
            min="0"
            max={totalDuration}
            step="0.05"
            value={currentTimestamp}
            onChange={(e) => onSeek(parseFloat(e.target.value))}
            className="w-full h-1.5 bg-neutral-800 rounded-lg appearance-none cursor-pointer accent-rose-500"
          />
          <div className="flex justify-between text-[11px] text-neutral-400 font-mono">
            <span>{currentTimestamp.toFixed(1)}s</span>
            <span>{totalDuration.toFixed(1)}s</span>
          </div>
        </div>

        {/* Playback action bar */}
        <div className="flex items-center justify-between gap-2 p-2 bg-neutral-900 border border-neutral-800 rounded-2xl">
          <div className="flex items-center gap-1">
            <button
              onClick={onReset}
              className="p-2 rounded-xl text-neutral-400 hover:text-white hover:bg-neutral-800 transition"
              title="Replay from start"
            >
              <RotateCcw className="w-4 h-4" />
            </button>

            <button
              onClick={onTogglePlay}
              className="px-4 py-2 rounded-xl bg-rose-600 hover:bg-rose-500 text-white text-xs font-semibold flex items-center gap-1.5 shadow-md transition"
            >
              {isPlaying ? <Pause className="w-4 h-4 fill-current" /> : <Play className="w-4 h-4 fill-current" />}
              {isPlaying ? 'Pause' : 'Play Short'}
            </button>
          </div>

          <div className="flex items-center gap-2">
            {/* Background Music toggle */}
            <button
              onClick={onToggleMusic}
              className={`p-2 rounded-xl border transition flex items-center gap-1 text-xs ${
                musicEnabled
                  ? 'bg-rose-950/60 border-rose-600/40 text-rose-300'
                  : 'bg-neutral-800 border-neutral-700 text-neutral-400'
              }`}
              title={musicEnabled ? 'Background music ON' : 'Background music OFF'}
            >
              <Music className="w-3.5 h-3.5" />
            </button>

            {/* Volume slider for background music */}
            {musicEnabled && (
              <input
                type="range"
                min="0.02"
                max="0.35"
                step="0.01"
                value={musicVolume}
                onChange={(e) => onMusicVolumeChange(parseFloat(e.target.value))}
                className="w-16 h-1 bg-neutral-700 rounded appearance-none cursor-pointer accent-rose-500"
                title={`Music Volume: ${Math.round(musicVolume * 100)}%`}
              />
            )}
          </div>
        </div>

        {/* Video Assembler & Export Action */}
        <button
          onClick={handleExportVideo}
          disabled={isExporting || beats.length === 0}
          className="w-full py-3 px-4 bg-gradient-to-r from-rose-600 to-red-600 hover:from-rose-500 hover:to-red-500 text-white font-semibold text-xs rounded-2xl shadow-lg transition flex items-center justify-center gap-2 disabled:opacity-50"
        >
          {isExporting ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              Rendering Vertical Video... {exportProgress}%
            </>
          ) : (
            <>
              <Download className="w-4 h-4" />
              Export & Download 1080x1920 Short
            </>
          )}
        </button>
      </div>
    </div>
  );
};
