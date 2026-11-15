import React, { useState, useEffect } from 'react';
import {
  Sparkles,
  Video,
  Play,
  Edit3,
  Trash2,
  Plus,
  Clock,
  Wand2,
  RefreshCw,
  Check,
  RotateCcw,
  Volume2,
  FileText,
  MoveLeft,
  MoveRight,
  Mic,
  MicOff,
  Subtitles,
  Sliders,
  Headphones,
  Radio,
} from 'lucide-react';
import { Beat, WordTiming, CaptionStyle, ShortScript } from '../types';
import { recalculateWordsFromBeats } from '../utils/pipeline';
import { getSafeThumbnail } from '../utils/visualPlaceholders';
import { VoiceToTextPanel } from './VoiceToTextPanel';
import { startLiveVoiceListener } from '../utils/voiceRecognition';
import { apiFetch, apiErrorMessage } from '../utils/api';

interface ScriptEditorProps {
  beats: Beat[];
  topic?: string;
  currentTimestamp: number;
  allWords?: WordTiming[];
  captionStyle?: CaptionStyle;
  audioSourceMode?: 'youtube' | 'tts';
  sourceYouTubeId?: string;
  clipStartSeconds?: number;
  clipEndSeconds?: number;
  aiVoiceEnabled?: boolean;
  onToggleAiVoice?: () => void;
  onUpdateBeat: (id: string, updates: Partial<Beat>) => void;
  onUpdateAllBeats?: (beats: Beat[]) => void;
  onSelectBeatToChangeClip: (beat: Beat) => void;
  onSeekToBeat: (startTime: number) => void;
  onAddBeat: () => void;
  onDeleteBeat: (id: string) => void;
  onAutoAlignBeats?: () => void;
  onShiftAllBeats?: (deltaSeconds: number) => void;
  onApplyWordsAndBeats?: (words: WordTiming[], beats?: Beat[]) => void;
  onTogglePlay?: () => void;
  isPlaying?: boolean;
  script?: ShortScript | null;
}

const BeatTextarea: React.FC<{
  initialText: string;
  onUpdate: (newText: string) => void;
  disabled?: boolean;
}> = ({ initialText, onUpdate, disabled }) => {
  const [val, setVal] = useState(initialText);

  useEffect(() => {
    setVal(initialText);
  }, [initialText]);

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const next = e.target.value;
    setVal(next);
    onUpdate(next);
  };

  return (
    <textarea
      value={val}
      onChange={handleChange}
      disabled={disabled}
      rows={2}
      className="w-full bg-[#090c10] border border-white/10 focus:border-rose-500 rounded-xl p-3 text-xs sm:text-sm text-neutral-100 placeholder-neutral-500 resize-none focus:outline-none transition leading-relaxed shadow-inner"
      placeholder="Type the spoken sentence for this beat..."
    />
  );
};

const TimestampInput: React.FC<{
  value: number;
  min?: number;
  step?: number;
  onCommit: (val: number) => void;
}> = ({ value, min = 0, step = 0.1, onCommit }) => {
  const [val, setVal] = useState(value.toFixed(1));

  useEffect(() => {
    setVal(value.toFixed(1));
  }, [value]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setVal(e.target.value);
    const num = parseFloat(e.target.value);
    if (!isNaN(num)) {
      onCommit(Math.max(min, parseFloat(num.toFixed(2))));
    }
  };

  const handleBlur = () => {
    const num = parseFloat(val);
    if (!isNaN(num)) {
      const clamped = Math.max(min, parseFloat(num.toFixed(2)));
      setVal(clamped.toFixed(1));
      onCommit(clamped);
    } else {
      setVal(value.toFixed(1));
    }
  };

  return (
    <input
      type="number"
      step={step}
      min={min}
      value={val}
      onChange={handleChange}
      onBlur={handleBlur}
      className="w-14 bg-transparent text-xs font-mono font-semibold text-white focus:outline-none tabular-nums"
    />
  );
};

