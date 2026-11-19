import type { Check, DimensionKey, Severity } from './models.ts';

/** Small helper so every check is built the same way (and always carries evidence). */
export function check(
  dimension: DimensionKey,
  id: string,
  passed: boolean,
  severity: Severity,
  message: string,
  evidence: Record<string, unknown>,
  suggestion?: string,
): Check {
  return { id, dimension, passed, severity, message, evidence, suggestion: passed ? undefined : suggestion, measured: true };
}

export function unmeasured(dimension: DimensionKey, id: string, message: string, evidence: Record<string, unknown> = {}): Check {
  return { id, dimension, passed: true, severity: 'info', message, evidence, measured: false };
}

export const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
