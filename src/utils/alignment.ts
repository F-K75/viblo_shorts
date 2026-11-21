/**
 * Word-level alignment of a known transcript to the REAL voiceover audio (pure: no DOM, unit-tested in node).
 *
 * We know what is said (the script line) and we have the audio that says it (the narration PCM). We do not have a
 * speech recogniser, so this is energy-based forced alignment:
 *   1. measure the voice level every 10 ms and find the pauses (≥ 120 ms below an adaptive threshold);
 *   2. choose which pauses separate which words by dynamic programming: each word group should last about as long as
 *      its syllables predict, and groups prefer to end at punctuation ("…yet, | keep looking. | Don't settle.");
 *   3. inside a group, distribute words by syllable weight and snap each boundary to the deepest level dip nearby
 *      (the short energy valley between two connected words).
 * The result is anchored to the real speech onset, real pauses and real end of each line, so captions follow the
 * voice instead of an estimate; accuracy inside a fast unbroken phrase is "near the right syllable", not phonetic.
 */

export interface AlignedWord {
  word: string;
  start_s: number;
  end_s: number;
}

export interface AlignmentResult {
  words: AlignedWord[];
  /** First and last voiced instant of the line. */
  speechStart: number;
  speechEnd: number;
  /** Pauses that were found in the audio (seconds). */
  pauses: Array<{ start: number; end: number }>;
  /** 'aligned' when anchored to audio; 'estimated' when the audio had no usable speech (falls back to even spread). */
  method: 'aligned' | 'estimated';
}

