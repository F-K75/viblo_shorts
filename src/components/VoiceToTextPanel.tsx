import React, { useState, useEffect, useRef } from 'react';
import {
  Mic,
  MicOff,
  Headphones,
  Sparkles,
  Play,
  Pause,
  CheckCircle2,
  RefreshCw,
  X,
  Volume2,
  ListOrdered,
  Clock,
  ArrowRight,
  AlertCircle,
  Radio,
} from 'lucide-react';
import { Beat, WordTiming, ShortScript } from '../types';
import {
  isSpeechRecognitionSupported,
  startLiveVoiceListener,
  VoiceListenerHandle,
  LiveHeardWord,
  fetchVideoVoiceTranscription,
  alignSpokenWordsToTimeline,
} from '../utils/voiceRecognition';

interface VoiceToTextPanelProps {
  isOpen: boolean;
  onClose: () => void;
  script: ShortScript | null;
  currentTimestamp: number;
  isPlaying: boolean;
  onTogglePlay: () => void;
  onSeek: (seconds: number) => void;
  onApplyWordsAndBeats: (words: WordTiming[], beats?: Beat[]) => void;
  initialMode?: 'hear-video' | 'instant-cc' | 'mic-dictate';
}

export const VoiceToTextPanel: React.FC<VoiceToTextPanelProps> = ({
  isOpen,
  onClose,
  script,
  currentTimestamp,
  isPlaying,
  onTogglePlay,
  onSeek,
  onApplyWordsAndBeats,
  initialMode = 'hear-video',
}) => {
  const [mode, setMode] = useState<'hear-video' | 'instant-cc' | 'mic-dictate'>(initialMode);

  useEffect(() => {
    if (isOpen && initialMode) {
      setMode(initialMode);
    }
  }, [isOpen, initialMode]);
  const [isListening, setIsListening] = useState(false);
  const [interimText, setInterimText] = useState('');
  const [heardWords, setHeardWords] = useState<WordTiming[]>([]);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isAiProcessing, setIsAiProcessing] = useState(false);
  const [aiStatus, setAiStatus] = useState('');

  const listenerRef = useRef<VoiceListenerHandle | null>(null);
  const currentTimestampRef = useRef<number>(currentTimestamp);
  currentTimestampRef.current = currentTimestamp;

  const supported = isSpeechRecognitionSupported();

  useEffect(() => {
    return () => {
      if (listenerRef.current) {
        listenerRef.current.stop();
      }
    };
  }, []);

  if (!isOpen) return null;

  // Toggle live speech recognition listening
  const handleToggleLiveListening = () => {
    if (isListening) {
      if (listenerRef.current) {
        listenerRef.current.stop();
      }
      setIsListening(false);
      if (isPlaying) {
        onTogglePlay(); // pause playback
      }
    } else {
      setErrorMessage(null);
      setInterimText('');

      const handle = startLiveVoiceListener({
        getPlayheadTime: () => currentTimestampRef.current,
        onWordRecognized: (w: LiveHeardWord) => {
          setHeardWords((prev) => {
            // Avoid duplicate words within 0.1s
            const exists = prev.some(
              (p) => p.word.toLowerCase() === w.word.toLowerCase() && Math.abs(p.start_s - w.start_s) < 0.2
            );
            if (exists) return prev;
            return [...prev, { word: w.word, start_s: w.start_s, end_s: w.end_s }];
          });
          setInterimText('');
        },
        onInterimText: (txt) => {
          setInterimText(txt);
        },
        onError: (err) => {
          setErrorMessage(err);
          setIsListening(false);
        },
        onStateChange: (active) => {
          setIsListening(active);
        },
      });

      listenerRef.current = handle;
      setIsListening(true);

      // If user selected "hear-video", also start playback so the audio plays through speaker/mic
      if (mode === 'hear-video' && !isPlaying) {
        onTogglePlay();
      }
    }
  };

  // Instant AI Audio Transcription (Extract verbatim words from video audio track)
  const handleInstantAudioTranscribe = async () => {
    setIsAiProcessing(true);
    setErrorMessage(null);
    setAiStatus('Listening to video voice track and extracting verbatim audio timestamps...');

    try {
      const data = await fetchVideoVoiceTranscription({
        videoId: script?.sourceYouTubeId,
        clipStartSeconds: script?.clipStartSeconds ?? 0,
        clipEndSeconds: script?.clipEndSeconds ?? 30,
        videoTitle: script?.title || script?.sourceYouTubeTitle,
        contextText: script?.beats.map((b) => b.text).join(' '),
      });

      if (data.success && Array.isArray(data.words) && data.words.length > 0) {
        setHeardWords(data.words);
        setAiStatus(`Extracted ${data.words.length} kinetic words from video voice (${data.source})`);

        // Automatically prepare beats if returned
        if (data.beats && data.beats.length > 0) {
          onApplyWordsAndBeats(data.words, data.beats);
        } else {
          onApplyWordsAndBeats(data.words);
        }
      } else {
        throw new Error('No words detected in audio stream.');
      }
    } catch (e: any) {
      setErrorMessage(e.message || 'Could not extract voice from video.');
    } finally {
      setIsAiProcessing(false);
    }
  };

  const handleApplyHeardWords = async () => {
    if (heardWords.length === 0) return;

    setIsAiProcessing(true);
    setAiStatus('Aligning recognized words to kinetic beats with Gemini...');

    try {
      const fullText = heardWords.map((w) => w.word).join(' ');
      const totalDur = heardWords[heardWords.length - 1].end_s - heardWords[0].start_s || 30;

      const aligned = await alignSpokenWordsToTimeline({
        speechText: fullText,
        targetDuration: Math.max(5, totalDur),
      });

      if (aligned.success && aligned.words.length > 0) {
        onApplyWordsAndBeats(aligned.words, aligned.beats);
      } else {
        onApplyWordsAndBeats(heardWords);
      }

      onClose();
    } catch (e) {
      onApplyWordsAndBeats(heardWords);
      onClose();
    } finally {
      setIsAiProcessing(false);
    }
  };

  const handleClearHeardWords = () => {
    setHeardWords([]);
    setInterimText('');
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md animate-in fade-in duration-150">
      <div className="bg-[#0f141c] border border-white/10 rounded-2xl w-full max-w-2xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="px-6 py-4 border-b border-white/8 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-rose-500/10 border border-rose-500/20 flex items-center justify-center text-rose-400">
              <Headphones className="w-4 h-4" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-white tracking-tight">Voice-to-Text: Hear Video Voice</h3>
              <p className="text-[11px] text-neutral-400">
                Transcribe spoken audio in real time and populate the Kinetic Words Timeline
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-neutral-400 hover:text-white rounded-lg transition"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Mode Selector Tabs */}
        <div className="px-6 pt-4 border-b border-white/6 flex items-center gap-3">
          <button
            onClick={() => setMode('hear-video')}
            className={`pb-2.5 text-xs font-semibold flex items-center gap-1.5 border-b-2 transition ${
              mode === 'hear-video'
                ? 'border-rose-500 text-white'
                : 'border-transparent text-neutral-400 hover:text-neutral-200'
            }`}
          >
            <Headphones className="w-3.5 h-3.5 text-rose-400" />
            <span>Hear Video Playback (Live)</span>
          </button>

          <button
            onClick={() => setMode('instant-cc')}
            className={`pb-2.5 text-xs font-semibold flex items-center gap-1.5 border-b-2 transition ${
              mode === 'instant-cc'
                ? 'border-rose-500 text-white'
                : 'border-transparent text-neutral-400 hover:text-neutral-200'
            }`}
          >
            <Sparkles className="w-3.5 h-3.5 text-amber-400" />
            <span>Instant Audio Transcribe (AI & CC)</span>
          </button>

          <button
            onClick={() => setMode('mic-dictate')}
            className={`pb-2.5 text-xs font-semibold flex items-center gap-1.5 border-b-2 transition ${
              mode === 'mic-dictate'
                ? 'border-rose-500 text-white'
                : 'border-transparent text-neutral-400 hover:text-neutral-200'
            }`}
          >
            <Mic className="w-3.5 h-3.5 text-emerald-400" />
            <span>Microphone Voiceover</span>
          </button>
        </div>

        {/* Content Body */}
        <div className="p-6 space-y-5 overflow-y-auto flex-1">
          {/* Mode 1: Hear Video Playback */}
          {mode === 'hear-video' && (
            <div className="space-y-4">
              <div className="p-4 rounded-xl bg-black/40 border border-white/8 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-white">Live Voice Listener</span>
                  <span className="text-[11px] font-mono text-neutral-400">
                    Playhead: <strong className="text-rose-400">{currentTimestamp.toFixed(1)}s</strong>
                  </span>
                </div>
                <p className="text-xs text-neutral-300 leading-relaxed">
                  Start the video playback. Forge Studio will listen to the speaker&rsquo;s voice through your speaker/mic, recognizing every spoken word and automatically mapping it to the playhead timeline.
                </p>
              </div>

              {/* Big Start / Stop Listener Controller */}
              <div className="flex flex-col sm:flex-row items-center justify-center gap-3 py-2">
                <button
                  type="button"
                  onClick={handleToggleLiveListening}
                  className={`px-6 py-3 rounded-xl font-semibold text-xs sm:text-sm flex items-center gap-2 transition shadow-lg ${
                    isListening
                      ? 'bg-red-600 hover:bg-red-500 text-white animate-pulse'
                      : 'bg-rose-600 hover:bg-rose-500 text-white'
                  }`}
                >
                  {isListening ? (
                    <>
                      <Radio className="w-4 h-4 animate-spin text-white" />
                      <span>Stop Listening & Pause</span>
                    </>
                  ) : (
                    <>
                      <Headphones className="w-4 h-4" />
                      <span>Hear Video Voice & Start Transcribing</span>
                    </>
                  )}
                </button>

                {heardWords.length > 0 && (
                  <button
                    type="button"
                    onClick={handleClearHeardWords}
                    className="px-4 py-2.5 rounded-xl bg-white/5 hover:bg-white/10 text-neutral-300 text-xs font-medium border border-white/8 transition"
                  >
                    Clear Words
                  </button>
                )}
              </div>

              {!supported && (
                <div className="p-3 rounded-xl bg-amber-950/40 border border-amber-600/40 text-xs text-amber-200 flex items-start gap-2">
                  <AlertCircle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                  <span>
                    Your browser does not support Web Speech Recognition. Use the &ldquo;Instant Audio Transcribe&rdquo; tab for server-side AI voice recognition.
                  </span>
                </div>
              )}
            </div>
          )}

          {/* Mode 2: Instant Audio Transcribe (AI & CC) */}
          {mode === 'instant-cc' && (
            <div className="space-y-4">
              <div className="p-4 rounded-xl bg-black/40 border border-white/8 space-y-2">
                <div className="flex items-center gap-2 text-xs font-semibold text-white">
                  <Sparkles className="w-4 h-4 text-amber-400" />
                  <span>Server-Side Voice-to-Text & Verbatim CC</span>
                </div>
                <p className="text-xs text-neutral-300 leading-relaxed">
                  Extracts verbatim audio transcription directly from the video track. Uses speech recognition algorithms and Gemini to align every single spoken word to sub-second timestamps.
                </p>
              </div>

              <div className="pt-2 flex justify-center">
                <button
                  type="button"
                  onClick={handleInstantAudioTranscribe}
                  disabled={isAiProcessing}
                  className="px-6 py-3 rounded-xl bg-rose-600 hover:bg-rose-500 disabled:opacity-50 text-white font-semibold text-xs sm:text-sm flex items-center gap-2 shadow-lg transition"
                >
                  {isAiProcessing ? (
                    <>
                      <RefreshCw className="w-4 h-4 animate-spin text-white" />
                      <span>{aiStatus || 'Processing audio...'}</span>
                    </>
                  ) : (
                    <>
                      <Sparkles className="w-4 h-4" />
                      <span>Extract Spoken Words from Video</span>
                    </>
                  )}
                </button>
              </div>
            </div>
          )}

          {/* Mode 3: Microphone Voiceover Dictation */}
          {mode === 'mic-dictate' && (
            <div className="space-y-4">
              <div className="p-4 rounded-xl bg-black/40 border border-white/8 space-y-2">
                <div className="flex items-center gap-2 text-xs font-semibold text-white">
                  <Mic className="w-4 h-4 text-emerald-400" />
                  <span>Microphone Voiceover to Kinetic Words</span>
                </div>
                <p className="text-xs text-neutral-300 leading-relaxed">
                  Speak into your microphone. Forge Studio will transcribe your voice into kinetic animated words timed to the cadence of your speech.
                </p>
              </div>

              <div className="pt-2 flex justify-center">
                <button
                  type="button"
                  onClick={handleToggleLiveListening}
                  className={`px-6 py-3 rounded-xl font-semibold text-xs sm:text-sm flex items-center gap-2 transition shadow-lg ${
                    isListening
                      ? 'bg-emerald-600 hover:bg-emerald-500 text-white animate-pulse'
                      : 'bg-emerald-600 hover:bg-emerald-500 text-white'
                  }`}
                >
                  {isListening ? (
                    <>
                      <MicOff className="w-4 h-4" />
                      <span>Stop Recording Voice</span>
                    </>
                  ) : (
                    <>
                      <Mic className="w-4 h-4" />
                      <span>Record & Transcribe Microphone</span>
                    </>
                  )}
                </button>
              </div>
            </div>
          )}

          {/* Live Soundwave & Word Stream Visualizer */}
          {isListening && (
            <div className="p-4 rounded-xl bg-black/50 border border-rose-500/40 space-y-3 animate-in fade-in">
              <div className="flex items-center justify-between text-xs text-rose-300 font-medium">
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full bg-rose-500 animate-ping" />
                  <span>Hearing voice in real time...</span>
                </div>
                <span className="font-mono">{currentTimestamp.toFixed(1)}s</span>
              </div>

              {interimText && (
                <div className="text-sm font-medium text-amber-300 italic bg-black/40 p-2.5 rounded-lg border border-amber-500/20">
                  &ldquo;{interimText}&rdquo;
                </div>
              )}
            </div>
          )}

          {/* Live Transcribed Kinetic Words Timeline Grid */}
          <div className="space-y-2.5">
            <div className="flex items-center justify-between text-xs">
              <div className="flex items-center gap-1.5 font-semibold text-white">
                <ListOrdered className="w-3.5 h-3.5 text-rose-400" />
                <span>Heard Words on Kinetic Timeline ({heardWords.length} words)</span>
              </div>
              {heardWords.length > 0 && (
                <span className="text-[11px] font-mono text-neutral-400">
                  {heardWords[0]?.start_s.toFixed(1)}s → {heardWords[heardWords.length - 1]?.end_s.toFixed(1)}s
                </span>
              )}
            </div>

            {heardWords.length > 0 ? (
              <div className="p-3 rounded-xl bg-[#090c10] border border-white/8 max-h-56 overflow-y-auto flex flex-wrap gap-1.5 items-center">
                {heardWords.map((item, idx) => (
                  <button
                    key={idx}
                    type="button"
                    onClick={() => onSeek(item.start_s)}
                    className="px-2 py-1 rounded-lg bg-black/60 hover:bg-rose-500/20 text-neutral-200 hover:text-white border border-white/8 hover:border-rose-500/40 text-xs font-medium transition flex items-center gap-1 group"
                    title={`Seek to ${item.start_s.toFixed(2)}s`}
                  >
                    <span>{item.word}</span>
                    <span className="text-[9px] font-mono text-neutral-500 group-hover:text-rose-300">
                      {item.start_s.toFixed(1)}s
                    </span>
                  </button>
                ))}
              </div>
            ) : (
              <div className="p-8 text-center text-xs text-neutral-500 border border-dashed border-white/8 rounded-xl bg-black/20">
                No words transcribed yet. Click &ldquo;Hear Video Voice&rdquo; or &ldquo;Extract Spoken Words&rdquo; to begin.
              </div>
            )}
          </div>

          {errorMessage && (
            <div className="p-3 rounded-xl bg-red-950/40 border border-red-800/50 text-xs text-red-200 flex items-start gap-2">
              <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
              <span>{errorMessage}</span>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-white/8 bg-black/20 flex flex-col sm:flex-row items-center justify-between gap-3">
          <div className="text-xs text-neutral-400">
            {heardWords.length > 0 ? (
              <span>Ready to synchronize with 9:16 Kinetic typography</span>
            ) : (
              <span>Select a voice-to-text mode above</span>
            )}
          </div>

          <div className="flex items-center gap-2 w-full sm:w-auto">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 sm:flex-none px-4 py-2 text-xs font-medium text-neutral-300 hover:text-white bg-white/5 hover:bg-white/10 rounded-xl transition border border-white/8"
            >
              Cancel
            </button>

            <button
              type="button"
              disabled={heardWords.length === 0 || isAiProcessing}
              onClick={handleApplyHeardWords}
              className="flex-1 sm:flex-none px-5 py-2 text-xs font-semibold text-white bg-rose-600 hover:bg-rose-500 disabled:opacity-50 rounded-xl transition flex items-center justify-center gap-2 shadow-sm"
            >
              {isAiProcessing ? (
                <>
                  <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                  <span>Aligning...</span>
                </>
              ) : (
                <>
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  <span>Apply Words to Kinetic Timeline</span>
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
