import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { resolveFfmpegBinary } from '../../server/media_engine/config.ts';

export interface GoldenMediaFixtures {
  dir: string;
  sample720p: string;
  sample1080p: string;
  samplePortrait: string;
  sampleLandscape: string;
  sampleAudioWav: string;
  sampleMusicMp3: string;
  sampleSubtitlesSrt: string;
  sampleSilentVideo: string;
  sampleCorrupted: string;
  sampleVariableFps: string;
}

function runFfmpegFixture(ffmpegBin: string, args: string[]) {
  execFileSync(ffmpegBin, ['-y', '-nostdin', '-loglevel', 'error', ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
  });
}

const DEV_FALLBACK_FFMPEG =
  '/Library/Frameworks/Python.framework/Versions/3.14/lib/python3.14/site-packages/imageio_ffmpeg/binaries/ffmpeg-macos-aarch64-v7.1';

function ensureTestFfmpegPath(): string {
  if (!process.env.FFMPEG_PATH) {
    const candidate = fs.existsSync('/tmp/ffmpeg-bin/ffmpeg')
      ? '/tmp/ffmpeg-bin/ffmpeg'
      : fs.existsSync(DEV_FALLBACK_FFMPEG)
        ? DEV_FALLBACK_FFMPEG
        : undefined;
    if (candidate) process.env.FFMPEG_PATH = candidate;
  }
  return resolveFfmpegBinary(process.env);
}

/**
 * Deterministically builds the 10-file Golden Media Fixture Suite specified in Section 13
 * using real FFmpeg lavfi generators (kept git-ignored under `tests/fixtures/media` or a temp dir).
 */
export function ensureGoldenMediaFixtures(targetDir?: string): GoldenMediaFixtures {
  const ffmpegBin = ensureTestFfmpegPath();
  const dir = targetDir ?? path.resolve(import.meta.dirname, '..', 'fixtures', 'media');
  fs.mkdirSync(dir, { recursive: true });

  const paths: GoldenMediaFixtures = {
    dir,
    sample720p: path.join(dir, 'sample_720p.mp4'),
    sample1080p: path.join(dir, 'sample_1080p.mp4'),
    samplePortrait: path.join(dir, 'sample_portrait.mp4'),
    sampleLandscape: path.join(dir, 'sample_landscape.mp4'),
    sampleAudioWav: path.join(dir, 'sample_audio.wav'),
    sampleMusicMp3: path.join(dir, 'sample_music.mp3'),
    sampleSubtitlesSrt: path.join(dir, 'sample_subtitles.srt'),
    sampleSilentVideo: path.join(dir, 'sample_silent_video.mp4'),
    sampleCorrupted: path.join(dir, 'sample_corrupted.mp4'),
    sampleVariableFps: path.join(dir, 'sample_variable_fps.mp4'),
  };

  if (!fs.existsSync(paths.sample720p)) {
    runFfmpegFixture(ffmpegBin, [
      '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30:duration=4',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=4',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '128k',
      paths.sample720p,
    ]);
  }

  if (!fs.existsSync(paths.sample1080p)) {
    runFfmpegFixture(ffmpegBin, [
      '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30:duration=4',
      '-f', 'lavfi', '-i', 'sine=frequency=523:sample_rate=44100:duration=4',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '128k',
      paths.sample1080p,
    ]);
  }

  if (!fs.existsSync(paths.samplePortrait)) {
    runFfmpegFixture(ffmpegBin, [
      '-f', 'lavfi', '-i', 'testsrc2=size=1080x1920:rate=30:duration=4',
      '-f', 'lavfi', '-i', 'sine=frequency=659:sample_rate=44100:duration=4',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '128k',
      paths.samplePortrait,
    ]);
  }

  if (!fs.existsSync(paths.sampleLandscape)) {
    runFfmpegFixture(ffmpegBin, [
      '-f', 'lavfi', '-i', 'smptebars=size=1920x1080:rate=30:duration=5',
      '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=44100:duration=5',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '128k',
      paths.sampleLandscape,
    ]);
  }

  if (!fs.existsSync(paths.sampleAudioWav)) {
    runFfmpegFixture(ffmpegBin, [
      '-f', 'lavfi', '-i', 'sine=frequency=480:sample_rate=44100:duration=4',
      '-ac', '2',
      '-c:a', 'pcm_s16le',
      paths.sampleAudioWav,
    ]);
  }

  if (!fs.existsSync(paths.sampleMusicMp3)) {
    runFfmpegFixture(ffmpegBin, [
      '-f', 'lavfi', '-i', 'sine=frequency=261:sample_rate=44100:duration=6',
      '-ac', '2',
      '-c:a', 'libmp3lame', '-q:a', '4',
      paths.sampleMusicMp3,
    ]);
  }

  if (!fs.existsSync(paths.sampleSubtitlesSrt)) {
    const srt = [
      '1',
      '00:00:00,200 --> 00:00:01,800',
      'Welcome to Forge Media Engine.',
      '',
      '2',
      '00:00:02,000 --> 00:00:03,800',
      'Deterministic FFmpeg rendering verified.',
      '',
    ].join('\n');
    fs.writeFileSync(paths.sampleSubtitlesSrt, srt, 'utf8');
  }

  if (!fs.existsSync(paths.sampleSilentVideo)) {
    runFfmpegFixture(ffmpegBin, [
      '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30:duration=3',
      '-an',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      paths.sampleSilentVideo,
    ]);
  }

  if (!fs.existsSync(paths.sampleCorrupted)) {
    // Invalid MP4 header + random garbage without moov/mdat atoms.
    fs.writeFileSync(paths.sampleCorrupted, Buffer.from('000000186674797069736f6ddeadbeefcafebabe0000', 'hex'));
  }

  if (!fs.existsSync(paths.sampleVariableFps)) {
    runFfmpegFixture(ffmpegBin, [
      '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30:duration=2.5',
      '-vf', "setpts='N*(1+0.6*mod(N,2))/30/TB'",
      '-fps_mode', 'vfr',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      paths.sampleVariableFps,
    ]);
  }

  return paths;
}
