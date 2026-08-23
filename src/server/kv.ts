/**
 * In-memory key-value cache for fast lookups.
 *
 * Pure `Map`-based implementation with:
 *   - LRU eviction (oldest entry evicted when `maxSize` is reached)
 *   - Optional TTL (time-to-live) per entry in milliseconds
 *
 * No persistence — this is RAM-only.  Use {@link Database} for
 * durable storage.  The KV cache is typically used as a hot layer
 * in front of the database (e.g. for bash-command pattern matching).
 */

interface CacheEntry<V> {
    value: V;
    ttl: number | null; // ms, or null for no expiry
    createdAt: number;
}

export class KVCache<V = string> {
    private readonly store: Map<string, CacheEntry<V>> = new Map();
    private readonly maxSize: number;

    constructor(maxSize = 1000) {
        this.maxSize = maxSize;
    }

    /**
     * Retrieve a value by key.  Returns `null` if the key is missing
     * or the entry has expired (expired entries are evicted on access).
     */
    get(key: string): V | null {
        const entry = this.store.get(key);
        if (!entry) return null;

        if (entry.ttl !== null) {
            const age = Date.now() - entry.createdAt;
            if (age > entry.ttl) {
                this.store.delete(key);
                return null;
            }
        }

        // Move to end (most-recently-used) for LRU.
        this.store.delete(key);
        this.store.set(key, entry);
        return entry.value;
    }

    /**
     * Store a value with an optional TTL.  If the cache is at capacity,
     * the oldest entry is evicted first.
     */
    set(key: string, value: V, ttl?: number): void {
        if (this.store.size >= this.maxSize && !this.store.has(key)) {
            const oldest = this.store.keys().next();
            if (!oldest.done && oldest.value !== undefined) {
                this.store.delete(oldest.value);
            }
        }

        this.store.set(key, {
            value,
            ttl: ttl ?? null,
            createdAt: Date.now(),
        });
    }

    /** Remove a single entry. */
    delete(key: string): void {
        this.store.delete(key);
    }

    /** Remove all entries. */
    clear(): void {
        this.store.clear();
    }

    /** Current number of entries. */
    get size(): number {
        return this.store.size;
    }

    /** Check whether a key exists and is not expired. */
    has(key: string): boolean {
        return this.get(key) !== null;
    }

    /**
     * Iterate over all non-expired entries.  Expired entries are
     * silently skipped (but not evicted — call `get()` to evict).
     */
    *entries(): IterableIterator<[string, V]> {
        const now = Date.now();
        for (const [key, entry] of this.store) {
            if (entry.ttl !== null && now - entry.createdAt > entry.ttl) continue;
            yield [key, entry.value];
        }
    }
}

// ---------------------------------------------------------------------------
// Singletons
// ---------------------------------------------------------------------------

/** General-purpose string-valued cache. */
export const kvCache = new KVCache<string>();

/**
 * Generic cache for arbitrary values (e.g. BashCommandPattern objects).
 * Use this when you need to store non-string values.
 */
export const objectCache = new KVCache<unknown>();

export default kvCache;
