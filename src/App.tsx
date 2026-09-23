import React, { useState, useEffect, useRef } from 'react';
import {
  Sparkles,
  Film,
  Play,
  Settings,
  ChevronDown,
  ChevronUp,
  CheckCircle2,
  RefreshCw,
  Video,
  Layers,
  Wand2,
  AlertCircle
} from 'lucide-react';
import { Beat, CaptionStyle, ShortScript, WordTiming } from './types';
import { estimateWordTimings, assignBeatTimings } from './utils/pipeline';
import { audioManager } from './utils/audio';
import { ShortsPlayer } from './components/ShortsPlayer';
import { ScriptEditor } from './components/ScriptEditor';
import { StockPickerModal } from './components/StockPickerModal';
import { YouTubeMetadataCard } from './components/YouTubeMetadataCard';
import { CaptionStyleConfig } from './components/CaptionStyleConfig';

const QUICK_TOPICS = [
  '5 productivity habits that actually work',
  'Why 99% of people quit their side project in 30 days',
  'The 3-second psychological hook that grabs attention',
  'The brutal truth about 8 hours of sleep',
  'How top 1% creators stay consistent without burnout'
];

export const App: React.FC = () => {
  // Input parameters
  const [topic, setTopic] = useState('5 productivity habits that actually work');
  const [audience, setAudience] = useState('general YouTube audience');
  const [tone, setTone] = useState('energetic, direct, no fluff');
  const [showAdvanced, setShowAdvanced] = useState(false);

  // Configuration status from server
  const [serverConfig, setServerConfig] = useState<{
    hasGeminiKey: boolean;
    hasAnthropicKey: boolean;
    hasPexelsKey: boolean;
  }>({
    hasGeminiKey: false,
    hasAnthropicKey: false,
    hasPexelsKey: false,
  });

  // Pipeline execution state
  const [isGenerating, setIsGenerating] = useState(false);
  const [generationStep, setGenerationStep] = useState<string>('');

  // Generated Script & Beats
  const [script, setScript] = useState<ShortScript | null>(null);
  const [allWords, setAllWords] = useState<WordTiming[]>([]);

  // Caption Styling
  const [captionStyle, setCaptionStyle] = useState<CaptionStyle>({
    id: 'tiktok-pop',
    name: 'TikTok Pop',
    fontSize: 28,
    textColor: '#FFFFFF',
    highlightColor: '#39FF88',
    strokeColor: '#000000',
    strokeWidth: 4,
    positionY: 68,
    wordsPerChunk: 3,
  });

  // Player state
  const [currentTimestamp, setCurrentTimestamp] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [voiceName, setVoiceName] = useState('Guy');
  const [musicEnabled, setMusicEnabled] = useState(true);
  const [musicVolume, setMusicVolume] = useState(0.12);

  // Modal state for changing a beat's clip
  const [editingClipBeat, setEditingClipBeat] = useState<Beat | null>(null);

  // Playback timer ref
  const playbackRaf = useRef<number | null>(null);
  const lastTimeRef = useRef<number>(0);

  // Fetch initial config
  useEffect(() => {
    fetch('/api/config')
      .then((r) => r.json())
      .then((data) => setServerConfig(data))
      .catch(() => {});

    // Automatically generate initial demo short so user sees output right away
    handleGenerateShort('5 productivity habits that actually work');
  }, []);

  // Handle Playback Loop
  useEffect(() => {
    if (!isPlaying) {
      if (playbackRaf.current) cancelAnimationFrame(playbackRaf.current);
      audioManager.stopSpeech();
      if (musicEnabled) audioManager.stopBackgroundMusic();
      return;
    }

    if (musicEnabled) {
      audioManager.startBackgroundMusic(musicVolume);
    }

    lastTimeRef.current = performance.now();

    const loop = (now: number) => {
      const delta = (now - lastTimeRef.current) / 1000;
      lastTimeRef.current = now;

      setCurrentTimestamp((prev) => {
        const totalDur = script?.beats && script.beats.length > 0
          ? script.beats[script.beats.length - 1].end_s
          : 30;

        const next = prev + delta;
        if (next >= totalDur) {
          setIsPlaying(false);
          return 0;
        }
        return next;
      });

      playbackRaf.current = requestAnimationFrame(loop);
    };

    playbackRaf.current = requestAnimationFrame(loop);

    return () => {
      if (playbackRaf.current) cancelAnimationFrame(playbackRaf.current);
    };
  }, [isPlaying, script, musicEnabled, musicVolume]);

  // Generate complete short pipeline
  const handleGenerateShort = async (inputTopic?: string) => {
    const selectedTopic = inputTopic || topic;
    if (!selectedTopic.trim() || isGenerating) return;

    setIsGenerating(true);
    setIsPlaying(false);
    audioManager.stopAll();

    try {
      // Step 1: Generate Script with Claude / Gemini
      setGenerationStep('Writing viral hook & script beats...');
      const scriptRes = await fetch('/api/generate-script', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          topic: selectedTopic,
          audience,
          tone,
        }),
      });

      if (!scriptRes.ok) {
        throw new Error('Failed to generate script');
      }

      const scriptData = await scriptRes.json();

      // Step 2: Voiceover & Word Timings
      setGenerationStep('Synthesizing speech & calculating word timestamps...');
      const fullText = scriptData.beats.map((b: any) => b.text).join(' ');
      const words = estimateWordTimings(fullText, 1.0);
      setAllWords(words);

      // Step 3: Fetch Stock footage clips per beat
      setGenerationStep('Matching vertical stock video clips...');
      const timedBeats = assignBeatTimings(scriptData.beats, words);

      // Fetch clips for all beats
      const finalBeats: Beat[] = await Promise.all(
        timedBeats.map(async (beat) => {
          try {
            const fRes = await fetch('/api/stock-footage', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ query: beat.visual_keywords }),
            });
            const fData = await fRes.json();
            const chosen = fData.results?.[0];
            return {
              ...beat,
              video_url: chosen?.url || 'https://assets.mixkit.co/videos/preview/mixkit-vertical-shot-of-a-person-typing-on-a-laptop-42994-large.mp4',
              thumbnail: chosen?.thumbnail,
            };
          } catch (e) {
            return beat;
          }
        })
      );

      // Step 4: Ready
      setScript({
        hook: scriptData.hook || finalBeats[0]?.text || '',
        title: scriptData.title || `${selectedTopic} #shorts`,
        description: scriptData.description || 'Watch to learn more.',
        hashtags: scriptData.hashtags || ['#shorts', '#viral'],
        beats: finalBeats,
      });

      setCurrentTimestamp(0);
    } catch (err) {
      console.error('Generation failed:', err);
    } finally {
      setIsGenerating(false);
      setGenerationStep('');
    }
  };

  // Player controls
  const handleTogglePlay = () => {
    setIsPlaying((prev) => !prev);
  };

  const handleReset = () => {
    setIsPlaying(false);
    setCurrentTimestamp(0);
  };

  const handleSeek = (time: number) => {
    setCurrentTimestamp(time);
  };

  // Beat edits
  const handleUpdateBeat = (id: string, updates: Partial<Beat>) => {
    if (!script) return;
    setScript({
      ...script,
      beats: script.beats.map((b) => (b.id === id ? { ...b, ...updates } : b)),
    });
  };

  const handleSelectClip = (beatId: string, videoUrl: string, thumbnail?: string) => {
    if (!script) return;
    setScript({
      ...script,
      beats: script.beats.map((b) => (b.id === beatId ? { ...b, video_url: videoUrl, thumbnail } : b)),
    });
  };

  const handleAddBeat = () => {
    if (!script) return;
    const lastBeat = script.beats[script.beats.length - 1];
    const newStart = lastBeat ? lastBeat.end_s : 0;
    const newEnd = newStart + 4.0;

    const newBeat: Beat = {
      id: `beat-${Date.now()}`,
      text: 'Here is another game-changing insight.',
      visual_keywords: 'person smiling confident success',
      start_s: newStart,
      end_s: newEnd,
      video_url: 'https://assets.mixkit.co/videos/preview/mixkit-vertical-view-of-a-woman-walking-down-a-city-street-41712-large.mp4',
    };

    setScript({
      ...script,
      beats: [...script.beats, newBeat],
    });
  };

  const handleDeleteBeat = (id: string) => {
    if (!script || script.beats.length <= 1) return;
    setScript({
      ...script,
      beats: script.beats.filter((b) => b.id !== id),
    });
  };

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100 flex flex-col selection:bg-rose-500 selection:text-white">
      {/* Top Navbar */}
      <header className="border-b border-neutral-800/80 bg-neutral-900/50 backdrop-blur-md sticky top-0 z-40">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-rose-600 to-red-500 flex items-center justify-center shadow-md shadow-rose-950/40">
              <Film className="w-5 h-5 text-white" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-extrabold text-white text-base tracking-tight">VIBLO</span>
                <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-rose-500/20 text-rose-400 border border-rose-500/30">
                  SHORTS
                </span>
              </div>
              <p className="text-[11px] text-neutral-400">One-line idea to finished captioned Short</p>
            </div>
          </div>

          <div className="flex items-center gap-2 sm:gap-3">
            <div className="hidden sm:flex items-center gap-2 px-3 py-1.5 rounded-xl bg-neutral-900 border border-neutral-800 text-xs">
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
              <span className="text-neutral-300">1080x1920 (9:16)</span>
            </div>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 py-6">
        {/* Generator Prompt Box */}
        <section className="bg-neutral-900 border border-neutral-800 rounded-3xl p-5 sm:p-6 shadow-xl mb-8">
          <div className="space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
              <label className="text-sm font-bold text-white flex items-center gap-2">
                <Wand2 className="w-4 h-4 text-rose-500" />
                What is your Short idea or topic?
              </label>
              <button
                onClick={() => setShowAdvanced(!showAdvanced)}
                className="text-xs text-neutral-400 hover:text-neutral-200 flex items-center gap-1 transition self-start sm:self-auto"
              >
                <Settings className="w-3.5 h-3.5" />
                {showAdvanced ? 'Hide Audience & Tone' : 'Audience & Tone'}
                {showAdvanced ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
              </button>
            </div>

            {/* Input and Action */}
            <div className="flex flex-col sm:flex-row gap-2">
              <div className="relative flex-1">
                <input
                  type="text"
                  value={topic}
                  onChange={(e) => setTopic(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleGenerateShort()}
                  placeholder="e.g. 5 productivity habits that actually work"
                  className="w-full px-4 py-3.5 bg-neutral-950 border border-neutral-800 focus:border-rose-500 rounded-2xl text-sm sm:text-base text-white placeholder-neutral-500 focus:outline-none transition shadow-inner"
                />
              </div>

              <button
                onClick={() => handleGenerateShort()}
                disabled={isGenerating || !topic.trim()}
                className="px-6 py-3.5 bg-gradient-to-r from-rose-600 to-red-600 hover:from-rose-500 hover:to-red-500 text-white font-semibold text-sm rounded-2xl shadow-lg transition flex items-center justify-center gap-2 disabled:opacity-50 shrink-0"
              >
                {isGenerating ? (
                  <>
                    <RefreshCw className="w-4 h-4 animate-spin" />
                    <span>Generating...</span>
                  </>
                ) : (
                  <>
                    <Sparkles className="w-4 h-4" />
                    <span>Generate Short</span>
                  </>
                )}
              </button>
            </div>

            {/* Advanced Audience & Tone drawer */}
            {showAdvanced && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 p-4 rounded-2xl bg-neutral-950/60 border border-neutral-800">
                <div>
                  <label className="text-xs font-semibold text-neutral-300 block mb-1">Target Audience</label>
                  <input
                    type="text"
                    value={audience}
                    onChange={(e) => setAudience(e.target.value)}
                    placeholder="e.g. ambitious college students, founders"
                    className="w-full px-3 py-2 bg-neutral-900 border border-neutral-700 rounded-xl text-xs text-white placeholder-neutral-500 focus:outline-none focus:border-rose-500"
                  />
                </div>
                <div>
                  <label className="text-xs font-semibold text-neutral-300 block mb-1">Tone & Pacing</label>
                  <input
                    type="text"
                    value={tone}
                    onChange={(e) => setTone(e.target.value)}
                    placeholder="e.g. energetic, direct, no fluff"
                    className="w-full px-3 py-2 bg-neutral-900 border border-neutral-700 rounded-xl text-xs text-white placeholder-neutral-500 focus:outline-none focus:border-rose-500"
                  />
                </div>
              </div>
            )}

            {/* Quick Inspiration Prompts */}
            <div className="flex items-center gap-2 overflow-x-auto pb-1 pt-1 text-xs">
              <span className="text-neutral-500 text-[11px] shrink-0 font-medium">Quick ideas:</span>
              {QUICK_TOPICS.map((t, idx) => (
                <button
                  key={idx}
                  onClick={() => {
                    setTopic(t);
                    handleGenerateShort(t);
                  }}
                  className="px-3 py-1 rounded-full bg-neutral-800/80 hover:bg-neutral-800 text-neutral-300 hover:text-white border border-neutral-700/60 whitespace-nowrap text-[11px] transition"
                >
                  {t}
                </button>
              ))}
            </div>

            {/* Progress indicator during pipeline generation */}
            {isGenerating && (
              <div className="p-3 rounded-xl bg-rose-950/30 border border-rose-800/40 text-rose-300 text-xs flex items-center gap-2">
                <RefreshCw className="w-3.5 h-3.5 animate-spin text-rose-400" />
                <span className="font-medium">{generationStep}</span>
              </div>
            )}
          </div>
        </section>

        {/* Studio Workspace: Left (Timeline + Controls) & Right (9:16 Player) */}
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_380px] gap-8 items-start">
          {/* Left Column: Script Timeline, Caption Config, YouTube Metadata */}
          <div className="space-y-6">
            {script ? (
              <>
                {/* Script Beats Editor */}
                <ScriptEditor
                  beats={script.beats}
                  currentTimestamp={currentTimestamp}
                  onUpdateBeat={handleUpdateBeat}
                  onSelectBeatToChangeClip={(beat) => setEditingClipBeat(beat)}
                  onSeekToBeat={handleSeek}
                  onAddBeat={handleAddBeat}
                  onDeleteBeat={handleDeleteBeat}
                />

                {/* Caption Styling Config */}
                <CaptionStyleConfig
                  style={captionStyle}
                  onChange={(updated) => setCaptionStyle((prev) => ({ ...prev, ...updated }))}
                />

                {/* YouTube Studio Metadata Card */}
                <YouTubeMetadataCard script={script} />
              </>
            ) : (
              <div className="p-12 text-center text-neutral-500 border border-dashed border-neutral-800 rounded-3xl">
                Enter a topic above and click Generate to start the pipeline.
              </div>
            )}
          </div>

          {/* Right Column: 9:16 Vertical Video Player & Exporter */}
          <div className="lg:sticky lg:top-24 flex flex-col items-center">
            {script && (
              <ShortsPlayer
                beats={script.beats}
                allWords={allWords}
                captionStyle={captionStyle}
                currentTimestamp={currentTimestamp}
                isPlaying={isPlaying}
                onSeek={handleSeek}
                onTogglePlay={handleTogglePlay}
                onReset={handleReset}
                voiceName={voiceName}
                musicEnabled={musicEnabled}
                musicVolume={musicVolume}
                onToggleMusic={() => {
                  setMusicEnabled(!musicEnabled);
                  if (musicEnabled) audioManager.stopBackgroundMusic();
                }}
                onMusicVolumeChange={(vol) => {
                  setMusicVolume(vol);
                  audioManager.setMusicVolume(vol);
                }}
              />
            )}
          </div>
        </div>
      </main>

      {/* Stock Video Picker Modal */}
      <StockPickerModal
        beat={editingClipBeat}
        isOpen={Boolean(editingClipBeat)}
        onClose={() => setEditingClipBeat(null)}
        onSelectClip={handleSelectClip}
      />
    </div>
  );
};

export default App;
