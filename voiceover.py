"""
Generates the voiceover audio with edge-tts (free, no API key) and
captures word-boundary timestamps so captions can be burned in
word-by-word, synced to speech — the core "auto-caption" trick
that CapCut/Viblo-style tools use.
"""
import asyncio
import edge_tts
from config import cfg


async def _synthesize(text: str, out_path: str) -> list[dict]:
    """
    Returns a list of {"word": str, "start_s": float, "end_s": float}
    using edge-tts's WordBoundary events (offsets are in 100-nanosecond units).
    """
    communicate = edge_tts.Communicate(text, cfg.tts_voice, rate=cfg.tts_rate)
    words = []
    with open(out_path, "wb") as audio_file:
        async for chunk in communicate.stream():
            if chunk["type"] == "audio":
                audio_file.write(chunk["data"])
            elif chunk["type"] == "WordBoundary":
                words.append({
                    "word": chunk["text"],
                    "start_s": chunk["offset"] / 1e7,
                    "end_s": (chunk["offset"] + chunk["duration"]) / 1e7,
                })
    return words


def generate_voiceover(full_text: str, out_path: str) -> list[dict]:
    """Synchronous wrapper. full_text is the whole script (all beats joined)."""
    return asyncio.run(_synthesize(full_text, out_path))


if __name__ == "__main__":
    import sys, json
    text = sys.argv[1] if len(sys.argv) > 1 else "This is a quick test of the voiceover pipeline."
    words = generate_voiceover(text, "test_voice.mp3")
    print(json.dumps(words, indent=2))
