// Loads the official YouTube IFrame Player API once and exposes a minimal typed surface.
// The official API performs the postMessage handshake that the embed requires before it reports
// playback time; hand-rolled postMessage "commands" never receive currentTime updates.

export interface YTPlayer {
  playVideo(): void;
  pauseVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  mute(): void;
  unMute(): void;
  setVolume(volume: number): void;
  getCurrentTime(): number;
  getPlayerState(): number;
  destroy(): void;
}

export const YT_STATE = { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 } as const;

declare global {
  interface Window {
    YT?: { Player: new (el: HTMLIFrameElement | string, opts: any) => YTPlayer };
    onYouTubeIframeAPIReady?: () => void;
  }
}

let apiPromise: Promise<NonNullable<Window['YT']>> | null = null;

export function loadYouTubeApi(timeoutMs = 10000): Promise<NonNullable<Window['YT']>> {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (apiPromise) return apiPromise;
  apiPromise = new Promise((resolve, reject) => {
    const prev = window.onYouTubeIframeAPIReady;
    const timer = setTimeout(() => {
      apiPromise = null;
      reject(new Error('YouTube player API did not load'));
    }, timeoutMs);
    window.onYouTubeIframeAPIReady = () => {
      clearTimeout(timer);
      prev?.();
      if (window.YT?.Player) resolve(window.YT);
    };
    const script = document.createElement('script');
    script.src = 'https://www.youtube.com/iframe_api';
    script.async = true;
    script.onerror = () => {
      clearTimeout(timer);
      apiPromise = null;
      reject(new Error('YouTube player API failed to load'));
    };
    document.head.appendChild(script);
  });
  return apiPromise;
}

/** Binds a YT.Player to an existing <iframe src=".../embed/ID?enablejsapi=1">. Resolves when ready. */
export async function attachYouTubePlayer(iframe: HTMLIFrameElement): Promise<YTPlayer> {
  const YT = await loadYouTubeApi();
  return new Promise((resolve) => {
    const player: YTPlayer = new YT.Player(iframe, {
      events: { onReady: () => resolve(player) },
    });
  });
}
