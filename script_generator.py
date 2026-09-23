"""
Turns a raw topic/idea into a structured Shorts script using Claude:
- a punchy hook (first line, first 2-3s)
- a full voiceover script sized to fit ~50-58s when spoken
- a list of visual search keywords per script beat (for stock footage)
- title, description, hashtags for YouTube
Returns a plain dict — no video/audio work happens here.
"""
import json
import re
from anthropic import Anthropic
from config import cfg

SYSTEM_PROMPT = """You write scripts for viral YouTube Shorts (vertical, 30-58 seconds).
You always respond with ONLY a single valid JSON object, no markdown fences, no commentary.

JSON shape:
{
  "hook": "<first spoken line, <=12 words, must create curiosity or tension>",
  "beats": [
    {"text": "<one sentence or short clause of voiceover>", "visual_keywords": "<2-4 word stock-footage search query matching this beat>"},
    ...
  ],
  "title": "<YouTube title, <=60 chars, punchy>",
  "description": "<1-2 sentence YouTube description>",
  "hashtags": ["#tag1", "#tag2", "#tag3"]
}

Rules:
- The hook IS the first beat's text as well — do not duplicate it separately in the spoken flow, just make beats[0].text equal to the hook.
- Total spoken words across all beats must be between 90 and 150 (fits ~35-58s at natural pace).
- Each beat is short (5-15 words) so it maps to one visual clip.
- visual_keywords must describe a concrete, filmable, stock-footage-searchable scene (e.g. "person typing laptop night", "city skyline sunrise drone") — never abstract ("success", "growth").
- No emojis in spoken text. Hashtags may include YouTube Shorts-relevant tags plus 1-2 topic-specific ones.
"""

USER_TEMPLATE = """Topic / idea: {topic}

Target audience: {audience}
Tone: {tone}

Write the Short script now, as the JSON object described."""


def _extract_json(text: str) -> dict:
    text = text.strip()
    # Strip accidental markdown fences if the model adds them anyway
    text = re.sub(r"^```(json)?", "", text).strip()
    text = re.sub(r"```$", "", text).strip()
    return json.loads(text)


def generate_script(topic: str, audience: str = "general YouTube audience",
                     tone: str = "energetic, direct, no fluff") -> dict:
    client = Anthropic(api_key=cfg.anthropic_api_key)
    resp = client.messages.create(
        model=cfg.script_model,
        max_tokens=1500,
        system=SYSTEM_PROMPT,
        messages=[{"role": "user", "content": USER_TEMPLATE.format(
            topic=topic, audience=audience, tone=tone
        )}],
    )
    raw_text = "".join(block.text for block in resp.content if block.type == "text")
    data = _extract_json(raw_text)

    # basic validation so failures are loud and early
    assert "beats" in data and len(data["beats"]) > 0, "No beats returned"
    assert data["beats"][0]["text"], "Empty hook"
    return data


if __name__ == "__main__":
    import sys, pprint
    topic = sys.argv[1] if len(sys.argv) > 1 else "why most people never finish their side projects"
    pprint.pprint(generate_script(topic))
