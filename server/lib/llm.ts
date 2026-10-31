// LLM output parsing and validation. Model output is untrusted: it is parsed defensively
// and normalised to a strict shape before it reaches clients.
import { jsonrepair } from 'jsonrepair';

export function cleanAndParseJSON(raw: string): any {
  let cleaned = String(raw ?? '').trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  }
  let parsed: any;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    try {
      parsed = JSON.parse(jsonrepair(cleaned));
    } catch (e) {
      const first = cleaned.indexOf('{');
      const last = cleaned.lastIndexOf('}');
      if (first !== -1 && last > first) {
        parsed = JSON.parse(jsonrepair(cleaned.slice(first, last + 1)));
      } else {
        throw e;
      }
    }
  }
  // jsonrepair happily turns plain prose into a JSON string; only objects/arrays are valid model output.
  if (parsed === null || typeof parsed !== 'object') {
    throw new Error('Model output is not a JSON object');
  }
  if (Array.isArray(parsed?.hashtags)) parsed.hashtags = normalizeHashtags(parsed.hashtags);
  return parsed;
}

export function normalizeHashtags(input: unknown, max = 10): string[] {
  if (!Array.isArray(input)) return [];
  const out = input
    .flatMap((h: any) => (typeof h === 'string' ? h.split(/[\s,]+/) : []))
    .map((h: string) => h.replace(/[^a-zA-Z0-9#]/g, '').replace(/^#+/, ''))
    .filter((h: string) => h.length > 0)
    .map((h: string) => `#${h}`);
  return Array.from(new Set(out)).slice(0, max);
}

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');

export interface ValidatedScript {
  hook: string;
  title: string;
  description: string;
  hashtags: string[];
  beats: Array<{ text: string; visual_keywords: string }>;
}

/** Validates a generated script. Returns null (=> caller treats as model failure) if unusable. */
export function validateScript(parsed: any): ValidatedScript | null {
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.beats)) return null;
  const beats = parsed.beats
    .map((b: any) => ({
      text: str(b?.text, 300),
      visual_keywords: str(b?.visual_keywords, 80) || 'cinematic b-roll',
    }))
    .filter((b: { text: string }) => b.text.length > 0)
    .slice(0, 10);
  if (beats.length < 2) return null;
  const hashtags = normalizeHashtags(parsed.hashtags);
  if (!hashtags.includes('#shorts')) hashtags.unshift('#shorts');
  return {
    hook: str(parsed.hook, 200) || beats[0].text,
    title: str(parsed.title, 100) || beats[0].text.slice(0, 60),
    description: str(parsed.description, 500),
    hashtags: hashtags.slice(0, 8),
    beats,
  };
}

/** Wraps untrusted user text so it is clearly delimited as data inside a prompt. */
export function quoteUserInput(tag: string, value: string): string {
  const safe = String(value || '').replace(/<\/?[a-z_]+>/gi, '');
  return `<${tag}>${safe}</${tag}>`;
}
