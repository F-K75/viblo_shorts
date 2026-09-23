"""
End-to-end: idea -> AI script -> voiceover -> stock footage -> captioned Short.

Usage:
    python main.py "5 productivity habits that actually work" --out my_short.mp4
"""
import argparse
import json
import os
import sys

from config import cfg
from script_generator import generate_script
from voiceover import generate_voiceover
from stock_footage import fetch_clips_for_beats
from utils import assign_beat_timings
from video_assembler import assemble_short


def run(topic: str, out_name: str, audience: str, tone: str):
    cfg.validate()
    os.makedirs(cfg.work_dir, exist_ok=True)
    os.makedirs(cfg.output_dir, exist_ok=True)

    print(f"[1/5] Generating script for: {topic!r}")
    script = generate_script(topic, audience=audience, tone=tone)
    print(f"      Hook: {script['beats'][0]['text']}")
    print(f"      Title: {script['title']}")

    full_text = " ".join(b["text"] for b in script["beats"])
    voiceover_path = os.path.join(cfg.work_dir, "voiceover.mp3")
    print("[2/5] Synthesizing voiceover + capturing word timings")
    words = generate_voiceover(full_text, voiceover_path)

    print("[3/5] Assigning per-beat timing windows")
    beats_timed = assign_beat_timings(script["beats"], words)

    print(f"[4/5] Fetching {len(beats_timed)} stock clips from Pexels")
    clip_paths = fetch_clips_for_beats(beats_timed)

    print("[5/5] Assembling final vertical video with burned-in captions")
    out_path = os.path.join(cfg.output_dir, out_name)
    assemble_short(script, beats_timed, clip_paths, voiceover_path, words, out_path)

    meta_path = os.path.join(cfg.output_dir, out_name.rsplit(".", 1)[0] + "_metadata.json")
    with open(meta_path, "w") as f:
        json.dump({
            "title": script["title"],
            "description": script["description"],
            "hashtags": script["hashtags"],
        }, f, indent=2)

    print(f"\nDone.\n  Video:    {out_path}\n  Metadata: {meta_path}")
    return out_path


def main():
    parser = argparse.ArgumentParser(description="Generate a YouTube Short from a topic idea.")
    parser.add_argument("topic", help="The idea/topic for the Short, in plain English.")
    parser.add_argument("--out", default="short.mp4", help="Output filename (in OUTPUT_DIR).")
    parser.add_argument("--audience", default="general YouTube audience")
    parser.add_argument("--tone", default="energetic, direct, no fluff")
    args = parser.parse_args()

    try:
        run(args.topic, args.out, args.audience, args.tone)
    except Exception as e:
        print(f"\nFailed: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
