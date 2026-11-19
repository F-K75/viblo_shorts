import { apiFetch } from './api';
/**
 * Production-ready Web Audio and TTS manager.
 * Provides synthesized royalty-free background music, Gemini Neural TTS decoding,
 * browser SpeechSynthesis fallback, and MediaStream audio mixing for video export.
 */

// Converts 16-bit linear PCM base64 string to a standard WAV Blob
export function pcmToWavBlob(base64Pcm: string, sampleRate = 24000): Blob {
  const binaryString = atob(base64Pcm);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }

  // 16-bit PCM mono
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const dataSize = bytes.length;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  // RIFF header
  const writeString = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true); // subchunk1size (16 for PCM)
  view.setUint16(20, 1, true); // audioFormat (1 for PCM)
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeString(36, 'data');
  view.setUint32(40, dataSize, true);

  // Copy raw PCM sample data
  const pcmView = new Uint8Array(buffer, 44);
  pcmView.set(bytes);

  return new Blob([buffer], { type: 'audio/wav' });
}

export type MusicMood = 'lofi' | 'hype' | 'ambient';

class AudioManager {
  private static readonly MAX_TTS_CACHE_SIZE = 50;
  private ctx: AudioContext | null = null;
  private musicGainNode: GainNode | null = null;
  private isMusicPlaying = false;
  private timer: number | null = null;
  private synthUtterance: SpeechSynthesisUtterance | null = null;
  private currentAudioElement: HTMLAudioElement | null = null;
  private currentMood: MusicMood = 'lofi';
  private ttsCache = new Map<string, string>();

  // Audio stream destination for video export recording
  private exportDestination: MediaStreamAudioDestinationNode | null = null;

  public initContext(): AudioContext | null {
    if (typeof window === 'undefined') return null;
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      if (AudioCtx) {
        this.ctx = new AudioCtx();
      }
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
    return this.ctx;
  }

  /** Resumes the AudioContext and reports whether audio is actually running (needed for export audio). */
  public async ensureRunning(): Promise<boolean> {
    const ctx = this.initContext();
    if (!ctx) return false;
    try {
      if (ctx.state !== 'running') await ctx.resume();
    } catch {
      // ignore
    }
    return ctx.state === 'running';
  }

  public getExportAudioStream(): MediaStreamTrack | null {
    const ctx = this.initContext();
    if (!ctx) return null;
    if (!this.exportDestination) {
      this.exportDestination = ctx.createMediaStreamDestination();
      // Keep-alive: a silent constant source guarantees the export audio track always carries samples.
      // Without it, an idle/suspended graph yields an empty audio track and the MP4 muxer stalls video frames.
      try {
        const keepAlive = ctx.createConstantSource();
        keepAlive.offset.value = 0;
        keepAlive.connect(this.exportDestination);
        keepAlive.start();
      } catch {
        // ConstantSourceNode unsupported: fall back to whatever sources are connected
      }
    }
    if (this.musicGainNode) {
      try {
        this.musicGainNode.connect(this.exportDestination);
      } catch {
        // already connected or failed
      }
    }
    return this.exportDestination.stream.getAudioTracks()[0] || null;
  }

  /**
   * Routes a media element's audio (e.g. the user's own source video) into the export recording.
   * `monitor` also plays it through the speakers. Returns a disconnect function.
   * Note: createMediaElementSource takes over the element's audio, so use a dedicated element per export.
   */
  public connectElementToExport(el: HTMLMediaElement, monitor = true): (() => void) | null {
    const ctx = this.initContext();
    if (!ctx) return null;
    this.getExportAudioStream(); // ensures the export destination exists
    try {
      const src = ctx.createMediaElementSource(el);
      src.connect(this.exportDestination!);
      if (monitor) src.connect(ctx.destination);
      return () => {
        try {
          src.disconnect();
        } catch {
          // already disconnected
        }
      };
    } catch {
      return null;
    }
  }

