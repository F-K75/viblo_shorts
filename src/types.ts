export interface Beat {
  id: string;
  text: string;
  visual_keywords: string;
  start_s: number;
  end_s: number;
  video_url: string;
  thumbnail?: string;
  duration?: number;
}

export interface ShortScript {
  hook: string;
  title: string;
  description: string;
  hashtags: string[];
  beats: Beat[];
  sourceYouTubeId?: string;
  sourceYouTubeTitle?: string;
  sourceYouTubeAuthor?: string;
  viralScore?: number;
  clipReasoning?: string;
  clipStartSeconds?: number;
  clipEndSeconds?: number;
  audioSourceMode?: 'youtube' | 'tts';
  captionOffsetSeconds?: number;
}

export interface WordTiming {
  word: string;
  start_s: number;
  end_s: number;
  beatId?: string;
}

export interface CaptionChunk {
  text: string;
  start_s: number;
  end_s: number;
  words: WordTiming[];
}

export interface CaptionStyle {
  id: string;
  name: string;
  fontSize: number;
  textColor: string;
  highlightColor: string;
  strokeColor: string;
  strokeWidth: number;
  backgroundColor?: string;
  positionY: number; // percentage from top, e.g. 68
  wordsPerChunk: number;
  fontFamily?: string;
  fontWeight?: string;
  textTransform?: 'uppercase' | 'none';
  boxStyle?: 'rounded-pill' | 'glow' | 'comic' | 'minimal' | 'fire';
  rotation?: number;
  badge?: string;
  showCaptions?: boolean;
}

export interface YouTubeVideoInfo {
  videoId: string;
  url: string;
  title: string;
  authorName: string;
  thumbnailUrl: string;
}

export interface YouTubeClipCandidate {
  id: string;
  clipTitle: string;
  viralScore?: number;
  reasoning: string;
  hook: string;
  approxStartTimestamp?: string;
  approxEndTimestamp?: string;
  startSeconds?: number;
  endSeconds?: number;
  hasAudioCC?: boolean;
  beats: Array<{
    text: string;
    visual_keywords: string;
    start_s?: number;
    end_s?: number;
  }>;
  suggestedTitles: string[];
  description: string;
  hashtags: string[];
}

export type VisualSourceMode = 'youtube-crop' | 'youtube-fit' | 'b-roll' | 'split';
export type AudioSourceMode = 'youtube' | 'tts';

export interface Project {
  id: string;
  userId?: string;
  title: string;
  topic: string;
  creationMode: 'youtube' | 'prompt';
  script: ShortScript;
  captionStyle: CaptionStyle;
  visualMode: VisualSourceMode;
  audioSourceMode: AudioSourceMode;
  videoInfo?: YouTubeVideoInfo | null;
  clipStartSeconds?: number;
  clipEndSeconds?: number;
  createdAt: string;
  updatedAt: string;
  thumbnail?: string;
  duration?: number;
}

export interface BackgroundJob {
  id: string;
  type: 'generate_clips' | 'transcribe_video' | 'render_short' | 'generate_script';
  status: 'queued' | 'processing' | 'completed' | 'failed';
  progress: number;
  stepMessage?: string;
  createdAt: string;
  completedAt?: string;
  error?: string;
  result?: any;
}

export interface UserSubscription {
  plan: 'free' | 'pro' | 'studio';
  status: 'active' | 'trialing' | 'canceled';
  dailyQuotaLimit: number;
  dailyQuotaUsed: number;
  monthlyRenderMinutesLimit: number;
  monthlyRenderMinutesUsed: number;
  currentPeriodEnd: string;
}

export type PublishingPlatform = 'youtube' | 'tiktok' | 'instagram';

export interface PlatformPublishingPack {
  platform: PublishingPlatform;
  title: string;
  description: string;
  hashtags: string[];
  recommendedDuration: string;
  aspectRatio: string;
  srtContent: string;
  vttContent: string;
}


