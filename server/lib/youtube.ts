// YouTube URL + caption parsing helpers (pure functions, unit-tested directly).

export type CaptionSegment = { start_s: number; end_s: number; text: string };

const ID_RE = /^[a-zA-Z0-9_-]{11}$/;

/**
 * Extract the 11-character video id from a YouTube URL or a bare id.
 * Returns null for anything that is not recognisably a YouTube link/id.
 * (Previously a catch-all regex turned any 11-letter word in a free-text topic,
 * e.g. "productivity", into a bogus video id.)
 */
export function extractYouTubeId(input: string): string | null {
  if (!input || typeof input !== 'string') return null;
  let str = input.trim().replace(/^[<"'\s(\[]+|[>"'\s)\]]+$/g, '');

  if (ID_RE.test(str)) return str;

  try {
    if (str.includes('%')) str = decodeURIComponent(str);
  } catch {
    // ignore malformed escapes
  }

  // Free text with spaces is never a URL.
  if (/\s/.test(str)) return null;

  try {
    const fullUrl = /^https?:\/\//i.test(str) ? str : `https://${str}`;
    const parsed = new URL(fullUrl);
    const host = parsed.hostname.toLowerCase();
    const isYouTubeHost =
      host === 'youtu.be' ||
      host === 'youtube.com' ||
      host.endsWith('.youtube.com') ||
      host === 'youtube-nocookie.com' ||
      host.endsWith('.youtube-nocookie.com');
    if (!isYouTubeHost) return null;

    const pathParts = parsed.pathname.split('/').filter(Boolean);
    if (host === 'youtu.be') {
      return pathParts[0] && ID_RE.test(pathParts[0]) ? pathParts[0] : null;
    }
    const vParam = parsed.searchParams.get('v');
    if (vParam && ID_RE.test(vParam)) return vParam;
    if (pathParts.length >= 2 && ['shorts', 'live', 'embed', 'v', 'vi'].includes(pathParts[0])) {
      return ID_RE.test(pathParts[1]) ? pathParts[1] : null;
    }
  } catch {
    // fallthrough
  }
  return null;
}

/** Parse MM:SS or HH:MM:SS (or plain seconds) to seconds. */
export function parseTimestampToSeconds(ts?: string, fallback = 0): number {
  if (!ts) return fallback;
  const cleaned = String(ts).trim().replace(/[^\d:.]/g, '');
  const parts = cleaned.split(':').map(Number);
  if (parts.length === 2 && parts.every((p) => !isNaN(p))) return parts[0] * 60 + parts[1];
  if (parts.length === 3 && parts.every((p) => !isNaN(p))) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  const parsed = parseFloat(cleaned);
  return isNaN(parsed) ? fallback : parsed;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;#39;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

const isNoise = (t: string) => !t || t.startsWith('[♪') || t === '[Music]' || t === '[Applause]';

/** Parses YouTube timedtext XML (srv3 `<p t d>` and classic `<text start dur>`). */
export function parseXmlCaptions(xml: string): CaptionSegment[] {
  const segments: CaptionSegment[] = [];
  const pRegex = /<p\s+t="(\d+)"\s+d="(\d+)"[^>]*>([\s\S]*?)<\/p>/gi;
  let pMatch: RegExpExecArray | null;
  while ((pMatch = pRegex.exec(xml)) !== null) {
    const tMs = parseInt(pMatch[1], 10);
    const dMs = parseInt(pMatch[2], 10);
    const inner = pMatch[3];
    let txt = '';
    const sRegex = /<s[^>]*>([^<]*)<\/s>/gi;
    let sMatch: RegExpExecArray | null;
    while ((sMatch = sRegex.exec(inner)) !== null) txt += sMatch[1];
    if (!txt) txt = inner.replace(/<[^>]+>/g, '');
    txt = decodeEntities(txt).replace(/\s+/g, ' ').trim();
    if (!isNoise(txt)) {
      segments.push({
        start_s: parseFloat((tMs / 1000).toFixed(2)),
        end_s: parseFloat(((tMs + dMs) / 1000).toFixed(2)),
        text: txt,
      });
    }
  }
  if (segments.length > 0) return segments;

  const textRegex = /<text\s+start="([0-9.]+)"\s+dur="([0-9.]+)"[^>]*>([\s\S]*?)<\/text>/gi;
  let m: RegExpExecArray | null;
  while ((m = textRegex.exec(xml)) !== null) {
    const start = parseFloat(m[1]);
    const dur = parseFloat(m[2]);
    const clean = decodeEntities(m[3]).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (!isNoise(clean)) {
      segments.push({ start_s: start, end_s: parseFloat((start + dur).toFixed(2)), text: clean });
    }
  }
  return segments;
}

/** Parses transcripts pasted from YouTube's "Show transcript" panel, or inline-timestamp formats. */
export function parsePastedTranscriptToSegments(rawText: string): CaptionSegment[] {
  if (!rawText || typeof rawText !== 'string') return [];
  const lines = rawText.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return [];
  const segments: CaptionSegment[] = [];

  const toSec = (s: string): number => {
    const parts = s.trim().split(':').map(parseFloat);
    if (parts.length === 2 && parts.every((p) => !isNaN(p))) return parts[0] * 60 + parts[1];
    if (parts.length === 3 && parts.every((p) => !isNaN(p))) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    const n = parseFloat(s);
    return isNaN(n) ? 0 : n;
  };

  const timeOnlyRegex = /^(\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?)$/;
  let timeLineCount = 0;
  for (let i = 0; i < Math.min(lines.length, 12); i++) if (timeOnlyRegex.test(lines[i])) timeLineCount++;

  if (timeLineCount >= 2) {
    let currentStart: number | null = null;
    let textParts: string[] = [];
    for (const line of lines) {
      if (timeOnlyRegex.test(line)) {
        if (currentStart !== null && textParts.length > 0) {
          segments.push({
            start_s: currentStart,
            end_s: Math.max(currentStart + 1.0, toSec(line)),
            text: textParts.join(' ').trim(),
          });
        }
        currentStart = toSec(line);
        textParts = [];
      } else {
        textParts.push(line);
      }
    }
    if (currentStart !== null && textParts.length > 0) {
      segments.push({ start_s: currentStart, end_s: currentStart + 3.5, text: textParts.join(' ').trim() });
    }
    if (segments.length > 0) return segments;
  }

  const inlineTimeRegex =
    /(?:\[?(\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?)(?:\s*[-–—]\s*(\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?))?\]?[:\s]+)(.+)/;
  for (const line of lines) {
    const m = line.match(inlineTimeRegex);
    if (m) {
      const start = toSec(m[1]);
      const end = m[2] ? toSec(m[2]) : start + 3.0;
      const t = m[3].trim();
      if (t) segments.push({ start_s: start, end_s: Math.max(start + 0.8, end), text: t });
    }
  }
  return segments;
}

/**
 * Deterministic word-timing estimate for text whose real audio timing is unknown.
 * Duration is distributed proportionally to word length (+ pause weight after punctuation).
 * Results are ESTIMATES and are labelled as such by callers.
 */
export function estimateWordTimeline(text: string, durationS: number, startOffset = 0) {
  const tokens = String(text || '').trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [] as Array<{ word: string; start_s: number; end_s: number }>;
  const weights = tokens.map((t) => Math.max(2, t.length) + (/[.!?]$/.test(t) ? 4 : /[,;:]$/.test(t) ? 2 : 0));
  const total = weights.reduce((a, b) => a + b, 0);
  let cur = startOffset;
  return tokens.map((word, i) => {
    const dur = (weights[i] / total) * durationS;
    const w = { word, start_s: +cur.toFixed(2), end_s: +(cur + dur * 0.92).toFixed(2) };
    cur += dur;
    return w;
  });
}

/** Splits text into sentence beats with estimated timings over durationS. */
export function estimateSentenceBeats(text: string, durationS: number) {
  const sentences = String(text || '')
    .replace(/\s+/g, ' ')
    .match(/[^.!?]+[.!?]*/g)
    ?.map((s) => s.trim())
    .filter(Boolean) || [];
  const totalWords = sentences.reduce((a, s) => a + s.split(' ').length, 0) || 1;
  let cur = 0;
  return sentences.map((s) => {
    const dur = (s.split(' ').length / totalWords) * durationS;
    const b = { text: s, start_s: +cur.toFixed(2), end_s: +(cur + dur).toFixed(2) };
    cur += dur;
    return b;
  });
}

// ---------------------------------------------------------------------------------------------
// Deterministic clip picking (used when AI ranking is unavailable, and to snap AI picks to sentences)
// ---------------------------------------------------------------------------------------------

export interface PickedClip {
  startIdx: number;
  endIdx: number; // inclusive
  start_s: number;
  end_s: number;
  score: number; // 0-100, heuristic (not a prediction of views)
  reasons: string[];
  title: string;
  keywords: string[];
}

const STRONG_WORDS = [
  'secret', 'mistake', 'never', 'always', 'truth', 'why', 'how', 'worst', 'best', 'nobody', 'everyone', 'problem',
  'actually', 'stop', 'wrong', 'biggest', 'reason', 'realized', 'crazy', 'insane', 'surprising', 'simple', 'only',
  'nothing', 'everything', 'hate', 'love', 'fear', 'afraid', 'imagine', 'remember', 'important', 'changed', 'difference',
  'rule', 'lesson', 'trick', 'habit', 'money', 'die', 'dead', 'life', 'happy', 'success', 'fail', 'failure', 'panic',
];
const WEAK_OPENERS = /^(and|but|so|because|which|that|or|then|also|um+|uh+|like|well|it|this|they|he|she)\b/i;
const INTRO_OUTRO = /\b(thank you|thanks for (watching|listening)|subscribe|welcome (back|to)|hi everyone|hello everyone|today i('m| am) going to|in this video|see you (next|in the)|like and subscribe)\b/i;
const DIGRESSION = /\b(let me tell you about|by the way|anyway|back to the (main )?point|quick side note|off topic|where was i)\b/i;
const STOPWORDS = new Set(('the a an and or but so because which that this these those it its i me my we our you your he she they them ' +
  'their is are was were be been being have has had do does did of to in on at for with from by as about into over after before ' +
  'just not no yes very really can could would should will what when where who how why there here than then if all any some ' +
  'more most much many one two three get got going go like know think thing things way also even dont im youre its thats ' +
  'kind sort lot little bit right okay well now people time say said make made want see').split(' '));

const endsSentence = (t: string) => /[.!?]["')\]]?$/.test(t.trim());
const startsSentence = (t: string) => /^["'(\[]?[A-Z0-9]/.test(t.trim());

function hookFeatures(text: string) {
  const words = text.toLowerCase().match(/[a-z0-9']+/g) || [];
  const first = words.slice(0, 18);
  const reasons: string[] = [];
  let s = 0;
  if (/\?/.test(text.split(/(?<=[.!?])\s/).slice(0, 2).join(' '))) { s += 3; reasons.push('opens with a question'); }
  const strong = first.filter((w) => STRONG_WORDS.includes(w)).length;
  if (strong) { s += Math.min(3, strong * 1.5); reasons.push('strong opening words'); }
  if (first.some((w) => w === 'you' || w === 'your')) { s += 1; reasons.push('speaks to the viewer'); }
  if (first.some((w) => /^\d+$/.test(w))) { s += 1; reasons.push('concrete number up front'); }
  if (WEAK_OPENERS.test(text.trim())) { s -= 2.5; reasons.push('starts on a connective word (needs context)'); }
  return { s, reasons };
}

/**
 * Picks the strongest self-contained moments from a timed transcript: sentence-aligned windows of minS-maxS seconds,
 * scored on hook strength, density of questions / strong words / numbers, clean start and end, and with intros/outros
 * penalised. Returns up to `count` non-overlapping clips, best first.
 */
export function pickTranscriptClips(
  segments: CaptionSegment[],
  opts: { count?: number; minS?: number; maxS?: number; idealS?: [number, number] } = {},
): PickedClip[] {
  const { count = 3, minS = 18, maxS = 50, idealS = [25, 40] } = opts;
  const segs = segments.filter((s) => s.text && s.end_s > s.start_s).sort((a, b) => a.start_s - b.start_s);
  if (segs.length === 0) return [];
  const total = segs[segs.length - 1].end_s;
  const hasPunctuation = segs.filter((s) => /[.!?]/.test(s.text)).length >= segs.length * 0.2;

  const goodStart = (i: number) => {
    if (i === 0) return true;
    const gap = segs[i].start_s - segs[i - 1].end_s;
    return hasPunctuation ? endsSentence(segs[i - 1].text) && startsSentence(segs[i].text) : gap >= 0.6 || startsSentence(segs[i].text);
  };
  const goodEnd = (j: number) => {
    if (j === segs.length - 1) return true;
    const gap = segs[j + 1].start_s - segs[j].end_s;
    return hasPunctuation ? endsSentence(segs[j].text) : gap >= 0.6;
  };

  const candidates: PickedClip[] = [];
  for (let i = 0; i < segs.length; i++) {
    const startOk = goodStart(i);
    for (let j = i; j < segs.length; j++) {
      const dur = segs[j].end_s - segs[i].start_s;
      if (dur > maxS) break;
      if (dur < minS) continue;
      const endOk = goodEnd(j);
      const text = segs.slice(i, j + 1).map((s) => s.text).join(' ');
      const words = text.toLowerCase().match(/[a-z0-9']+/g) || [];
      const hook = hookFeatures(text);
      const reasons = [...hook.reasons];
      let score = 50 + hook.s * 4;
      if (startOk) { score += 6; } else { score -= 12; reasons.push('starts mid-sentence'); }
      if (endOk) { score += 6; reasons.push('ends on a complete thought'); } else { score -= 10; reasons.push('ends mid-sentence'); }
      const strongDensity = words.filter((w) => STRONG_WORDS.includes(w)).length / Math.max(1, words.length);
      score += Math.min(10, strongDensity * 250);
      const questions = (text.match(/\?/g) || []).length;
      if (questions) score += Math.min(6, questions * 2);
      const youDensity = words.filter((w) => w === 'you' || w === 'your').length / Math.max(1, words.length);
      score += Math.min(5, youDensity * 120);
      const wps = words.length / dur;
      if (wps < 1.4) { score -= 6; reasons.push('slow / sparse speech'); }
      if (dur < idealS[0]) score -= (idealS[0] - dur) * 0.8;
      if (dur > idealS[1]) score -= (dur - idealS[1]) * 0.8;
      if (INTRO_OUTRO.test(text)) { score -= 15; reasons.push('contains intro/outro talk'); }
      if (DIGRESSION.test(text)) { score -= 12; reasons.push('drifts into a tangent'); }
      if (segs[i].start_s < total * 0.03 && total > 180) score -= 8;
      candidates.push({ startIdx: i, endIdx: j, start_s: segs[i].start_s, end_s: segs[j].end_s, score, reasons, title: '', keywords: [] });
    }
  }
  candidates.sort((a, b) => b.score - a.score);

  const picked: PickedClip[] = [];
  for (const c of candidates) {
    if (picked.length >= count) break;
    if (picked.some((p) => c.start_s < p.end_s - 0.05 && c.end_s > p.start_s + 0.05)) continue; // back-to-back is fine
    picked.push(c);
  }

  return picked.map((c) => {
    const text = segs.slice(c.startIdx, c.endIdx + 1).map((s) => s.text).join(' ');
    const firstSentence = (text.match(/^[^.!?]+[.!?]?/)?.[0] || text).trim();
    const title = firstSentence.length <= 60 ? firstSentence : firstSentence.slice(0, 60).replace(/\s+\S*$/, '') + '…';
    const freq = new Map<string, number>();
    for (const w of text.toLowerCase().match(/[a-z][a-z']{3,}/g) || []) {
      if (!STOPWORDS.has(w.replace(/'/g, ''))) freq.set(w, (freq.get(w) || 0) + 1);
    }
    const keywords = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([w]) => w.replace(/'/g, ''));
    const positives = c.reasons.filter((r) => !/mid-sentence|intro|slow|connective|tangent/.test(r));
    return {
      ...c,
      start_s: +c.start_s.toFixed(2),
      end_s: +c.end_s.toFixed(2),
      score: Math.max(0, Math.min(100, Math.round(c.score))),
      reasons: positives.length ? positives : ['most self-contained passage available'],
      title,
      keywords,
    };
  });
}
