"""
Final assembly step: stitches per-beat stock clips into a vertical
1080x1920 background track sized to the voiceover, burns in word-chunk
captions synced to speech, and mixes voiceover + optional music.
"""
import os
from moviepy import (
    VideoFileClip, TextClip, CompositeVideoClip, CompositeAudioClip,
    concatenate_videoclips, AudioFileClip,
)
from moviepy.video.fx import Crop, Resize
from moviepy.audio.fx import MultiplyVolume
from config import cfg
from utils import assign_beat_timings
from caption_renderer import chunk_words


def _fit_vertical(clip: VideoFileClip, width: int, height: int) -> VideoFileClip:
    """Resize-to-cover then center-crop, so every clip fills the 9:16 frame with no bars."""
    target_ratio = width / height
    src_ratio = clip.w / clip.h
    if src_ratio > target_ratio:
        # source too wide -> match height, crop width
        clip = clip.with_effects([Resize(height=height)])
    else:
        # source too tall/narrow -> match width, crop height
        clip = clip.with_effects([Resize(width=width)])
    x_center, y_center = clip.w / 2, clip.h / 2
    clip = clip.with_effects([Crop(
        x_center=x_center, y_center=y_center, width=width, height=height
    )])
    return clip


def _build_background(beats_timed: list[dict], clip_paths: list[str]) -> VideoFileClip:
    segments = []
    for beat, path in zip(beats_timed, clip_paths):
        dur = max(beat["end_s"] - beat["start_s"], 0.6)
        raw = VideoFileClip(path)
        # loop the source clip if it's shorter than the beat needs
        if raw.duration < dur:
            loops = int(dur // raw.duration) + 1
            raw = concatenate_videoclips([raw] * loops)
        seg = raw.subclipped(0, dur)
        seg = _fit_vertical(seg, cfg.width, cfg.height)
        segments.append(seg)
    return concatenate_videoclips(segments, method="compose")


def _build_caption_clips(words: list[dict]) -> list[TextClip]:
    font_path = os.path.join(os.path.dirname(__file__), "assets", "fonts", "Poppins-Bold.ttf")
    clips = []
    for chunk in chunk_words(words):
        dur = max(chunk["end_s"] - chunk["start_s"], 0.15)
        txt = TextClip(
            font=font_path,
            text=chunk["text"],
            font_size=cfg.font_size,
            color=cfg.caption_color,
            stroke_color="black",
            stroke_width=6,
            method="caption",
            size=(int(cfg.width * 0.9), None),
            text_align="center",
        ).with_start(chunk["start_s"]).with_duration(dur)
        txt = txt.with_position(("center", int(cfg.height * 0.68)))
        clips.append(txt)
    return clips


def assemble_short(script: dict, beats_timed: list[dict], clip_paths: list[str],
                    voiceover_path: str, words: list[dict], out_path: str) -> str:
    os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)

    background = _build_background(beats_timed, clip_paths)
    voiceover = AudioFileClip(voiceover_path)

    # Trim/pad background to exactly match voiceover length
    target_dur = min(voiceover.duration, cfg.max_duration_s)
    if background.duration > target_dur:
        background = background.subclipped(0, target_dur)
    voiceover = voiceover.subclipped(0, target_dur)

    caption_clips = [c for c in _build_caption_clips(words) if c.start < target_dur]

    audio_tracks = [voiceover]
    if cfg.music_path and os.path.exists(cfg.music_path):
        music = AudioFileClip(cfg.music_path)
        if music.duration < target_dur:
            loops = int(target_dur // music.duration) + 1
            music = concatenate_videoclips([music] * loops).audio if False else music
        music = music.subclipped(0, target_dur).with_effects([MultiplyVolume(cfg.music_volume)])
        audio_tracks.append(music)

    final_audio = CompositeAudioClip(audio_tracks) if len(audio_tracks) > 1 else voiceover
    final_video = CompositeVideoClip([background, *caption_clips], size=(cfg.width, cfg.height))
    final_video = final_video.with_audio(final_audio).with_duration(target_dur)

    final_video.write_videofile(
        out_path, fps=cfg.fps, codec="libx264", audio_codec="aac",
        threads=4, preset="medium", logger=None,
    )
    return out_path
