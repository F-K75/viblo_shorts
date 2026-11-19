// Shot segmentation and duplicate-shot detection from per-second perceptual hashes + scene cuts.

export function hamming(a: string, b: string): number {
  let x = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let n = 0;
  while (x) {
    n += Number(x & 1n);
    x >>= 1n;
  }
  return n;
}

export interface Shot {
  start: number;
  end: number;
  hash: string | null;
}

/** Splits [0, duration] at scene cuts (ignoring cuts closer than minGap) and picks each shot's middle-second hash. */
export function segmentShots(durationS: number, cuts: number[], frameHashes: string[], minGapS = 0.5): Shot[] {
  const bounds = [0];
  for (const c of [...cuts].sort((a, b) => a - b)) {
    if (c - bounds[bounds.length - 1] >= minGapS && durationS - c >= minGapS) bounds.push(c);
  }
  bounds.push(durationS);
  const shots: Shot[] = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const mid = Math.floor((bounds[i] + bounds[i + 1]) / 2);
    shots.push({ start: bounds[i], end: bounds[i + 1], hash: frameHashes[Math.min(mid, frameHashes.length - 1)] ?? null });
  }
  return shots;
}

/**
 * Indices of shots that repeat an EARLIER, non-adjacent shot (hash distance <= maxDistance). Adjacent near-identical
 * shots are a continuation (e.g. a cut detected inside one clip), not a repetition.
 */
export function repeatedShots(shots: Shot[], maxDistance = 8): Array<{ index: number; repeats: number; distance: number }> {
  const out: Array<{ index: number; repeats: number; distance: number }> = [];
  for (let j = 2; j < shots.length; j++) {
    const hj = shots[j].hash;
    if (!hj) continue;
    for (let i = 0; i < j - 1; i++) {
      const hi = shots[i].hash;
      if (!hi) continue;
      const d = hamming(hi, hj);
      if (d <= maxDistance) {
        out.push({ index: j, repeats: i, distance: d });
        break;
      }
    }
  }
  return out;
}