  /**
   * Generates royalty-free background music using Web Audio synthesis with selectable mood.
   */
  public startBackgroundMusic(volume = 0.12, mood: MusicMood = 'lofi') {
    this.stopBackgroundMusic();
    const ctx = this.initContext();
    if (!ctx) return;

    this.currentMood = mood;
    this.musicGainNode = ctx.createGain();
    this.musicGainNode.gain.setValueAtTime(Math.min(volume, 0.4), ctx.currentTime);
    this.musicGainNode.connect(ctx.destination);

    // Also connect to export destination if active
    if (this.exportDestination) {
      try {
        this.musicGainNode.connect(this.exportDestination);
      } catch {
        // ignore
      }
    }

    this.isMusicPlaying = true;
    let step = 0;

    const chordProgressions: Record<MusicMood, number[][]> = {
      lofi: [
        [261.63, 329.63, 392.0, 493.88], // Cmaj7
        [220.0, 261.63, 329.63, 392.0], // Am7
        [174.61, 220.0, 261.63, 329.63], // Fmaj7
        [196.0, 246.94, 293.66, 349.23], // G7
      ],
      hype: [
        [130.81, 196.0, 261.63], // C3 power
        [110.0, 164.81, 220.0], // A2 power
        [87.31, 130.81, 174.61], // F2 power
        [98.0, 146.83, 196.0], // G2 power
      ],
      ambient: [
        [174.61, 261.63, 329.63, 392.0], // Fmaj7 space
        [196.0, 293.66, 349.23, 440.0], // G9 space
        [220.0, 261.63, 329.63, 523.25], // Am9 space
        [174.61, 220.0, 329.63, 392.0], // Fmaj9
      ],
    };

    const tempoMs: Record<MusicMood, number> = {
      lofi: 1100,
      hype: 750,
      ambient: 1800,
    };

    const playChord = () => {
      if (!this.isMusicPlaying || !this.ctx || !this.musicGainNode) return;

      const chords = chordProgressions[this.currentMood] || chordProgressions.lofi;
      const chord = chords[step % chords.length];
      const now = this.ctx.currentTime;

      chord.forEach((freq, i) => {
        const osc = this.ctx!.createOscillator();
        const noteGain = this.ctx!.createGain();

        osc.type = i === 0 ? 'triangle' : this.currentMood === 'hype' ? 'sawtooth' : 'sine';
        osc.frequency.setValueAtTime(freq / (this.currentMood === 'hype' ? 1.5 : 2), now);

        const decay = this.currentMood === 'ambient' ? 3.0 : this.currentMood === 'hype' ? 0.9 : 1.8;
        noteGain.gain.setValueAtTime(0.001, now);
        noteGain.gain.linearRampToValueAtTime(this.currentMood === 'hype' ? 0.05 : 0.08, now + 0.12);
        noteGain.gain.exponentialRampToValueAtTime(0.001, now + decay);

        osc.connect(noteGain);
        noteGain.connect(this.musicGainNode!);

        osc.start(now);
        osc.stop(now + decay + 0.1);
      });

      // Rhythm pulses
      if (this.currentMood === 'hype' || (this.currentMood === 'lofi' && step % 2 === 0)) {
        const kickOsc = this.ctx.createOscillator();
        const kickGain = this.ctx.createGain();
        kickOsc.frequency.setValueAtTime(this.currentMood === 'hype' ? 140 : 110, now);
        kickOsc.frequency.exponentialRampToValueAtTime(32, now + 0.12);
        kickGain.gain.setValueAtTime(0.2, now);
        kickGain.gain.exponentialRampToValueAtTime(0.001, now + 0.15);
        kickOsc.connect(kickGain);
        kickGain.connect(this.musicGainNode!);
        kickOsc.start(now);
        kickOsc.stop(now + 0.16);
      }

      step++;
      this.timer = window.setTimeout(playChord, tempoMs[this.currentMood] || 1100);
    };

    playChord();
  }

  public setMusicMood(mood: MusicMood, volume = 0.12) {
    if (this.currentMood !== mood && this.isMusicPlaying) {
      this.startBackgroundMusic(volume, mood);
    } else {
      this.currentMood = mood;
    }
  }

  public setMusicVolume(volume: number) {
    if (this.musicGainNode && this.ctx) {
      this.musicGainNode.gain.setValueAtTime(Math.min(volume, 0.4), this.ctx.currentTime);
    }
  }

