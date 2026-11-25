// Pure parts of speaker-aware vertical cropping: path smoothing, time lookup and per-frame scoring (no browser).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cropFraction,
  cropXAt,
  cropCenterAt,
  leftForCenter,
  objectPositionPercent,
  scoreColumns,
  smoothCropPath,
  subjectFromColumns,
  type SubjectSample,
} from '../src/utils/smartCrop.ts';

const FRAC = cropFraction(1280, 720); // 9:16 window of a 16:9 frame
const at = (fps: number, secs: number, x: (t: number) => number, confidence = 1): SubjectSample[] =>
  Array.from({ length: Math.round(secs * fps) + 1 }, (_, i) => ({ t: i / fps, x: x(i / fps), confidence }));
const maxStep = (lefts: number[]) => Math.max(0, ...lefts.slice(1).map((v, i) => Math.abs(v - lefts[i])));

test('cropFraction: 9:16 of 1280x720 is ~0.316; portrait sources cannot be cropped horizontally', () => {
  assert.ok(Math.abs(FRAC - 405 / 1280) < 1e-9);
  assert.equal(cropFraction(720, 1280), 1);
  assert.equal(cropFraction(0, 0), 1);
});

test('steady subject → steady crop centred on the subject', () => {
  const path = smoothCropPath(at(4, 10, () => 0.25), FRAC);
  const expected = leftForCenter(0.25, FRAC);
  for (const l of path.lefts) assert.ok(Math.abs(l - expected) < 1e-9);
  assert.ok(Math.abs(cropCenterAt(path, 3.3) - 0.25) < 1e-9);
});

test('small jitter inside the dead zone → the crop does not move at all', () => {
  const jitter = [0, 0.03, -0.02, 0.04, -0.035, 0.01, -0.04, 0.025];
  const path = smoothCropPath(at(4, 12, (t) => 0.4 + jitter[Math.round(t * 4) % jitter.length]), FRAC);
  assert.equal(new Set(path.lefts).size, 1, 'one constant crop position');
});

test('single-frame outliers (a hand wave, a passing object) are ignored', () => {
  const path = smoothCropPath(at(4, 8, (t) => (Math.round(t * 4) % 9 === 4 ? 0.9 : 0.3)), FRAC);
  assert.equal(new Set(path.lefts).size, 1);
});

test('a real move left → right pans with bounded speed and settles on the new position', () => {
  const maxSpeed = 0.35;
  const samples = at(4, 12, (t) => (t < 4 ? 0.2 : 0.8));
  const path = smoothCropPath(samples, FRAC, { maxSpeed });
  const startLeft = leftForCenter(0.2, FRAC);
  const endLeft = leftForCenter(0.8, FRAC);
  assert.ok(Math.abs(cropXAt(path, 0) - startLeft) < 1e-9, 'starts on the subject, no pan from the centre');
  assert.ok(Math.abs(cropXAt(path, 12) - endLeft) < 1e-9, 'ends on the subject');
  assert.ok(Math.abs(cropXAt(path, 3.75) - startLeft) < 1e-9, 'the crop holds until the move is real');
  // Never faster than maxSpeed (frame widths per second) between samples (0.25 s apart).
  assert.ok(maxStep(path.lefts) <= maxSpeed * 0.25 + 1e-9, `step ${maxStep(path.lefts)}`);
  // The pan takes time: half-way through the move it is between the two positions.
  const mid = cropXAt(path, 5);
  assert.ok(mid > startLeft && mid < endLeft, `mid-pan left ${mid}`);
  // Monotonic: no overshoot or wobble.
  for (let i = 1; i < path.lefts.length; i++) assert.ok(path.lefts[i] >= path.lefts[i - 1] - 1e-12);
});

test('clamping: subjects at the very edges keep the window inside the frame', () => {
  const left = smoothCropPath(at(4, 3, () => 0.01), FRAC);
  const right = smoothCropPath(at(4, 3, () => 0.995), FRAC);
  for (const l of left.lefts) assert.equal(l, 0);
  for (const l of right.lefts) assert.ok(Math.abs(l - (1 - FRAC)) < 1e-9);
  assert.equal(objectPositionPercent(0, FRAC), 0);
  assert.ok(Math.abs(objectPositionPercent(1 - FRAC, FRAC) - 100) < 1e-9);
  assert.equal(objectPositionPercent(leftForCenter(0.5, FRAC), FRAC), 50);
});

test('low-confidence samples keep the last confident position (or the centre when nothing is known)', () => {
  const s = at(4, 6, (t) => (t < 2 ? 0.25 : 0.9)).map((x) => ({ ...x, confidence: x.t < 2 ? 1 : 0 }));
  const path = smoothCropPath(s, FRAC);
  assert.equal(new Set(path.lefts).size, 1);
  assert.ok(Math.abs(cropCenterAt(path, 5) - 0.25) < 1e-9);
  const unknown = smoothCropPath(at(4, 3, () => 0.1, 0), FRAC);
  assert.ok(Math.abs(cropCenterAt(unknown, 1) - 0.5) < 1e-9);
});

test('cropXAt: linear interpolation between samples, held at the ends; deterministic', () => {
  const path = { times: [0, 1, 2], lefts: [0.1, 0.3, 0.3], cropFrac: FRAC };
  assert.equal(cropXAt(path, -5), 0.1);
  assert.ok(Math.abs(cropXAt(path, 0.5) - 0.2) < 1e-12);
  assert.equal(cropXAt(path, 9), 0.3);
  assert.equal(cropXAt(null, 1), 0);
  const samples = at(4, 10, (t) => 0.5 + 0.3 * Math.sin(t));
  assert.deepEqual(smoothCropPath(samples, FRAC), smoothCropPath(samples, FRAC));
});

test('scoreColumns + subjectFromColumns: a moving skin-toned box on the left is found', () => {
  const w = 160;
  const h = 90;
  const frame = (boxX: number) => {
    const px = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const inBox = x >= boxX && x < boxX + 24 && y >= 20 && y < 70;
        // 0xE0AC69 skin tone on a dark blue-grey background
        px[i] = inBox ? 0xe0 : 0x20;
        px[i + 1] = inBox ? 0xac : 0x30;
        px[i + 2] = inBox ? 0x69 : 0x40;
        px[i + 3] = 255;
      }
    }
    return px;
  };
  const a = scoreColumns(frame(14), w, h);
  const b = scoreColumns(frame(18), w, h, a.luma);
  const found = subjectFromColumns(b.scores, FRAC);
  assert.ok(Math.abs(found.x - 30 / 160) < 0.05, `subject x ${found.x}`);
  assert.ok(found.confidence > 0.5, `confidence ${found.confidence}`);
  // A flat, static frame carries no evidence.
  const flat = new Uint8ClampedArray(w * h * 4).fill(40);
  assert.equal(subjectFromColumns(scoreColumns(flat, w, h).scores, FRAC).confidence, 0);
});
