import React, { useRef } from 'react';
import {
  ArrowLeft,
  CloudUpload,
  Sparkles,
  Download,
  Share2,
  Film,
  Type,
  ListFilter,
  CheckCircle2,
} from 'lucide-react';
import { ShortScript, Beat, CaptionStyle, WordTiming, AudioSourceMode, VisualSourceMode } from '../types';
import { ScriptEditor } from './ScriptEditor';
import { CaptionStyleConfig } from './CaptionStyleConfig';
import { YouTubeMetadataCard } from './YouTubeMetadataCard';
import { ShortsPlayer } from './ShortsPlayer';
import { audioManager } from '../utils/audio';

interface StudioPage3CanvasTimelineProps {
  script: ShortScript;
  topic: string;
  allWords: WordTiming[];
  captionStyle: CaptionStyle;
  captionOffsetSeconds: number;
  currentTimestamp: number;
  isPlaying: boolean;
  voiceName: string;
  aiVoiceEnabled: boolean;
  musicEnabled: boolean;
  musicVolume: number;
  onSeek: (time: number) => void;
  onTogglePlay: () => void;
  onReset: () => void;
  onSelectVoiceName: (voice: string) => void;
  onToggleAiVoice: () => void;
  onToggleMusic: () => void;
  onMusicVolumeChange: (vol: number) => void;
  onChangeAudioSourceMode: (mode: AudioSourceMode) => void;
  onChangeCaptionOffset: (offset: number) => void;
  onChangeCaptionStyle: (style: Partial<CaptionStyle>) => void;
  onUpdateBeat: (id: string, updates: Partial<Beat>) => void;
  onUpdateAllBeats: (beats: Beat[]) => void;
  onSelectBeatToChangeClip: (beat: Beat) => void;
  onAddBeat: () => void;
  onDeleteBeat: (id: string) => void;
  onAutoAlignBeats: () => void;
  onShiftAllBeats: (delta: number) => void;
  onUpdateMetadata: (updates: Partial<ShortScript>) => void;
  onUpdateClipStartSeconds: (startSec: number) => void;
  onBackToStrategies: () => void;
  onOpenGoogleDriveExport: () => void;
  onOpenPublishingPack?: () => void;
  onApplyWordsAndBeats?: (words: WordTiming[], beats?: Beat[]) => void;
  visualMode?: VisualSourceMode;
  onChangeVisualMode?: (mode: VisualSourceMode) => void;
  registerPlaybackClock?: (fn: (() => number | null) | null) => void;
  localSourceUrl?: string;
  localSourceName?: string;
  onSelectLocalSource?: (file: File) => void;
  onClearLocalSource?: () => void;
}

