// Track C (R-13): bounded request bodies, backpressure and a memory guard.
//
//  * Route-specific body limits. Requests whose Content-Length exceeds the route limit are refused with 413 before a
//    byte of the body is read; chunked bodies are cut off by the JSON parser while streaming (same limit).
//  * Bodies are read only AFTER the header-based authentication middleware, so anonymous clients cannot make the
//    server buffer anything on protected routes (wiring in server.ts).
//  * At most `concurrency` large bodies (> largeBodyBytes, or chunked) are in flight per instance. A large body holds
//    its slot until the response is finished, because its parsed form stays in memory for the whole handler.
//    Excess requests get 503 `busy` + Retry-After instead of queueing in memory.
//  * Memory guard: RSS is sampled every `sampleMs`. Above `softLimitMb`, large-body and render requests get 503
//    `memory_pressure` and readiness reports not-ready (the load balancer drains the instance). It recovers below 90 %
//    of the limit (hysteresis, so it does not flap). Liveness is unaffected: a drained instance is not restarted.
import fs from 'fs';
import os from 'os';
import type { NextFunction, Request, RequestHandler, Response } from 'express';

const MB = 1024 * 1024;

export interface BodyLimits {
  /** Routes that carry a whole project (save, publishing pack, metadata optimizer, render, jobs). */
  projectBytes: number;
  /** Pasted transcripts; the server truncates them after parsing, so the transport limit stays generous. */
  transcriptBytes: number;
  /** Voice-to-text helpers (a few thousand characters of context). */
  mediumBytes: number;
  /** Everything else (small JSON forms). */
  defaultBytes: number;
}

const PROJECT_ROUTES = new Set(['/api/projects', '/api/publish/generate-pack', '/api/gemini/optimize-metadata', '/api/render/video', '/api/jobs/create']);
const TRANSCRIPT_ROUTES = new Set(['/api/youtube/parse-transcript', '/api/youtube/generate-clips']);
const MEDIUM_ROUTES = new Set(['/api/voice-to-text/transcribe-clip', '/api/voice-to-text/align-words']);
/** Routes that start renders: refused under memory pressure whatever their body size. */
const RENDER_ROUTE = /^\/api\/(render\/video|jobs\/create|jobs\/[^/]+\/retry)$/;

export function bodyLimitFor(path: string, limits: BodyLimits): number {
  if (PROJECT_ROUTES.has(path)) return limits.projectBytes;
  if (TRANSCRIPT_ROUTES.has(path)) return limits.transcriptBytes;
  if (MEDIUM_ROUTES.has(path)) return limits.mediumBytes;
  return limits.defaultBytes;
}

// ---------------- memory guard ----------------
/** Container memory limit (cgroup v2, then v1), or null when unlimited/unknown. */
export function containerMemoryLimitBytes(): number | null {
  for (const f of ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes']) {
    try {
      const v = fs.readFileSync(f, 'utf8').trim();
      const n = Number(v);
      if (v !== 'max' && Number.isFinite(n) && n > 0 && n < 2 ** 60) return n;
    } catch {
      // not present
    }
  }
  return null;
}

export interface MemoryBudgetInput {
  /** MEMORY_SOFT_LIMIT_MB when set: the Node threshold itself (0 disables the guard). */
  explicitSoftLimitMb?: number;
  /** Container memory limit in MB (MEMORY_CONTAINER_LIMIT_MB, else cgroup), or null when unknown/unlimited. */
  containerLimitMb: number | null;
  /** Fallback when there is no container limit (defaults to this host's memory). */
  hostMemoryMb?: number;
  /** MAX_CONCURRENT_RENDERS: ffmpeg processes this instance may run at once. */
  maxConcurrentRenders: number;
  /** RENDER_MEMORY_RESERVE_MB: memory set aside per concurrent render (worst case measured: 169 MB). */
  renderReserveMb: number;
  /** The smallest Node threshold that is still useful (MEMORY_MIN_NODE_MB, default 192). */
  minNodeMb?: number;
}
export interface MemoryBudget {
  softLimitMb: number;
  source: 'computed' | 'explicit' | 'disabled';
  memoryMb: number | null;
  reservedForRendersMb: number;
  maxConcurrentRenders: number;
  renderReserveMb: number;
}

