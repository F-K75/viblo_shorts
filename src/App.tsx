import React, { useState, useEffect, useRef } from 'react';
import {
  Sparkles,
  Settings,
  ChevronDown,
  ChevronUp,
  RefreshCw,
  Wand2,
  Youtube,
  Plus,
  CloudUpload,
  LogOut,
  User,
  Home,
  CheckCircle2,
  Scissors,
  Layers,
  ArrowRight,
  FolderKanban,
  Zap,
  Save,
  Loader2,
  Share2,
} from 'lucide-react';
import {
  Beat,
  CaptionStyle,
  ShortScript,
  WordTiming,
  YouTubeClipCandidate,
  YouTubeVideoInfo,
  AudioSourceMode,
  VisualSourceMode,
  Project,
} from './types';
import {
  estimateWordTimings,
  assignBeatTimings,
  recalculateWordsFromBeats,
  autoAlignBeatTimelines,
  shiftAllBeats,
} from './utils/pipeline';
import { audioManager } from './utils/audio';
import { getSafeThumbnail } from './utils/visualPlaceholders';
import { HomePage } from './components/HomePage';
import { AuthPage, AuthUser } from './components/AuthPage';
import { StudioPage1Source } from './components/StudioPage1Source';
import { StudioPage2ClipStrategies } from './components/StudioPage2ClipStrategies';
import { StudioPage3CanvasTimeline } from './components/StudioPage3CanvasTimeline';
import { StockPickerModal } from './components/StockPickerModal';
import { GoogleDriveExportModal } from './components/GoogleDriveExportModal';
import { BillingModal } from './components/BillingModal';
import { MyProjectsModal } from './components/MyProjectsModal';
import { PublishingPackModal } from './components/PublishingPackModal';

const QUICK_TOPICS = [
  '5 productivity habits that actually work',
  'Why 99% of people quit their side project in 30 days',
  'The 3-second psychological hook that grabs attention',
  'The brutal truth about 8 hours of sleep',
  'How top 1% creators stay consistent without burnout',
];

const SAMPLE_VIDEOS = [
  {
    label: 'Steve Jobs 2005 Speech',
    url: 'https://www.youtube.com/watch?v=UF8uR6Z6KLc',
    note: 'Life, death, and intuition',
  },
  {
    label: 'Huberman on Sleep & Focus',
    url: 'https://www.youtube.com/watch?v=nm1TxQj94ow',
    note: 'Morning sunlight & dopamine',
  },
  {
    label: 'Me at the zoo (First Video)',
    url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw',
    note: 'Elephant trunks & internet history',
  },
];

