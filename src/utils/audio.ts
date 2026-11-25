import { apiFetch } from './api';
import type { AudioAnalysisMetrics, Beat } from '../types';

/**
 * Production-ready Web Audio and TTS manager.
 * Provides:
 * - Synthesized royalty-free background music with voiceover ducking
 * - Gemini Neural TTS PCM->WAV conversion, AudioBuffer decoding & waveform silence validation
 * - Sample-accurate AudioBufferSourceNode scheduling into MediaStreamAudioDestinationNode for MP4 export
 * - Real-time AnalyserNode RMS/peak level monitoring during export so silent tracks are detected immediately
 */

// Converts 16-bit linear PCM base64 string to a standard WAV Blob
export function pcmToWavBlob(base64Pcm: string, sampleRate = 24000): Blob {
  const binaryString = atob(base64Pcm);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }

  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const dataSize = bytes.length;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeString = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeString(36, 'data');
  view.setUint32(40, dataSize, true);

  const pcmView = new Uint8Array(buffer, 44);
  pcmView.set(bytes);

  return new Blob([buffer], { type: 'audio/wav' });
}

/**
 * Analyzes a decoded Web Audio AudioBuffer for RMS level, peak level, silence ratio, and duration.
 * Guarantees silent or corrupted TTS buffers are detected before mixing or export.
 */
export function analyzeAudioBuffer(buffer: AudioBuffer): AudioAnalysisMetrics {
  const sampleRate = buffer.sampleRate;
  const durationS = Math.round(buffer.duration * 100) / 100;
  const channels = buffer.numberOfChannels;
  const length = buffer.length;
  if (length === 0 || channels === 0) {
    return { durationS: 0, rmsDb: -120, peakDb: -120, silenceRatio: 1, isSilent: true, sampleRate };
  }
  const ch0 = buffer.getChannelData(0);
  let sumSq = 0;
  let peak = 0;
  // Evaluate silence in 50ms windows
  const winSize = Math.max(1, Math.floor(sampleRate * 0.05));
  let silentWindows = 0;
  let totalWindows = 0;
  for (let start = 0; start < length; start += winSize) {
    const end = Math.min(length, start + winSize);
    let winSq = 0;
    for (let i = start; i < end; i++) {
      const s = ch0[i];
      const a = Math.abs(s);
      if (a > peak) peak = a;
      sumSq += s * s;
      winSq += s * s;
    }
    const winRms = Math.sqrt(winSq / Math.max(1, end - start));
    if (winRms < 0.003) silentWindows++; // ~ -50 dBFS
    totalWindows++;
  }
  const rms = Math.sqrt(sumSq / length);
  const rmsDb = rms > 1e-6 ? Math.round(20 * Math.log10(rms) * 10) / 10 : -120;
  const peakDb = peak > 1e-6 ? Math.round(20 * Math.log10(peak) * 10) / 10 : -120;
  const silenceRatio = totalWindows ? Math.round((silentWindows / totalWindows) * 1000) / 1000 : 1;
  const isSilent = durationS < 0.1 || peakDb < -45 || rmsDb < -58 || silenceRatio >= 0.96;
  return { durationS, rmsDb, peakDb, silenceRatio, isSilent, sampleRate };
}

export type MusicMood = 'lofi' | 'hype' | 'ambient';

export interface ExportAudioMonitorResult {
  peakDb: number;
  rmsDb: number;
  hasSignal: boolean;
  samplesTaken: number;
}

class AudioManager {
  private static readonly MAX_TTS_CACHE_SIZE = 50;
  private ctx: AudioContext | null = null;
  private musicGainNode: GainNode | null = null;
  private musicBaseVolume = 0.12;
  private isMusicPlaying = false;
  private timer: number | null = null;
  private synthUtterance: SpeechSynthesisUtterance | null = null;
  private currentAudioElement: HTMLAudioElement | null = null;
  private currentBufferSources: AudioBufferSourceNode[] = [];
  private currentMood: MusicMood = 'lofi';
  private ttsCache = new Map<string, string>();
  private ttsBuffers = new Map<string, AudioBuffer>();
  private ttsDurations = new Map<string, number>();