export const StudioPage3CanvasTimeline: React.FC<StudioPage3CanvasTimelineProps> = ({
  script,
  topic,
  allWords,
  captionStyle,
  captionOffsetSeconds,
  currentTimestamp,
  isPlaying,
  voiceName,
  aiVoiceEnabled,
  musicEnabled,
  musicVolume,
  onSeek,
  onTogglePlay,
  onReset,
  onSelectVoiceName,
  onToggleAiVoice,
  onToggleMusic,
  onMusicVolumeChange,
  onChangeAudioSourceMode,
  onChangeCaptionOffset,
  onChangeCaptionStyle,
  onUpdateBeat,
  onUpdateAllBeats,
  onSelectBeatToChangeClip,
  onAddBeat,
  onDeleteBeat,
  onAutoAlignBeats,
  onShiftAllBeats,
  onUpdateMetadata,
  onUpdateClipStartSeconds,
  onBackToStrategies,
  onOpenGoogleDriveExport,
  onOpenPublishingPack,
  onApplyWordsAndBeats,
  visualMode,
  onChangeVisualMode,
  registerPlaybackClock,
  localSourceUrl,
  localSourceName,
  onSelectLocalSource,
  onClearLocalSource,
}) => {
  const scriptSectionRef = useRef<HTMLDivElement>(null);
  const captionSectionRef = useRef<HTMLDivElement>(null);
  const metadataSectionRef = useRef<HTMLDivElement>(null);

  const totalDuration = script.beats && script.beats.length > 0
    ? script.beats[script.beats.length - 1].end_s
    : 0;

  return (
    <div className="space-y-8 animate-in fade-in duration-200">
      {/* Top Header & Actions Bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-white/8">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onBackToStrategies}
            className="px-3 py-1.5 rounded-xl bg-white/5 hover:bg-white/10 text-xs font-medium text-neutral-300 hover:text-white transition flex items-center gap-1.5 border border-white/8"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            <span>Back to Strategies & Trimmer</span>
          </button>

          <div>
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold text-rose-400 font-mono uppercase tracking-wider">
                Step 3 of 3
              </span>
              <span className="text-neutral-500" aria-hidden="true">·</span>
              <h1 className="text-base font-semibold text-white tracking-tight">
                Studio Canvas & Timeline
              </h1>
            </div>
          </div>
        </div>

        {/* Action CTAs: Social Publishing & Google Drive */}
        <div className="flex items-center gap-2.5">
          {onOpenPublishingPack && (
            <button
              type="button"
              onClick={onOpenPublishingPack}
              className="px-3.5 py-2 bg-gradient-to-r from-purple-600 to-rose-600 hover:from-purple-500 hover:to-rose-500 text-white font-semibold text-xs rounded-xl transition flex items-center gap-1.5 shadow-lg shadow-purple-950/40"
              title="Generate multi-platform publishing package (Shorts, TikTok, Reels)"
            >
              <Share2 className="w-4 h-4" />
              <span>Social Publishing</span>
            </button>
          )}

          <button
            type="button"
            onClick={onOpenGoogleDriveExport}
            className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white font-semibold text-xs sm:text-sm rounded-xl transition flex items-center gap-2 shadow-lg shadow-emerald-950/40"
          >
            <CloudUpload className="w-4 h-4" />
            <span>Export to Google Drive</span>
          </button>
        </div>
      </div>

      {/* Grid: Left (Multi-track Timeline, Typography, Publishing) & Right (9:16 Canvas) */}
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-8 items-start">
        {/* Left Workbench */}
        <div className="space-y-8">
          {/* Quick Sub-navigation anchor tags */}
          <div className="flex items-center gap-2 overflow-x-auto pb-1 text-xs">
            <button
              onClick={() => scriptSectionRef.current?.scrollIntoView({ behavior: 'smooth' })}
              className="px-3 py-1.5 rounded-lg bg-black/40 hover:bg-white/5 border border-white/6 text-neutral-300 hover:text-white transition flex items-center gap-1.5 whitespace-nowrap"
            >
              <Film className="w-3.5 h-3.5 text-rose-400" />
              <span>Multi-track Beat Timeline</span>
            </button>
            <button
              onClick={() => captionSectionRef.current?.scrollIntoView({ behavior: 'smooth' })}
              className="px-3 py-1.5 rounded-lg bg-black/40 hover:bg-white/5 border border-white/6 text-neutral-300 hover:text-white transition flex items-center gap-1.5 whitespace-nowrap"
            >
              <Type className="w-3.5 h-3.5 text-amber-400" />
              <span>Kinetic Caption Typography</span>
            </button>
            <button
              onClick={() => metadataSectionRef.current?.scrollIntoView({ behavior: 'smooth' })}
              className="px-3 py-1.5 rounded-lg bg-black/40 hover:bg-white/5 border border-white/6 text-neutral-300 hover:text-white transition flex items-center gap-1.5 whitespace-nowrap"
            >
              <ListFilter className="w-3.5 h-3.5 text-emerald-400" />
              <span>Publishing Metadata & SEO Pack</span>
            </button>
          </div>

          {/* 1. Multi-Track Timeline & Beat Sequencer */}
          <div ref={scriptSectionRef}>
            <ScriptEditor
              beats={script.beats}
              topic={topic}
              currentTimestamp={currentTimestamp}
              allWords={allWords}
              captionStyle={captionStyle}
              audioSourceMode={script.audioSourceMode}
              sourceYouTubeId={script.sourceYouTubeId}
              clipStartSeconds={script.clipStartSeconds}
              clipEndSeconds={script.clipEndSeconds}
              aiVoiceEnabled={aiVoiceEnabled}
              onToggleAiVoice={onToggleAiVoice}
              onUpdateBeat={onUpdateBeat}
              onUpdateAllBeats={onUpdateAllBeats}
              onSelectBeatToChangeClip={onSelectBeatToChangeClip}
              onSeekToBeat={onSeek}
              onAddBeat={onAddBeat}
              onDeleteBeat={onDeleteBeat}
              onAutoAlignBeats={onAutoAlignBeats}
              onShiftAllBeats={onShiftAllBeats}
              onApplyWordsAndBeats={onApplyWordsAndBeats}
              onTogglePlay={onTogglePlay}
              isPlaying={isPlaying}
              script={script}
            />
          </div>

          {/* 2. Caption Typography Engine */}
          <div ref={captionSectionRef}>
            <CaptionStyleConfig
              style={captionStyle}
              onChange={onChangeCaptionStyle}
              captionOffsetSeconds={captionOffsetSeconds}
              onChangeCaptionOffset={onChangeCaptionOffset}
            />
          </div>

          {/* 3. YouTube Shorts Metadata & SEO Pack */}
          <div ref={metadataSectionRef}>
            <YouTubeMetadataCard
              script={script}
              topic={topic}
              onUpdateMetadata={onUpdateMetadata}
            />
          </div>
        </div>

        {/* Right Stage: Interactive 9:16 Studio Canvas */}
        <aside className="lg:sticky lg:top-24 flex flex-col items-center">
          <ShortsPlayer
            beats={script.beats}
            allWords={allWords}
            captionStyle={captionStyle}
            currentTimestamp={currentTimestamp}
            isPlaying={isPlaying}
            onSeek={onSeek}
            onTogglePlay={onTogglePlay}
            onReset={onReset}
            voiceName={voiceName}
            onSelectVoiceName={onSelectVoiceName}
            aiVoiceEnabled={aiVoiceEnabled}
            onToggleAiVoice={onToggleAiVoice}
            musicEnabled={musicEnabled}
            musicVolume={musicVolume}
            onToggleMusic={onToggleMusic}
            onMusicVolumeChange={onMusicVolumeChange}
            sourceYouTubeId={script.sourceYouTubeId}
            sourceYouTubeTitle={script.sourceYouTubeTitle}
            viralScore={script.viralScore}
            clipStartSeconds={script.clipStartSeconds}
            onUpdateClipStartSeconds={onUpdateClipStartSeconds}
            audioSourceMode={script.audioSourceMode}
            onChangeAudioSourceMode={onChangeAudioSourceMode}
            captionOffsetSeconds={captionOffsetSeconds}
            onUpdateCaptionOffset={onChangeCaptionOffset}
            onUpdateCaptionStyle={onChangeCaptionStyle}
            visualMode={visualMode}
            onChangeVisualMode={onChangeVisualMode}
            registerPlaybackClock={registerPlaybackClock}
            localSourceUrl={localSourceUrl}
            localSourceName={localSourceName}
            onSelectLocalSource={onSelectLocalSource}
            onClearLocalSource={onClearLocalSource}
          />
        </aside>
      </div>
    </div>
  );
};
