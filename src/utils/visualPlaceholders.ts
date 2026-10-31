// High quality reliable SVG data URLs for vertical video thumbnails
// Guarantees zero broken images across all sandbox and offline environments

function createSvgPlaceholder(title: string, subtitle: string, gradientStart: string, gradientEnd: string, iconSymbol: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="720" height="1280" viewBox="0 0 720 1280">
  <defs>
    <linearGradient id="grad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="${gradientStart}" />
      <stop offset="100%" stop-color="${gradientEnd}" />
    </linearGradient>
    <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
      <path d="M 40 0 L 0 0 0 40" fill="none" stroke="rgba(255,255,255,0.04)" stroke-width="1"/>
    </pattern>
  </defs>
  <rect width="100%" height="100%" fill="url(#grad)" />
  <rect width="100%" height="100%" fill="url(#grid)" />
  <circle cx="360" cy="560" r="140" fill="rgba(255,255,255,0.06)" />
  <text x="360" y="580" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" font-size="84" font-weight="900" fill="#ffffff" text-anchor="middle" dominant-baseline="middle">${iconSymbol}</text>
  <text x="360" y="760" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" font-size="34" font-weight="800" fill="#ffffff" text-anchor="middle" letter-spacing="1">${title.toUpperCase()}</text>
  <text x="360" y="810" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" font-size="20" font-weight="500" fill="rgba(255,255,255,0.7)" text-anchor="middle">${subtitle}</text>
  <rect x="300" y="860" width="120" height="6" rx="3" fill="#E11D48" />
</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export const FALLBACK_THUMBNAILS = {
  tech: createSvgPlaceholder('Focus & Code', 'Deep Work Studio', '#0B0F19', '#1E293B', '⚡'),
  clock: createSvgPlaceholder('Time Management', 'Morning Habits', '#18181B', '#27272A', '⏱️'),
  coffee: createSvgPlaceholder('Morning Routine', 'Daily Ritual', '#1C1917', '#292524', '☕'),
  city: createSvgPlaceholder('Urban Motion', 'Daily Commute', '#090D16', '#1E1B4B', '🏙️'),
  fitness: createSvgPlaceholder('High Energy', 'Peak Performance', '#18181B', '#3F3F46', '🔥'),
  wealth: createSvgPlaceholder('Wealth & Growth', 'Compounding Results', '#061A14', '#064E3B', '📈'),
  phone: createSvgPlaceholder('Social Hook', 'Digital Attention', '#1E1B4B', '#312E81', '📱'),
  study: createSvgPlaceholder('Deep Learning', 'Mastery & Focus', '#172554', '#1E3A8A', '📚'),
  default: createSvgPlaceholder('Short Visual', 'High Impact Beat', '#0F172A', '#1E293B', '🎬'),
};

export function getSafeThumbnail(query?: string, providedUrl?: string): string {
  if (providedUrl && !providedUrl.includes('unsplash.com') && !providedUrl.includes('placeholder.com')) {
    return providedUrl;
  }
  const q = (query || '').toLowerCase();
  if (q.includes('code') || q.includes('tech') || q.includes('laptop') || q.includes('developer')) {
    return FALLBACK_THUMBNAILS.tech;
  }
  if (q.includes('clock') || q.includes('time') || q.includes('timer') || q.includes('habit')) {
    return FALLBACK_THUMBNAILS.clock;
  }
  if (q.includes('coffee') || q.includes('morning') || q.includes('desk') || q.includes('tea')) {
    return FALLBACK_THUMBNAILS.coffee;
  }
  if (q.includes('city') || q.includes('walk') || q.includes('street') || q.includes('urban')) {
    return FALLBACK_THUMBNAILS.city;
  }
  if (q.includes('gym') || q.includes('fitness') || q.includes('workout') || q.includes('exercise')) {
    return FALLBACK_THUMBNAILS.fitness;
  }
  if (q.includes('money') || q.includes('wealth') || q.includes('finance') || q.includes('dollar')) {
    return FALLBACK_THUMBNAILS.wealth;
  }
  if (q.includes('phone') || q.includes('scroll') || q.includes('app') || q.includes('social')) {
    return FALLBACK_THUMBNAILS.phone;
  }
  if (q.includes('book') || q.includes('study') || q.includes('read') || q.includes('learn')) {
    return FALLBACK_THUMBNAILS.study;
  }
  return FALLBACK_THUMBNAILS.default;
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
