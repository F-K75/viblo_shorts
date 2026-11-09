// Persistent daily AI-usage ledger (JSON backend, single instance) with the same reservation semantics as the
// PostgreSQL backend (R-02):
//  * reserve(entries, id) is a synchronous all-or-nothing check-and-increment, so concurrent requests in this
//    process cannot exceed a limit (no await between check and increment). Idempotent per id.
//  * settle(id, 'usage' | 'commit' | 'refund') happens exactly once; a repeated settle is a no-op (no double refund).
//  * beginAttempt(id) / endAttempt(id, result) record every provider attempt (review R2); beginAttempt is written to
//    disk synchronously before the provider is called (review R1). 'usage' charges iff an attempt was billable,
//    uncertain or is still open (or the reservation was started by the previous release); otherwise it refunds.
//  * open reservations are persisted, and expire() settles those never settled (crash, failed settle) by usage.
// Counts and open reservations are flushed to usage.json (debounced, and on shutdown) and reloaded at boot.
// A corrupt usage.json is never overwritten: the ledger fails closed (AI endpoints answer 503).
import { readJsonFile, writeJsonFileAtomic, StoreUnavailableError } from './storage.ts';

interface OpenReservation {
  keys: string[];
  day: number;
  at: number;
  /** F10: when the first provider attempt began (persisted, so crash recovery knows a call may have run). */
  started?: number;
  /** Review R2: provider attempts (absent on reservations written by the previous release). */
  attempts?: { total: number; open: number; billable: number; uncertain: number; tokens: number };
}
interface UsageFile {
  v: 1 | 2;
  day: number;
  counts: Record<string, number>;
  reservations?: Record<string, OpenReservation>;
}

export const utcDay = (now = Date.now()) => Math.floor(now / 86400000);

export class UsageLedger {
  private day = utcDay();
  private counts = new Map<string, number>();
  private open = new Map<string, OpenReservation>();
  private settled = new Set<string>(); // ids settled in this process (idempotency for late duplicates)
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
      for (const [id, r] of Object.entries(data?.reservations || {})) {
        if (r && Array.isArray(r.keys) && typeof r.day === 'number') this.open.set(id, r);
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

  private assertAvailable() {
    if (this.unavailableReason) throw new StoreUnavailableError(`Usage ledger unavailable: ${this.unavailableReason}`, this.file);
  }

  peek(key: string): number {
    this.rollover();
    return this.counts.get(key) || 0;
  }

  /** Atomically reserves one unit on every key, or none. Returns the first key whose limit is reached. */
  reserve(entries: Array<{ key: string; limit: number }>, id: string): { ok: true } | { ok: false; key: string } {
    this.assertAvailable();
    this.rollover();
    if (this.open.has(id) || this.settled.has(id)) return { ok: true }; // retried reserve: already applied
    for (const e of entries) if ((this.counts.get(e.key) || 0) >= e.limit) return { ok: false, key: e.key };
    for (const e of entries) this.counts.set(e.key, (this.counts.get(e.key) || 0) + 1);
    this.open.set(id, { keys: entries.map((e) => e.key), day: this.day, at: Date.now() });
    this.markDirty();
    return { ok: true };
  }

  /**
   * Review R1/R2: records that a provider attempt begins, only while the reservation is open. Written to disk NOW,
   * before the caller invokes the provider: with the debounced flush a crash in the next second lost the start and
   * recovery refunded a call that may have run. If the write fails, the attempt is undone and refused (no provider
   * call without a durable record).
   */
  beginAttempt(id: string): boolean {
    this.assertAvailable();
    const r = this.open.get(id);
    if (!r) return false;
    const prev = { started: r.started, attempts: r.attempts ? { ...r.attempts } : undefined };
    r.started ??= Date.now();
    const a = (r.attempts ??= { total: 0, open: 0, billable: 0, uncertain: 0, tokens: 0 });
    a.total++;
    a.open++;
    this.dirty = true;
    try {
      this.writeNow();
    } catch (err: any) {
      if (prev.started === undefined) delete r.started;
      if (prev.attempts) r.attempts = prev.attempts;
      else delete r.attempts;
      console.error(JSON.stringify({ level: 'error', event: 'usage_attempt_not_persisted', error: String(err?.message || err) }));
      return false;
    }
    return true;
  }

  /** Review R2: the outcome of an attempt. Accounting only; a settled reservation is already decided (no-op). */
  endAttempt(id: string, result: { billable: 'yes' | 'no' | 'uncertain'; tokens: number }) {
    const a = this.open.get(id)?.attempts;
    if (!a) return;
    a.open = Math.max(0, a.open - 1);
    if (result.billable === 'yes') {
      a.billable++;
      a.tokens += Math.max(0, Math.floor(result.tokens) || 0);
    } else if (result.billable === 'uncertain') a.uncertain++;
    this.markDirty();
  }

  /**
   * Settles a reservation exactly once. Unknown or already-settled ids are a no-op. 'usage' (review R2): charged iff an
   * attempt was billable, uncertain or is still open, or the reservation was started without attempt records (the
   * previous release); otherwise refunded.
   */
  settle(id: string, outcome: 'commit' | 'refund' | 'usage'): 'settled' | 'already_settled' {
    this.assertAvailable();
    const r = this.open.get(id);
    if (!r) return 'already_settled';
    this.open.delete(id);
    this.settled.add(id);
    if (this.settled.size > 50000) this.settled.clear(); // bounded; ids are random, re-use is not expected
    const a = r.attempts;
    const chargedByUsage = a ? a.billable > 0 || a.uncertain > 0 || a.open > 0 : r.started !== undefined;
    const refund = outcome === 'refund' || (outcome === 'usage' && !chargedByUsage);
    if (refund && r.day === utcDay()) {
      // a reservation from a previous day was never counted in today's totals
      for (const k of r.keys) {
        const v = (this.counts.get(k) || 0) - 1;
        if (v > 0) this.counts.set(k, v);
        else this.counts.delete(k);
      }
    }
    this.markDirty();
    return 'settled';
  }

  /** Settles reservations left open longer than ttlMs by usage (review R2). */
  expire(ttlMs: number): number {
    if (this.unavailableReason) return 0;
    const cutoff = Date.now() - ttlMs;
    let n = 0;
    for (const [id, r] of [...this.open]) {
      if (r.at < cutoff) {
        this.settle(id, 'usage');
        n++;
      }
    }
    return n;
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

  /** Writes the whole ledger synchronously (atomic rename); throws on failure. */
  private writeNow() {
    writeJsonFileAtomic(
      this.file,
      { v: 2, day: this.day, counts: Object.fromEntries(this.counts), reservations: Object.fromEntries(this.open) } satisfies UsageFile,
      0,
    );
    this.dirty = false;
  }

  /** Writes the ledger now. Never writes over a file that failed to load. */
  flush() {
    if (!this.dirty || this.unavailableReason) return;
    try {
      this.writeNow();
    } catch (err: any) {
      console.error(JSON.stringify({ level: 'error', event: 'usage_flush_failed', error: String(err?.message || err) }));
    }
  }
}
