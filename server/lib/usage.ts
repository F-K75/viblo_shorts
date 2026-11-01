// Persistent daily AI-usage ledger with reserve / commit / refund semantics.
//
// FS-007: quota used to be (a) charged before the call even when a template fallback was served and
// (b) held only in memory, so every restart reset it. Now:
//  * reserve() is a synchronous check-and-increment, so concurrent requests in this process can never
//    exceed the limit (no await between check and increment);
//  * a reservation is refunded unless the handler marks the call as a real model success;
//  * counts are persisted to usage.json (debounced, flushed on shutdown) and reloaded at boot.
// A corrupt usage.json is never overwritten: the ledger fails closed (AI endpoints answer 503).
// Single-process only; Redis/PostgreSQL replaces this in Phase 2.
import { readJsonFile, writeJsonFileAtomic, StoreUnavailableError } from './storage.ts';

interface UsageFile {
  v: 1;
  day: number;
  counts: Record<string, number>;
}

export const utcDay = (now = Date.now()) => Math.floor(now / 86400000);

export class UsageLedger {
  private day = utcDay();
  private counts = new Map<string, number>();
  private dirty = false;
  private timer: NodeJS.Timeout | null = null;
  private unavailableReason: string | null = null;

  constructor(
    private readonly file: string,
    private readonly flushDelayMs = 1000,
  ) {
    try {
      const data = readJsonFile<UsageFile | null>(file, null);
      if (data && data.day === this.day && data.counts && typeof data.counts === 'object') {
        for (const [k, v] of Object.entries(data.counts)) if (typeof v === 'number' && v > 0) this.counts.set(k, v);
      }
    } catch (err: any) {
      this.unavailableReason = String(err?.message || err);
    }
  }

  get available() {
    return this.unavailableReason === null;
  }
  get reason() {
    return this.unavailableReason;
  }

  private rollover() {
    const d = utcDay();
    if (d !== this.day) {
      this.day = d;
      this.counts.clear();
      this.markDirty();
    }
  }

  peek(key: string): number {
    this.rollover();
    return this.counts.get(key) || 0;
  }

  /**
   * Atomically reserves one unit on every key, or none. Returns the first key whose limit is reached.
   */
  reserve(entries: Array<{ key: string; limit: number }>): { ok: true } | { ok: false; key: string } {
    if (this.unavailableReason) throw new StoreUnavailableError(`Usage ledger unavailable: ${this.unavailableReason}`, this.file);
    this.rollover();
    for (const e of entries) if ((this.counts.get(e.key) || 0) >= e.limit) return { ok: false, key: e.key };
    for (const e of entries) this.counts.set(e.key, (this.counts.get(e.key) || 0) + 1);
    this.markDirty();
    return { ok: true };
  }

  refund(keys: string[], reservedDay: number) {
    if (reservedDay !== utcDay()) return; // reserved yesterday: today's counter was never charged
    for (const k of keys) {
      const v = (this.counts.get(k) || 0) - 1;
      if (v > 0) this.counts.set(k, v);
      else this.counts.delete(k);
    }
    this.markDirty();
  }

  private markDirty() {
    this.dirty = true;
    if (!this.timer && this.flushDelayMs > 0) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.flush();
      }, this.flushDelayMs);
      this.timer.unref();
    } else if (this.flushDelayMs <= 0) {
      this.flush();
    }
  }

  /** Writes the ledger now. Never writes over a file that failed to load. */
  flush() {
    if (!this.dirty || this.unavailableReason) return;
    try {
      writeJsonFileAtomic(this.file, { v: 1, day: this.day, counts: Object.fromEntries(this.counts) } satisfies UsageFile, 0);
      this.dirty = false;
    } catch (err: any) {
      console.error(JSON.stringify({ level: 'error', event: 'usage_flush_failed', error: String(err?.message || err) }));
    }
  }
}