export const App: React.FC = () => {
  const [currentPage, setCurrentPage] = useState<'home' | 'auth' | 'studio'>('home');
  const [authMode, setAuthMode] = useState<'signin' | 'signup'>('signin');
  const [currentUser, setCurrentUser] = useState<AuthUser | null>(() => {
    try {
      const saved = localStorage.getItem('forge_user') || localStorage.getItem('viblo_user');
      return saved ? JSON.parse(saved) : null;
    } catch {
      return null;
    }
  });

  // Studio Progressive 3-Page Flow: 1: Source & Idea -> 2: Clip Strategies & Trimmer -> 3: Studio Canvas & Timeline
  const [studioStep, setStudioStep] = useState<1 | 2 | 3>(1);

  const [creationMode, setCreationMode] = useState<'youtube' | 'prompt'>('youtube');
  const [topic, setTopic] = useState("Steve Jobs' 2005 Stanford Commencement Address");
  const [audience, setAudience] = useState('general YouTube audience');
  const [tone, setTone] = useState('energetic, direct, no fluff');

  const [isGenerating, setIsGenerating] = useState(false);
  const [generationStep, setGenerationStep] = useState<string>('');
  const [youtubeError, setYoutubeError] = useState<string | null>(null);

  const [script, setScript] = useState<ShortScript | null>(null);
  const [clipCandidates, setClipCandidates] = useState<YouTubeClipCandidate[]>([]);
  const [videoInfo, setVideoInfo] = useState<YouTubeVideoInfo | null>(null);

  const [allWords, setAllWords] = useState<WordTiming[]>([]);
  const [captionOffsetSeconds, setCaptionOffsetSeconds] = useState<number>(0);

  const [visualMode, setVisualMode] = useState<VisualSourceMode>('youtube-crop');
  const [youtubeVolume, setYoutubeVolume] = useState<number>(1.0);
  const [isYoutubeMuted, setIsYoutubeMuted] = useState<boolean>(false);

  const [captionStyle, setCaptionStyle] = useState<CaptionStyle>({
    id: 'hormozi',
    name: 'Alex Hormozi',
    fontFamily: 'Montserrat',
    fontWeight: '900',
    fontSize: 32,
    textColor: '#FFFFFF',
    highlightColor: '#FFE600',
    strokeColor: '#000000',
    strokeWidth: 5,
    positionY: 68,
    wordsPerChunk: 2,
    textTransform: 'uppercase',
    boxStyle: 'rounded-pill',
    badge: 'Hormozi Gold',
  });

  const [currentTimestamp, setCurrentTimestamp] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [voiceName, setVoiceName] = useState('Kore');
  const [aiVoiceEnabled, setAiVoiceEnabled] = useState(false);
  const [musicEnabled, setMusicEnabled] = useState(false);
  const [musicVolume, setMusicVolume] = useState(0.12);

  const [editingClipBeat, setEditingClipBeat] = useState<Beat | null>(null);
  const [isDriveModalOpen, setIsDriveModalOpen] = useState(false);
  const [isBillingOpen, setIsBillingOpen] = useState(false);
  const [isMyProjectsOpen, setIsMyProjectsOpen] = useState(false);
  const [isPublishingOpen, setIsPublishingOpen] = useState(false);
  const [currentProjectId, setCurrentProjectId] = useState<string | undefined>('proj_sample_steve_jobs');
  const [isSavingProject, setIsSavingProject] = useState(false);
  const [lastSavedMessage, setLastSavedMessage] = useState<string | null>(null);
  const [userPlan, setUserPlan] = useState<'free' | 'pro' | 'studio'>('pro');

  const playbackRaf = useRef<number | null>(null);
  const lastTimeRef = useRef<number>(0);
  const scriptRef = useRef<ShortScript | null>(script);
  scriptRef.current = script;
  const voiceNameRef = useRef<string>(voiceName);
  voiceNameRef.current = voiceName;
  const aiVoiceEnabledRef = useRef<boolean>(aiVoiceEnabled);
  aiVoiceEnabledRef.current = aiVoiceEnabled;

  const handleSaveProject = async () => {
    if (!script) return;
    setIsSavingProject(true);
    setLastSavedMessage(null);

    const projectPayload: Partial<Project> = {
      id: currentProjectId || `proj_${Date.now()}`,
      title: script.title || topic || 'Untitled Short',
      topic,
      creationMode,
      script,
      captionStyle,
      visualMode,
      audioSourceMode: script.audioSourceMode || 'youtube',
      videoInfo,
      clipStartSeconds: script.clipStartSeconds,
      clipEndSeconds: script.clipEndSeconds,
      duration: script.beats.length > 0 ? script.beats[script.beats.length - 1].end_s : 30,
      thumbnail: script.beats[0]?.thumbnail || videoInfo?.thumbnailUrl,
    };

    try {
      const activeUserId = currentUser?.id || 'default_user';
      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-user-id': activeUserId,
        },
        body: JSON.stringify({ ...projectPayload, userId: activeUserId }),
      });

      if (res.ok) {
        const data = await res.json();
        setCurrentProjectId(data.project.id);
        try {
          localStorage.setItem('forge_active_project', JSON.stringify(data.project));
          localStorage.setItem('forge_studio_step', String(studioStep));
        } catch {
          // ignore localStorage quota errors
        }
        setLastSavedMessage('Saved to database!');
        setTimeout(() => setLastSavedMessage(null), 3000);
      }
    } catch (err) {
      console.error('Save failed:', err);
      setLastSavedMessage('Save error');
    } finally {
      setIsSavingProject(false);
    }
  };

  const handleLoadProject = (proj: Project) => {
    setCurrentProjectId(proj.id);
    setTopic(proj.topic);
    setCreationMode(proj.creationMode);
    if (proj.script) {
      setScript(proj.script);
      const accurateWords = recalculateWordsFromBeats(proj.script.beats || []);
      setAllWords(accurateWords);
    }
    if (proj.captionStyle) {
      setCaptionStyle(proj.captionStyle);
    }
    if (proj.visualMode) {
      setVisualMode(proj.visualMode);
    }
    if (proj.videoInfo) {
      setVideoInfo(proj.videoInfo);
    }
    setStudioStep(3);
    setLastSavedMessage(`Loaded "${proj.title.slice(0, 20)}..."`);
    setTimeout(() => setLastSavedMessage(null), 3000);
  };

  const handleNewProject = () => {
    setCurrentProjectId(undefined);
    setTopic('');
    setScript(null);
    setClipCandidates([]);
    setVideoInfo(null);
    setAllWords([]);
    setStudioStep(1);
  };

  const loadDefaultYouTubeClip = () => {
    const videoId = 'UF8uR6Z6KLc';
    const startSec = 15;
    const endSec = 48;
    const rawBeats = [
      { text: "Your time is limited, so don't waste it living someone else's life.", start_s: 0.0, end_s: 5.5 },
      { text: "Don't be trapped by dogma, which is living with the results of other people's thinking.", start_s: 5.5, end_s: 12.0 },
      { text: "Don't let the noise of others' opinions drown out your own inner voice.", start_s: 12.0, end_s: 18.5 },
      { text: "And most important, have the courage to follow your heart and intuition.", start_s: 18.5, end_s: 25.5 },
      { text: "They somehow already know what you truly want to become. Everything else is secondary.", start_s: 25.5, end_s: 33.0 },
    ];

    const beats: Beat[] = rawBeats.map((b, idx) => ({
      id: `yt-beat-${idx + 1}`,
      text: b.text,
      visual_keywords: 'focus inspiration speech leadership',
      start_s: b.start_s,
      end_s: b.end_s,
      video_url: '',
      thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    }));

    const accurateWords = recalculateWordsFromBeats(beats);

    const initialScript: ShortScript = {
      hook: "Your time is limited, so don't waste it living someone else's life.",
      title: "Steve Jobs' #1 Rule For Life (Must Watch) #shorts",
      description: "Key excerpt from Steve Jobs' 2005 Stanford Commencement Speech. Follow your heart and intuition.",
      hashtags: ['#shorts', '#stevejobs', '#motivation', '#wisdom', '#success'],
      beats,
      sourceYouTubeId: videoId,
      sourceYouTubeTitle: "Steve Jobs' 2005 Stanford Commencement Address",
      sourceYouTubeAuthor: "Stanford",
      viralScore: 97,
      clipReasoning: "Iconic philosophical reflection on mortality and personal truth. High emotional retention hook.",
      clipStartSeconds: startSec,
      clipEndSeconds: endSec,
      audioSourceMode: 'youtube',
    };

    setScript(initialScript);
    setAllWords(accurateWords);
    setTopic("Steve Jobs' 2005 Stanford Commencement Address");
    setVideoInfo({
      videoId,
      title: "Steve Jobs' 2005 Stanford Commencement Address",
      authorName: 'Stanford',
      thumbnailUrl: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      url: `https://www.youtube.com/watch?v=${videoId}`,
    });

    setClipCandidates([
      {
        id: 'candidate-jobs-1',
        clipTitle: "Steve Jobs' #1 Rule For Life",
        hook: "Your time is limited, so don't waste it living someone else's life.",
        viralScore: 97,
        reasoning: "High emotional retention hook. Clear philosophical thesis.",
        startSeconds: 15,
        endSeconds: 48,
        approxStartTimestamp: '00:15',
        beats,
        suggestedTitles: ["Steve Jobs' #1 Rule For Life (Must Watch) #shorts"],
        description: "Key excerpt from Steve Jobs' 2005 Stanford Commencement Speech.",
        hashtags: ['#shorts', '#stevejobs', '#motivation'],
      },
      {
        id: 'candidate-jobs-2',
        clipTitle: 'Stay Hungry, Stay Foolish',
        hook: 'Stay hungry, stay foolish. I have always wished that for myself.',
        viralScore: 94,
        reasoning: 'Memorable call-to-action closing quote that triggers high shareability.',
        startSeconds: 120,
        endSeconds: 152,
        approxStartTimestamp: '02:00',
        beats: beats.slice(2),
        suggestedTitles: ['The Greatest Advice Steve Jobs Ever Gave #shorts'],
        description: 'Stay Hungry, Stay Foolish commencement speech closing.',
        hashtags: ['#shorts', '#stevejobs', '#quotes'],
      },
    ]);

    setCreationMode('youtube');
    setCurrentTimestamp(0);
  };

  useEffect(() => {
    try {
      const savedProj = localStorage.getItem('forge_active_project');
      const savedStep = localStorage.getItem('forge_studio_step');
      if (savedProj) {
        const parsed = JSON.parse(savedProj);
        handleLoadProject(parsed);
        if (savedStep && ['1', '2', '3'].includes(savedStep)) {
          setStudioStep(Number(savedStep) as 1 | 2 | 3);
        }
        return;
      }
    } catch (e) {
      // fallback to default
    }
    loadDefaultYouTubeClip();
  }, []);

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
        const currentScript = scriptRef.current;
        const totalDur = currentScript?.beats && currentScript.beats.length > 0
          ? currentScript.beats[currentScript.beats.length - 1].end_s
          : 30;

        const next = prev + delta;
        if (next >= totalDur) {
          setIsPlaying(false);
          audioManager.stopSpeech();
          if (musicEnabled) audioManager.stopBackgroundMusic();
          return 0;
        }

        const isYouTubeVoice = Boolean(currentScript?.sourceYouTubeId && currentScript?.audioSourceMode !== 'tts');
        if (!isYouTubeVoice && aiVoiceEnabledRef.current) {
          const currentBeat = currentScript?.beats.find((b) => prev < b.start_s && next >= b.start_s);
          if (currentBeat) {
            audioManager.speakNeuralOrFallback(currentBeat.text, voiceNameRef.current);
          }
        }

        return next;
      });

      playbackRaf.current = requestAnimationFrame(loop);
    };

    playbackRaf.current = requestAnimationFrame(loop);

    return () => {
      if (playbackRaf.current) cancelAnimationFrame(playbackRaf.current);
    };
  }, [isPlaying, musicEnabled, musicVolume]);

  const handleGenerateFromPrompt = async (inputTopic?: string) => {
    const selectedTopic = inputTopic || topic;
    if (!selectedTopic.trim() || isGenerating) return;

    setIsGenerating(true);
    setIsPlaying(false);
    audioManager.stopAll();

    try {
      setGenerationStep('Gemini composing high-retention hook, script beats, and visual cues...');
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

      setGenerationStep('Synthesizing speech & word timestamps for kinetic captions...');
      const fullText = scriptData.beats.map((b: any) => b.text).join(' ');
      const words = estimateWordTimings(fullText, 1.0);
      setAllWords(words);

      setGenerationStep('Matching vertical footage to Gemini visual prompts...');
      const timedBeats = assignBeatTimings(scriptData.beats, words);

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
              video_url: chosen?.url || '',
              thumbnail: getSafeThumbnail(beat.visual_keywords, chosen?.thumbnail),
            };
          } catch (e) {
            return {
              ...beat,
              thumbnail: getSafeThumbnail(beat.visual_keywords),
            };
          }
        })
      );

      const newScript: ShortScript = {
        hook: scriptData.hook || finalBeats[0]?.text || '',
        title: scriptData.title || `${selectedTopic} #shorts`,
        description: scriptData.description || 'Watch to learn more.',
        hashtags: scriptData.hashtags || ['#shorts', '#viral'],
        beats: finalBeats,
        viralScore: 96,
        clipReasoning: 'Structured narrative arc engineered for full watch-time completion.',
      };

      setScript(newScript);
      const accurateWords = recalculateWordsFromBeats(finalBeats);
      setAllWords(accurateWords);
      setCurrentTimestamp(0);

      // Create a clip candidate strategy for Page 2
      setClipCandidates([
        {
          id: `strategy-prompt-${Date.now()}`,
          clipTitle: scriptData.title || selectedTopic,
          hook: newScript.hook,
          viralScore: 96,
          reasoning: 'Generated full retention arc with hook, tension, and resolution.',
          startSeconds: 0,
          endSeconds: finalBeats[finalBeats.length - 1]?.end_s || 30,
          approxStartTimestamp: '00:00',
          beats: finalBeats,
          suggestedTitles: [newScript.title],
          description: newScript.description,
          hashtags: newScript.hashtags,
        },
      ]);

      // Automatically transition to Page 2 (Clip Strategies & Trimmer)
      setStudioStep(2);
    } catch (err) {
      console.error('Generation failed:', err);
    } finally {
      setIsGenerating(false);
      setGenerationStep('');
    }
  };

  const handleAnalyzeYouTubeUrl = async (url: string, objective: string, customTranscript?: string) => {
    setIsGenerating(true);
    setIsPlaying(false);
    audioManager.stopAll();
    setYoutubeError(null);

    try {
      setGenerationStep('Fetching YouTube video metadata...');
      const infoRes = await fetch('/api/youtube/info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });

      if (!infoRes.ok) {
        const errJson = await infoRes.json().catch(() => ({}));
        throw new Error(errJson.error || 'Could not fetch YouTube video details');
      }

      const infoData: YouTubeVideoInfo = await infoRes.json();
      setVideoInfo(infoData);
      setTopic(infoData.title);

      setGenerationStep('Gemini analyzing viral moments and high-retention clip strategies...');
      const genRes = await fetch('/api/youtube/generate-clips', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url,
          clipObjective: objective,
          transcript: customTranscript,
        }),
      });

      if (!genRes.ok) {
        const errJson = await genRes.json().catch(() => ({}));
        throw new Error(errJson.error || 'Failed to generate viral clips from this video.');
      }

      const genData = await genRes.json();
      if (!genData.clips || genData.clips.length === 0) {
        throw new Error(genData.error || 'No clips found');
      }

      setClipCandidates(genData.clips);
      if (genData.videoInfo) {
        setVideoInfo(genData.videoInfo);
      }

      // Automatically load the highest ranked candidate
      const topClip = genData.clips[0];
      await handleSelectYouTubeCandidate(topClip, infoData);

      // Automatically transition to Page 2 (Clip Strategies & Trimmer)
      setStudioStep(2);
    } catch (err: any) {
      console.error('Failed to process YouTube link:', err);
      setYoutubeError(err?.message || 'Failed to process YouTube link. Please check the URL or try one of the verified sample videos below.');
    } finally {
      setIsGenerating(false);
      setGenerationStep('');
    }
  };

  const handleSelectYouTubeCandidate = async (clip: YouTubeClipCandidate, infoOverride?: YouTubeVideoInfo) => {
    const currentInfo = infoOverride || videoInfo;
    if (!currentInfo) return;

    const startSec = clip.startSeconds ?? 15;
    const endSec = clip.endSeconds ?? (startSec + 30);
    const targetDuration = Math.max(endSec - startSec, 6);

    let sourceBeats = clip.beats;
    let timedBeats: Beat[];

    if (sourceBeats.length > 0 && sourceBeats.every((b) => typeof b.start_s === 'number' && typeof b.end_s === 'number')) {
      timedBeats = sourceBeats.map((b, idx) => ({
        id: `beat-${idx + 1}-${Date.now()}`,
        text: b.text,
        visual_keywords: b.visual_keywords,
        start_s: b.start_s!,
        end_s: b.end_s!,
        video_url: '',
      }));
    } else {
      const fullText = sourceBeats.map((b) => b.text).join(' ');
      const words = estimateWordTimings(fullText, 1.0, targetDuration);
      timedBeats = assignBeatTimings(sourceBeats, words);
    }

    const finalBeats: Beat[] = timedBeats.map((beat) => ({
      ...beat,
      video_url: '', // Real YouTube video rendered directly from iframe!
      thumbnail: currentInfo.thumbnailUrl,
    }));

    setScript({
      hook: clip.hook || finalBeats[0]?.text || '',
      title: clip.suggestedTitles?.[0] || `${clip.clipTitle} #shorts`,
      description: clip.description || `Key moment from "${currentInfo.title}" by ${currentInfo.authorName}.`,
      hashtags: clip.hashtags || ['#shorts', '#viral'],
      beats: finalBeats,
      sourceYouTubeId: currentInfo.videoId,
      sourceYouTubeTitle: currentInfo.title,
      sourceYouTubeAuthor: currentInfo.authorName,
      viralScore: clip.viralScore,
      clipReasoning: clip.reasoning,
      clipStartSeconds: startSec,
      clipEndSeconds: endSec,
      audioSourceMode: 'youtube',
    });

    const accurateWords = recalculateWordsFromBeats(finalBeats);
    setAllWords(accurateWords);
    setTopic(currentInfo.title);
    setCurrentTimestamp(0);
  };

  const handleUpdateClipRange = (startSec: number, endSec: number) => {
    setScript((prev) => {
      if (!prev) return null;
      const prevStart = prev.clipStartSeconds ?? 0;
      const delta = startSec - prevStart;

      const updatedBeats = prev.beats.map((b) => ({
        ...b,
        start_s: Math.max(0, parseFloat((b.start_s - (delta !== 0 ? delta : 0)).toFixed(2))),
        end_s: Math.max(0.5, parseFloat((b.end_s - (delta !== 0 ? delta : 0)).toFixed(2))),
      }));

      const newWords = recalculateWordsFromBeats(updatedBeats);
      setAllWords(newWords);

      return {
        ...prev,
        clipStartSeconds: startSec,
        clipEndSeconds: endSec,
        beats: updatedBeats,
      };
    });
  };

  const handleUpdateBeatText = (beatId: string, newText: string) => {
    setScript((prev) => {
      if (!prev) return null;
      const updatedBeats = prev.beats.map((b) => (b.id === beatId ? { ...b, text: newText } : b));
      const newWords = recalculateWordsFromBeats(updatedBeats);
      setAllWords(newWords);
      return {
        ...prev,
        beats: updatedBeats,
        hook: updatedBeats[0]?.text || prev.hook,
      };
    });
  };

  const handleUpdateClipStartSeconds = (startSec: number) => {
    setScript((prev) => (prev ? { ...prev, clipStartSeconds: startSec } : null));
  };

  const handleChangeAudioSourceMode = (mode: AudioSourceMode) => {
    setScript((prev) => (prev ? { ...prev, audioSourceMode: mode } : null));
    if (mode === 'youtube') {
      audioManager.stopSpeech();
    }
  };

  const handleToggleAiVoice = () => {
    setAiVoiceEnabled((prev) => {
      const next = !prev;
      if (!next) {
        audioManager.stopSpeech();
      }
      return next;
    });
  };

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

  const handleUpdateBeat = (id: string, updates: Partial<Beat>) => {
    setScript((prev) => {
      if (!prev) return null;
      const updatedBeats = prev.beats.map((b) => (b.id === id ? { ...b, ...updates } : b));
      const newWords = recalculateWordsFromBeats(updatedBeats);
      setAllWords(newWords);
      return {
        ...prev,
        beats: updatedBeats,
        hook: updatedBeats[0]?.text || prev.hook,
      };
    });
  };

  const handleUpdateAllBeats = (updatedBeats: Beat[]) => {
    const newWords = recalculateWordsFromBeats(updatedBeats);
    setAllWords(newWords);
    setScript((prev) =>
      prev
        ? {
            ...prev,
            beats: updatedBeats,
            hook: updatedBeats[0]?.text || prev.hook,
          }
        : null
    );
  };

  const handleApplyWordsAndBeats = (words: WordTiming[], updatedBeats?: Beat[]) => {
    if (words && words.length > 0) {
      setAllWords(words);
    }
    if (updatedBeats && updatedBeats.length > 0) {
      setScript((prev) => {
        if (!prev) return null;
        return {
          ...prev,
          beats: updatedBeats,
          hook: updatedBeats[0]?.text || prev.hook,
        };
      });
    }
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
    const newEnd = parseFloat((newStart + 3.5).toFixed(2));

    const newBeat: Beat = {
      id: `beat-${Date.now()}`,
      text: 'Here is another game-changing insight.',
      visual_keywords: 'person smiling confident success',
      start_s: newStart,
      end_s: newEnd,
      video_url: 'https://assets.mixkit.co/videos/preview/mixkit-vertical-view-of-a-woman-walking-down-a-city-street-41712-large.mp4',
      thumbnail: getSafeThumbnail('person smiling confident success'),
    };

    const updatedBeats = [...script.beats, newBeat];
    const newWords = recalculateWordsFromBeats(updatedBeats);

    setScript({
      ...script,
      beats: updatedBeats,
    });
    setAllWords(newWords);
  };

  const handleDeleteBeat = (id: string) => {
    if (!script || script.beats.length <= 1) return;
    const updatedBeats = script.beats.filter((b) => b.id !== id);
    const newWords = recalculateWordsFromBeats(updatedBeats);

    setScript({
      ...script,
      beats: updatedBeats,
      hook: updatedBeats[0]?.text || script.hook,
    });
    setAllWords(newWords);
  };

  const handleAutoAlignBeats = () => {
    if (!script || script.beats.length === 0) return;
    const targetDur =
      script.audioSourceMode === 'youtube' &&
      script.clipStartSeconds !== undefined &&
      script.clipEndSeconds !== undefined
        ? Math.max(script.clipEndSeconds - script.clipStartSeconds, 5)
        : undefined;

    const aligned = autoAlignBeatTimelines(script.beats, targetDur);
    const newWords = recalculateWordsFromBeats(aligned);

    setScript({
      ...script,
      beats: aligned,
    });
    setAllWords(newWords);
  };

  const handleShiftAllBeats = (deltaSeconds: number) => {
    if (!script || script.beats.length === 0) return;
    const shifted = shiftAllBeats(script.beats, deltaSeconds);
    const newWords = recalculateWordsFromBeats(shifted);

    setScript({
      ...script,
      beats: shifted,
    });
    setAllWords(newWords);
  };

  const totalDuration = script?.beats && script.beats.length > 0
    ? script.beats[script.beats.length - 1].end_s
    : 0;

  if (currentPage === 'home') {
    return (
      <HomePage
        onStartFree={() => setCurrentPage(currentUser ? 'studio' : 'auth')}
        onSignIn={() => {
          setAuthMode('signin');
          setCurrentPage('auth');
        }}
        onTrySample={(url) => {
          if (url) {
            setTopic(url);
          }
          if (currentUser) {
            setCurrentPage('studio');
          } else {
            setCurrentPage('auth');
          }
        }}
      />
    );
  }

  if (currentPage === 'auth') {
    return (
      <AuthPage
        initialMode={authMode}
        onSuccess={(user) => {
          setCurrentUser(user);
          try {
            localStorage.setItem('forge_user', JSON.stringify(user));
          } catch {
            // ignore
          }
          setCurrentPage('studio');
        }}
        onBackToHome={() => setCurrentPage('home')}
      />
    );
  }

  return (
    <div className="min-h-screen bg-[#090c10] text-[#f1f5f9] flex flex-col selection:bg-rose-500 selection:text-white">
      {/* Top Bar Navigation */}
      <header className="sticky top-0 z-40 bg-[#090c10]/90 backdrop-blur-md border-b border-white/8">
        <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
          {/* Brand Wordmark with Home Action */}
          <button
            onClick={() => setCurrentPage('home')}
            className="flex items-center gap-2.5 text-left group"
          >
            <div className="w-8 h-8 rounded-lg bg-rose-600 flex items-center justify-center text-white font-bold shadow-md shadow-rose-950/50">
              <Youtube className="w-4 h-4 fill-current" />
            </div>
            <span className="font-display text-lg font-bold tracking-tight text-white group-hover:text-rose-400 transition select-none">
              Forge Studio
            </span>
          </button>

          {/* Stepper Navigation: 3 Studio Pages */}
          <nav className="hidden lg:flex items-center gap-1.5 p-1 bg-black/40 border border-white/8 rounded-xl shrink-0">
            {/* Step 1 */}
            <button
              onClick={() => setStudioStep(1)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5 transition ${
                studioStep === 1
                  ? 'bg-rose-600 text-white font-semibold shadow-sm'
                  : 'text-neutral-400 hover:text-white'
              }`}
            >
              <span className="w-4 h-4 rounded-full bg-white/20 flex items-center justify-center text-[10px] font-mono font-bold">
                1
              </span>
              <span>Source & Idea</span>
            </button>

            {/* Step 2 */}
            <button
              onClick={() => {
                if (script) setStudioStep(2);
              }}
              disabled={!script}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5 transition disabled:opacity-40 ${
                studioStep === 2
                  ? 'bg-rose-600 text-white font-semibold shadow-sm'
                  : 'text-neutral-400 hover:text-white'
              }`}
            >
              <span className="w-4 h-4 rounded-full bg-white/20 flex items-center justify-center text-[10px] font-mono font-bold">
                2
              </span>
              <span>Clip Strategies</span>
            </button>

            {/* Step 3 */}
            <button
              onClick={() => {
                if (script) setStudioStep(3);
              }}
              disabled={!script}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5 transition disabled:opacity-40 ${
                studioStep === 3
                  ? 'bg-rose-600 text-white font-semibold shadow-sm'
                  : 'text-neutral-400 hover:text-white'
              }`}
            >
              <span className="w-4 h-4 rounded-full bg-white/20 flex items-center justify-center text-[10px] font-mono font-bold">
                3
              </span>
              <span>Canvas & Timeline</span>
            </button>
          </nav>

          {/* User Profile & Actions */}
          <div className="flex items-center gap-2 shrink-0">
            {currentUser ? (
              <div className="flex items-center gap-1.5 bg-black/40 border border-white/8 px-2 py-1 rounded-xl">
                <img
                  src={currentUser.avatar}
                  alt={currentUser.name}
                  className="w-5 h-5 rounded-full bg-neutral-800"
                />
                <span className="text-xs text-white font-medium max-w-[80px] truncate hidden md:inline">
                  {currentUser.name}
                </span>
                <span className="text-[10px] font-mono text-emerald-400 bg-emerald-950/60 px-1 rounded uppercase font-bold">
                  {currentUser.plan}
                </span>
                <button
                  onClick={() => {
                    setCurrentUser(null);
                    localStorage.removeItem('viblo_user');
                    localStorage.removeItem('forge_user');
                    setCurrentPage('home');
                  }}
                  className="text-neutral-400 hover:text-rose-400 p-0.5 rounded transition ml-0.5"
                  title="Sign out & return to home"
                >
                  <LogOut className="w-3.5 h-3.5" />
                </button>
              </div>
            ) : (
              <button
                onClick={() => {
                  setAuthMode('signin');
                  setCurrentPage('auth');
                }}
                className="text-xs text-neutral-300 hover:text-white px-2.5 py-1.5 rounded-lg border border-white/8 transition"
              >
                Sign In
              </button>
            )}

            {/* Plan Quota Badge & Billing Modal Trigger */}
            <button
              onClick={() => setIsBillingOpen(true)}
              className="px-2.5 py-1.5 text-xs font-semibold text-amber-300 bg-amber-500/10 border border-amber-500/25 hover:bg-amber-500/20 rounded-xl flex items-center gap-1.5 transition"
              title="Manage subscription and generation quotas"
            >
              <Zap className="w-3.5 h-3.5 text-amber-400 fill-current" />
              <span className="hidden md:inline">Pro Plan</span>
            </button>

            {/* My Projects Dashboard Modal Trigger */}
            <button
              onClick={() => setIsMyProjectsOpen(true)}
              className="px-2.5 py-1.5 text-xs font-medium text-neutral-300 hover:text-white rounded-xl border border-white/8 bg-black/40 hover:bg-white/6 flex items-center gap-1.5 transition"
              title="View and load saved projects"
            >
              <FolderKanban className="w-3.5 h-3.5 text-rose-400" />
              <span className="hidden md:inline">Projects</span>
            </button>

            {/* Save Current Project Button */}
            {script && (
              <button
                onClick={handleSaveProject}
                disabled={isSavingProject}
                className="px-3 py-1.5 text-xs font-semibold text-white bg-rose-600 hover:bg-rose-500 rounded-xl transition flex items-center gap-1.5 shadow-md shadow-rose-950/40 disabled:opacity-50"
                title="Save current project to database"
              >
                {isSavingProject ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Save className="w-3.5 h-3.5" />
                )}
                <span className="hidden sm:inline">{isSavingProject ? 'Saving...' : 'Save'}</span>
              </button>
            )}

            {/* Quick Export to Google Drive Button in Topbar */}
            <button
              onClick={() => setIsDriveModalOpen(true)}
              className="px-3 py-1.5 text-xs font-semibold text-white bg-emerald-600 hover:bg-emerald-500 rounded-xl transition whitespace-nowrap shadow-sm flex items-center gap-1.5"
            >
              <CloudUpload className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Drive</span>
            </button>
          </div>
        </div>
      </header>

      {/* Sub-Header Project Breadcrumb & Status */}
      <div className="bg-[#0f141c] border-b border-white/6 px-6 py-2.5 text-xs text-neutral-400">
        <div className="max-w-7xl mx-auto flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <div className="flex items-center gap-2 truncate">
            <span className="text-white font-medium truncate">
              {script?.title ? script.title.replace('#shorts', '').trim() : 'Project Untitled'}
            </span>
            <span aria-hidden="true">·</span>
            <span className="font-mono tabular-nums">{script?.beats.length || 0} beats</span>
            <span aria-hidden="true">·</span>
            <span className="font-mono tabular-nums">{totalDuration.toFixed(1)}s duration</span>
            <span aria-hidden="true">·</span>
            <span>9:16 Vertical</span>
            {lastSavedMessage && (
              <span className="text-[11px] text-emerald-400 font-medium ml-2 px-2 py-0.5 rounded-md bg-emerald-500/10 border border-emerald-500/20 flex items-center gap-1 animate-in fade-in">
                <CheckCircle2 className="w-3 h-3 text-emerald-400" />
                <span>{lastSavedMessage}</span>
              </span>
            )}
          </div>

          <div className="flex items-center gap-2 text-[11px] text-neutral-500 shrink-0">
            <span>Stage: {studioStep === 1 ? '1. Source & Idea' : studioStep === 2 ? '2. Clip Strategies & Trimmer' : '3. Studio Canvas & Timeline'}</span>
            <span aria-hidden="true">·</span>
            <span className="text-emerald-400 font-mono">Cloud Database Active</span>
          </div>
        </div>
      </div>

      {/* Main Studio Body: Render 3 Distinct Pages Based on studioStep */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 py-8">
        {studioStep === 1 && (
          <StudioPage1Source
            creationMode={creationMode}
            onChangeCreationMode={setCreationMode}
            topic={topic}
            onChangeTopic={setTopic}
            audience={audience}
            onChangeAudience={setAudience}
            tone={tone}
            onChangeTone={setTone}
            isProcessing={isGenerating}
            processingStep={generationStep}
            onGenerateFromPrompt={handleGenerateFromPrompt}
            onAnalyzeYouTubeUrl={handleAnalyzeYouTubeUrl}
            sampleVideos={SAMPLE_VIDEOS}
            quickTopics={QUICK_TOPICS}
            errorMessage={youtubeError}
            onClearError={() => setYoutubeError(null)}
          />
        )}

        {studioStep === 2 && script && (
          <StudioPage2ClipStrategies
            script={script}
            candidates={clipCandidates}
            videoInfo={videoInfo}
            currentTimestamp={currentTimestamp}
            allWords={allWords}
            visualMode={visualMode}
            onChangeVisualMode={setVisualMode}
            youtubeVolume={youtubeVolume}
            onChangeVolume={setYoutubeVolume}
            isMuted={isYoutubeMuted}
            onToggleMute={() => setIsYoutubeMuted(!isYoutubeMuted)}
            onSeek={handleSeek}
            onUpdateClipRange={handleUpdateClipRange}
            onUpdateBeatText={handleUpdateBeatText}
            onSelectCandidate={(candidate) => handleSelectYouTubeCandidate(candidate)}
            onBackToSource={() => setStudioStep(1)}
            onProceedToCanvas={() => setStudioStep(3)}
          />
        )}

        {studioStep === 3 && script && (
          <StudioPage3CanvasTimeline
            script={script}
            topic={topic}
            allWords={allWords}
            captionStyle={captionStyle}
            captionOffsetSeconds={captionOffsetSeconds}
            currentTimestamp={currentTimestamp}
            isPlaying={isPlaying}
            voiceName={voiceName}
            aiVoiceEnabled={aiVoiceEnabled}
            musicEnabled={musicEnabled}
            musicVolume={musicVolume}
            onSeek={handleSeek}
            onTogglePlay={handleTogglePlay}
            onReset={handleReset}
            onSelectVoiceName={setVoiceName}
            onToggleAiVoice={handleToggleAiVoice}
            onToggleMusic={() => {
              setMusicEnabled(!musicEnabled);
              if (musicEnabled) audioManager.stopBackgroundMusic();
            }}
            onMusicVolumeChange={(vol) => {
              setMusicVolume(vol);
              audioManager.setMusicVolume(vol);
            }}
            onChangeAudioSourceMode={handleChangeAudioSourceMode}
            onChangeCaptionOffset={setCaptionOffsetSeconds}
            onChangeCaptionStyle={(updates) => setCaptionStyle((prev) => ({ ...prev, ...updates }))}
            onUpdateBeat={handleUpdateBeat}
            onUpdateAllBeats={handleUpdateAllBeats}
            onSelectBeatToChangeClip={(beat) => setEditingClipBeat(beat)}
            onAddBeat={handleAddBeat}
            onDeleteBeat={handleDeleteBeat}
            onAutoAlignBeats={handleAutoAlignBeats}
            onShiftAllBeats={handleShiftAllBeats}
            onUpdateMetadata={(updates) => {
              setScript((prev) => (prev ? { ...prev, ...updates } : null));
            }}
            onUpdateClipStartSeconds={handleUpdateClipStartSeconds}
            onBackToStrategies={() => setStudioStep(2)}
            onOpenGoogleDriveExport={() => setIsDriveModalOpen(true)}
            onOpenPublishingPack={() => setIsPublishingOpen(true)}
            onApplyWordsAndBeats={handleApplyWordsAndBeats}
            visualMode={visualMode}
            onChangeVisualMode={setVisualMode}
          />
        )}
      </main>

      {/* Stock Video Picker Modal */}
      <StockPickerModal
        beat={editingClipBeat}
        isOpen={Boolean(editingClipBeat)}
        onClose={() => setEditingClipBeat(null)}
        onSelectClip={handleSelectClip}
      />

      {/* Google Drive Export Modal with OAuth & upload */}
      <GoogleDriveExportModal
        isOpen={isDriveModalOpen}
        onClose={() => setIsDriveModalOpen(false)}
        script={script}
        topic={topic}
      />

      {/* SaaS Billing & Quotas Modal (Phase 4) */}
      <BillingModal
        isOpen={isBillingOpen}
        onClose={() => setIsBillingOpen(false)}
        onPlanChanged={(plan) => setUserPlan(plan)}
      />

      {/* Persistent Projects Management Modal (Phase 1 & 5) */}
      <MyProjectsModal
        isOpen={isMyProjectsOpen}
        onClose={() => setIsMyProjectsOpen(false)}
        onLoadProject={handleLoadProject}
        onNewProject={handleNewProject}
        currentProjectId={currentProjectId}
        userId={currentUser?.id || 'default_user'}
      />

      {/* Multi-Platform Social Publishing Pack Modal (Phase 2 & 5) */}
      {script && (
        <PublishingPackModal
          isOpen={isPublishingOpen}
          onClose={() => setIsPublishingOpen(false)}
          script={script}
          topic={topic}
        />
      )}
    </div>
  );
};

export default App;
