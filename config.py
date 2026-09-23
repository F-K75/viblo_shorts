"""
Central configuration for the Shorts pipeline.
All secrets come from environment variables (loaded from .env).
"""
import os
from dataclasses import dataclass
from dotenv import load_dotenv

load_dotenv()


@dataclass
class Config:
    # --- Script generation (Anthropic Claude) ---
    anthropic_api_key: str = os.getenv("ANTHROPIC_API_KEY", "")
    script_model: str = os.getenv("SCRIPT_MODEL", "claude-sonnet-4-6")

    # --- Voiceover (edge-tts, free, no key required) ---
    tts_voice: str = os.getenv("TTS_VOICE", "en-US-GuyNeural")
    tts_rate: str = os.getenv("TTS_RATE", "+0%")  # e.g. "+10%" for faster

    # --- Stock footage (Pexels, free tier) ---
    pexels_api_key: str = os.getenv("PEXELS_API_KEY", "")

    # --- Optional background music track (local mp3, royalty-free) ---
    music_path: str = os.getenv("MUSIC_PATH", "")
    music_volume: float = float(os.getenv("MUSIC_VOLUME", "0.12"))

    # --- Video output ---
    width: int = 1080
    height: int = 1920
    fps: int = 30
    max_duration_s: int = int(os.getenv("MAX_DURATION_S", "58"))

    # --- Caption styling ---
    font: str = os.getenv("CAPTION_FONT", "Arial-Bold")
    font_size: int = int(os.getenv("CAPTION_FONT_SIZE", "78"))
    caption_color: str = os.getenv("CAPTION_COLOR", "white")
    highlight_color: str = os.getenv("CAPTION_HIGHLIGHT_COLOR", "#39FF88")

    work_dir: str = os.getenv("WORK_DIR", "./_work")
    output_dir: str = os.getenv("OUTPUT_DIR", "./output")

    def validate(self):
        missing = []
        if not self.anthropic_api_key:
            missing.append("ANTHROPIC_API_KEY")
        if not self.pexels_api_key:
            missing.append("PEXELS_API_KEY (get a free one at pexels.com/api)")
        if missing:
            raise RuntimeError(
                "Missing required config:\n  - " + "\n  - ".join(missing) +
                "\nSet these in a .env file (see .env.example)."
            )


cfg = Config()