/**
 * The memory guard's Node threshold (Track C correction 1). ffmpeg renders run as separate processes: their memory is
 * never part of Node's RSS, but it counts against the same container limit. So, by default:
 *
 *     L = floor(0.8 x M - R x S)      M = container (else host) memory, R = concurrent renders, S = reserve per render
 *
 * An explicit MEMORY_SOFT_LIMIT_MB is the Node threshold itself; the reserve is NOT subtracted from it again. A budget
 * that leaves Node less than `minNodeMb` (or nothing) is refused: a useless threshold must never be accepted silently.
 */
export function computeMemoryBudget(i: MemoryBudgetInput): MemoryBudget {
  const R = i.maxConcurrentRenders;
  const S = i.renderReserveMb;
  if (!Number.isInteger(R) || R < 1) throw new Error(`MAX_CONCURRENT_RENDERS must be a whole number >= 1 (got ${R})`);
  if (!Number.isFinite(S) || S < 0) throw new Error(`RENDER_MEMORY_RESERVE_MB must be a number >= 0 (got ${S})`);
  if (i.explicitSoftLimitMb !== undefined) {
    const e = i.explicitSoftLimitMb;
    if (!Number.isFinite(e) || e < 0) throw new Error(`MEMORY_SOFT_LIMIT_MB must be a number >= 0 (got ${e})`);
    return { softLimitMb: e, source: e === 0 ? 'disabled' : 'explicit', memoryMb: i.containerLimitMb, reservedForRendersMb: 0, maxConcurrentRenders: R, renderReserveMb: S };
  }
  if (i.containerLimitMb !== null && (!Number.isFinite(i.containerLimitMb) || i.containerLimitMb <= 0)) {
    throw new Error(`MEMORY_CONTAINER_LIMIT_MB must be a number > 0 (got ${i.containerLimitMb})`);
  }
  const M = i.containerLimitMb ?? i.hostMemoryMb ?? Math.round(os.totalmem() / MB);
  const reserved = R * S;
  const L = Math.floor(0.8 * M - reserved);
  const min = i.minNodeMb ?? 192;
  if (L < min) {
    throw new Error(
      `insufficient memory budget: 80 % of ${M} MB minus ${R} renders x ${S} MB leaves ${L} MB for the Node process (minimum ${min} MB). ` +
        'Give the container more memory, lower MAX_CONCURRENT_RENDERS or RENDER_MEMORY_RESERVE_MB, or set MEMORY_SOFT_LIMIT_MB explicitly.',
    );
  }
  return { softLimitMb: L, source: 'computed', memoryMb: M, reservedForRendersMb: reserved, maxConcurrentRenders: R, renderReserveMb: S };
}

export class MemoryGuard {
  pressured = false;
  lastRssMb = 0;
  trips = 0;
  private timer: NodeJS.Timeout | null = null;
  constructor(
    readonly softLimitMb: number, // 0 disables the guard
    private readonly sampleMs: number,
    private readonly readRssMb: () => number,
  ) {}
  sample() {
    try {
      this.lastRssMb = this.readRssMb();
    } catch {
      return; // a failed sample keeps the previous state
    }
    if (!this.softLimitMb) return;
    if (!this.pressured && this.lastRssMb > this.softLimitMb) {
      this.pressured = true;
      this.trips++;
      console.warn(JSON.stringify({ level: 'warn', event: 'memory_pressure_on', rssMb: this.lastRssMb, softLimitMb: this.softLimitMb }));
    } else if (this.pressured && this.lastRssMb < this.softLimitMb * 0.9) {
      this.pressured = false;
      console.warn(JSON.stringify({ level: 'warn', event: 'memory_pressure_off', rssMb: this.lastRssMb, softLimitMb: this.softLimitMb }));
    }
  }
  start() {
    this.sample();
    this.timer = setInterval(() => this.sample(), this.sampleMs);
    this.timer.unref();
    return this;
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
  }
}

