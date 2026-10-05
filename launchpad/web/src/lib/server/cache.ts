// Tiny in-memory TTL cache for server code. Concurrent callers share one in-flight load.
// When a load fails, callers keep getting the last good value (or the error, if there
// is none yet) and the load isn't retried for min(ttl, 30s), so a failing upstream
// isn't hammered. The store lives on globalThis so every route bundle and dev hot
// reload shares it.

type Entry = {
  value?: unknown;
  ok: boolean; // `value` holds a successful result
  error?: unknown; // the last failure, while there's no good value
  expires: number; // fresh until, or after a failure: no retry before
  pending?: Promise<unknown>;
};

const RETRY_MS = 30_000;
const MAX_ENTRIES = 10_000;

const g = globalThis as typeof globalThis & { __gramfunCache?: Map<string, Entry> };
const store = (g.__gramfunCache ??= new Map<string, Entry>());

export function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const entry = store.get(key);
  if (entry?.pending) return entry.pending as Promise<T>;
  if (entry && Date.now() < entry.expires) {
    return entry.ok ? Promise.resolve(entry.value as T) : Promise.reject(entry.error);
  }
  if (!entry && store.size >= MAX_ENTRIES) {
    const oldest = store.keys().next().value;
    if (oldest !== undefined) store.delete(oldest);
  }

  const load = Promise.resolve()
    .then(fn)
    .then(
      (value) => {
        store.set(key, { value, ok: true, expires: Date.now() + ttlMs });
        return value;
      },
      (error: unknown) => {
        const retryAt = Date.now() + Math.min(ttlMs, RETRY_MS);
        if (!entry?.ok) {
          store.set(key, { ok: false, error, expires: retryAt });
          throw error;
        }
        console.warn(`cache: refreshing ${key} failed, serving the last good value:`, error instanceof Error ? error.message : error);
        store.set(key, { value: entry.value, ok: true, expires: retryAt });
        return entry.value as T;
      },
    );
  store.set(key, { ...(entry ?? { ok: false, expires: 0 }), pending: load });
  return load;
}

// The last good value for `key`, even if it has expired.
export function peek<T>(key: string): T | undefined {
  const entry = store.get(key);
  return entry?.ok ? (entry.value as T) : undefined;
}
