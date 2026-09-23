"""
Fetches vertical-friendly stock video clips from Pexels for each beat's
visual_keywords. Downloads to a local cache so re-runs don't re-fetch.
"""
import os
import hashlib
import requests
from config import cfg

PEXELS_SEARCH_URL = "https://api.pexels.com/videos/search"


def _cache_path(query: str) -> str:
    os.makedirs(cfg.work_dir, exist_ok=True)
    key = hashlib.sha1(query.encode()).hexdigest()[:12]
    return os.path.join(cfg.work_dir, f"clip_{key}.mp4")


def _pick_best_file(video: dict) -> str | None:
    """Prefer a vertical or near-square HD file; fall back to the largest available."""
    files = sorted(video.get("video_files", []), key=lambda f: f.get("width", 0) * f.get("height", 0), reverse=True)
    for f in files:
        w, h = f.get("width", 0), f.get("height", 0)
        if h and w and h >= w:  # portrait or square
            return f["link"]
    return files[0]["link"] if files else None


def fetch_clip_for_query(query: str, min_duration_s: int = 4) -> str:
    """Returns local path to a downloaded mp4 matching the query. Caches by query."""
    cached = _cache_path(query)
    if os.path.exists(cached):
        return cached

    headers = {"Authorization": cfg.pexels_api_key}
    params = {"query": query, "orientation": "portrait", "per_page": 5}
    r = requests.get(PEXELS_SEARCH_URL, headers=headers, params=params, timeout=20)
    r.raise_for_status()
    results = r.json().get("videos", [])

    if not results:
        # widen the search if nothing portrait-tagged matched
        params["orientation"] = "landscape"
        r = requests.get(PEXELS_SEARCH_URL, headers=headers, params=params, timeout=20)
        r.raise_for_status()
        results = r.json().get("videos", [])

    if not results:
        raise RuntimeError(f"No Pexels results for query: '{query}'")

    candidates = [v for v in results if v.get("duration", 0) >= min_duration_s] or results
    link = _pick_best_file(candidates[0])
    if not link:
        raise RuntimeError(f"No downloadable file found for query: '{query}'")

    video_bytes = requests.get(link, timeout=60).content
    with open(cached, "wb") as f:
        f.write(video_bytes)
    return cached


def fetch_clips_for_beats(beats: list[dict]) -> list[str]:
    """beats: list of {"visual_keywords": ...}. Returns matching local file paths, one per beat."""
    return [fetch_clip_for_query(beat["visual_keywords"]) for beat in beats]


if __name__ == "__main__":
    import sys
    q = sys.argv[1] if len(sys.argv) > 1 else "person typing laptop night"
    print(fetch_clip_for_query(q))
