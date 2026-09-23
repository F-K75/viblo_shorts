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
}

export interface WordTiming {
  word: string;
  start_s: number;
  end_s: number;
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
}
