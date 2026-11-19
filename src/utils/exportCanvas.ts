import type { CaptionStyle, WordTiming } from '../types';
import { TOPICS, getTopic } from './visualPlaceholders';

/** The editor preview is 360 px wide; exported frames are scaled from it so captions look the same as in the editor. */
export const PREVIEW_WIDTH = 360;

/** Characters that fit in two caption lines at this font size (bold caps average ~0.62em per glyph). */
export function captionMaxChars(fontSize: number, lines = 2): number {
  const usable = (PREVIEW_WIDTH - 24) * 0.94 - 28;
  return Math.max(8, Math.floor((usable / (Math.max(10, fontSize) * 0.62)) * lines));
}

const easeOut = (x: number) => 1 - Math.pow(1 - Math.min(1, Math.max(0, x)), 3);

/**
 * Animated motion-graphics background for beats that have no real footage or photo (no stock API key, offline,
 * or blocked media). Drifting colour orbs in the beat's topic palette, a floating topic icon that pops in on every cut,
 * and story-style progress segments.
 */
export function drawMotionBackground(
  ctx: CanvasRenderingContext2D,
  opts: { t: number; beatIndex: number; beatCount: number; beatProgress: number; beatElapsed: number; text?: string; keywords?: string; w: number; h: number },
) {
  const { t, beatIndex, beatCount, beatProgress, beatElapsed, text, keywords, w, h } = opts;
  // The beat's own words pick the icon (varies per beat); the visual keywords are the fallback.
  const byText = getTopic(text);
  const topic = TOPICS[byText !== 'default' ? byText : getTopic(keywords)];
  const hue = (topic.hue + beatIndex * 28) % 360;

  const base = ctx.createLinearGradient(0, 0, w * 0.4, h);
  base.addColorStop(0, `hsl(${hue}, 55%, 9%)`);
  base.addColorStop(1, `hsl(${(hue + 40) % 360}, 60%, 18%)`);
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, w, h);

  // Drifting light orbs
  const orbs = [
    { x: 0.2, y: 0.25, r: 0.55, sp: 0.23, hs: 0, a: 0.55 },
    { x: 0.85, y: 0.55, r: 0.6, sp: 0.17, hs: 50, a: 0.45 },
    { x: 0.4, y: 0.9, r: 0.5, sp: 0.29, hs: -40, a: 0.4 },
  ];
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  orbs.forEach((o, i) => {
    const cx = (o.x + Math.sin(t * o.sp + i * 2.1) * 0.12) * w;
    const cy = (o.y + Math.cos(t * o.sp * 0.8 + i) * 0.08) * h;
    const r = o.r * w;
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    g.addColorStop(0, `hsla(${(hue + o.hs + 360) % 360}, 85%, 55%, ${o.a})`);
    g.addColorStop(1, `hsla(${(hue + o.hs + 360) % 360}, 85%, 55%, 0)`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  });
  ctx.restore();

  // Diagonal light sweep
  ctx.save();
  ctx.globalAlpha = 0.06;
  ctx.fillStyle = '#ffffff';
  const sweepX = ((t * 0.15) % 1.6 - 0.3) * w;
  ctx.beginPath();
  ctx.moveTo(sweepX, 0);
  ctx.lineTo(sweepX + w * 0.25, 0);
  ctx.lineTo(sweepX - w * 0.35, h);
  ctx.lineTo(sweepX - w * 0.6, h);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  // Topic icon: pops in on each cut, then floats
  const pop = easeOut(beatElapsed / 0.35);
  const scale = (0.6 + 0.4 * pop) * (1 + beatProgress * 0.06);
  const iconY = h * 0.36 + Math.sin(t * 1.6) * h * 0.008;
  const ringR = w * 0.2 * scale;
  ctx.save();
  ctx.globalAlpha = pop;
  const ring = ctx.createRadialGradient(w / 2, iconY, ringR * 0.2, w / 2, iconY, ringR * 1.4);
  ring.addColorStop(0, 'rgba(255,255,255,0.22)');
  ring.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = ring;
  ctx.beginPath();
  ctx.arc(w / 2, iconY, ringR * 1.4, 0, Math.PI * 2);
  ctx.fill();
  ctx.font = `${Math.round(w * 0.2 * scale)}px "Noto Color Emoji", "Apple Color Emoji", "Segoe UI Emoji", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(topic.icon, w / 2, iconY);
  ctx.restore();

  // Story-style progress segments (inside the top safe zone)
  if (beatCount > 1) {
    const margin = w * 0.05;
    const gap = w * 0.012;
    const segW = (w - margin * 2 - gap * (beatCount - 1)) / beatCount;
    const y = h * 0.035;
    const segH = Math.max(4, w * 0.006);
    for (let i = 0; i < beatCount; i++) {
      const x = margin + i * (segW + gap);
      ctx.fillStyle = 'rgba(255,255,255,0.25)';
      ctx.beginPath();
      ctx.roundRect(x, y, segW, segH, segH / 2);
      ctx.fill();
      const fill = i < beatIndex ? 1 : i === beatIndex ? beatProgress : 0;
      if (fill > 0) {
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.roundRect(x, y, segW * fill, segH, segH / 2);
        ctx.fill();
      }
    }
  }

  // Vignette for caption contrast
  const vig = ctx.createRadialGradient(w / 2, h / 2, w * 0.3, w / 2, h / 2, h * 0.75);
  vig.addColorStop(0, 'rgba(0,0,0,0)');
  vig.addColorStop(1, 'rgba(0,0,0,0.55)');
  ctx.fillStyle = vig;
  ctx.fillRect(0, 0, w, h);
}

/**
 * Number of lines drawCaptionChunk will need for these words (same font, word gap, width and active-word reserve),
 * so captions can be grouped to fit the line limit with the renderer's own layout instead of a character estimate.
 */
export function captionLineCount(ctx: CanvasRenderingContext2D, words: string[], style: CaptionStyle, w = PREVIEW_WIDTH): number {
  const k = w / PREVIEW_WIDTH;
  const isUpper = style.textTransform !== 'none';
  const fontPx = style.fontSize * k;
  ctx.save();
  ctx.font = `${style.fontWeight || '900'} ${fontPx}px '${style.fontFamily || 'Montserrat'}', 'Poppins', sans-serif`;
  const gap = fontPx * 0.32;
  // 3% safety margin: measuring at preview scale and drawing at export scale can differ by a pixel at the wrap point.
  const maxLineW = ((PREVIEW_WIDTH - 24) * 0.94 * k - 14 * k * 2) * 0.97;
  const widths = words
    .map((wd) => (isUpper ? wd.toUpperCase() : wd).replace(/[.,!?;:]/g, ''))
    .filter(Boolean)
    .map((t) => ctx.measureText(t).width * 1.12); // any word may be the highlighted (1.12x) one
  ctx.restore();
  if (!widths.length) return 0;
  let lines = 1;
  let lineW = 0;
  for (const wd of widths) {
    const add = (lineW ? gap : 0) + wd;
    if (lineW && lineW + add > maxLineW) {
      lines++;
      lineW = wd;
    } else lineW += add;
  }
  return lines;
}

/**
 * Draws a kinetic caption chunk exactly like the editor preview (ShortsPlayer overlay), scaled from the 360 px preview:
 * same font size, stroke, pill box, 94% max width with line wrapping, and the 1.12x pop on the active word.
 */
export function drawCaptionChunk(
  ctx: CanvasRenderingContext2D,
  opts: { words: WordTiming[]; t: number; style: CaptionStyle; w: number; h: number },
) : number {
  const { words, t, style, w, h } = opts;
  const k = w / PREVIEW_WIDTH;
  const isUpper = style.textTransform !== 'none';
  const fmt = (s: string) => (isUpper ? s.toUpperCase() : s).replace(/[.,!?;:]/g, '');
  const fontPx = style.fontSize * k;
  const fontFam = style.fontFamily || 'Montserrat';
  ctx.save();
  ctx.font = `${style.fontWeight || '900'} ${fontPx}px '${fontFam}', 'Poppins', sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const gap = fontPx * 0.32; // a real word space
  const padX = 14 * k;
  const padY = 8 * k;
  const maxLineW = (PREVIEW_WIDTH - 24) * 0.94 * k - padX * 2;
  const items = words
    .map((wd) => ({ text: fmt(wd.word), active: t >= wd.start_s && t <= wd.end_s }))
    .filter((i) => i.text)
    // Reserve the active word's 1.12x pop in the layout so it never collides with its neighbours.
    .map((i) => ({ ...i, width: ctx.measureText(i.text).width * (i.active ? 1.12 : 1) }));
  if (!items.length) {
    ctx.restore();
    return 0;
  }

  // Greedy line wrap
  const lines: (typeof items)[] = [[]];
  let lineW = 0;
  for (const it of items) {
    const add = (lines[lines.length - 1].length ? gap : 0) + it.width;
    if (lines[lines.length - 1].length && lineW + add > maxLineW) {
      lines.push([it]);
      lineW = it.width;
    } else {
      lines[lines.length - 1].push(it);
      lineW += add;
    }
  }
  const lineWidths = lines.map((l) => l.reduce((a, i) => a + i.width, 0) + gap * (l.length - 1));
  const lineH = fontPx * 1.25;
  const boxW = Math.min(Math.max(...lineWidths), maxLineW) + padX * 2;
  const boxH = lineH * lines.length + padY * 2;
  const cy = h * (style.positionY / 100);

  ctx.translate(w / 2, cy);
  if (style.rotation) ctx.rotate((style.rotation * Math.PI) / 180);
  ctx.translate(-w / 2, -cy);

  ctx.fillStyle = style.boxStyle === 'glow' ? 'rgba(0,0,0,0.85)' : style.boxStyle === 'minimal' ? 'rgba(0,0,0,0.5)' : 'rgba(0,0,0,0.75)';
  ctx.shadowColor = 'rgba(0,0,0,0.5)';
  ctx.shadowBlur = 24 * k;
  ctx.beginPath();
  ctx.roundRect(w / 2 - boxW / 2, cy - boxH / 2, boxW, boxH, 12 * k);
  ctx.fill();
  ctx.shadowBlur = 0;

  lines.forEach((line, li) => {
    let x = w / 2 - lineWidths[li] / 2;
    const y = cy - boxH / 2 + padY + lineH * (li + 0.5);
    line.forEach((it) => {
      const cx = x + it.width / 2;
      ctx.save();
      ctx.translate(cx, y);
      if (it.active) ctx.scale(1.12, 1.12);
      ctx.lineJoin = 'round';
      ctx.strokeStyle = style.strokeColor || '#000000';
      ctx.lineWidth = Math.max(2, (style.strokeWidth || 4) * 0.8) * k;
      ctx.strokeText(it.text, 0, 0);
      if (style.boxStyle === 'glow' && it.active) {
        ctx.shadowColor = style.highlightColor;
        ctx.shadowBlur = 16 * k;
      }
      ctx.fillStyle = it.active ? style.highlightColor : style.textColor;
      ctx.fillText(it.text, 0, 0);
      ctx.restore();
      x += it.width + gap;
    });
  });
  ctx.restore();
  return lines.length; // reported to the quality check (caption overflow evidence)
}

