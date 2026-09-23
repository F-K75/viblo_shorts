"""
Turns edge-tts word-boundary timestamps into short "caption chunks"
(2-4 words each) — the punchy, fast-moving on-screen text style used
by Shorts/Reels/TikTok tools, rather than full subtitle sentences.
"""
from config import cfg

WORDS_PER_CHUNK = 3


def chunk_words(words: list[dict], words_per_chunk: int = WORDS_PER_CHUNK) -> list[dict]:
    """
    words: [{"word": str, "start_s": float, "end_s": float}, ...]
    Returns: [{"text": "word word word", "start_s": ..., "end_s": ...}, ...]
    """
    chunks = []
    for i in range(0, len(words), words_per_chunk):
        group = words[i:i + words_per_chunk]
        if not group:
            continue
        chunks.append({
            "text": " ".join(w["word"] for w in group).upper(),
            "start_s": group[0]["start_s"],
            "end_s": group[-1]["end_s"],
        })
    return chunks


if __name__ == "__main__":
    sample = [
        {"word": "Most", "start_s": 0.0, "end_s": 0.3},
        {"word": "people", "start_s": 0.3, "end_s": 0.6},
        {"word": "quit", "start_s": 0.6, "end_s": 0.9},
        {"word": "on", "start_s": 0.9, "end_s": 1.0},
        {"word": "day", "start_s": 1.0, "end_s": 1.2},
        {"word": "three.", "start_s": 1.2, "end_s": 1.6},
    ]
    for c in chunk_words(sample):
        print(c)
