import React, { useRef, useEffect, useState, useMemo } from 'react';
import {
  Play,
  Pause,
  RotateCcw,
  Volume2,
  VolumeX,
  Music,
  Download,
  Sparkles,
  Loader2,
  Youtube,
  Layers,
  Flame,
  Mic,
  MicOff,
  Subtitles,
  Eye,
  EyeOff,
  ShieldAlert,
  FileVideo,
  X,
  ScanFace,
} from 'lucide-react';
import { Beat, CaptionStyle, WordTiming, VisualSourceMode, AudioSourceMode } from '../types';
import { chunkWords, applyCaptionOffset } from '../utils/pipeline';
import { audioManager, MusicMood } from '../utils/audio';
import { apiFetch, apiErrorMessage } from '../utils/api';
import { getSafeThumbnail, getSafeVideoUrl, isPlaceholderImage } from '../utils/visualPlaceholders';
import { drawCaptionChunk, drawMotionBackground, drawSourceFrame } from '../utils/exportCanvas';
import { analyzeSubjectTrack, cropCenterAt, cropXAt, objectPositionPercent, type CropPath } from '../utils/smartCrop';

function formatSecondsToTimestamp(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m < 10 ? '0' : ''}${m}:${s < 10 ? '0' : ''}${s}`;
}

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
  onSelectVoiceName?: (name: string) => void;
  aiVoiceEnabled?: boolean;
  onToggleAiVoice?: () => void;
  musicEnabled: boolean;
  musicVolume: number;
  onToggleMusic: () => void;
  onMusicVolumeChange: (vol: number) => void;
  sourceYouTubeId?: string;
  sourceYouTubeTitle?: string;
  viralScore?: number;
  clipStartSeconds?: number;
  onUpdateClipStartSeconds?: (startSeconds: number) => void;
  audioSourceMode?: AudioSourceMode;
  onChangeAudioSourceMode?: (mode: AudioSourceMode) => void;
  captionOffsetSeconds?: number;
  onUpdateCaptionOffset?: (offset: number) => void;
  onUpdateCaptionStyle?: (updates: Partial<CaptionStyle>) => void;
  visualMode?: VisualSourceMode;
  onChangeVisualMode?: (mode: VisualSourceMode) => void;
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
  onSelectVoiceName,
  aiVoiceEnabled = false,
  onToggleAiVoice,
  musicEnabled,
  musicVolume,
  onToggleMusic,
  onMusicVolumeChange,
  sourceYouTubeId,
  sourceYouTubeTitle,
  viralScore,
  clipStartSeconds = 0,
  onUpdateClipStartSeconds,
  audioSourceMode = 'youtube',
  onChangeAudioSourceMode,
  captionOffsetSeconds = 0,
  onUpdateCaptionOffset,
  onUpdateCaptionStyle,
  visualMode: propVisualMode,
  onChangeVisualMode,
}) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const wasPlayingRef = useRef(false);
  const messageStateRef = useRef({
    audioMode: 'youtube' as AudioSourceMode,
    isYoutubeMuted: false,
    youtubeVolume: 1.0,
    clipStartSec: clipStartSeconds,
    isPlaying,
    currentTimestamp,
    onSeek,
  });

  const [isExporting, setIsExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);
  const [exportResolution, setExportResolution] = useState<'1080p' | '720p'>('1080p');
  const [exportError, setExportError] = useState<string | null>(null);
  const isYouTubeSource = Boolean(sourceYouTubeId);
  const [musicMood, setMusicMood] = useState<MusicMood>('lofi');
  const [videoLoaded, setVideoLoaded] = useState(false);
  const [videoError, setVideoError] = useState(false);
  const [visualMode, setVisualMode] = useState<VisualSourceMode>(
    propVisualMode || (sourceYouTubeId ? 'youtube-crop' : 'split')
  );
  const [showSafeZones, setShowSafeZones] = useState(false);

  // YouTube Audio Sync State - locked to original YouTube audio when source is YouTube
  const [audioMode, setAudioMode] = useState<AudioSourceMode>('youtube');
  const [youtubeVolume, setYoutubeVolume] = useState(1.0);
  const [isYoutubeMuted, setIsYoutubeMuted] = useState(false);
  const [clipStartSec, setClipStartSec] = useState<number>(clipStartSeconds);

  // The user's own copy of the source video (local file, never uploaded). YouTube's embedded player cannot be
  // recorded, so this is what puts the real footage and the speaker's audio into exported clips.
  // `offset`: source time at which the file starts (a downloaded YouTube section starts before the clip; a full
  // local copy starts at 0). Source time for playhead t = clip start + t, so file time = that minus offset.
  const [sourceFile, setSourceFile] = useState<{ url: string; name: string; offset: number; end?: number } | null>(null);
  const sourceOffset = sourceFile?.offset ?? 0;
  const sourceStartSec = Math.max(0, clipStartSec - sourceOffset);
  const [ytDownloadEnabled, setYtDownloadEnabled] = useState(false);
  const [rightsConfirmed, setRightsConfirmed] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);
  useEffect(() => {
    if (!sourceYouTubeId) return;
    let alive = true;
    fetch('/api/config')
      .then((r) => (r.ok ? r.json() : null))
      .then((c) => alive && setYtDownloadEnabled(Boolean(c?.features?.youtubeDownload)))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [sourceYouTubeId]);
  const handleDownloadFromYouTube = async () => {
    if (!sourceYouTubeId || isDownloading) return;
    setIsDownloading(true);
    setExportError(null);
    try {
      const clipLen = beats.length ? Math.max(...beats.map((b) => b.end_s)) : 30;
      const r = await apiFetch('/api/youtube/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: `https://www.youtube.com/watch?v=${sourceYouTubeId}`,
          startSeconds: clipStartSec,
          endSeconds: clipStartSec + clipLen,
          rightsConfirmed,
        }),
      });
      if (!r.ok) throw new Error(await apiErrorMessage(r, 'YouTube download failed.'));
      const d = await r.json();
      const fileRes = await apiFetch(`/api/youtube/download/${d.downloadId}`);
      if (!fileRes.ok) throw new Error(await apiErrorMessage(fileRes, 'Could not load the downloaded footage.'));
      const blob = await fileRes.blob();
      setSourceFile({ url: URL.createObjectURL(blob), name: `YouTube footage (${Math.round(d.offsetSeconds)}s–${Math.round(d.endSeconds)}s)`, offset: d.offsetSeconds, end: d.endSeconds });
    } catch (e: any) {
      setExportError(e?.message || 'YouTube download failed.');
    } finally {
      setIsDownloading(false);
    }
  };
  const sourceVideoRef = useRef<HTMLVideoElement>(null);
  const useSourceFile = Boolean(sourceFile) && visualMode !== 'b-roll';
  useEffect(() => () => {
    if (sourceFile) URL.revokeObjectURL(sourceFile.url);
  }, [sourceFile]);
  const handlePickSourceFile = (file: File | undefined) => {
    if (!file) return;
    if (!file.type.startsWith('video/') && !/\.(mp4|webm|mov|m4v|mkv)$/i.test(file.name)) {
      setExportError('Please choose a video file (MP4, WebM or MOV).');
      return;
    }
    setExportError(null);
    setSourceFile({ url: URL.createObjectURL(file), name: file.name, offset: 0 });
  };

  // A downloaded section only covers the range it was fetched for; if the clip moves outside it, drop it.
  useEffect(() => {
    if (!sourceFile?.end) return;
    const clipLen = beats.length ? Math.max(...beats.map((b) => b.end_s)) : 0;
    if (clipStartSec < sourceFile.offset - 0.05 || clipStartSec + clipLen > sourceFile.end + 0.05) {
      setSourceFile(null);
      setExportError('The clip range moved outside the downloaded footage. Get the footage again for the new range.');
    }
  }, [clipStartSec, beats, sourceFile]);

  // Keep the local source video on the clip timeline: source time = clip start + playhead.
  useEffect(() => {
    const v = sourceVideoRef.current;
    if (!v || !useSourceFile) return;
    const target = sourceStartSec + currentTimestamp;
    if (Math.abs(v.currentTime - target) > 0.3) v.currentTime = target;
    v.volume = youtubeVolume;
    if (isPlaying && v.paused) v.play().catch(() => {});
    if (!isPlaying && !v.paused) v.pause();
  }, [isPlaying, currentTimestamp, sourceStartSec, useSourceFile, youtubeVolume]);

  useEffect(() => {
    if (propVisualMode) {
      setVisualMode(propVisualMode);
    }
  }, [propVisualMode]);

  const handleSetVisualMode = (mode: VisualSourceMode) => {
    setVisualMode(mode);
    onChangeVisualMode?.(mode);
  };

  useEffect(() => {
    if (sourceYouTubeId) {
      setVisualMode('youtube-crop');
      setAudioMode('youtube');
    }
  }, [sourceYouTubeId]);

  useEffect(() => {
    setClipStartSec(clipStartSeconds);
  }, [clipStartSeconds]);

  useEffect(() => {
    if (audioSourceMode) {
      setAudioMode(audioSourceMode);
    }
  }, [audioSourceMode]);

  const postToYouTube = (func: string, args: any[] = []) => {
    if (!iframeRef.current || !iframeRef.current.contentWindow) return;
    try {
      iframeRef.current.contentWindow.postMessage(
        JSON.stringify({ event: 'command', func, args }),
        '*'
      );
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    if (!sourceYouTubeId) return;

    if (isPlaying) {
      postToYouTube('setOption', ['captions', 'track', {}]);
      postToYouTube('unloadModule', ['captions']);
      postToYouTube('unloadModule', ['cc']);

      if (audioMode === 'youtube') {
        if (!isYoutubeMuted) {
          postToYouTube('unMute');
          postToYouTube('setVolume', [Math.round(youtubeVolume * 100)]);
        } else {
          postToYouTube('mute');
        }
      } else {
        postToYouTube('mute');
      }

      const targetTime = clipStartSec + currentTimestamp;
      postToYouTube('seekTo', [targetTime, true]);
      postToYouTube('playVideo');
    } else {
      postToYouTube('pauseVideo');
    }
  }, [isPlaying, sourceYouTubeId, audioMode, isYoutubeMuted, youtubeVolume, clipStartSec]);

  useEffect(() => {
    messageStateRef.current = {
      audioMode,
      isYoutubeMuted,
      youtubeVolume,
      clipStartSec,
      isPlaying,
      currentTimestamp,
      onSeek,
    };
  }, [audioMode, isYoutubeMuted, youtubeVolume, clipStartSec, isPlaying, currentTimestamp, onSeek]);

  useEffect(() => {
    const handleWindowMessage = (e: MessageEvent) => {
      try {
        const data = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
        const {
          audioMode: curAudioMode,
          isYoutubeMuted: curIsYoutubeMuted,
          youtubeVolume: curYoutubeVolume,
          clipStartSec: curClipStartSec,
          isPlaying: curIsPlaying,
          currentTimestamp: curTimestamp,
          onSeek: curOnSeek,
        } = messageStateRef.current;

        if (data?.event === 'onReady') {
          postToYouTube('listening');
          postToYouTube('setOption', ['captions', 'track', {}]);
          postToYouTube('unloadModule', ['captions']);
          postToYouTube('unloadModule', ['cc']);
          if (curAudioMode === 'youtube' && !curIsYoutubeMuted) {
            postToYouTube('unMute');
            postToYouTube('setVolume', [Math.round(curYoutubeVolume * 100)]);
          }
        }
        if (data?.event === 'infoDelivery' && typeof data?.info?.currentTime === 'number') {
          const ytTime = data.info.currentTime;
          const clipTime = Math.max(0, ytTime - curClipStartSec);
          if (curIsPlaying && Math.abs(curTimestamp - clipTime) > 0.35) {
            curOnSeek(clipTime);
          }
        }
      } catch {
        // ignore
      }
    };
    window.addEventListener('message', handleWindowMessage);
    return () => window.removeEventListener('message', handleWindowMessage);
  }, []);

  useEffect(() => {
    if (!isPlaying || !sourceYouTubeId || audioMode !== 'youtube') return;
    const pollInterval = setInterval(() => {
      postToYouTube('getCurrentTime');
    }, 250);
    return () => clearInterval(pollInterval);
  }, [isPlaying, sourceYouTubeId, audioMode]);

  const handleSetAudioMode = (mode: AudioSourceMode) => {
    setAudioMode(mode);
    if (onChangeAudioSourceMode) {
      onChangeAudioSourceMode(mode);
    }
    if (mode === 'youtube') {
      audioManager.stopSpeech();
      if (isPlaying && !isYoutubeMuted) {
        postToYouTube('unMute');
        postToYouTube('setVolume', [Math.round(youtubeVolume * 100)]);
      }
    } else {
      postToYouTube('mute');
    }
  };

  const handlePlayerSeek = (newTime: number) => {
    onSeek(newTime);
    if (sourceYouTubeId) {
      const targetTime = clipStartSec + newTime;
      postToYouTube('seekTo', [targetTime, true]);
      if (isPlaying) postToYouTube('playVideo');
    }
  };

  const handlePlayerReset = () => {
    onReset();
    if (sourceYouTubeId) {
      postToYouTube('seekTo', [clipStartSec, true]);
      if (isPlaying) postToYouTube('playVideo');
    }
  };

  const totalDuration = useMemo(() => {
    if (beats.length === 0) return 30;
    return Math.max(...beats.map((b) => b.end_s), 10);
  }, [beats]);

  // Speaker-aware Vertical Fill: a centre crop cuts off speakers who stand left or right of centre, so the clip range
  // of the source file is analysed (in the background; playback isn't blocked) and the 9:16 window follows the subject.
  const [autoFrame, setAutoFrame] = useState(true);
  const [cropTrack, setCropTrack] = useState<{ key: string; path: CropPath } | null>(null);
  const [isFindingSpeaker, setIsFindingSpeaker] = useState(false);
  const cropAnalysisRef = useRef<Promise<{ key: string; path: CropPath } | null> | null>(null);
  const smartCropOn = useSourceFile && autoFrame && visualMode === 'youtube-crop';
  const cropKey = sourceFile ? `${sourceFile.url}|${sourceStartSec.toFixed(2)}|${totalDuration.toFixed(2)}` : '';
  const cropPath = smartCropOn && cropTrack?.key === cropKey ? cropTrack.path : null;
  useEffect(() => {
    if (!smartCropOn || !sourceFile || cropTrack?.key === cropKey) return;
    const ac = new AbortController();
    const key = cropKey;
    setIsFindingSpeaker(true);
    cropAnalysisRef.current = analyzeSubjectTrack(sourceFile.url, sourceStartSec, sourceStartSec + totalDuration, { signal: ac.signal })
      .then(({ path }) => {
        if (ac.signal.aborted) return null;
        setCropTrack({ key, path });
        return { key, path };
      })
      .catch(() => null) // a nicety, never a blocker: on failure the centre crop stays
      .finally(() => {
        if (!ac.signal.aborted) setIsFindingSpeaker(false);
      });
    // A new file, range or mode cancels the running analysis.
    return () => {
      ac.abort();
      setIsFindingSpeaker(false);
    };
  }, [smartCropOn, cropKey]);

  const activeBeat = useMemo(() => {
    if (beats.length === 0) return null;
    const found = beats.find((b) => currentTimestamp >= b.start_s && currentTimestamp < b.end_s);
    return found || beats[beats.length - 1];
  }, [beats, currentTimestamp]);

  useEffect(() => {
    setVideoLoaded(false);
    setVideoError(false);
  }, [activeBeat?.id, activeBeat?.video_url]);

  const effectiveWords = useMemo(() => {
    return applyCaptionOffset(allWords, captionOffsetSeconds || 0);
  }, [allWords, captionOffsetSeconds]);

  const captionChunks = useMemo(() => {
    return chunkWords(effectiveWords, captionStyle.wordsPerChunk);
  }, [effectiveWords, captionStyle.wordsPerChunk]);

  const activeChunk = useMemo(() => {
    if (captionChunks.length === 0) return null;
    const direct = captionChunks.find((c) => currentTimestamp >= c.start_s && currentTimestamp <= c.end_s);
    if (direct) return direct;
    const prev = [...captionChunks].reverse().find((c) => currentTimestamp >= c.start_s);
    if (prev && currentTimestamp <= prev.end_s + 0.35) {
      return prev;
    }
    return null;
  }, [captionChunks, currentTimestamp]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const targetUrl = getSafeVideoUrl(activeBeat?.visual_keywords, activeBeat?.video_url);
    const targetTime = Math.max(0, currentTimestamp - (activeBeat?.start_s || 0));
    const srcChanged = video.src !== targetUrl;

    if (srcChanged) {
      video.src = targetUrl;
      video.load();
      video.currentTime = targetTime;
    } else if (Math.abs(video.currentTime - targetTime) > 0.4) {
      video.currentTime = targetTime;
    }

    if (isPlaying) {
      if (srcChanged || !wasPlayingRef.current || video.paused) {
        video.play().catch(() => {});
      }
    } else if (!video.paused) {
      video.pause();
    }

    wasPlayingRef.current = isPlaying;
  }, [activeBeat, isPlaying, currentTimestamp]);

  // Video Export Handler using Canvas + MediaRecorder with mixed audio
  const handleExportVideo = async () => {
    if (beats.length === 0 || isExporting) return;
    if (typeof MediaRecorder === 'undefined') {
      setExportError('Your browser does not support in-browser video recording. Please use a recent Chrome, Edge or Firefox.');
      return;
    }
    setIsExporting(true);
    setExportProgress(0);
    setExportError(null);

    const canvasW = exportResolution === '720p' ? 720 : 1080;
    const canvasH = exportResolution === '720p' ? 1280 : 1920;

    const canvas = document.createElement('canvas');
    canvas.width = canvasW;
    canvas.height = canvasH;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      setIsExporting(false);
      return;
    }

    try {
      const audioRunning = await audioManager.ensureRunning();
      // The user's own source video: real footage + original speech. Music is ducked under the speech.
      let sourceVideo: HTMLVideoElement | null = null;
      let disconnectSource: (() => void) | null = null;
      const sourceAudible = useSourceFile && audioMode === 'youtube' && !isYoutubeMuted;
      // Export follows the speaker too; if analysis is still running, wait for it rather than export a centre crop.
      let exportCropPath: CropPath | null = cropPath;
      if (!exportCropPath && smartCropOn && cropAnalysisRef.current) {
        const done = await cropAnalysisRef.current;
        if (done?.key === cropKey) exportCropPath = done.path;
      }
      if (useSourceFile && sourceFile) {
        sourceVideo = document.createElement('video');
        sourceVideo.src = sourceFile.url;
        sourceVideo.playsInline = true;
        sourceVideo.preload = 'auto';
        sourceVideo.muted = !sourceAudible;
        sourceVideo.volume = youtubeVolume;
        await new Promise<void>((resolve, reject) => {
          sourceVideo!.onloadedmetadata = () => resolve();
          sourceVideo!.onerror = () => reject(new Error('could not read the source video file'));
        });
        sourceVideo.currentTime = Math.min(sourceStartSec, Math.max(0, sourceVideo.duration - 0.1));
        await new Promise((r) => {
          sourceVideo!.onseeked = r;
          setTimeout(r, 3000);
        });
        if (sourceAudible && audioRunning) disconnectSource = audioManager.connectElementToExport(sourceVideo);
      }
      if (musicEnabled) {
        audioManager.startBackgroundMusic(sourceAudible ? musicVolume * 0.3 : musicVolume, musicMood);
      }
      // Only attach an audio track when the audio graph is running; a dead track stalls the muxer.
      const audioTrack = audioRunning ? audioManager.getExportAudioStream() : null;
      // captureStream(0) + requestFrame(): emit exactly one frame per drawn frame. With captureStream(30),
      // Chromium only emits frames when it decides the canvas changed, which dropped most frames of static scenes.
      const videoTrack = canvas.captureStream(0).getVideoTracks()[0] as MediaStreamTrack & { requestFrame?: () => void };
      const combinedStream = audioTrack
        ? new MediaStream([videoTrack, audioTrack])
        : new MediaStream([videoTrack]);

      // Prefer H.264: it is hardware-accelerated almost everywhere, YouTube's preferred upload codec, and
      // in testing it was the only codec that kept up with real-time 1080p capture on a 4-core machine
      // (VP8/VP9 software encoders dropped most frames).
      const mimeTypes = [
        'video/mp4;codecs=avc1.42E028,mp4a.40.2',
        'video/mp4;codecs=avc1.42E028',
        'video/mp4;codecs=avc1',
        'video/webm;codecs=h264,opus',
        'video/webm;codecs=h264',
        'video/mp4',
        'video/webm;codecs=vp9',
        'video/webm',
      ];
      const supportedMime = mimeTypes.find((m) => MediaRecorder.isTypeSupported(m)) || 'video/webm';

      const recorder = new MediaRecorder(combinedStream, {
        mimeType: supportedMime,
        videoBitsPerSecond: exportResolution === '720p' ? 4500000 : 9000000,
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

      recorder.start(1000); // timeslice: stream chunks out instead of buffering the whole video in the encoder

      const videoElements: HTMLVideoElement[] = beats.map((b) => {
        const v = document.createElement('video');
        v.crossOrigin = 'anonymous';
        v.src = b.video_url;
        v.muted = true;
        v.loop = true;
        return v;
      });

      const imageElements: HTMLImageElement[] = beats.map((b) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.src = getSafeThumbnail(b.visual_keywords, b.thumbnail);
        return img;
      });

      await Promise.all([
        ...videoElements.map((v) => new Promise((res) => {
          v.onloadeddata = res;
          v.onerror = res;
          setTimeout(res, 1200);
        })),
        ...imageElements.map((img) => new Promise((res) => {
          img.onload = res;
          img.onerror = res;
          setTimeout(res, 1200);
        })),
      ]);

      videoElements.forEach((v) => v.play().catch(() => {}));
      if (sourceVideo) await sourceVideo.play().catch(() => {});

      // MediaRecorder captures in WALL-CLOCK time, so frames must be drawn in real time.
      // (Previously the loop ran ~3x faster than real time and a 33s Short exported as ~10s.)
      const fps = 30;
      const frameMs = 1000 / fps;
      const startWall = performance.now();
      const narrate = aiVoiceEnabled && !(isYouTubeSource && audioSourceMode === 'youtube');
      let lastSpokenBeat = -1;
      let frame = 0;

      while (true) {
        const t = (performance.now() - startWall) / 1000;
        if (t >= totalDuration) break;
        if (frame % 10 === 0) setExportProgress(Math.min(99, Math.round((t / totalDuration) * 100)));

        const bIndex = beats.findIndex((b) => t >= b.start_s && t < b.end_s);
        const activeIdx = bIndex !== -1 ? bIndex : 0;
        const currentV = videoElements[activeIdx];
        const currentImg = imageElements[activeIdx];
        const currentBeat = beats[activeIdx];
        if (narrate && bIndex !== -1 && bIndex !== lastSpokenBeat) {
          lastSpokenBeat = bIndex;
          // Neural TTS audio is routed into the export stream by audioManager.
          void audioManager.speakNeuralOrFallback(currentBeat.text, voiceName);
        }

        ctx.fillStyle = '#0a0a0a';
        ctx.fillRect(0, 0, canvasW, canvasH);
        const drawMotion = () =>
          drawMotionBackground(ctx, {
            t,
            beatIndex: activeIdx,
            beatCount: beats.length,
            beatProgress: currentBeat ? Math.max(0, Math.min(1, (t - currentBeat.start_s) / Math.max(0.5, currentBeat.end_s - currentBeat.start_s))) : 0,
            beatElapsed: currentBeat ? Math.max(0, t - currentBeat.start_s) : t,
            text: currentBeat?.text,
            keywords: currentBeat?.visual_keywords,
            w: canvasW,
            h: canvasH,
          });

        try {
          if (sourceVideo && sourceVideo.videoWidth) {
            // Keep footage on the wall clock (the recorder is real time): resync only on real drift.
            const want = sourceStartSec + t;
            if (Math.abs(sourceVideo.currentTime - want) > 0.35 && !sourceVideo.seeking) sourceVideo.currentTime = want;
            const cropCenter = exportCropPath ? cropCenterAt(exportCropPath, sourceVideo.currentTime) : 0.5;
            drawSourceFrame(ctx, sourceVideo, visualMode === 'youtube-fit' ? 'fit' : 'fill', canvasW, canvasH, cropCenter);
          } else if (currentV && currentV.videoWidth) {
            const vw = currentV.videoWidth;
            const vh = currentV.videoHeight;
            const targetRatio = canvasW / canvasH;
            const srcRatio = vw / vh;

            let sx = 0, sy = 0, sw = vw, sh = vh;
            if (srcRatio > targetRatio) {
              sw = vh * targetRatio;
              sx = (vw - sw) / 2;
            } else {
              sh = vw / targetRatio;
              sy = (vh - sh) / 2;
            }
            ctx.drawImage(currentV, sx, sy, sw, sh, 0, 0, canvasW, canvasH);
          } else if (currentImg && currentImg.naturalWidth && !isPlaceholderImage(currentImg.src)) {
            const iw = currentImg.naturalWidth;
            const ih = currentImg.naturalHeight;
            const targetRatio = canvasW / canvasH;
            const srcRatio = iw / ih;

            let sx = 0, sy = 0, sw = iw, sh = ih;
            if (srcRatio > targetRatio) {
              sw = ih * targetRatio;
              sx = (iw - sw) / 2;
            } else {
              sh = iw / targetRatio;
              sy = (ih - sh) / 2;
            }

            const beatProgress = currentBeat
              ? Math.max(0, Math.min(1, (t - currentBeat.start_s) / Math.max(0.5, currentBeat.end_s - currentBeat.start_s)))
              : 0;
            const scale = 1.0 + (beatProgress * 0.08);

            ctx.save();
            ctx.translate(canvasW / 2, canvasH / 2);
            ctx.scale(scale, scale);
            ctx.translate(-canvasW / 2, -canvasH / 2);
            ctx.drawImage(currentImg, sx, sy, sw, sh, 0, 0, canvasW, canvasH);
            ctx.restore();
          } else {
            drawMotion();
          }
        } catch {
          // CORS-tainted or undecodable media: keep the frame alive with the motion background
          drawMotion();
        }

        const chunk = captionChunks.find((c) => t >= c.start_s && t <= c.end_s);
        if (captionStyle.showCaptions !== false && chunk) {
          drawCaptionChunk(ctx, { words: chunk.words, t, style: captionStyle, w: canvasW, h: canvasH });
        }

        videoTrack.requestFrame?.();
        frame++;
        const wait = startWall + frame * frameMs - performance.now();
        await new Promise((r) => setTimeout(r, Math.max(0, wait)));
      }

      recorder.stop();
      audioManager.stopSpeech();
      videoElements.forEach((v) => v.pause());
      if (sourceVideo) {
        sourceVideo.pause();
        disconnectSource?.();
        sourceVideo.removeAttribute('src');
        sourceVideo.load();
      }

      const blob = await exportPromise;
      const downloadUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = downloadUrl;
      const extension = supportedMime.includes('mp4') ? 'mp4' : 'webm';
      a.download = `forge_short_${exportResolution}_${Date.now()}.${extension}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Revoking immediately can cancel the download in some browsers.
      setTimeout(() => URL.revokeObjectURL(downloadUrl), 60_000);
    } catch (err: any) {
      console.error('Video export error:', err);
      setExportError(`Export failed: ${err?.message || 'unknown error'}. Please try again, or use 720p.`);
    } finally {
      if (!isPlaying) {
        audioManager.stopBackgroundMusic();
      }
      setIsExporting(false);
      setExportProgress(0);
    }
  };

  const safeActiveThumb = getSafeThumbnail(activeBeat?.visual_keywords, activeBeat?.thumbnail);

  return (
    <div className="w-full max-w-[360px] flex flex-col items-center select-none">
      {/* Studio Monitor Top Bar */}
      <div className="w-full flex items-center justify-between pb-2 text-xs text-neutral-400">
        <div className="flex items-center gap-1.5">
          <span className="font-semibold text-white">9:16 Canvas</span>
          <span aria-hidden="true">·</span>
          <span className="font-mono text-[11px] text-neutral-400">
            {sourceYouTubeId ? (visualMode === 'youtube-crop' ? 'YT Fill' : visualMode === 'youtube-fit' ? 'YT Fit' : 'B-Roll') : 'HD B-Roll'}
          </span>
        </div>

        <div className="flex items-center gap-1.5">
          {sourceYouTubeId && (
            <div className="flex items-center bg-black/40 border border-white/8 rounded-lg p-0.5 text-[10px]">
              <button
                type="button"
                onClick={() => handleSetVisualMode('youtube-crop')}
                className={`px-1.5 py-0.5 rounded transition ${visualMode === 'youtube-crop' ? 'bg-rose-600 text-white font-semibold' : 'text-neutral-400 hover:text-white'}`}
                title="Vertical Fill: Fill 9:16 vertical canvas"
              >
                Fill
              </button>
              <button
                type="button"
                onClick={() => handleSetVisualMode('youtube-fit')}
                className={`px-1.5 py-0.5 rounded transition ${visualMode === 'youtube-fit' ? 'bg-rose-600 text-white font-semibold' : 'text-neutral-400 hover:text-white'}`}
                title="Letterbox Fit: 16:9 frame with ambient background"
              >
                Fit
              </button>
              <button
                type="button"
                onClick={() => handleSetVisualMode('b-roll')}
                className={`px-1.5 py-0.5 rounded transition ${visualMode === 'b-roll' ? 'bg-rose-600 text-white font-semibold' : 'text-neutral-400 hover:text-white'}`}
                title="Stock B-Roll: Vertical stock video loops matching your keywords"
              >
                B-Roll
              </button>
            </div>
          )}

          <button
            type="button"
            onClick={() => setShowSafeZones(!showSafeZones)}
            className={`px-1.5 py-0.5 rounded text-[10px] font-medium border transition flex items-center gap-1 ${
              showSafeZones
                ? 'bg-rose-500/10 border-rose-500/30 text-rose-300'
                : 'bg-black/30 border-white/8 text-neutral-400 hover:text-white'
            }`}
            title="Toggle YouTube Shorts UI overlay guidelines"
          >
            <ShieldAlert className="w-3 h-3" />
            <span>{showSafeZones ? 'Safe ON' : 'Safe'}</span>
          </button>
        </div>
      </div>

      {/* 9:16 Vertical Screen Frame */}
      <div
        ref={containerRef}
        className="relative w-full aspect-[9/16] rounded-3xl overflow-hidden shadow-2xl bg-black border border-white/12 select-none group"
      >
        {/* Visual Layer: YouTube Video OR Vertical B-Roll */}
        {useSourceFile && sourceFile ? (
          <div className="absolute inset-0 overflow-hidden bg-black flex items-center justify-center">
            <video
              ref={sourceVideoRef}
              src={sourceFile.url}
              playsInline
              preload="auto"
              muted={audioMode !== 'youtube' || isYoutubeMuted}
              onLoadedMetadata={(e) => {
                e.currentTarget.currentTime = sourceStartSec + currentTimestamp;
              }}
              className={`w-full h-full pointer-events-none ${visualMode === 'youtube-fit' ? 'object-contain' : 'object-cover'}`}
              style={
                cropPath && visualMode === 'youtube-crop'
                  ? { objectPosition: `${objectPositionPercent(cropXAt(cropPath, sourceStartSec + currentTimestamp), cropPath.cropFrac)}% 50%` }
                  : undefined
              }
            />
          </div>
        ) : sourceYouTubeId && visualMode !== 'b-roll' ? (
          visualMode === 'youtube-fit' ? (
            <div className="absolute inset-0 overflow-hidden bg-black flex items-center justify-center">
              {/* Ambient blurred backdrop of original YouTube video */}
              <img
                src={`https://i.ytimg.com/vi/${sourceYouTubeId}/hqdefault.jpg`}
                alt="Ambient backdrop"
                className="absolute inset-0 w-full h-full object-cover blur-2xl opacity-50 scale-125 pointer-events-none"
              />
              <div className="relative w-full aspect-video shadow-2xl z-10 overflow-hidden border-y border-white/10 bg-black">
                {/* Fallback image if iframe has not yet rendered */}
                <img
                  src={`https://i.ytimg.com/vi/${sourceYouTubeId}/hqdefault.jpg`}
                  alt="YouTube Thumbnail"
                  className="absolute inset-0 w-full h-full object-cover pointer-events-none"
                />
                <iframe
                  ref={iframeRef}
                  src={`https://www.youtube.com/embed/${sourceYouTubeId}?enablejsapi=1&autoplay=0&controls=0&disablekb=1&fs=0&loop=1&playlist=${sourceYouTubeId}&playsinline=1&rel=0&modestbranding=1&origin=${encodeURIComponent(typeof window !== 'undefined' ? window.location.origin : '')}`}
                  className="relative w-full h-full object-cover pointer-events-none z-10"
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                  title="YouTube Source"
                />
              </div>
            </div>
          ) : (
            <div className="absolute inset-0 overflow-hidden bg-black">
              {/* Always display high-res YouTube thumbnail as crisp backdrop underneath */}
              <img
                src={`https://i.ytimg.com/vi/${sourceYouTubeId}/hqdefault.jpg`}
                alt="YouTube Backdrop"
                className="absolute inset-0 w-full h-full object-cover scale-105 pointer-events-none"
              />
              <iframe
                ref={iframeRef}
                src={`https://www.youtube.com/embed/${sourceYouTubeId}?enablejsapi=1&autoplay=0&controls=0&disablekb=1&fs=0&loop=1&playlist=${sourceYouTubeId}&playsinline=1&rel=0&modestbranding=1&origin=${encodeURIComponent(typeof window !== 'undefined' ? window.location.origin : '')}`}
                className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[340%] h-[115%] pointer-events-none z-10"
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                title="YouTube Source"
              />
            </div>
          )
        ) : (
          <div className="absolute inset-0 overflow-hidden bg-black">
            <img
              key={activeBeat?.id || 'default-bg'}
              src={safeActiveThumb}
              alt={activeBeat?.visual_keywords || 'Short visual'}
              referrerPolicy="no-referrer"
              className={`absolute inset-0 w-full h-full object-cover transition-transform duration-1000 ease-out pointer-events-none ${
                isPlaying ? 'scale-108' : 'scale-100'
              }`}
            />

            <video
              ref={videoRef}
              muted
              loop
              playsInline
              src={getSafeVideoUrl(activeBeat?.visual_keywords, activeBeat?.video_url)}
              onLoadedData={() => setVideoLoaded(true)}
              onError={(e) => {
                console.warn('HTML5 video load error on source', e);
              }}
              className="absolute inset-0 w-full h-full object-cover pointer-events-none"
            />
          </div>
        )}

        {/* Scrim Gradients for Visual Contrast */}
        <div className="absolute inset-x-0 top-0 h-24 bg-gradient-to-b from-black/75 to-transparent pointer-events-none" />
        <div className="absolute inset-x-0 bottom-0 h-32 bg-gradient-to-t from-black/85 via-black/35 to-transparent pointer-events-none" />

        {/* Top Info Bar inside frame */}
        <div className="absolute top-3.5 inset-x-3.5 flex items-center justify-between pointer-events-none z-20">
          <div className="px-2.5 py-1 rounded-lg bg-black/60 backdrop-blur-md border border-white/10 text-[11px] font-medium text-white flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-rose-500 animate-pulse" />
            <span>Shorts Studio</span>
          </div>

          <div className="px-2 py-0.5 rounded-lg bg-black/60 backdrop-blur-md text-[11px] font-mono text-neutral-300 tabular-nums border border-white/8">
            {formatSecondsToTimestamp(currentTimestamp)} / {formatSecondsToTimestamp(totalDuration)}
          </div>
        </div>

        {/* Kinetic Word-by-Word Caption Highlight Overlay */}
        {(captionStyle.showCaptions ?? true) && activeChunk && (
          <div
            className="absolute inset-x-3 pointer-events-none transition-all z-20"
            style={{
              top: `${captionStyle.positionY}%`,
              transform: `translateY(-50%) ${captionStyle.rotation ? `rotate(${captionStyle.rotation}deg)` : ''}`,
            }}
          >
            <div
              className={`flex flex-wrap items-center justify-center gap-1.5 px-3.5 py-2 rounded-xl mx-auto max-w-[94%] transition-all ${
                captionStyle.boxStyle === 'glow'
                  ? 'bg-black/85 backdrop-blur-md border border-rose-500/30 shadow-xl'
                  : captionStyle.boxStyle === 'minimal'
                  ? 'bg-black/50 backdrop-blur-sm border border-white/8'
                  : 'bg-black/75 backdrop-blur-sm border border-white/8 shadow-2xl'
              }`}
            >
              {activeChunk.words.map((w, idx) => {
                const isWordActive = currentTimestamp >= w.start_s && currentTimestamp <= w.end_s;
                const isUppercase = captionStyle.textTransform !== 'none';
                const displayText = isUppercase
                  ? w.word.toUpperCase().replace(/[.,!?;:]/g, '')
                  : w.word.replace(/[.,!?;:]/g, '');

                return (
                  <span
                    key={idx}
                    className={`tracking-tight transition-transform duration-75 text-center inline-block ${
                      isUppercase ? 'uppercase' : ''
                    }`}
                    style={{
                      fontFamily: `'${captionStyle.fontFamily || 'Montserrat'}', 'Poppins', sans-serif`,
                      fontWeight: captionStyle.fontWeight || '900',
                      fontSize: `${captionStyle.fontSize}px`,
                      color: isWordActive ? captionStyle.highlightColor : captionStyle.textColor,
                      textShadow:
                        captionStyle.boxStyle === 'glow' && isWordActive
                          ? `0 0 16px ${captionStyle.highlightColor}, -2px -2px 0 #000, 2px -2px 0 #000, -2px 2px 0 #000, 2px 2px 0 #000`
                          : `
                            -2px -2px 0 ${captionStyle.strokeColor},
                            2px -2px 0 ${captionStyle.strokeColor},
                            -2px 2px 0 ${captionStyle.strokeColor},
                            2px 2px 0 ${captionStyle.strokeColor},
                            0 4px 12px rgba(0,0,0,0.85)
                          `,
                      transform: isWordActive ? 'scale(1.12)' : 'scale(1)',
                    }}
                  >
                    {displayText}
                  </span>
                );
              })}
            </div>
          </div>
        )}

        {/* YouTube Shorts Safe Zones Visual Overlay (When Enabled) */}
        {showSafeZones && (
          <div className="absolute inset-0 pointer-events-none z-30 border-2 border-dashed border-amber-400/40 m-2 rounded-2xl flex flex-col justify-between p-2">
            <div className="text-[10px] font-mono text-amber-300 bg-black/70 px-1.5 py-0.5 rounded self-start">
              Top Safe Margin
            </div>

            <div className="flex justify-between items-end">
              <div className="text-[10px] font-mono text-amber-300 bg-black/70 px-1.5 py-0.5 rounded max-w-[65%]">
                Bottom Channel Title & Audio Zone
              </div>
              <div className="text-[10px] font-mono text-amber-300 bg-black/70 px-1.5 py-0.5 rounded text-right">
                Like/Share Buttons Zone
              </div>
            </div>
          </div>
        )}

        {/* Center Play Button Overlay */}
        <button
          onClick={onTogglePlay}
          className={`absolute inset-0 flex items-center justify-center transition-all ${
            isPlaying ? 'bg-transparent opacity-0 group-hover:opacity-100 hover:bg-black/20' : 'bg-black/35 opacity-100'
          }`}
          title={isPlaying ? 'Click to Pause' : 'Click to Play Video & Audio'}
        >
          <div className="w-14 h-14 rounded-full bg-rose-600/90 hover:bg-rose-500 text-white flex items-center justify-center shadow-2xl transform transition hover:scale-110 border border-white/20">
            {isPlaying ? <Pause className="w-6 h-6 fill-current" /> : <Play className="w-6 h-6 fill-current ml-1" />}
          </div>
        </button>

        {/* Progress Bar Inside Video */}
        <div className="absolute bottom-0 inset-x-0 h-1 bg-white/10">
          <div
            className="h-full bg-rose-500 transition-all duration-75"
            style={{ width: `${(currentTimestamp / totalDuration) * 100}%` }}
          />
        </div>
      </div>

      {/* Scrub & Transport Bar */}
      <div className="w-full mt-3.5 space-y-3">
        <div className="space-y-1">
          <div className="relative flex items-center">
            <input
              type="range"
              min="0"
              max={totalDuration}
              step="0.05"
              value={currentTimestamp}
              onChange={(e) => handlePlayerSeek(parseFloat(e.target.value))}
              className="w-full h-1.5 bg-[#121721] rounded-lg appearance-none cursor-pointer accent-rose-500 z-10"
            />
          </div>

          <div className="flex justify-between text-xs text-neutral-400 font-mono tabular-nums">
            <span>{currentTimestamp.toFixed(1)}s</span>
            <span className="text-neutral-500">{beats.length} beats</span>
            <span>{totalDuration.toFixed(1)}s</span>
          </div>
        </div>

        {/* Framing Selector for YouTube Clip */}
        {sourceYouTubeId && (
          <div className="grid grid-cols-3 gap-1.5 p-1 bg-[#0f141c] border border-white/8 rounded-xl text-xs">
            <button
              onClick={() => handleSetVisualMode('youtube-crop')}
              className={`py-1.5 rounded-lg font-medium transition flex items-center justify-center gap-1.5 ${
                visualMode === 'youtube-crop' ? 'bg-[#1e2638] text-white shadow-sm' : 'text-neutral-400 hover:text-white'
              }`}
            >
              <span>Vertical Fill</span>
            </button>
            <button
              onClick={() => handleSetVisualMode('youtube-fit')}
              className={`py-1.5 rounded-lg font-medium transition flex items-center justify-center gap-1.5 ${
                visualMode === 'youtube-fit' ? 'bg-[#1e2638] text-white shadow-sm' : 'text-neutral-400 hover:text-white'
              }`}
            >
              <span>Letterbox Fit</span>
            </button>
            <button
              onClick={() => handleSetVisualMode('b-roll')}
              className={`py-1.5 rounded-lg font-medium transition flex items-center justify-center gap-1.5 ${
                visualMode === 'b-roll' ? 'bg-[#1e2638] text-white shadow-sm' : 'text-neutral-400 hover:text-white'
              }`}
            >
              <span>Stock B-Roll</span>
            </button>
          </div>
        )}
        {sourceYouTubeId && visualMode === 'youtube-crop' && (
          <div className="flex items-center justify-between gap-2 px-1 text-[11px]">
            <label className="flex items-center gap-1.5 text-neutral-300 cursor-pointer">
              <input type="checkbox" checked={autoFrame} onChange={(e) => setAutoFrame(e.target.checked)} className="accent-rose-500" />
              <ScanFace className="w-3.5 h-3.5" />
              <span>Auto-frame speaker</span>
            </label>
            {smartCropOn && (
              <span className="flex items-center gap-1 text-neutral-500" aria-live="polite">
                {isFindingSpeaker ? (
                  <>
                    <Loader2 className="w-3 h-3 animate-spin" />
                    Finding the speaker…
                  </>
                ) : cropPath ? (
                  'Speaker framed'
                ) : null}
              </span>
            )}
          </div>
        )}

        {sourceYouTubeId && (
          <div className="p-2.5 bg-[#0f141c] border border-white/8 rounded-xl text-xs flex flex-col gap-1.5">
            {sourceFile ? (
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5 min-w-0 text-emerald-300">
                  <FileVideo className="w-3.5 h-3.5 shrink-0" />
                  <span className="truncate" title={sourceFile.name}>{sourceFile.name}</span>
                </div>
                <button
                  type="button"
                  onClick={() => setSourceFile(null)}
                  className="p-1 rounded-md text-neutral-400 hover:text-white hover:bg-white/5"
                  aria-label="Remove source video file"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            ) : (
              <>
              {ytDownloadEnabled && (
                <div className="flex flex-col gap-1.5 pb-1.5 border-b border-white/8">
                  <label className="flex items-start gap-1.5 text-[11px] text-neutral-300 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={rightsConfirmed}
                      onChange={(e) => setRightsConfirmed(e.target.checked)}
                      className="mt-0.5 accent-rose-500"
                    />
                    <span>I own this video or have permission to use it</span>
                  </label>
                  <button
                    type="button"
                    onClick={handleDownloadFromYouTube}
                    disabled={!rightsConfirmed || isDownloading}
                    className="flex items-center justify-center gap-1.5 py-1.5 rounded-lg bg-rose-600 hover:bg-rose-500 disabled:opacity-40 disabled:cursor-not-allowed text-white font-medium transition"
                  >
                    {isDownloading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Youtube className="w-3.5 h-3.5" />}
                    <span>{isDownloading ? 'Downloading clip footage…' : 'Get this clip\'s footage from YouTube'}</span>
                  </button>
                </div>
              )}
              <label className="flex items-center justify-center gap-1.5 py-1.5 rounded-lg border border-dashed border-white/15 text-neutral-200 hover:border-rose-400/60 hover:text-white cursor-pointer transition">
                <FileVideo className="w-3.5 h-3.5" />
                <span>Add your video file for real footage + audio</span>
                <input
                  type="file"
                  accept="video/*"
                  className="sr-only"
                  aria-label="Source video file"
                  onChange={(e) => handlePickSourceFile(e.target.files?.[0])}
                />
              </label>
              </>
            )}
            <p className="text-[10px] leading-snug text-neutral-500">
              {sourceFile
                ? 'Export uses this file from the clip start, with its original audio. It stays on your device.'
                : 'Use a copy of the full video you have the rights to (e.g. your own upload from YouTube Studio). It stays on your device.'}
            </p>
          </div>
        )}

        {/* Primary Transport Controls */}
        <div className="flex items-center justify-between gap-2 p-2 bg-[#0f141c] border border-white/8 rounded-2xl">
          <div className="flex items-center gap-1.5">
            <button
              onClick={handlePlayerReset}
              className="p-2 rounded-xl text-neutral-400 hover:text-white hover:bg-white/5 transition"
              title="Restart from beginning"
            >
              <RotateCcw className="w-4 h-4" />
            </button>

            <button
              onClick={onTogglePlay}
              className="px-4 py-2 rounded-xl bg-rose-600 hover:bg-rose-500 text-white text-xs font-semibold flex items-center gap-1.5 shadow-sm transition"
            >
              {isPlaying ? <Pause className="w-3.5 h-3.5 fill-current" /> : <Play className="w-3.5 h-3.5 fill-current" />}
              <span>{isPlaying ? 'Pause' : 'Play Short'}</span>
            </button>
          </div>

          <div className="flex items-center gap-1.5">
            {sourceYouTubeId && (
              <div className="flex items-center gap-1 bg-black/40 border border-white/8 px-2 py-1.5 rounded-xl">
                <button
                  type="button"
                  onClick={() => {
                    const nextMuted = !isYoutubeMuted;
                    setIsYoutubeMuted(nextMuted);
                    if (nextMuted) {
                      postToYouTube('mute');
                    } else {
                      postToYouTube('unMute');
                      postToYouTube('setVolume', [Math.round(youtubeVolume * 100)]);
                    }
                  }}
                  className="text-neutral-300 hover:text-white transition"
                  title={isYoutubeMuted ? 'Unmute YouTube Audio' : 'Mute YouTube Audio'}
                >
                  {isYoutubeMuted ? <VolumeX className="w-3.5 h-3.5 text-red-400" /> : <Volume2 className="w-3.5 h-3.5 text-emerald-400" />}
                </button>
                <span className="text-[10px] font-mono text-neutral-400">
                  {isYoutubeMuted ? 'Muted' : `${Math.round(youtubeVolume * 100)}%`}
                </span>
              </div>
            )}

            {!sourceYouTubeId && onToggleAiVoice && (
              <button
                type="button"
                onClick={onToggleAiVoice}
                className={`px-2.5 py-1.5 rounded-xl border text-xs font-medium transition flex items-center gap-1.5 ${
                  aiVoiceEnabled
                    ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
                    : 'bg-neutral-900 border-white/8 text-neutral-400 hover:text-white'
                }`}
                title={aiVoiceEnabled ? 'AI Voiceover: ON' : 'AI Voiceover: OFF'}
              >
                {aiVoiceEnabled ? <Mic className="w-3.5 h-3.5 text-emerald-400" /> : <MicOff className="w-3.5 h-3.5" />}
                <span className="text-[11px]">{aiVoiceEnabled ? 'AI Voice' : 'No Voice'}</span>
              </button>
            )}

            <button
              type="button"
              onClick={() => setShowSafeZones(!showSafeZones)}
              className={`p-2 rounded-xl text-xs font-medium border transition ${
                showSafeZones
                  ? 'bg-amber-500/10 border-amber-500/30 text-amber-300'
                  : 'bg-black/30 border-white/8 text-neutral-400 hover:text-white'
              }`}
              title="Toggle YouTube Safe Margin Guidelines"
            >
              <ShieldAlert className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Dedicated Background Audio & Music Strip */}
        <div className="p-2.5 rounded-2xl bg-[#0f141c] border border-white/8 space-y-2">
          <div className="flex items-center justify-between text-xs">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onToggleMusic}
                className={`p-1.5 rounded-lg border text-xs transition flex items-center gap-1.5 ${
                  musicEnabled
                    ? 'bg-rose-500/10 border-rose-500/30 text-rose-300'
                    : 'bg-black/30 border-white/8 text-neutral-400 hover:text-white'
                }`}
                title={musicEnabled ? 'Disable Background Music' : 'Enable Background Music'}
              >
                <Music className="w-3.5 h-3.5 text-rose-400" />
                <span className="font-medium text-[11px]">BGM Music</span>
              </button>
              {musicEnabled && (
                <span className="text-[10px] font-mono text-neutral-400">
                  {Math.round(musicVolume * 100)}% vol
                </span>
              )}
            </div>

            {musicEnabled && (
              <div className="flex items-center gap-1">
                {(['lofi', 'hype', 'ambient'] as MusicMood[]).map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => {
                      setMusicMood(m);
                      audioManager.setMusicMood(m, musicVolume);
                    }}
                    className={`px-2 py-0.5 rounded text-[10px] font-medium uppercase tracking-wider transition ${
                      musicMood === m
                        ? 'bg-rose-600 text-white font-semibold shadow-xs'
                        : 'bg-black/30 text-neutral-400 hover:text-white'
                    }`}
                  >
                    {m}
                  </button>
                ))}
              </div>
            )}
          </div>

          {musicEnabled && (
            <div className="flex items-center gap-2 pt-0.5">
              <span className="text-[10px] text-neutral-500 font-mono">Vol</span>
              <input
                type="range"
                min="0.02"
                max="0.35"
                step="0.01"
                value={musicVolume}
                onChange={(e) => onMusicVolumeChange(parseFloat(e.target.value))}
                className="w-full h-1 bg-neutral-800 rounded appearance-none cursor-pointer accent-rose-500"
                title={`Music Volume: ${Math.round(musicVolume * 100)}%`}
              />
            </div>
          )}
        </div>

        {/* Export Panel */}
        <div className="space-y-2 pt-1">
          <div className="flex items-center justify-between text-xs px-1">
            <span className="text-neutral-400">Export Quality:</span>
            <div className="flex items-center p-0.5 bg-[#0f141c] rounded-lg border border-white/8">
              <button
                type="button"
                onClick={() => setExportResolution('1080p')}
                className={`px-2.5 py-1 rounded text-[11px] font-mono transition ${
                  exportResolution === '1080p'
                    ? 'bg-[#1e2638] text-white font-semibold shadow-xs'
                    : 'text-neutral-400 hover:text-white'
                }`}
              >
                1080×1920 (FHD)
              </button>
              <button
                type="button"
                onClick={() => setExportResolution('720p')}
                className={`px-2.5 py-1 rounded text-[11px] font-mono transition ${
                  exportResolution === '720p'
                    ? 'bg-[#1e2638] text-white font-semibold shadow-xs'
                    : 'text-neutral-400 hover:text-white'
                }`}
              >
                720×1280 (HD)
              </button>
            </div>
          </div>

          <p className="text-[10px] leading-snug text-neutral-500 px-1">
            {isYouTubeSource && useSourceFile
              ? 'Exports in real time with your video file\'s footage and original audio (a 30s clip takes ~30s). Keep this tab in the foreground.'
              : isYouTubeSource
              ? 'Without your video file the export is a captions-only clip on animated backgrounds (no speaker footage or voice). YouTube\'s embedded player cannot be recorded.'
              : 'Exports render in real time (a 30s Short takes ~30s). Keep this tab in the foreground. Narration is included when server AI voice is available; browser system voices cannot be recorded.'}
          </p>
          {isYouTubeSource && !sourceFile && visualMode !== 'b-roll' && (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-200 flex items-start gap-2">
              <FileVideo className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <span>
                <strong className="font-semibold">{ytDownloadEnabled ? 'Get the footage from YouTube or add your video file' : 'Add your video file'}</strong>{' '}
                (above the play controls) to export this clip with the real footage and the speaker&apos;s voice.
              </span>
            </div>
          )}
          {exportError && (
            <div role="alert" className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-[11px] text-rose-200">
              {exportError}
            </div>
          )}
          <button
            onClick={handleExportVideo}
            disabled={isExporting || beats.length === 0}
            className="w-full py-3 px-4 bg-rose-600 hover:bg-rose-500 text-white font-semibold text-xs rounded-xl shadow-lg shadow-rose-950/40 transition flex items-center justify-center gap-2 disabled:opacity-50"
          >
            {isExporting ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>Rendering {exportResolution} Short... {exportProgress}%</span>
              </>
            ) : (
              <>
                <Download className="w-4 h-4" />
                <span>Export & Download Finished Short</span>
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
};