const FRAME = 0.01;
const PUNCT_END = /[.,!?;:—]["')\]]?$/;
const SENT_END = /[.!?]["')\]]?$/;

/** Rough syllable count (vowel groups), with digits read as words. Good enough as a duration weight. */
export function syllables(word: string): number {
  const w = word.toLowerCase().replace(/[^a-z0-9']/g, '');
  if (!w) return 1;
  if (/^\d+$/.test(w)) return Math.max(1, w.length * 1.5);
  const groups = w.replace(/e$/, '').match(/[aeiouy]+/g);
  return Math.max(1, groups ? groups.length : 1);
}

const weight = (w: string) => 0.35 + syllables(w);

function levelsDb(samples: Float32Array, sampleRate: number): Float32Array {
  const hop = Math.max(1, Math.round(sampleRate * FRAME));
  const n = Math.floor(samples.length / hop);
  const raw = new Float32Array(n);
  for (let f = 0; f < n; f++) {
    let s = 0;
    for (let i = f * hop; i < (f + 1) * hop; i++) s += samples[i] * samples[i];
    const r = Math.sqrt(s / hop);
    raw[f] = r > 1e-6 ? 20 * Math.log10(r) : -120;
  }
  // 3-frame median: removes single-frame clicks without moving edges.
  const out = new Float32Array(n);
  for (let f = 0; f < n; f++) {
    const a = raw[Math.max(0, f - 1)];
    const b = raw[f];
    const c = raw[Math.min(n - 1, f + 1)];
    out[f] = Math.max(Math.min(a, b), Math.min(Math.max(a, b), c));
  }
  return out;
}

function evenSpread(words: string[], start: number, end: number): AlignedWord[] {
  const ws = words.map(weight);
  const total = ws.reduce((a, b) => a + b, 0) || 1;
  let t = start;
  return words.map((w, i) => {
    const d = ((end - start) * ws[i]) / total;
    const out = { word: w, start_s: round(t), end_s: round(t + d * 0.92) };
    t += d;
    return out;
  });
}

const round = (n: number) => Math.round(n * 1000) / 1000;

export function alignWordsToAudio(
  samples: Float32Array,
  sampleRate: number,
  words: string[],
  opts: { minPauseS?: number; rangeDb?: number; floorDb?: number } = {},
): AlignmentResult {
  const minPause = Math.round((opts.minPauseS ?? 0.12) / FRAME);
  const db = levelsDb(samples, sampleRate);
  const n = db.length;
  const dur = n * FRAME;
  if (!words.length) return { words: [], speechStart: 0, speechEnd: 0, pauses: [], method: 'estimated' };
  const sorted = Array.from(db).sort((a, b) => a - b);
  const loud = sorted[Math.floor(sorted.length * 0.95)] ?? -120;
  const thr = Math.max(opts.floorDb ?? -55, loud - (opts.rangeDb ?? 35));
  const voiced = Array.from(db, (d) => d > thr);
  const first = voiced.indexOf(true);
  const last = voiced.lastIndexOf(true);
  if (first < 0 || loud < -70) {
    return { words: evenSpread(words, 0, dur), speechStart: 0, speechEnd: dur, pauses: [], method: 'estimated' };
  }
  const speechStart = first * FRAME;
  const speechEnd = (last + 1) * FRAME;

  // Pauses strictly inside the voiced region.
  const pauses: Array<{ start: number; end: number }> = [];
  for (let f = first; f <= last; ) {
    if (voiced[f]) {
      f++;
      continue;
    }
    let g = f;
    while (g <= last && !voiced[g]) g++;
    if (g - f >= minPause) pauses.push({ start: f * FRAME, end: g * FRAME });
    f = g;
  }

  // ---- 2. choose group boundaries among pauses (DP) ----
  // Nodes: 0 = speech start, 1..P = pauses, P+1 = speech end. A group spans node a (its end) → node b (its start).
  const P = pauses.length;
  const nodeEnd = (i: number) => (i === 0 ? speechStart : pauses[i - 1].end); // where a group starting after node i begins
  const nodeStart = (i: number) => (i === P + 1 ? speechEnd : pauses[i - 1].start); // where a group ending at node i ends
  const W = words.length;
  const wts = words.map(weight);
  const cum = [0];
  for (const x of wts) cum.push(cum[cum.length - 1] + x);
  const voicedTotal = speechEnd - speechStart - pauses.reduce((s, p) => s + (p.end - p.start), 0);
  const rate = Math.max(0.05, voicedTotal / cum[W]); // seconds per weight unit
  const INF = Number.POSITIVE_INFINITY;
  // dp[i][j]: best cost with the first j words placed and the last group ending at node i.
  const dp: Float64Array[] = Array.from({ length: P + 2 }, () => new Float64Array(W + 1).fill(INF));
  const from: Int32Array[] = Array.from({ length: P + 2 }, () => new Int32Array(W + 1).fill(-1));
  const fromJ: Int32Array[] = Array.from({ length: P + 2 }, () => new Int32Array(W + 1).fill(-1));
  dp[0][0] = 0;
  for (let b = 1; b <= P + 1; b++) {
    for (let a = 0; a < b; a++) {
      const gStart = nodeEnd(a);
      const gEnd = nodeStart(b);
      if (gEnd <= gStart) continue;
      // Pauses skipped inside this group (between a and b) are voiced-time-neutral but should be short.
      let skipped = 0;
      for (let k = a + 1; k < b; k++) skipped += pauses[k - 1].end - pauses[k - 1].start;
      const span = gEnd - gStart - skipped;
      for (let j0 = 0; j0 < W; j0++) {
        if (dp[a][j0] === INF) continue;
        for (let j = j0 + 1; j <= W; j++) {
          if (b === P + 1 && j !== W) continue; // the last group takes the remaining words
          const expect = (cum[j] - cum[j0]) * rate;
          let cost = ((span - expect) * (span - expect)) / Math.max(0.15, expect);
          cost += skipped * 2; // a long silence inside a group is unlikely
          if (b <= P) {
            // A real pause after a punctuated word is expected; a pause after an unpunctuated word less so.
            const lastWord = words[j - 1];
            const pauseLen = pauses[b - 1].end - pauses[b - 1].start;
            cost += SENT_END.test(lastWord) ? -0.3 : PUNCT_END.test(lastWord) ? -0.15 : 0.12 / Math.max(0.5, pauseLen * 5);
          }
          const total = dp[a][j0] + cost;
          if (total < dp[b][j]) {
            dp[b][j] = total;
            from[b][j] = a;
            fromJ[b][j] = j0;
          }
        }
      }
    }
  }
  if (dp[P + 1][W] === INF) return { words: evenSpread(words, speechStart, speechEnd), speechStart, speechEnd, pauses, method: 'estimated' };
  const groups: Array<{ a: number; b: number; j0: number; j: number }> = [];
  for (let b = P + 1, j = W; b > 0; ) {
    const a = from[b][j];
    const j0 = fromJ[b][j];
    groups.unshift({ a, b, j0, j });
    b = a;
    j = j0;
  }

  // ---- 3. inside each group: weighted spread, boundaries snapped to the deepest dip nearby ----
  const out: AlignedWord[] = [];
  for (const g of groups) {
    const gStart = nodeEnd(g.a);
    const gEnd = nodeStart(g.b);
    // Skipped pauses inside the group are hard word boundaries' best candidates; treat the group as voiced pieces.
    const gw = words.slice(g.j0, g.j);
    const gWts = wts.slice(g.j0, g.j);
    const tot = gWts.reduce((x, y) => x + y, 0);
    const bounds = [gStart];
    let acc = 0;
    for (let i = 0; i < gw.length - 1; i++) {
      acc += gWts[i];
      const guess = gStart + ((gEnd - gStart) * acc) / tot;
      const avg = (gEnd - gStart) / gw.length;
      const lo = Math.max(bounds[bounds.length - 1] + 0.06, guess - avg * 0.35);
      const hi = Math.min(gEnd - 0.06 * (gw.length - 1 - i), guess + avg * 0.35);
      let best = guess;
      let bestDb = INF;
      for (let t = lo; t <= hi; t += FRAME) {
        const f = Math.round(t / FRAME);
        // Prefer deep dips, mildly prefer staying near the syllable-based guess.
        const score = (db[f] ?? 0) + Math.abs(t - guess) * 20;
        if (score < bestDb) {
          bestDb = score;
          best = t;
        }
      }
      bounds.push(Math.max(bounds[bounds.length - 1] + 0.05, Math.min(best, gEnd - 0.05)));
    }
    bounds.push(gEnd);
    gw.forEach((w, i) => {
      const s = bounds[i];
      const e = i === gw.length - 1 ? bounds[i + 1] : Math.max(s + 0.05, bounds[i + 1] - 0.02);
      out.push({ word: w, start_s: round(s), end_s: round(e) });
    });
  }
  return { words: out, speechStart: round(speechStart), speechEnd: round(speechEnd), pauses, method: 'aligned' };
}

/** Decodes base64 little-endian 16-bit mono PCM (the /api/tts payload) to floats. */
export function pcm16Base64ToFloat(b64: string): Float32Array {
  const bin = typeof atob === 'function' ? atob(b64) : Buffer.from(b64, 'base64').toString('binary');
  const n = Math.floor(bin.length / 2);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let v = bin.charCodeAt(i * 2) | (bin.charCodeAt(i * 2 + 1) << 8);
    if (v >= 0x8000) v -= 0x10000;
    out[i] = v / 32768;
  }
  return out;
}
