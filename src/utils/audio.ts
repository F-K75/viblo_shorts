/**
 * Web Audio synthesizer for royalty-free background music and audio mixing.
 */
class AudioManager {
  private ctx: AudioContext | null = null;
  private musicGainNode: GainNode | null = null;
  private isMusicPlaying = false;
  private timer: number | null = null;
  private synthUtterance: SpeechSynthesisUtterance | null = null;

  private initContext() {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      this.ctx = new AudioCtx();
    }
    if (this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
  }

  /**
   * Generates a warm, modern lofi chill beat using Web Audio oscillators and noise nodes.
   * Completely royalty-free, zero network dependencies, runs smoothly anywhere.
   */
  public startBackgroundMusic(volume = 0.12) {
    this.stopBackgroundMusic();
    this.initContext();
    if (!this.ctx) return;

    this.musicGainNode = this.ctx.createGain();
    this.musicGainNode.gain.setValueAtTime(Math.min(volume, 0.4), this.ctx.currentTime);
    this.musicGainNode.connect(this.ctx.destination);

    this.isMusicPlaying = true;
    let step = 0;
    const chords = [
      [261.63, 329.63, 392.00, 493.88], // Cmaj7
      [220.00, 261.63, 329.63, 392.00], // Am7
      [174.61, 220.00, 261.63, 329.63], // Fmaj7
      [196.00, 246.94, 293.66, 349.23], // G7
    ];

    const playChord = () => {
      if (!this.isMusicPlaying || !this.ctx || !this.musicGainNode) return;

      const chord = chords[step % chords.length];
      const now = this.ctx.currentTime;

      chord.forEach((freq, i) => {
        const osc = this.ctx!.createOscillator();
        const noteGain = this.ctx!.createGain();

        osc.type = i === 0 ? 'triangle' : 'sine';
        osc.frequency.setValueAtTime(freq / 2, now);

        noteGain.gain.setValueAtTime(0.001, now);
        noteGain.gain.linearRampToValueAtTime(0.08, now + 0.15);
        noteGain.gain.exponentialRampToValueAtTime(0.001, now + 1.8);

        osc.connect(noteGain);
        noteGain.connect(this.musicGainNode!);

        osc.start(now);
        osc.stop(now + 2.0);
      });

      // subtle kick / click rhythm
      if (step % 2 === 0) {
        const kickOsc = this.ctx.createOscillator();
        const kickGain = this.ctx.createGain();
        kickOsc.frequency.setValueAtTime(110, now);
        kickOsc.frequency.exponentialRampToValueAtTime(30, now + 0.12);
        kickGain.gain.setValueAtTime(0.2, now);
        kickGain.gain.exponentialRampToValueAtTime(0.001, now + 0.15);
        kickOsc.connect(kickGain);
        kickGain.connect(this.musicGainNode!);
        kickOsc.start(now);
        kickOsc.stop(now + 0.16);
      }

      step++;
      this.timer = window.setTimeout(playChord, 1200);
    };

    playChord();
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
      } catch (e) {
        // ignore
      }
      this.musicGainNode = null;
    }
  }

  /**
   * Speaks voiceover text with browser SpeechSynthesis and calls onWord callback
   */
  public speak(
    text: string,
    voiceName?: string,
    rate = 1.0,
    onWord?: (charIndex: number, word: string) => void,
    onEnd?: () => void
  ) {
    if (!('speechSynthesis' in window)) return;
    this.stopSpeech();

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = rate;

    const voices = window.speechSynthesis.getVoices();
    if (voiceName) {
      const selected = voices.find(v => v.name.includes(voiceName) || v.voiceURI.includes(voiceName));
      if (selected) utterance.voice = selected;
    } else {
      const defaultVoice = voices.find(v => v.lang.startsWith('en') && (v.name.includes('Natural') || v.name.includes('Google') || v.name.includes('Guy')));
      if (defaultVoice) utterance.voice = defaultVoice;
    }

    if (onWord) {
      utterance.onboundary = (e) => {
        if (e.name === 'word') {
          const word = text.substring(e.charIndex, e.charIndex + (e.charLength || 10)).split(/\s+/)[0];
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
    window.speechSynthesis.speak(utterance);
  }

  public stopSpeech() {
    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel();
      this.synthUtterance = null;
    }
  }

  public stopAll() {
    this.stopBackgroundMusic();
    this.stopSpeech();
  }
}

export const audioManager = new AudioManager();