export const ScriptEditor: React.FC<ScriptEditorProps> = ({
  beats,
  topic = '',
  currentTimestamp,
  allWords = [],
  captionStyle,
  audioSourceMode = 'tts',
  sourceYouTubeId,
  clipStartSeconds,
  clipEndSeconds,
  aiVoiceEnabled = false,
  onToggleAiVoice,
  onUpdateBeat,
  onUpdateAllBeats,
  onSelectBeatToChangeClip,
  onSeekToBeat,
  onAddBeat,
  onDeleteBeat,
  onAutoAlignBeats,
  onShiftAllBeats,
  onApplyWordsAndBeats,
  onTogglePlay,
  isPlaying = false,
  script = null,
}) => {
  const [rewritingBeatId, setRewritingBeatId] = useState<string | null>(null);
  const [showHooksModal, setShowHooksModal] = useState(false);
  const [suggestedHooks, setSuggestedHooks] = useState<Array<{ hook: string; style: string; visual_keywords: string }>>([]);
  const [loadingHooks, setLoadingHooks] = useState(false);
  const [hooksError, setHooksError] = useState<string | null>(null);
  const [activePunchUpMenuBeatId, setActivePunchUpMenuBeatId] = useState<string | null>(null);
  const [fetchingYouTubeCC, setFetchingYouTubeCC] = useState(false);
  const [ccFeedback, setCcFeedback] = useState<string | null>(null);
  const [showPasteCcModal, setShowPasteCcModal] = useState(false);
  const [pastedCcText, setPastedCcText] = useState('');
  const [parsingPastedCc, setParsingPastedCc] = useState(false);
  const [pasteError, setPasteError] = useState<string | null>(null);
  const [showVoiceToTextModal, setShowVoiceToTextModal] = useState(false);
  const [voiceToTextInitialMode, setVoiceToTextInitialMode] = useState<'hear-video' | 'instant-cc' | 'mic-dictate'>('hear-video');

  const totalDuration = beats.length > 0 ? beats[beats.length - 1].end_s : 0;

  const handleSuggestHooks = async () => {
    setShowHooksModal(true);
    setLoadingHooks(true);
    setHooksError(null);
    try {
      const res = await apiFetch('/api/gemini/suggest-hooks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic: topic || beats[0]?.text || 'viral YouTube Short' }),
      });
      if (!res.ok) {
        throw new Error(await apiErrorMessage(res, 'Failed to get hook suggestions'));
      }
      const data = await res.json();
      if (data.hooks && Array.isArray(data.hooks)) {
        setSuggestedHooks(
          data.isFallback
            ? data.hooks.map((h: any) => ({ ...h, style: `Template (AI unavailable) · ${h.style}` }))
            : data.hooks
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to get hook suggestions';
      console.error('Failed to get hook suggestions:', err);
      setHooksError(msg);
    } finally {
      setLoadingHooks(false);
    }
  };

  const handleApplyHook = (hookText: string, visualKeywords?: string) => {
    if (beats.length > 0) {
      onUpdateBeat(beats[0].id, {
        text: hookText,
        visual_keywords: visualKeywords || beats[0].visual_keywords,
      });
    }
    setShowHooksModal(false);
  };

  const handleRewriteBeat = async (beat: Beat, action: 'punchy' | 'curiosity' | 'shorten' | 'dramatic') => {
    setRewritingBeatId(beat.id);
    setActivePunchUpMenuBeatId(null);
    try {
      const res = await apiFetch('/api/gemini/rewrite-beat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          currentText: beat.text,
          action,
          topic,
        }),
      });
      if (!res.ok) {
        const msg = await apiErrorMessage(res, 'AI rewrite is unavailable right now; the line was left unchanged.');
        setCcFeedback(msg);
        return;
      }
      const data = await res.json();
      if (data.unchanged || data.isFallback) {
        setCcFeedback(data.fallbackMessage || 'AI rewrite is unavailable right now; the line was left unchanged.');
      } else if (data.text) {
        onUpdateBeat(beat.id, {
          text: data.text,
          visual_keywords: data.visual_keywords || beat.visual_keywords,
        });
      }
    } catch (err) {
      console.error('Failed to rewrite beat with Gemini:', err);
    } finally {
      setRewritingBeatId(null);
    }
  };

  const handleNudgeStart = (beat: Beat, delta: number) => {
    const newStart = Math.max(0, parseFloat((beat.start_s + delta).toFixed(2)));
    const newEnd = Math.max(newStart + 0.5, beat.end_s);
    onUpdateBeat(beat.id, { start_s: newStart, end_s: newEnd });
  };

  const handleNudgeEnd = (beat: Beat, delta: number) => {
    const newEnd = Math.max(beat.start_s + 0.4, parseFloat((beat.end_s + delta).toFixed(2)));
    onUpdateBeat(beat.id, { end_s: newEnd });
  };

  const handleFetchYouTubeCC = async () => {
    if (!sourceYouTubeId) return;
    setFetchingYouTubeCC(true);
    setCcFeedback(null);
    try {
      const res = await apiFetch('/api/youtube/captions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ videoId: sourceYouTubeId }),
      });
      if (!res.ok) {
        setCcFeedback(await apiErrorMessage(res, 'Could not fetch YouTube CC.'));
        return;
      }
      const data = await res.json();
      if (data.success && Array.isArray(data.segments) && data.segments.length > 0) {
        const clipStart = clipStartSeconds ?? 0;
        const clipEnd = clipEndSeconds ?? (clipStart + 40);
        const relevantSegments = data.segments.filter(
          (s: any) => s.end_s >= clipStart && s.start_s <= clipEnd
        );

        const segmentsToUse = relevantSegments.length > 0 ? relevantSegments : data.segments.slice(0, beats.length);

        if (segmentsToUse.length > 0) {
          const updatedBeats: Beat[] = segmentsToUse.map((seg: any, idx: number) => {
            const relStart = Math.max(0, parseFloat((seg.start_s - clipStart).toFixed(2)));
            const relEnd = Math.max(relStart + 0.6, parseFloat((seg.end_s - clipStart).toFixed(2)));
            const existing = beats[idx];
            return {
              id: existing?.id || `beat-cc-${idx + 1}-${Date.now()}`,
              text: seg.text,
              visual_keywords: existing?.visual_keywords || 'high energy cinematic viral video',
              start_s: relStart,
              end_s: relEnd,
              video_url: existing?.video_url || '',
              thumbnail: existing?.thumbnail,
            };
          });

          if (onUpdateAllBeats) {
            onUpdateAllBeats(updatedBeats);
          } else {
            updatedBeats.forEach((b) => onUpdateBeat(b.id, b));
          }
          setCcFeedback(`Synchronized ${updatedBeats.length} Audio CC caption segments`);
        } else {
          setCcFeedback('Found YouTube CC, but outside the selected clip boundary.');
        }
      } else {
        setCcFeedback('No timed YouTube CC found for this video.');
      }
    } catch (e) {
      setCcFeedback('Could not fetch YouTube CC.');
    } finally {
      setFetchingYouTubeCC(false);
      setTimeout(() => setCcFeedback(null), 5000);
    }
  };

  const handleApplyPastedCC = async () => {
    if (!pastedCcText.trim()) return;
    setParsingPastedCc(true);
    setPasteError(null);
    try {
      const res = await apiFetch('/api/youtube/parse-transcript', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          transcript: pastedCcText,
          clipStartSeconds: clipStartSeconds ?? 0,
          clipEndSeconds: clipEndSeconds ?? (clipStartSeconds ? clipStartSeconds + 45 : 300),
        }),
      });
      if (!res.ok) {
        setPasteError(await apiErrorMessage(res, 'Error parsing captions'));
        return;
      }
      const data = await res.json();
      if (data.success && Array.isArray(data.segments) && data.segments.length > 0) {
        const clipStart = clipStartSeconds ?? 0;
        const updatedBeats: Beat[] = data.segments.map((seg: any, idx: number) => {
          const relStart = Math.max(0, parseFloat((seg.start_s - clipStart).toFixed(2)));
          const relEnd = Math.max(relStart + 0.6, parseFloat((seg.end_s - clipStart).toFixed(2)));
          const existing = beats[idx];
          return {
            id: existing?.id || `beat-cc-${idx + 1}-${Date.now()}`,
            text: seg.text,
            visual_keywords: existing?.visual_keywords || 'high energy viral vertical video backdrop',
            start_s: relStart,
            end_s: relEnd,
            video_url: existing?.video_url || '',
            thumbnail: existing?.thumbnail,
          };
        });

        if (onUpdateAllBeats) {
          onUpdateAllBeats(updatedBeats);
        } else {
          updatedBeats.forEach((b) => onUpdateBeat(b.id, b));
        }

        setShowPasteCcModal(false);
        setPastedCcText('');
        setCcFeedback(`Imported ${updatedBeats.length} timed CC segments`);
        setTimeout(() => setCcFeedback(null), 5000);
      } else {
        setPasteError('Could not detect timestamped captions. Paste lines like "0:01 Text"');
      }
    } catch (e: any) {
      setPasteError(e.message || 'Error parsing captions');
    } finally {
      setParsingPastedCc(false);
    }
  };

  return (
    <section className="bg-[#0f141c] border border-white/8 rounded-2xl p-6 shadow-sm space-y-5">
      {/* Header and Quick Actions */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between pb-4 border-b border-white/8 gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-base font-semibold text-white tracking-tight">Timeline & Script Beats</h2>
            <div className="flex items-center gap-1.5 text-xs text-neutral-400">
              <span aria-hidden="true">·</span>
              <span className="font-mono tabular-nums">{beats.length} beats</span>
              <span aria-hidden="true">·</span>
              <span className="font-mono tabular-nums">{totalDuration.toFixed(1)}s total</span>
            </div>
          </div>
          <p className="text-xs text-neutral-400 mt-0.5">
            Fine-tune spoken beats, rephrase hooks with Gemini, and match vertical stock visual cues
          </p>
        </div>

        {/* Global Timeline Actions */}
        <div className="flex items-center gap-2 flex-wrap">
          {onAutoAlignBeats && (
            <button
              onClick={onAutoAlignBeats}
              type="button"
              className="px-2.5 py-1.5 rounded-lg bg-black/40 hover:bg-black/60 border border-white/8 text-neutral-300 hover:text-white text-xs font-medium flex items-center gap-1.5 transition"
              title="Automatically align all beats sequentially without gaps"
            >
              <RotateCcw className="w-3 h-3 text-neutral-400" />
              <span>Auto-Align Beats</span>
            </button>
          )}

          {onShiftAllBeats && (
            <div className="flex items-center p-0.5 bg-black/40 border border-white/8 rounded-lg text-xs">
              <button
                type="button"
                onClick={() => onShiftAllBeats(-0.3)}
                className="px-2 py-1 text-[11px] text-neutral-400 hover:text-white rounded flex items-center gap-1 transition font-mono tabular-nums"
                title="Shift all beats 0.3s earlier"
              >
                <MoveLeft className="w-3 h-3" />
                -0.3s
              </button>
              <span className="text-white/10">|</span>
              <button
                type="button"
                onClick={() => onShiftAllBeats(0.3)}
                className="px-2 py-1 text-[11px] text-neutral-400 hover:text-white rounded flex items-center gap-1 transition font-mono tabular-nums"
                title="Shift all beats 0.3s later"
              >
                +0.3s
                <MoveRight className="w-3 h-3" />
              </button>
            </div>
          )}

          {sourceYouTubeId && (
            <button
              onClick={handleFetchYouTubeCC}
              disabled={fetchingYouTubeCC}
              type="button"
              className="px-2.5 py-1.5 rounded-lg bg-black/40 hover:bg-black/60 border border-white/8 text-rose-300 hover:text-white text-xs font-medium flex items-center gap-1.5 transition"
            >
              {fetchingYouTubeCC ? (
                <RefreshCw className="w-3 h-3 animate-spin text-rose-400" />
              ) : (
                <Subtitles className="w-3 h-3 text-rose-400" />
              )}
              <span>Import Audio CC</span>
            </button>
          )}

          <button
            onClick={() => {
              setPasteError(null);
              setShowPasteCcModal(true);
            }}
            type="button"
            className="px-2.5 py-1.5 rounded-lg bg-black/40 hover:bg-black/60 border border-white/8 text-neutral-300 hover:text-white text-xs font-medium flex items-center gap-1.5 transition"
          >
            <FileText className="w-3 h-3 text-neutral-400" />
            <span>Paste CC</span>
          </button>

          <button
            onClick={handleSuggestHooks}
            type="button"
            className="px-2.5 py-1.5 rounded-lg bg-rose-500/10 hover:bg-rose-500/20 text-rose-300 border border-rose-500/25 text-xs font-medium flex items-center gap-1.5 transition"
          >
            <Sparkles className="w-3 h-3 text-rose-400" />
            <span>Viral Hooks</span>
          </button>

          <button
            onClick={onAddBeat}
            type="button"
            className="px-3 py-1.5 rounded-lg bg-rose-600 hover:bg-rose-500 text-white text-xs font-semibold flex items-center gap-1.5 transition shadow-sm"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Add Beat</span>
          </button>
        </div>
      </div>

      {/* Voice-to-Text Studio Interactive Quick Bar */}
      <div className="p-3 rounded-xl bg-gradient-to-r from-rose-950/40 via-amber-950/20 to-black/50 border border-rose-500/25 flex flex-col sm:flex-row sm:items-center justify-between gap-3 shadow-md">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-rose-500/20 text-rose-400 flex items-center justify-center shrink-0 border border-rose-500/30">
            <Radio className="w-4 h-4 animate-pulse" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold text-white">Voice-to-Text Kinetic Timeline</span>
              <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-rose-500/20 text-rose-300 border border-rose-500/30">
                Audio Sync
              </span>
            </div>
            <p className="text-[11px] text-neutral-400">
              Hear video voice track to generate real-time kinetic words, or transcribe with AI audio CC sync.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0 flex-wrap">
          <button
            type="button"
            onClick={() => {
              setVoiceToTextInitialMode('hear-video');
              setShowVoiceToTextModal(true);
            }}
            className="px-2.5 py-1.5 rounded-lg bg-rose-600/30 hover:bg-rose-600 text-rose-200 hover:text-white border border-rose-500/40 text-xs font-medium flex items-center gap-1.5 transition"
          >
            <Headphones className="w-3 h-3 text-rose-300" />
            <span>Hear Live Audio</span>
          </button>

          <button
            type="button"
            onClick={() => {
              setVoiceToTextInitialMode('instant-cc');
              setShowVoiceToTextModal(true);
            }}
            className="px-2.5 py-1.5 rounded-lg bg-black/50 hover:bg-white/10 text-neutral-300 hover:text-white border border-white/10 text-xs font-medium flex items-center gap-1.5 transition"
          >
            <Sparkles className="w-3 h-3 text-amber-400" />
            <span>AI Audio Sync</span>
          </button>

          <button
            type="button"
            onClick={() => {
              setVoiceToTextInitialMode('mic-dictate');
              setShowVoiceToTextModal(true);
            }}
            className="px-2.5 py-1.5 rounded-lg bg-black/50 hover:bg-white/10 text-neutral-300 hover:text-white border border-white/10 text-xs font-medium flex items-center gap-1.5 transition"
          >
            <Mic className="w-3 h-3 text-emerald-400" />
            <span>Mic Dictate</span>
          </button>
        </div>
      </div>

      {/* Visual Timeline Track Ruler */}
      {totalDuration > 0 && (
        <div className="p-3 rounded-xl bg-black/40 border border-white/6 space-y-2">
          <div className="flex items-center justify-between text-[11px] text-neutral-400 font-mono tabular-nums">
            <span>TIMELINE TRACK</span>
            <span>
              Playhead: <strong className="text-white font-mono">{currentTimestamp.toFixed(2)}s</strong> / {totalDuration.toFixed(2)}s
            </span>
          </div>

          {/* Graphical Track Blocks */}
          <div className="h-7 w-full bg-[#090c10] rounded-lg relative overflow-hidden flex border border-white/10">
            {beats.map((beat, bIndex) => {
              const beatDur = Math.max(beat.end_s - beat.start_s, 0.4);
              const widthPct = (beatDur / totalDuration) * 100;
              const isCurrent = currentTimestamp >= beat.start_s && currentTimestamp < beat.end_s;

              return (
                <div
                  key={beat.id}
                  onClick={() => onSeekToBeat(beat.start_s)}
                  style={{ width: `${widthPct}%` }}
                  title={`Beat ${bIndex + 1}: ${beat.text.slice(0, 30)}... (${beatDur.toFixed(1)}s)`}
                  className={`h-full border-r border-white/10 cursor-pointer flex items-center justify-center transition-colors px-1 text-[10px] font-mono select-none truncate ${
                    isCurrent
                      ? 'bg-rose-600/30 text-rose-200 font-bold'
                      : 'bg-white/3 text-neutral-400 hover:bg-white/8'
                  }`}
                >
                  <span className="truncate">0{bIndex + 1}</span>
                </div>
              );
            })}

            {/* Playhead Indicator Line */}
            <div
              className="absolute top-0 bottom-0 w-0.5 bg-rose-500 shadow-md shadow-rose-500/50 pointer-events-none transition-all duration-75"
              style={{
                left: `${Math.min(100, Math.max(0, (currentTimestamp / totalDuration) * 100))}%`,
              }}
            />
          </div>
        </div>
      )}

      {ccFeedback && (
        <div className="px-3 py-2 rounded-xl bg-emerald-950/40 border border-emerald-500/30 text-emerald-300 text-xs flex items-center gap-2">
          <Check className="w-3.5 h-3.5 text-emerald-400" />
          <span>{ccFeedback}</span>
        </div>
      )}

      {/* Beats List */}
      <div className="space-y-3.5">
        {beats.map((beat, index) => {
          const isActive = currentTimestamp >= beat.start_s && currentTimestamp < beat.end_s;
          const isHook = index === 0;
          const isRewriting = rewritingBeatId === beat.id;
          const isMenuOpen = activePunchUpMenuBeatId === beat.id;
          const beatDuration = Math.max(0, beat.end_s - beat.start_s);

          const matchedById = allWords.filter((w) => w.beatId === beat.id);
          const matchedByTime = allWords.filter(
            (w) => w.start_s >= beat.start_s - 0.05 && w.end_s <= beat.end_s + 0.15
          );
          const beatWords =
            matchedById.length > 0
              ? matchedById
              : matchedByTime.length > 0
              ? matchedByTime
              : recalculateWordsFromBeats([beat]);

          const safeThumb = getSafeThumbnail(beat.visual_keywords, beat.thumbnail);

          return (
            <div
              key={beat.id}
              className={`rounded-2xl border transition-all p-5 ${
                isActive
                  ? 'bg-[#121722] border-rose-500/80 shadow-md ring-1 ring-rose-500/20'
                  : 'bg-[#0b0f15] border-white/8 hover:border-white/16'
              }`}
            >
              {/* Beat Header Bar */}
              <div className="flex flex-col sm:flex-row sm:items-center justify-between pb-3 border-b border-white/6 gap-2">
                <div className="flex items-center gap-2 text-xs">
                  <span className="font-mono font-bold text-white">
                    0{index + 1}.
                  </span>
                  <span className="font-semibold text-white">
                    {isHook ? 'Opening Hook Beat' : `Beat Segment`}
                  </span>
                  <span aria-hidden="true" className="text-neutral-500">·</span>
                  <span className="font-mono tabular-nums text-neutral-400">
                    {beatDuration.toFixed(1)}s duration
                  </span>
                </div>

                <div className="flex items-center gap-2 relative">
                  <button
                    type="button"
                    onClick={() => onSeekToBeat(beat.start_s)}
                    className="px-2.5 py-1 rounded-lg bg-black/40 hover:bg-black/70 text-xs font-mono text-neutral-300 hover:text-white flex items-center gap-1.5 border border-white/6 transition"
                    title="Seek video playhead to this beat"
                  >
                    <Play className="w-3 h-3 text-rose-400 fill-current" />
                    <span>Jump</span>
                  </button>

                  {/* Gemini Punch Up Menu */}
                  <div className="relative">
                    <button
                      onClick={() => setActivePunchUpMenuBeatId(isMenuOpen ? null : beat.id)}
                      disabled={isRewriting}
                      className="px-2.5 py-1 rounded-lg bg-rose-500/10 hover:bg-rose-500/20 text-xs font-medium text-rose-300 hover:text-white flex items-center gap-1.5 transition border border-rose-500/25"
                    >
                      {isRewriting ? (
                        <RefreshCw className="w-3 h-3 animate-spin text-rose-400" />
                      ) : (
                        <Wand2 className="w-3 h-3 text-rose-400" />
                      )}
                      <span>Punch Up</span>
                    </button>

                    {isMenuOpen && (
                      <div className="absolute right-0 top-full mt-1.5 w-48 bg-[#0f141c] border border-white/15 rounded-xl shadow-2xl p-1 z-30 space-y-0.5">
                        <div className="px-2.5 py-1 text-[10px] font-mono text-neutral-400 uppercase tracking-wider">
                          Gemini Rewrite Style
                        </div>
                        <button
                          onClick={() => handleRewriteBeat(beat, 'punchy')}
                          className="w-full text-left px-2.5 py-1.5 rounded-lg text-xs text-neutral-200 hover:bg-white/5 hover:text-white transition flex items-center justify-between"
                        >
                          <span>High Energy Viral</span>
                          <Sparkles className="w-3 h-3 text-amber-400" />
                        </button>
                        <button
                          onClick={() => handleRewriteBeat(beat, 'curiosity')}
                          className="w-full text-left px-2.5 py-1.5 rounded-lg text-xs text-neutral-200 hover:bg-white/5 hover:text-white transition flex items-center justify-between"
                        >
                          <span>Curiosity Gap Hook</span>
                          <Sparkles className="w-3 h-3 text-rose-400" />
                        </button>
                        <button
                          onClick={() => handleRewriteBeat(beat, 'shorten')}
                          className="w-full text-left px-2.5 py-1.5 rounded-lg text-xs text-neutral-200 hover:bg-white/5 hover:text-white transition flex items-center justify-between"
                        >
                          <span>Tighter Pacing</span>
                          <Clock className="w-3 h-3 text-emerald-400" />
                        </button>
                        <button
                          onClick={() => handleRewriteBeat(beat, 'dramatic')}
                          className="w-full text-left px-2.5 py-1.5 rounded-lg text-xs text-neutral-200 hover:bg-white/5 hover:text-white transition flex items-center justify-between"
                        >
                          <span>More Dramatic</span>
                          <Sparkles className="w-3 h-3 text-purple-400" />
                        </button>
                      </div>
                    )}
                  </div>

                  {beats.length > 1 && (
                    <button
                      onClick={() => onDeleteBeat(beat.id)}
                      className="p-1 rounded-lg text-neutral-400 hover:text-rose-400 hover:bg-white/5 transition"
                      title="Delete beat"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              </div>

              {/* Time Window Steppers */}
              <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-xs text-neutral-400">
                <div className="flex items-center gap-2">
                  <Clock className="w-3.5 h-3.5 text-neutral-400" />
                  <span>Timecode:</span>
                </div>

                <div className="flex items-center gap-3 flex-wrap">
                  <div className="flex items-center gap-1.5 bg-black/40 border border-white/8 px-2.5 py-1 rounded-lg">
                    <span className="text-[10px] text-neutral-500 uppercase font-semibold">Start:</span>
                    <TimestampInput
                      value={beat.start_s}
                      min={0}
                      onCommit={(val) => onUpdateBeat(beat.id, { start_s: val })}
                    />
                    <span className="text-[10px] text-neutral-500">s</span>
                    <button
                      type="button"
                      onClick={() => handleNudgeStart(beat, -0.2)}
                      className="px-1 text-[10px] text-neutral-400 hover:text-white rounded hover:bg-white/10 font-mono tabular-nums"
                    >
                      -0.2
                    </button>
                    <button
                      type="button"
                      onClick={() => handleNudgeStart(beat, 0.2)}
                      className="px-1 text-[10px] text-neutral-400 hover:text-white rounded hover:bg-white/10 font-mono tabular-nums"
                    >
                      +0.2
                    </button>
                  </div>

                  <span className="text-neutral-600 font-mono">→</span>

                  <div className="flex items-center gap-1.5 bg-black/40 border border-white/8 px-2.5 py-1 rounded-lg">
                    <span className="text-[10px] text-neutral-500 uppercase font-semibold">End:</span>
                    <TimestampInput
                      value={beat.end_s}
                      min={beat.start_s + 0.2}
                      onCommit={(val) => onUpdateBeat(beat.id, { end_s: val })}
                    />
                    <span className="text-[10px] text-neutral-500">s</span>
                    <button
                      type="button"
                      onClick={() => handleNudgeEnd(beat, -0.2)}
                      className="px-1 text-[10px] text-neutral-400 hover:text-white rounded hover:bg-white/10 font-mono tabular-nums"
                    >
                      -0.2
                    </button>
                    <button
                      type="button"
                      onClick={() => handleNudgeEnd(beat, 0.2)}
                      className="px-1 text-[10px] text-neutral-400 hover:text-white rounded hover:bg-white/10 font-mono tabular-nums"
                    >
                      +0.2
                    </button>
                  </div>
                </div>
              </div>

              {/* Main Beat Grid: Spoken Text & Visual Matching */}
              <div className="grid grid-cols-1 sm:grid-cols-[1fr_110px] gap-4 mt-3 items-start">
                <div className="space-y-2.5">
                  <div className="relative">
                    <BeatTextarea
                      initialText={beat.text}
                      onUpdate={(newText) => onUpdateBeat(beat.id, { text: newText })}
                      disabled={isRewriting}
                    />
                    {isRewriting && (
                      <div className="absolute inset-0 bg-[#090c10]/80 rounded-xl flex items-center justify-center gap-2 text-xs text-rose-300 backdrop-blur-xs">
                        <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                        <span>Gemini refining phrasing...</span>
                      </div>
                    )}
                  </div>

                  {/* Words Kinetic Preview */}
                  <div className="p-2.5 rounded-xl bg-black/30 border border-white/6 space-y-1.5">
                    <div className="flex items-center justify-between text-[10px] text-neutral-500">
                      <div className="flex items-center gap-1.5">
                        <span className="font-mono tracking-wider font-semibold text-rose-400/90">KINETIC WORDS TIMELINE</span>
                        <span className="text-white/20">·</span>
                        <span className="font-mono tabular-nums text-neutral-400">{beatWords.length} words</span>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          onSeekToBeat(beat.start_s);
                          setVoiceToTextInitialMode('hear-video');
                          setShowVoiceToTextModal(true);
                        }}
                        className="text-[10px] text-rose-300 hover:text-white flex items-center gap-1 px-2 py-0.5 rounded-lg bg-rose-500/15 hover:bg-rose-500/30 border border-rose-500/30 transition font-medium"
                        title="Hear voice of video and update words for this beat"
                      >
                        <Headphones className="w-2.5 h-2.5 text-rose-400" />
                        <span>Hear Beat Voice</span>
                      </button>
                    </div>

                    <div className="flex flex-wrap gap-1.5 items-center pt-0.5">
                      {(beatWords.length > 0
                        ? beatWords
                        : (beat.text || '').trim().split(/\s+/).map((w) => ({ word: w, start_s: beat.start_s, end_s: beat.end_s }))
                      ).map((w, wIdx) => {
                        const isWordActive =
                          currentTimestamp >= w.start_s && currentTimestamp <= w.end_s;
                        return (
                          <button
                            key={wIdx}
                            type="button"
                            onClick={() => onSeekToBeat(w.start_s)}
                            title={`Seek to ${w.start_s.toFixed(2)}s - ${w.end_s.toFixed(2)}s`}
                            className={`px-2 py-1 rounded-md text-[11px] font-semibold transition-all cursor-pointer flex items-center gap-1.5 ${
                              isWordActive
                                ? 'bg-amber-400 text-black shadow-md scale-105 ring-2 ring-amber-300/80 font-bold'
                                : 'bg-black/50 hover:bg-white/10 text-neutral-300 border border-white/8 hover:border-white/20'
                            }`}
                          >
                            <span>{w.word}</span>
                            <span
                              className={`text-[9px] font-mono tabular-nums ${
                                isWordActive ? 'text-black/70 font-bold' : 'text-neutral-500'
                              }`}
                            >
                              {w.start_s.toFixed(1)}s
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* Visual Keyword Tag */}
                  <div className="flex items-center gap-2 text-xs pt-0.5">
                    <span className="text-neutral-400 font-medium">B-Roll Visual:</span>
                    <input
                      type="text"
                      value={beat.visual_keywords}
                      onChange={(e) => onUpdateBeat(beat.id, { visual_keywords: e.target.value })}
                      className="flex-1 bg-[#090c10] border border-white/10 focus:border-rose-500 rounded-lg px-2.5 py-1 text-xs text-white placeholder-neutral-500 focus:outline-none transition"
                      placeholder="e.g. coffee cup morning desk sunlight"
                    />
                  </div>
                </div>

                {/* Vertical Clip Preview & Change Button */}
                <div className="flex sm:flex-col items-center sm:items-stretch gap-2">
                  <div
                    onClick={() => onSelectBeatToChangeClip(beat)}
                    className="relative group rounded-xl overflow-hidden w-24 sm:w-full aspect-[9/16] bg-black border border-white/10 hover:border-rose-500 cursor-pointer transition shadow-sm shrink-0"
                  >
                    <img
                      src={safeThumb}
                      alt={beat.visual_keywords}
                      referrerPolicy="no-referrer"
                      className="w-full h-full object-cover group-hover:scale-105 transition duration-300"
                      onError={(e) => {
                        (e.target as HTMLElement).style.display = 'none';
                      }}
                    />
                    <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent opacity-0 group-hover:opacity-100 flex items-center justify-center transition">
                      <span className="text-[11px] font-semibold text-white px-2 py-1 rounded bg-rose-600 shadow-md">
                        Change
                      </span>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => onSelectBeatToChangeClip(beat)}
                    className="flex-1 sm:flex-none py-1.5 px-3 rounded-lg bg-black/40 hover:bg-white/5 text-[11px] font-medium text-neutral-300 transition text-center border border-white/8 whitespace-nowrap"
                  >
                    Swap Visual
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Paste CC Modal */}
      {showPasteCcModal && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-md z-50 flex items-center justify-center p-4">
          <div className="bg-[#0f141c] border border-white/10 rounded-2xl max-w-lg w-full p-5 space-y-4 shadow-2xl">
            <div className="flex items-center justify-between pb-3 border-b border-white/8">
              <h3 className="font-semibold text-white text-sm">Import Timed Transcript / Subtitles</h3>
              <button
                onClick={() => setShowPasteCcModal(false)}
                className="text-neutral-400 hover:text-white text-xs px-2 py-1 rounded hover:bg-white/5 transition"
              >
                Close
              </button>
            </div>

            <p className="text-xs text-neutral-400">
              Paste timestamps from YouTube &ldquo;Show transcript&rdquo; or lines like <span className="font-mono text-white">0:01 Text...</span>
            </p>

            <textarea
              value={pastedCcText}
              onChange={(e) => setPastedCcText(e.target.value)}
              rows={6}
              placeholder={"0:01 Welcome to today's breakdown\n0:05 We explain the exact formula\n0:09 to build consistency"}
              className="w-full bg-[#090c10] border border-white/10 rounded-xl p-3 text-xs text-neutral-200 placeholder-neutral-600 focus:outline-none focus:border-rose-500 font-mono leading-relaxed resize-none shadow-inner"
            />

            {pasteError && (
              <div className="p-2.5 bg-red-950/40 border border-red-800/50 rounded-xl text-xs text-red-200">
                {pasteError}
              </div>
            )}

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-white/8">
              <button
                type="button"
                onClick={() => setShowPasteCcModal(false)}
                className="px-3 py-1.5 rounded-lg text-xs font-medium text-neutral-400 hover:text-white transition"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleApplyPastedCC}
                disabled={parsingPastedCc || !pastedCcText.trim()}
                className="px-4 py-2 rounded-xl text-xs font-semibold bg-rose-600 hover:bg-rose-500 text-white disabled:opacity-50 flex items-center gap-1.5 transition shadow-sm"
              >
                {parsingPastedCc ? (
                  <>
                    <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                    <span>Parsing Timestamps...</span>
                  </>
                ) : (
                  <>
                    <Check className="w-3.5 h-3.5" />
                    <span>Apply Timed Captions</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Gemini Hooks Suggestion Modal */}
      {showHooksModal && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-md z-50 flex items-center justify-center p-4">
          <div className="bg-[#0f141c] border border-white/10 rounded-2xl max-w-lg w-full p-5 space-y-4 shadow-2xl">
            <div className="flex items-center justify-between pb-3 border-b border-white/8">
              <div>
                <h3 className="font-semibold text-white text-sm">Viral Hook Variations</h3>
                <p className="text-xs text-neutral-400">High-retention opening hooks for Beat 1</p>
              </div>
              <button
                onClick={() => setShowHooksModal(false)}
                className="text-neutral-400 hover:text-white text-xs px-2 py-1 rounded hover:bg-white/5 transition"
              >
                Close
              </button>
            </div>

            {loadingHooks ? (
              <div className="py-8 flex flex-col items-center justify-center gap-3 text-neutral-400 text-xs">
                <RefreshCw className="w-5 h-5 animate-spin text-rose-400" />
                <span>Gemini generating viral hook formulas...</span>
              </div>
            ) : hooksError ? (
              <div className="p-3.5 rounded-xl bg-rose-500/10 border border-rose-500/25 text-xs text-rose-300">
                {hooksError}
              </div>
            ) : (
              <div className="space-y-2.5 max-h-96 overflow-y-auto">
                {suggestedHooks.map((item, idx) => (
                  <div
                    key={idx}
                    className="p-3.5 rounded-xl bg-[#090c10] border border-white/8 hover:border-white/20 transition space-y-2"
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] font-mono text-rose-400 uppercase tracking-wider">
                        {item.style}
                      </span>
                      <button
                        onClick={() => handleApplyHook(item.hook, item.visual_keywords)}
                        className="text-xs font-semibold px-2.5 py-1 rounded-lg bg-rose-600 hover:bg-rose-500 text-white flex items-center gap-1 transition shadow-sm"
                      >
                        <Check className="w-3 h-3" />
                        Apply
                      </button>
                    </div>
                    <p className="text-xs text-neutral-200 font-medium leading-relaxed">
                      &ldquo;{item.hook}&rdquo;
                    </p>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
      {/* Voice-to-Text Transcriber Panel (Hear Video Voice & Dictate) */}
      <VoiceToTextPanel
        isOpen={showVoiceToTextModal}
        onClose={() => setShowVoiceToTextModal(false)}
        initialMode={voiceToTextInitialMode}
        script={script}
        currentTimestamp={currentTimestamp}
        isPlaying={isPlaying}
        onTogglePlay={onTogglePlay || (() => {})}
        onSeek={onSeekToBeat}
        onApplyWordsAndBeats={(words, beats) => {
          if (onApplyWordsAndBeats) {
            onApplyWordsAndBeats(words, beats);
          } else if (beats && onUpdateAllBeats) {
            onUpdateAllBeats(beats);
          }
          setShowVoiceToTextModal(false);
        }}
      />
    </section>
  );
};