  public stopBackgroundMusic() {
    this.isMusicPlaying = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.musicGainNode) {
      try {
        this.musicGainNode.disconnect();
      } catch {
        // ignore
      }
      this.musicGainNode = null;
    }
  }

  /**
   * Speaks voiceover text with browser SpeechSynthesis fallback
   */
  public speak(
    text: string,
    voiceName?: string,
    rate = 1.0,
    onWord?: (charIndex: number, word: string) => void,
    onEnd?: () => void
  ) {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
    this.stopSpeech();

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = rate;

    const voices = window.speechSynthesis.getVoices();
    if (voiceName) {
      const selected = voices.find(
        (v) => v.name.includes(voiceName) || v.voiceURI.includes(voiceName)
      );
      if (selected) utterance.voice = selected;
    } else {
      const defaultVoice = voices.find(
        (v) =>
          v.lang.startsWith('en') &&
          (v.name.includes('Natural') || v.name.includes('Google') || v.name.includes('Guy'))
      );
      if (defaultVoice) utterance.voice = defaultVoice;
    }

    if (onWord) {
      utterance.onboundary = (e) => {
        if (e.name === 'word') {
          const word = text
            .substring(e.charIndex, e.charIndex + (e.charLength || 10))
            .split(/\s+/)[0];
          onWord(e.charIndex, word);
        }
      };
    }

    utterance.onend = () => {
      this.synthUtterance = null;
      if (onEnd) onEnd();
    };

    utterance.onerror = () => {
      this.synthUtterance = null;
      if (onEnd) onEnd();
    };

    this.synthUtterance = utterance;
    try {
      window.speechSynthesis.speak(utterance);
    } catch {
      // ignore
    }
  }

  private setTtsCache(key: string, blobUrl: string) {
    const activeSrc = this.currentAudioElement?.src;
    const existing = this.ttsCache.get(key);
    if (existing) {
      this.ttsCache.delete(key);
      if (existing !== blobUrl && existing !== activeSrc) {
        URL.revokeObjectURL(existing);
      }
    }
    while (this.ttsCache.size >= AudioManager.MAX_TTS_CACHE_SIZE) {
      const oldestKey = this.ttsCache.keys().next().value;
      if (oldestKey === undefined) break;
      const evictedUrl = this.ttsCache.get(oldestKey);
      this.ttsCache.delete(oldestKey);
      if (evictedUrl && evictedUrl !== activeSrc) {
        URL.revokeObjectURL(evictedUrl);
      }
    }
    this.ttsCache.set(key, blobUrl);
  }

  public clearTtsCache() {
    this.stopSpeech();
    for (const url of this.ttsCache.values()) {
      URL.revokeObjectURL(url);
    }
    this.ttsCache.clear();
  }

  /**
   * Attempts to play studio-quality Google Neural TTS from /api/tts with automatic memory caching,
   * seamlessly falling back to browser SpeechSynthesis if offline or when using system voices.
   */
  private ttsDurations = new Map<string, number>();

  /**
   * Fetches (and caches) the neural TTS line ahead of time and returns its real duration in seconds, so beats and
   * captions can be timed to the actual voice. Null when neural TTS is unavailable (no key / error).
   */
  public async prefetchTts(text: string, voiceName: string = 'Kore'): Promise<number | null> {
    const cacheKey = `${voiceName}:${text.trim()}`;
    if (!text.trim()) return null;
    const known = this.ttsDurations.get(cacheKey);
    if (known !== undefined && this.ttsCache.has(cacheKey)) return known;
    try {
      const res = await apiFetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, voice: voiceName }),
      });
      if (!res.ok) return null;
      const data = await res.json();
      if (!data.success || !data.audioData) return null;
      const sampleRate = data.sampleRate || 24000;
      const bytes = Math.floor((data.audioData.length * 3) / 4); // base64 → bytes (16-bit mono PCM)
      const seconds = bytes / 2 / sampleRate;
      this.setTtsCache(cacheKey, URL.createObjectURL(pcmToWavBlob(data.audioData, sampleRate)));
      this.ttsDurations.set(cacheKey, seconds);
      return seconds;
    } catch {
      return null;
    }
  }

  public async speakNeuralOrFallback(text: string, voiceName: string = 'Kore') {
    const isGoogleVoice = ['Kore', 'Puck', 'Fenrir', 'Zephyr', 'Charon'].includes(voiceName);
    if (isGoogleVoice && text.trim()) {
      const cacheKey = `${voiceName}:${text.trim()}`;
      let blobUrl = this.ttsCache.get(cacheKey);
      if (blobUrl) {
        // Refresh entry for LRU ordering
        this.ttsCache.delete(cacheKey);
        this.ttsCache.set(cacheKey, blobUrl);
      }

      if (!blobUrl) {
        try {
          const res = await apiFetch('/api/tts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text, voice: voiceName }),
          });
          if (res.ok) {
            const data = await res.json();
            if (data.success && data.audioData) {
              const wavBlob = pcmToWavBlob(data.audioData, data.sampleRate || 24000);
              blobUrl = URL.createObjectURL(wavBlob);
              this.setTtsCache(cacheKey, blobUrl);
            }
          }
        } catch {
          // ignore error, will fall through to speech synthesis
        }
      }

      if (blobUrl) {
        this.stopSpeech();
        const audio = new Audio(blobUrl);
        this.currentAudioElement = audio;

        // If export destination is active, route audio to export stream
        if (this.ctx && this.exportDestination) {
          try {
            const source = this.ctx.createMediaElementSource(audio);
            source.connect(this.ctx.destination);
            source.connect(this.exportDestination);
          } catch {
            // ignore
          }
        }

        try {
          await audio.play();
          return;
        } catch {
          // If browser blocked autoplay, fall through
        }
      }
    }

    this.speak(text, voiceName);
  }

  public stopSpeech() {
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      try {
        window.speechSynthesis.cancel();
      } catch {
        // ignore
      }
      this.synthUtterance = null;
    }
    if (this.currentAudioElement) {
      try {
        this.currentAudioElement.pause();
        this.currentAudioElement.src = '';
      } catch {
        // ignore
      }
      this.currentAudioElement = null;
    }
  }

  public stopAll() {
    this.stopBackgroundMusic();
    this.stopSpeech();
  }
}

export const audioManager = new AudioManager();
