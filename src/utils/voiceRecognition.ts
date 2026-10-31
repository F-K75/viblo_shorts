import { WordTiming, Beat } from '../types';
import { apiFetch } from './api';

// SpeechRecognition type declarations for browsers
declare global {
  interface Window {
    SpeechRecognition?: any;
    webkitSpeechRecognition?: any;
  }
}

export function isSpeechRecognitionSupported(): boolean {
  if (typeof window === 'undefined') return false;
  return Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);
}

export interface LiveHeardWord {
  word: string;
  start_s: number;
  end_s: number;
  confidence?: number;
}

export interface VoiceListenerHandle {
  stop: () => void;
  isListening: boolean;
}

/**
 * Starts a live voice listener using browser speech recognition.
 * As the video plays (or user speaks), it hears the voice and emits timestamped words
 * pegged to the playhead timestamp.
 */
export function startLiveVoiceListener(options: {
  getPlayheadTime: () => number;
  onWordRecognized: (word: LiveHeardWord) => void;
  onInterimText?: (text: string) => void;
  onError?: (err: string) => void;
  onStateChange?: (listening: boolean) => void;
  lang?: string;
}): VoiceListenerHandle {
  const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;

  if (!SpeechRec) {
    options.onError?.('Speech recognition is not supported in this browser. Please use Chrome, Edge, or Safari.');
    return { stop: () => {}, isListening: false };
  }

  const recognition = new SpeechRec();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = options.lang || 'en-US';

  let isRunning = true;
  let lastEmittedWordCount = 0;
  let sessionStartTime = options.getPlayheadTime();

  recognition.onstart = () => {
    isRunning = true;
    options.onStateChange?.(true);
  };

  recognition.onerror = (event: any) => {
    if (event.error !== 'no-speech') {
      console.warn('[Voice Recognition] Error:', event.error);
      options.onError?.(event.error === 'not-allowed' ? 'Microphone permission denied' : `Voice recognition: ${event.error}`);
    }
  };

  recognition.onend = () => {
    if (isRunning) {
      try {
        recognition.start();
      } catch {
        isRunning = false;
        options.onStateChange?.(false);
      }
    } else {
      options.onStateChange?.(false);
    }
  };

  recognition.onresult = (event: any) => {
    const playhead = options.getPlayheadTime();

    for (let i = event.resultIndex; i < event.results.length; ++i) {
      const res = event.results[i];
      const transcript = res[0]?.transcript || '';

      if (res.isFinal) {
        const words = transcript.trim().split(/\s+/).filter(Boolean);
        const timeWindow = Math.max(0.6, playhead - sessionStartTime);
        const wordDur = timeWindow / Math.max(words.length, 1);

        words.forEach((w: string, idx: number) => {
          const wStart = parseFloat((sessionStartTime + idx * wordDur).toFixed(2));
          const wEnd = parseFloat((wStart + wordDur * 0.9).toFixed(2));
          options.onWordRecognized({
            word: w.replace(/[.,!?;:]/g, ''),
            start_s: wStart,
            end_s: wEnd,
            confidence: res[0]?.confidence,
          });
        });

        sessionStartTime = playhead;
        lastEmittedWordCount = 0;
      } else {
        options.onInterimText?.(transcript);
      }
    }
  };

  try {
    recognition.start();
  } catch (e: any) {
    options.onError?.(e.message || 'Could not start voice recognition');
  }

  return {
    stop: () => {
      isRunning = false;
      try {
        recognition.stop();
      } catch {
        // ignore
      }
      options.onStateChange?.(false);
    },
    isListening: isRunning,
  };
}

/**
 * Calls server-side endpoint to extract verbatim audio CC or Gemini voice transcript
 * with word-level timestamps directly from the video.
 */
export async function fetchVideoVoiceTranscription(params: {
  videoId?: string;
  clipStartSeconds?: number;
  clipEndSeconds?: number;
  videoTitle?: string;
  contextText?: string;
}): Promise<{
  success: boolean;
  words: WordTiming[];
  beats: Beat[];
  fullText: string;
  source: string;
}> {
  const res = await apiFetch('/api/voice-to-text/transcribe-clip', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.error || 'Failed to fetch voice transcription from server');
  }
  return data;
}

/**
 * Aligns spoken or dictated text to kinetic words with Gemini.
 */
export async function alignSpokenWordsToTimeline(params: {
  speechText: string;
  targetDuration: number;
}): Promise<{
  success: boolean;
  words: WordTiming[];
  beats: Beat[];
}> {
  const res = await apiFetch('/api/voice-to-text/align-words', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });

  if (!res.ok) {
    throw new Error('Failed to align spoken words');
  }

  return await res.json();
}