  // Export audio bus: sources -> exportMixBus -> analyser -> exportDestination
  private exportDestination: MediaStreamAudioDestinationNode | null = null;
  private exportMixBus: GainNode | null = null;
  private exportAnalyser: AnalyserNode | null = null;
  private monitorPeak = 0;
  private monitorRmsSum = 0;
  private monitorSamples = 0;

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

  private ensureExportBus(): GainNode | null {
    const ctx = this.initContext();
    if (!ctx) return null;
    if (!this.exportDestination) {
      this.exportDestination = ctx.createMediaStreamDestination();
      this.exportMixBus = ctx.createGain();
      this.exportMixBus.gain.value = 1.0;
      this.exportAnalyser = ctx.createAnalyser();
      this.exportAnalyser.fftSize = 2048;

      this.exportMixBus.connect(this.exportAnalyser);
      this.exportAnalyser.connect(this.exportDestination);

      // Keep-alive: a silent constant source keeps the audio clock advancing during brief pauses between beats.
      // Actual audio presence is verified by exportAnalyser + server-side FFmpeg waveform analysis.
      try {
        const keepAlive = ctx.createConstantSource();
        keepAlive.offset.value = 0;
        keepAlive.connect(this.exportMixBus);
        keepAlive.start();
      } catch {
        // ConstantSourceNode unsupported
      }
    }
    return this.exportMixBus;
  }

  public getExportAudioStream(): MediaStreamTrack | null {
    const bus = this.ensureExportBus();
    if (!bus || !this.exportDestination) return null;
    if (this.musicGainNode) {
      try {
        this.musicGainNode.connect(bus);
      } catch {
        // already connected
      }
    }
    return this.exportDestination.stream.getAudioTracks()[0] || null;
  }

  /** Resets the real-time export audio level monitor before starting MediaRecorder. */
  public startExportAudioMonitor() {
    this.ensureExportBus();
    this.monitorPeak = 0;
    this.monitorRmsSum = 0;
    this.monitorSamples = 0;
  }

  /** Samples the active export bus during recording to measure real peak & RMS levels. */
  public sampleExportAudio() {
    if (!this.exportAnalyser) return;
    const buf = new Float32Array(this.exportAnalyser.fftSize);
    this.exportAnalyser.getFloatTimeDomainData(buf);
    let sumSq = 0;
    let peak = 0;
    for (let i = 0; i < buf.length; i++) {
      const a = Math.abs(buf[i]);
      if (a > peak) peak = a;
      sumSq += buf[i] * buf[i];
    }
    if (peak > this.monitorPeak) this.monitorPeak = peak;
    this.monitorRmsSum += Math.sqrt(sumSq / buf.length);
    this.monitorSamples++;
  }

  public getExportAudioMetrics(): ExportAudioMonitorResult {
    const avgRms = this.monitorSamples > 0 ? this.monitorRmsSum / this.monitorSamples : 0;
    const peakDb = this.monitorPeak > 1e-6 ? Math.round(20 * Math.log10(this.monitorPeak) * 10) / 10 : -120;
    const rmsDb = avgRms > 1e-6 ? Math.round(20 * Math.log10(avgRms) * 10) / 10 : -120;
    return {
      peakDb,
      rmsDb,
      hasSignal: peakDb > -48 && rmsDb > -60,
      samplesTaken: this.monitorSamples,
    };
  }

