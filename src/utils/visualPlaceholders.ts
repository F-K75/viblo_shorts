// High quality reliable SVG data URLs for vertical video thumbnails
// Guarantees zero broken images across all sandbox and offline environments

/** Topic categories for keyless fallbacks: icon + palette only (no titles that could mislabel the Short). */
export const TOPICS = {
  sleep: { icon: '🌙', from: '#0B1026', to: '#312E81', hue: 245, words: ['sleep', 'bed', 'night', 'dream', 'melatonin', 'rem', 'tired', 'nap', 'insomnia'] },
  tech: { icon: '⚡', from: '#0B0F19', to: '#1E293B', hue: 200, words: ['code', 'tech', 'laptop', 'developer', 'computer', 'ai', 'software'] },
  fitness: { icon: '🔥', from: '#1C0A0A', to: '#7F1D1D', hue: 10, words: ['gym', 'fitness', 'workout', 'exercise', 'run', 'muscle', 'sport'] },
  wealth: { icon: '📈', from: '#061A14', to: '#064E3B', hue: 155, words: ['money', 'wealth', 'finance', 'dollar', 'invest', 'income', 'business'] },
  food: { icon: '🥗', from: '#14210A', to: '#3F6212', hue: 90, words: ['food', 'eat', 'diet', 'meal', 'nutrition', 'cook', 'coffee', 'caffeine', 'tea'] },
  study: { icon: '📚', from: '#172554', to: '#1E3A8A', hue: 220, words: ['book', 'study', 'read', 'learn', 'brain', 'focus', 'memory', 'mind'] },
  phone: { icon: '📱', from: '#1E1B4B', to: '#312E81', hue: 265, words: ['phone', 'scroll', 'app', 'social', 'screen', 'blue light'] },
  city: { icon: '🏙️', from: '#090D16', to: '#1E1B4B', hue: 230, words: ['city', 'walk', 'street', 'urban', 'travel'] },
  clock: { icon: '⏱️', from: '#18181B', to: '#3F3F46', hue: 35, words: ['clock', 'time', 'timer', 'habit', 'routine', 'morning', 'schedule'] },
  default: { icon: '✨', from: '#0F172A', to: '#1E293B', hue: 330, words: [] as string[] },
} as const;
export type TopicKey = keyof typeof TOPICS;

export function getTopic(query?: string): TopicKey {
  const q = (query || '').toLowerCase();
  for (const key of Object.keys(TOPICS) as TopicKey[]) {
    // Whole word plus common endings: "sleep" matches "sleeping"; "ai" never matches "brain", "rem" never "remember".
    if (TOPICS[key].words.some((w) => new RegExp(`\\b${w}(s|es|ing|ed|y|er|ers)?\\b`).test(q))) return key;
  }
  return 'default';
}

function createSvgPlaceholder(topic: TopicKey): string {
  const { icon, from, to } = TOPICS[topic];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="720" height="1280" viewBox="0 0 720 1280">
  <defs>
    <linearGradient id="grad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="${from}" />
      <stop offset="100%" stop-color="${to}" />
    </linearGradient>
    <radialGradient id="glow" cx="50%" cy="40%" r="50%">
      <stop offset="0%" stop-color="rgba(255,255,255,0.16)" />
      <stop offset="100%" stop-color="rgba(255,255,255,0)" />
    </radialGradient>
  </defs>
  <rect width="100%" height="100%" fill="url(#grad)" />
  <rect width="100%" height="100%" fill="url(#glow)" />
  <text x="360" y="500" font-family="sans-serif" font-size="150" text-anchor="middle" dominant-baseline="middle">${icon}</text>
</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export const FALLBACK_THUMBNAILS = Object.fromEntries(
  (Object.keys(TOPICS) as TopicKey[]).map((k) => [k, createSvgPlaceholder(k)]),
) as Record<TopicKey, string>;

/** True for the built-in SVG placeholders (no real footage or photo for this beat). */
export function isPlaceholderImage(url?: string): boolean {
  return !!url && url.startsWith('data:image/svg+xml');
}

export function getSafeThumbnail(query?: string, providedUrl?: string): string {
  if (providedUrl && !providedUrl.includes('unsplash.com') && !providedUrl.includes('placeholder.com')) {
    return providedUrl;
  }
  return FALLBACK_THUMBNAILS[getTopic(query)];
}

export const FALLBACK_VIDEOS = {
  tech: 'https://assets.mixkit.co/videos/preview/mixkit-typing-on-a-computer-keyboard-in-a-dark-room-42416-large.mp4',
  clock: 'https://assets.mixkit.co/videos/preview/mixkit-analog-clock-ticking-fast-41487-large.mp4',
  coffee: 'https://assets.mixkit.co/videos/preview/mixkit-pouring-coffee-into-a-glass-mug-42930-large.mp4',
  city: 'https://assets.mixkit.co/videos/preview/mixkit-vertical-view-of-a-woman-walking-down-a-city-street-41712-large.mp4',
  fitness: 'https://assets.mixkit.co/videos/preview/mixkit-athlete-training-in-a-gym-41988-large.mp4',
  wealth: 'https://assets.mixkit.co/videos/preview/mixkit-counting-dollar-bills-on-a-table-41706-large.mp4',
  phone: 'https://assets.mixkit.co/videos/preview/mixkit-hands-holding-a-smartphone-in-vertical-view-41484-large.mp4',
  study: 'https://assets.mixkit.co/videos/preview/mixkit-person-writing-notes-in-a-notebook-42415-large.mp4',
  default: 'https://assets.mixkit.co/videos/preview/mixkit-vertical-view-of-a-woman-walking-down-a-city-street-41712-large.mp4',
};

export function getSafeVideoUrl(query?: string, providedUrl?: string): string {
  if (providedUrl && typeof providedUrl === 'string' && providedUrl.trim().length > 5) {
    return providedUrl;
  }
  const q = (query || '').toLowerCase();
  if (q.includes('code') || q.includes('tech') || q.includes('laptop') || q.includes('developer')) {
    return FALLBACK_VIDEOS.tech;
  }
  if (q.includes('clock') || q.includes('time') || q.includes('timer') || q.includes('habit')) {
    return FALLBACK_VIDEOS.clock;
  }
  if (q.includes('coffee') || q.includes('morning') || q.includes('desk') || q.includes('tea')) {
    return FALLBACK_VIDEOS.coffee;
  }
  if (q.includes('city') || q.includes('walk') || q.includes('street') || q.includes('urban')) {
    return FALLBACK_VIDEOS.city;
  }
  if (q.includes('gym') || q.includes('fitness') || q.includes('workout') || q.includes('exercise')) {
    return FALLBACK_VIDEOS.fitness;
  }
  if (q.includes('money') || q.includes('wealth') || q.includes('finance') || q.includes('dollar')) {
    return FALLBACK_VIDEOS.wealth;
  }
  if (q.includes('phone') || q.includes('scroll') || q.includes('app') || q.includes('social')) {
    return FALLBACK_VIDEOS.phone;
  }
  if (q.includes('book') || q.includes('study') || q.includes('read') || q.includes('learn')) {
    return FALLBACK_VIDEOS.study;
  }
  return FALLBACK_VIDEOS.default;
}
