// PostgreSQL connection pool + transaction helper (ADR-001).
import pg from 'pg';

export type Db = pg.Pool;
export type Tx = pg.PoolClient;

export class DatabaseUnavailableError extends Error {
  readonly code = 'database_unavailable';
  constructor(message: string) {
    super(message);
    this.name = 'DatabaseUnavailableError';
  }
}

// SQLSTATE classes that mean "the database is not reachable / not usable right now" (not a bug in the query).
const UNAVAILABLE_CODES = new Set(['57P01', '57P02', '57P03', '08000', '08001', '08003', '08004', '08006', '53300']);
export function isUnavailable(err: any): boolean {
  if (!err) return false;
  if (err instanceof DatabaseUnavailableError) return true;
  if (UNAVAILABLE_CODES.has(err.code)) return true;
  if (['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EHOSTUNREACH'].includes(err.code)) return true;
  return /Connection terminated|connection timeout|timeout exceeded when trying to connect|Client has encountered a connection error/i.test(String(err.message || ''));
}

export function createPool(connectionString: string, opts: { max?: number; applicationName?: string } = {}): Db {
  const { url, ssl } = tlsConfig(connectionString);
  const pool = new pg.Pool({
    connectionString: url,
    ssl,
    max: opts.max ?? Number(process.env.DATABASE_POOL_MAX || 10),
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: Number(process.env.DATABASE_CONNECT_TIMEOUT_MS || 5000),
    // Bound every statement so a stuck query cannot hold a request (and a pool slot) forever.
    statement_timeout: Number(process.env.DATABASE_STATEMENT_TIMEOUT_MS || 10000),
    query_timeout: Number(process.env.DATABASE_STATEMENT_TIMEOUT_MS || 10000) + 2000,
    application_name: opts.applicationName || 'forge-studio',
  });
  // An idle client losing its connection (DB restart/failover) must not crash the process.
  pool.on('error', (err) => {
    console.error(JSON.stringify({ level: 'error', event: 'db_pool_idle_client_error', error: String(err?.message || err) }));
  });
  return pool;
}

/**
 * TLS policy (ADR-001). sslmode comes from the URL or DATABASE_SSLMODE:
 *   disable -> plain TCP (local/test only); unset -> TLS in production, plain elsewhere;
 *   anything else -> TLS with certificate verification (set DATABASE_SSL_REJECT_UNAUTHORIZED=false only for
 *   providers whose CA you cannot install). sslmode is removed from the URL so node-postgres cannot reinterpret it.
 */
export function tlsConfig(connectionString: string): { url: string; ssl: pg.PoolConfig['ssl'] } {
  const u = new URL(connectionString);
  const mode = (u.searchParams.get('sslmode') || process.env.DATABASE_SSLMODE || '').toLowerCase();
  u.searchParams.delete('sslmode');
  const verify = process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== 'false';
  if (mode === 'disable') return { url: u.toString(), ssl: false };
  if (mode === '' && process.env.NODE_ENV !== 'production') return { url: u.toString(), ssl: false };
  return { url: u.toString(), ssl: { rejectUnauthorized: verify } };
}

/**
 * Checks out a client for exclusive use. node-postgres emits 'error' on a CHECKED-OUT client whose connection
 * dies (database restart, failover, network cut); without a listener that is an uncaught exception that kills
 * the process (verified). The listener records the error, and release() then destroys the broken client instead
 * of returning it to the pool.
 */
export async function checkout(db: Db): Promise<{ client: Tx; release: () => void; broken: () => Error | null }> {
  let client: Tx;
  try {
    client = await db.connect();
  } catch (err: any) {
    throw new DatabaseUnavailableError(`cannot connect to database: ${err?.message || err}`);
  }
  let brokenErr: Error | null = null;
  const onError = (err: Error) => {
    brokenErr = err;
    console.error(JSON.stringify({ level: 'error', event: 'db_client_connection_lost', error: String(err?.message || err).slice(0, 200) }));
  };
  client.on('error', onError);
  return {
    client,
    broken: () => brokenErr,
    release: () => {
      client.off('error', onError);
      client.release(brokenErr ?? undefined);
    },
  };
}

/** SQLSTATEs where the whole transaction was rolled back by the server and may safely be re-run. */
export const RETRYABLE_SQLSTATES = new Set(['40P01', '40001']); // deadlock_detected, serialization_failure
export const isRetryableTxError = (err: any) => RETRYABLE_SQLSTATES.has(err?.code);

/**
 * Runs fn inside a transaction (READ COMMITTED); rolls back on any error. Deadlock/serialization failures are
 * retried (default 3 attempts, jittered backoff). This is safe because PostgreSQL rolled the whole transaction
 * back and every fn in this codebase is pure database work (no external side effects), so a retry starts from
 * a clean state and cannot double-apply. Lock ordering (ADR-003) is the primary defence; this is the backstop.
 */
export async function withTx<T>(db: Db, fn: (tx: Tx) => Promise<T>, opts: { attempts?: number } = {}): Promise<T> {
  const attempts = Math.max(1, opts.attempts ?? 3);
  for (let attempt = 1; ; attempt++) {
    const { client, release, broken } = await checkout(db);
    try {
      await client.query('BEGIN');
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (err) {
      if (!broken()) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // connection already broken; the error below is what matters
        }
      }
      if (isRetryableTxError(err) && attempt < attempts && !broken()) {
        txRetryCount++;
        console.warn(JSON.stringify({ level: 'warn', event: 'db_tx_retry', code: (err as any).code, attempt }));
        await new Promise((r) => setTimeout(r, 5 * 2 ** attempt + Math.floor(Math.random() * 20)));
        continue;
      }
      throw err;
    } finally {
      release();
    }
  }
}

/** Number of transaction retries since start (exposed in detailed health; should stay ~0 after R-02). */
export let txRetryCount = 0;

/** Stable 64-bit advisory-lock keys (distributed locks across instances). */
export const LOCKS = {
  migrations: 7_311_000_001,
  dataMigration: 7_311_000_002,
  jobReaper: 7_311_000_003,
  maintenance: 7_311_000_004,
  /** Track B: serializes job admission so the global queue cap is exact across instances. */
  jobAdmission: 7_311_000_005,
} as const;