  /**
   * Routes a media element's audio (e.g. the user's own source video) into the export recording.
   * `monitor` also plays it through the speakers. Returns a disconnect function.
   */
  public connectElementToExport(el: HTMLMediaElement, monitor = true): (() => void) | null {
    const ctx = this.initContext();
    if (!ctx) return null;
    const bus = this.ensureExportBus();
    if (!bus) return null;
    try {
      const src = ctx.createMediaElementSource(el);
      src.connect(bus);
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
    this.musicBaseVolume = Math.min(volume, 0.4);
    this.musicGainNode = ctx.createGain();
    this.musicGainNode.gain.setValueAtTime(this.musicBaseVolume, ctx.currentTime);
    this.musicGainNode.connect(ctx.destination);

    if (this.exportMixBus) {
      try {
        this.musicGainNode.connect(this.exportMixBus);
      } catch {
        // ignore
      }
    }

    this.isMusicPlaying = true;
    let step = 0;

    const chordProgressions: Record<MusicMood, number[][]> = {
      lofi: [
        [261.63, 329.63, 392.0, 493.88],
        [220.0, 261.63, 329.63, 392.0],
        [174.61, 220.0, 261.63, 329.63],
        [196.0, 246.94, 293.66, 349.23],
      ],
      hype: [
        [130.81, 196.0, 261.63],
        [110.0, 164.81, 220.0],
        [87.31, 130.81, 174.61],
        [98.0, 146.83, 196.0],
      ],
      ambient: [
        [174.61, 261.63, 329.63, 392.0],
        [196.0, 293.66, 349.23, 440.0],
        [220.0, 261.63, 329.63, 523.25],
        [174.61, 220.0, 329.63, 392.0],
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
    this.musicBaseVolume = Math.min(volume, 0.4);
    if (this.musicGainNode && this.ctx) {
      this.musicGainNode.gain.setValueAtTime(this.musicBaseVolume, this.ctx.currentTime);
    }
  }

  /** Smoothly ducks background music while narration is speaking, then restores it. */
  public duckMusic(ducked: boolean) {
    if (!this.musicGainNode || !this.ctx) return;
    const target = ducked ? Math.min(this.musicBaseVolume * 0.45, 0.09) : this.musicBaseVolume;
    this.musicGainNode.gain.setTargetAtTime(target, this.ctx.currentTime, 0.08);
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
   * Speaks voiceover text with browser SpeechSynthesis fallback (preview only; cannot be captured by MediaStream).
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

  private setTtsCache(key: string, blobUrl: string, buffer?: AudioBuffer) {
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
      this.ttsBuffers.delete(oldestKey);
      this.ttsDurations.delete(oldestKey);
      if (evictedUrl && evictedUrl !== activeSrc) {
        URL.revokeObjectURL(evictedUrl);
      }
    }
    this.ttsCache.set(key, blobUrl);
    if (buffer) this.ttsBuffers.set(key, buffer);
  }

  public clearTtsCache() {
    this.stopSpeech();
    for (const url of this.ttsCache.values()) {
      URL.revokeObjectURL(url);
    }
    this.ttsCache.clear();
    this.ttsBuffers.clear();
    this.ttsDurations.clear();
  }

  public getCachedTtsBuffer(text: string, voiceName = 'Kore'): AudioBuffer | null {
    return this.ttsBuffers.get(`${voiceName}:${text.trim()}`) || null;
  }

  /**
   * Fetches, decodes, validates non-silence, and caches neural TTS ahead of time.
   * Returns its verified real duration in seconds, or null if TTS is unavailable or silent.
   */
  public async prefetchTts(text: string, voiceName: string = 'Kore'): Promise<number | null> {
    const clean = text.trim();
    if (!clean) return null;
    const cacheKey = `${voiceName}:${clean}`;
    const known = this.ttsDurations.get(cacheKey);
    if (known !== undefined && (this.ttsBuffers.has(cacheKey) || this.ttsCache.has(cacheKey))) return known;
    try {
      const res = await apiFetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: clean, voice: voiceName }),
      });
      if (!res.ok) return null;
      const data = await res.json();
      if (!data.success || !data.audioData) return null;
      const sampleRate = data.sampleRate || 24000;
      const wavBlob = pcmToWavBlob(data.audioData, sampleRate);
      let decoded: AudioBuffer | undefined;
      const ctx = this.initContext();
      if (ctx) {
        try {
          const ab = await wavBlob.arrayBuffer();
          decoded = await ctx.decodeAudioData(ab.slice(0));
          const metrics = analyzeAudioBuffer(decoded);
          if (metrics.isSilent) {
            console.warn('[AudioManager] Discarding silent TTS buffer:', metrics);
            return null;
          }
        } catch {
          // decode failed; fall back to blob playback
        }
      }
      const bytes = Math.floor((data.audioData.length * 3) / 4);
      const seconds = decoded ? Math.round(decoded.duration * 100) / 100 : Math.round((bytes / 2 / sampleRate) * 100) / 100;
      if (seconds < 0.1) return null;
      this.setTtsCache(cacheKey, URL.createObjectURL(wavBlob), decoded);
      this.ttsDurations.set(cacheKey, seconds);
      return seconds;
    } catch {
      return null;
    }
  }

  /** Pre-fetches and validates TTS audio for every beat before export recording begins. */
  public async prefetchAllTts(
    beats: Beat[],
    voiceName = 'Kore',
  ): Promise<{ durations: Array<number | null>; loadedCount: number; totalBeats: number }> {
    const durations: Array<number | null> = [];
    let loadedCount = 0;
    for (const beat of beats) {
      const d = await this.prefetchTts(beat.text, voiceName);
      durations.push(d);
      if (d !== null) loadedCount++;
    }
    return { durations, loadedCount, totalBeats: beats.length };
  }

  /**
   * Sample-accurately schedules all cached TTS AudioBuffers onto the Web Audio clock for export recording,
   * routing them directly into the export mix bus (and speakers) with automatic music ducking.
   */
  public scheduleTtsTrack(
    beats: Beat[],
    voiceName = 'Kore',
    monitor = true,
  ): { scheduledCount: number; stop: () => void } {
    const ctx = this.initContext();
    const bus = this.ensureExportBus();
    if (!ctx || !bus) return { scheduledCount: 0, stop: () => {} };

    this.stopSpeech();
    const baseTime = ctx.currentTime + 0.05;
    const sources: AudioBufferSourceNode[] = [];
    const voiceGain = ctx.createGain();
    voiceGain.gain.value = 1.0;
    voiceGain.connect(bus);
    if (monitor) voiceGain.connect(ctx.destination);

    let scheduledCount = 0;
    for (const beat of beats) {
      const buffer = this.getCachedTtsBuffer(beat.text, voiceName);
      if (!buffer) continue;
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(voiceGain);
      const when = baseTime + Math.max(0, beat.start_s);
      src.start(when);
      sources.push(src);
      scheduledCount++;
    }

    if (scheduledCount > 0) this.duckMusic(true);
    this.currentBufferSources = sources;

    const stop = () => {
      for (const src of sources) {
        try {
          src.stop();
          src.disconnect();
        } catch {
          // already ended
        }
      }
      try {
        voiceGain.disconnect();
      } catch {
        // ignore
      }
      this.currentBufferSources = [];
      this.duckMusic(false);
    };

    return { scheduledCount, stop };
  }

  public async speakNeuralOrFallback(text: string, voiceName: string = 'Kore') {
    const isGoogleVoice = ['Kore', 'Puck', 'Fenrir', 'Zephyr', 'Charon'].includes(voiceName);
    const clean = text.trim();
    if (isGoogleVoice && clean) {
      const cacheKey = `${voiceName}:${clean}`;
      let decoded = this.ttsBuffers.get(cacheKey);
      if (!decoded) {
        await this.prefetchTts(clean, voiceName);
        decoded = this.ttsBuffers.get(cacheKey);
      }

      if (decoded && this.ctx) {
        this.stopSpeech();
        const src = this.ctx.createBufferSource();
        src.buffer = decoded;
        const gain = this.ctx.createGain();
        gain.gain.value = 1.0;
        src.connect(gain);
        gain.connect(this.ctx.destination);
        if (this.exportMixBus) gain.connect(this.exportMixBus);
        this.duckMusic(true);
        src.onended = () => {
          this.duckMusic(false);
          try {
            gain.disconnect();
          } catch {
            // ignore
          }
        };
        this.currentBufferSources = [src];
        src.start();
        return;
      }

      const blobUrl = this.ttsCache.get(cacheKey);
      if (blobUrl) {
        this.stopSpeech();
        const audio = new Audio(blobUrl);
        this.currentAudioElement = audio;
        if (this.ctx && this.exportMixBus) {
          try {
            const source = this.ctx.createMediaElementSource(audio);
            source.connect(this.ctx.destination);
            source.connect(this.exportMixBus);
          } catch {
            // ignore
          }
        }
        try {
          await audio.play();
          return;
        } catch {
          // fall through
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
    for (const src of this.currentBufferSources) {
      try {
        src.stop();
        src.disconnect();
      } catch {
        // ignore
      }
    }
    this.currentBufferSources = [];
    if (this.currentAudioElement) {
      try {
        this.currentAudioElement.pause();
        this.currentAudioElement.src = '';
      } catch {
        // ignore
      }
      this.currentAudioElement = null;
    }
    this.duckMusic(false);
  }

  public stopAll() {
    this.stopBackgroundMusic();
    this.stopSpeech();
  }
}

export const audioManager = new AudioManager();