// ---------------- body admission (limits + backpressure + memory) ----------------
export interface BodyGuardStats {
  bodyConcurrency: number;
  largeBodyBytes: number;
  largeBodiesInFlight: number;
  largeBodiesInFlightMax: number;
  largeBodiesAdmitted: number;
  rejectedTooLarge: number;
  rejectedBusy: number;
  rejectedMemory: number;
}

export function createBodyGuard(opts: { limits: BodyLimits; concurrency: number; largeBodyBytes: number; memory: MemoryGuard }): {
  middleware: RequestHandler;
  stats: BodyGuardStats;
} {
  const stats: BodyGuardStats = {
    bodyConcurrency: opts.concurrency,
    largeBodyBytes: opts.largeBodyBytes,
    largeBodiesInFlight: 0,
    largeBodiesInFlightMax: 0,
    largeBodiesAdmitted: 0,
    rejectedTooLarge: 0,
    rejectedBusy: 0,
    rejectedMemory: 0,
  };
  // The body is never parsed or buffered for these answers. Node discards whatever the client still sends after the
  // response (no memory; bounded by REQUEST_TIMEOUT_MS). The connection is NOT closed early: a client still uploading
  // would then see a broken pipe instead of the 413/503 and its message.
  const refuse = (res: Response, status: number, body: Record<string, unknown>, retryAfterS?: number) => {
    if (retryAfterS) res.setHeader('Retry-After', String(retryAfterS));
    res.status(status).json(body);
  };
  const middleware: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
    const path = req.baseUrl + req.path;
    const lengthHeader = req.headers['content-length'];
    const length = lengthHeader !== undefined ? Number(lengthHeader) : null;
    const chunked = length === null && req.headers['transfer-encoding'] !== undefined;
    const hasBody = chunked || (length !== null && length > 0);
    const renderRoute = RENDER_ROUTE.test(path);
    if (!hasBody && !renderRoute) return next();

    const limit = bodyLimitFor(path, opts.limits);
    if (length !== null && length > limit) {
      stats.rejectedTooLarge++;
      return refuse(res, 413, { error: `Request body too large (max ${Math.round(limit / 1024)} KB for this endpoint).`, code: 'payload_too_large', limitBytes: limit });
    }
    const large = chunked || (length !== null && length > opts.largeBodyBytes);
    if ((large || renderRoute) && opts.memory.pressured) {
      stats.rejectedMemory++;
      return refuse(res, 503, { error: 'The server is under memory pressure. Please retry shortly.', code: 'memory_pressure' }, 5);
    }
    if (!large) return next();
    if (stats.largeBodiesInFlight >= opts.concurrency) {
      stats.rejectedBusy++;
      return refuse(res, 503, { error: 'The server is busy with other uploads. Please retry shortly.', code: 'busy' }, 2);
    }
    stats.largeBodiesInFlight++;
    stats.largeBodiesAdmitted++;
    stats.largeBodiesInFlightMax = Math.max(stats.largeBodiesInFlightMax, stats.largeBodiesInFlight);
    let released = false;
    const release = () => {
      if (!released) {
        released = true;
        stats.largeBodiesInFlight--;
      }
    };
    res.on('finish', release);
    res.on('close', release);
    next();
  };
  return { middleware, stats };
}

/** One JSON parser per distinct limit, chosen per route. */
export function createRouteJsonParser(limits: BodyLimits, makeParser: (limitBytes: number) => RequestHandler): RequestHandler {
  const parsers = new Map<number, RequestHandler>();
  return (req, res, next) => {
    const limit = bodyLimitFor(req.baseUrl + req.path, limits);
    let p = parsers.get(limit);
    if (!p) parsers.set(limit, (p = makeParser(limit)));
    return p(req, res, next);
  };
}