/**
 * Draws a landscape (or any) source video frame into the vertical canvas.
 * fill: crop to 9:16 around `cropCenter` (normalized 0..1 of the frame width; default 0.5 = centre crop), clamped so
 * the window stays inside the frame — smartCrop supplies a speaker-following centre.
 * fit: blurred, darkened cover as background + the whole frame centred.
 */
export function drawSourceFrame(
  ctx: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  mode: 'fill' | 'fit',
  w: number,
  h: number,
  cropCenter = 0.5,
  zoom = 1,
) {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  const cover = (center: number) => {
    const target = w / h;
    const src = vw / vh;
    let sx = 0, sy = 0, sw = vw, sh = vh;
    if (src > target) {
      sw = vh * target;
    } else {
      sh = vw / target;
    }
    // Punch-in: a tighter crop of the same frame (a framing change at a sentence boundary). Kept slightly above
    // centre vertically, where faces usually are.
    const z = mode === 'fill' && zoom > 1 ? zoom : 1;
    sw /= z;
    sh /= z;
    const c = Number.isFinite(center) ? center : 0.5;
    sx = Math.min(vw - sw, Math.max(0, c * vw - sw / 2));
    sy = Math.min(vh - sh, Math.max(0, (vh - sh) * (z > 1 ? 0.35 : 0.5)));
    ctx.drawImage(video, sx, sy, sw, sh, 0, 0, w, h);
  };
  if (mode === 'fill') {
    cover(cropCenter);
    return;
  }
  ctx.save();
  ctx.filter = 'blur(40px) brightness(0.45)';
  cover(0.5);
  ctx.restore();
  const scale = Math.min(w / vw, h / vh);
  const dw = vw * scale;
  const dh = vh * scale;
  ctx.drawImage(video, (w - dw) / 2, (h - dh) / 2, dw, dh);
}
