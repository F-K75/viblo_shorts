/**
 * Classified failure taxonomy for the Forge Media Engine.
 * Matches Section 9 ("Failure handling") of the FFmpeg Media Production specification.
 */

export const MEDIA_FAILURE_CODES = [
  'ASSET_ERROR',
  'PROBE_ERROR',
  'TIMELINE_ERROR',
  'UNSUPPORTED_CODEC',
  'FILTER_ERROR',
  'RENDER_TIMEOUT',
  'RESOURCE_LIMIT',
  'OUTPUT_CORRUPTION',
  'QUALITY_FAILURE',
  'STORAGE_ERROR',
] as const;

export type MediaFailureCode = (typeof MEDIA_FAILURE_CODES)[number];

const RECOVERABLE_BY_CODE: Record<MediaFailureCode, boolean> = {
  ASSET_ERROR: false,
  PROBE_ERROR: false,
  TIMELINE_ERROR: false,
  UNSUPPORTED_CODEC: false,
  FILTER_ERROR: false,
  RENDER_TIMEOUT: true,
  RESOURCE_LIMIT: true,
  OUTPUT_CORRUPTION: true,
  QUALITY_FAILURE: true,
  STORAGE_ERROR: true,
};

const HTTP_STATUS_BY_CODE: Record<MediaFailureCode, number> = {
  ASSET_ERROR: 400,
  PROBE_ERROR: 422,
  TIMELINE_ERROR: 400,
  UNSUPPORTED_CODEC: 422,
  FILTER_ERROR: 400,
  RENDER_TIMEOUT: 504,
  RESOURCE_LIMIT: 429,
  OUTPUT_CORRUPTION: 500,
  QUALITY_FAILURE: 422,
  STORAGE_ERROR: 503,
};

export interface MediaErrorOptions {
  recoverable?: boolean;
  httpStatus?: number;
  details?: Record<string, unknown>;
  cause?: unknown;
}

export class MediaEngineError extends Error {
  readonly code: MediaFailureCode;
  readonly recoverable: boolean;
  readonly httpStatus: number;
  readonly details?: Record<string, unknown>;

  constructor(code: MediaFailureCode, message: string, opts: MediaErrorOptions = {}) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'MediaEngineError';
    this.code = code;
    this.recoverable = opts.recoverable ?? RECOVERABLE_BY_CODE[code];
    this.httpStatus = opts.httpStatus ?? HTTP_STATUS_BY_CODE[code];
    this.details = opts.details;
  }

  toJSON() {
    return {
      error: this.message,
      code: this.code,
      recoverable: this.recoverable,
      ...(this.details ? { details: this.details } : {}),
    };
  }
}

export function classifyMediaError(err: unknown, fallbackCode: MediaFailureCode = 'STORAGE_ERROR'): MediaEngineError {
  if (err instanceof MediaEngineError) return err;
  const msg = err instanceof Error ? err.message : String(err ?? 'Unknown media engine error');
  if (/timed?\s*out/i.test(msg)) {
    return new MediaEngineError('RENDER_TIMEOUT', msg, { cause: err });
  }
  if (/quota|limit|exhausted|space|ENOSPC|EMFILE/i.test(msg)) {
    return new MediaEngineError('RESOURCE_LIMIT', msg, { cause: err });
  }
  if (/codec|pixel format|pix_fmt/i.test(msg)) {
    return new MediaEngineError('UNSUPPORTED_CODEC', msg, { cause: err });
  }
  if (/filter|filtergraph/i.test(msg)) {
    return new MediaEngineError('FILTER_ERROR', msg, { cause: err });
  }
  if (/moov atom|Invalid data found|corrupt|truncated/i.test(msg)) {
    return new MediaEngineError('PROBE_ERROR', msg, { cause: err });
  }
  return new MediaEngineError(fallbackCode, msg, { cause: err });
}
