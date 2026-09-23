# Viblo-style Shorts Generator

Turns a one-line idea into a finished, captioned YouTube Short — the same
"idea in, video out" flow Viblo AI uses for TikTok/Reels, aimed at YouTube
Shorts (1080x1920, ≤58s).

## Pipeline

```
topic string
   │
   ▼
[1] script_generator.py   → Claude writes hook + beats + title/description/hashtags (JSON)
   │
   ▼
[2] voiceover.py          → edge-tts speaks the script, returns word-level timestamps
   │
   ▼
[3] utils.py               → maps those timestamps onto each script "beat"
   │
   ▼
[4] stock_footage.py       → Pexels clip fetched per beat, matched by visual_keywords
   │
   ▼
[5] video_assembler.py     → clips cropped to 9:16, stitched to voiceover length,
                              word-synced captions burned in, voiceover + music mixed
   │
   ▼
output/short.mp4  +  output/short_metadata.json (title/description/hashtags)
```

## Setup

```bash
cd viblo_shorts
pip install -r requirements.txt
cp .env.example .env
# then edit .env and fill in ANTHROPIC_API_KEY and PEXELS_API_KEY
```

You also need `ffmpeg` on your system (moviepy uses it under the hood):
- macOS: `brew install ffmpeg`
- Ubuntu/Debian: `sudo apt install ffmpeg`
- Windows: `choco install ffmpeg` or download from ffmpeg.org

## Run

```bash
python main.py "5 productivity habits that actually work" --out habits.mp4
```

This produces:
- `output/habits.mp4` — the finished vertical Short
- `output/habits_metadata.json` — title, description, hashtags ready to paste into YouTube Studio

Options:
```bash
python main.py "<topic>" \
  --out <filename.mp4> \
  --audience "e.g. college students" \
  --tone "e.g. calm and reassuring"
```

## Notes / where to extend

- **Voice**: swap `TTS_VOICE` in `.env` for any edge-tts voice (`edge-tts --list-voices` to see all).
- **Captions**: word grouping size is `WORDS_PER_CHUNK` in `caption_renderer.py` (default 3 words/chunk); styling (font size, color, position) is in `config.py` / `video_assembler.py`.
- **Music**: drop a royalty-free mp3 anywhere and point `MUSIC_PATH` at it.
- **Stock source**: `stock_footage.py` only talks to Pexels; swapping in Pixabay or your own footage library means changing that one file — nothing else in the pipeline needs to know.
- **Script style**: the actual writing instructions live in `SYSTEM_PROMPT` inside `script_generator.py` — that's the highest-leverage place to tune hook style, pacing, or niche voice.
- **Cost per video**: roughly one Claude call (~1-2k tokens) + a handful of Pexels API calls (free tier: 200 requests/hour) + free TTS. No per-video GPU cost.

## Known limits vs. a polished product like Viblo

- No auto-generated B-roll (Viblo has AI video gen; this sources real stock footage instead — often looks more natural, but you're limited to what Pexels has for a query).
- No multi-platform export presets (TikTok/Reels crops) — everything here targets 1080x1920 only; cropping to 1:1 or other ratios would be a small addition to `video_assembler.py`.
- No built-in trend/hook A/B testing — `main.py` generates one script per run; calling `generate_script` a few times and picking the best hook is a one-line change if you want that.
