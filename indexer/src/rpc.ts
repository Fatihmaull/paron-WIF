/**
 * RPC resilience helpers (carried over and hardened from the legacy indexer):
 *  - exponential backoff with full jitter for transient errors (429, 5xx, timeouts, resets);
 *  - adaptive block-range splitting for providers that cap eth_getLogs ranges or result sizes.
 */
export type RetryOptions = { retries?: number; baseMs?: number; maxMs?: number; sleep?: (ms: number) => Promise<void>; random?: () => number };

const TRANSIENT = /(429|rate limit|too many requests|timeout|timed out|ECONNRESET|ECONNREFUSED|ETIMEDOUT|socket hang up|502|503|504|fetch failed|network)/i;
const RANGE = /(block range|range too large|exceed|too many results|limit exceeded|query returned more than|response size|-32005|-32602|max.*blocks)/i;

export function errorText(error: unknown): string {
  const parts: string[] = [];
  let v: unknown = error;
  for (let depth = 0; depth < 6 && v && typeof v === "object"; depth += 1) {
    const o = v as { shortMessage?: unknown; message?: unknown; details?: unknown; code?: unknown; cause?: unknown };
    for (const k of ["shortMessage", "message", "details"] as const) if (typeof o[k] === "string") parts.push(o[k] as string);
    if (typeof o.code === "number" || typeof o.code === "string") parts.push(String(o.code));
    v = o.cause;
  }
  if (typeof error === "string") parts.push(error);
  return parts.join(" | ");
}

export function isTransient(error: unknown): boolean {
  return TRANSIENT.test(errorText(error));
}

export function isRangeError(error: unknown): boolean {
  return RANGE.test(errorText(error));
}

export function backoffMs(attempt: number, baseMs = 250, maxMs = 8_000, random: () => number = Math.random): number {
  const cap = Math.min(maxMs, baseMs * 2 ** attempt);
  return Math.floor(random() * cap);
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const retries = opts.retries ?? 5;
  const sleep = opts.sleep ?? defaultSleep;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= retries || !isTransient(error)) throw error;
      await sleep(backoffMs(attempt, opts.baseMs, opts.maxMs, opts.random));
    }
  }
}

/**
 * Fetches [from, to] in chunks of `span` blocks, halving a chunk whenever the provider rejects it
 * as too large, down to single blocks.
 */
export async function getLogsAdaptive<T>(
  from: bigint,
  to: bigint,
  fetchRange: (from: bigint, to: bigint) => Promise<T[]>,
  span = 2_000n,
  opts: RetryOptions = {},
): Promise<T[]> {
  const out: T[] = [];
  let cursor = from;
  let size = span;
  while (cursor <= to) {
    const end = cursor + size - 1n > to ? to : cursor + size - 1n;
    try {
      out.push(...(await withRetry(() => fetchRange(cursor, end), opts)));
      cursor = end + 1n;
      if (size < span) size *= 2n;
    } catch (error) {
      if (isRangeError(error) && size > 1n) {
        size = size / 2n;
        continue;
      }
      throw error;
    }
  }
  return out;
}
