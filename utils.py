"""Small shared helpers used across the pipeline."""
import re


def _normalize(w: str) -> str:
    return re.sub(r"[^a-z0-9']", "", w.lower())


def assign_beat_timings(beats: list[dict], words: list[dict]) -> list[dict]:
    """
    beats: [{"text": "...", "visual_keywords": "..."}, ...]  (in speaking order)
    words: [{"word": str, "start_s": float, "end_s": float}, ...] from the TTS
           of all beat texts joined by single spaces, in the same order.

    Returns beats with "start_s" and "end_s" added, covering the span of
    words that belong to each beat. Falls back to even splitting if word
    counts don't line up exactly (e.g. TTS merges punctuation oddly).
    """
    word_counts = [len(b["text"].split()) for b in beats]
    total_expected = sum(word_counts)

    out = []
    if len(words) >= total_expected and total_expected > 0:
        idx = 0
        for beat, n in zip(beats, word_counts):
            span = words[idx: idx + n]
            idx += n
            start_s = span[0]["start_s"] if span else (out[-1]["end_s"] if out else 0.0)
            end_s = span[-1]["end_s"] if span else start_s + 1.0
            out.append({**beat, "start_s": start_s, "end_s": end_s})
    else:
        # Fallback: split total voiceover duration evenly across beats
        total_dur = words[-1]["end_s"] if words else len(beats) * 2.0
        per_beat = total_dur / max(len(beats), 1)
        for i, beat in enumerate(beats):
            out.append({**beat, "start_s": i * per_beat, "end_s": (i + 1) * per_beat})
    return out
