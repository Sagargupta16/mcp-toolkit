/**
 * @mcp-toolkit/cache
 *
 * Response caching middleware for MCP servers.
 * Supports LRU (Least Recently Used) and TTL (Time To Live) eviction strategies.
 */

// ---------------------------------------------------------------------------
// Types & Interfaces
// ---------------------------------------------------------------------------

/** A single entry stored in the cache. */
export interface CacheEntry<T = unknown> {
  /** The cached value. */
  value: T;
  /** Timestamp (ms) when this entry was created. */
  createdAt: number;
  /** Timestamp (ms) when this entry was last accessed. */
  lastAccessed: number;
  /** Number of times this entry has been accessed. */
  hits: number;
}

/** Statistics about cache usage. */
export interface CacheStats {
  /** Total number of entries currently in the cache. */
  size: number;
  /** Maximum number of entries the cache can hold. */
  maxSize: number;
  /** Number of cache hits since creation. */
  hits: number;
  /** Number of cache misses since creation. */
  misses: number;
  /** Hit rate as a number between 0 and 1. */
  hitRate: number;
}

/** Function used to derive a cache key from a tool name and its arguments. */
export type KeyGenerator = (toolName: string, args: Record<string, unknown>) => string;

// -- Strategy options -------------------------------------------------------

export interface LruCacheOptions {
  strategy: "lru";
  /**
   * Maximum number of entries to keep in the cache.
   * @default 1000
   */
  maxSize?: number;
  /**
   * Time-to-live in **seconds**.  Entries older than this are considered stale.
   * Set to `0` to disable TTL expiration (entries only leave via LRU eviction).
   * @default 300
   */
  ttl?: number;
  /**
   * Custom key generator function.
   * @default `(name, args) => \`${name}:${JSON.stringify(args)}\``
   */
  keyGenerator?: KeyGenerator;
}

export interface TtlCacheOptions {
  strategy: "ttl";
  /**
   * Time-to-live in **seconds**.
   * @default 300
   */
  ttl?: number;
  /**
   * Maximum number of entries.
   * @default 1000
   */
  maxSize?: number;
  /**
   * Custom key generator function.
   */
  keyGenerator?: KeyGenerator;
}

export type CacheOptions = LruCacheOptions | TtlCacheOptions;

// ---------------------------------------------------------------------------
// LRU Cache implementation
// ---------------------------------------------------------------------------

/**
 * A simple in-memory LRU cache backed by a `Map` (which preserves insertion order).
 *
 * Eviction policy:
 *  - When the cache is full the **least recently used** entry is removed.
 *  - Entries that exceed the configured TTL are lazily evicted on access.
 */
export class LRUCache<T = unknown> {
  private readonly map = new Map<string, CacheEntry<T>>();
  private readonly maxSize: number;
  private readonly ttlMs: number;
  private totalHits = 0;
  private totalMisses = 0;

  constructor(maxSize: number = 1000, ttlSeconds: number = 300) {
    if (maxSize < 1) throw new RangeError("maxSize must be >= 1");
    this.maxSize = maxSize;
    this.ttlMs = ttlSeconds * 1000;
  }

  /** Retrieve a value from the cache. Returns `undefined` on miss or stale entry. */
  get(key: string): T | undefined {
    const entry = this.map.get(key);
    if (!entry) {
      this.totalMisses++;
      return undefined;
    }

    // TTL check
    if (this.ttlMs > 0 && Date.now() - entry.createdAt > this.ttlMs) {
      this.map.delete(key);
      this.totalMisses++;
      return undefined;
    }

    // Move to end (most recently used) by re-inserting
    this.map.delete(key);
    entry.lastAccessed = Date.now();
    entry.hits++;
    this.map.set(key, entry);

    this.totalHits++;
    return entry.value;
  }

  /** Insert or update a value in the cache. */
  set(key: string, value: T): void {
    // If the key already exists, remove it first so re-insert goes to the end
    if (this.map.has(key)) {
      this.map.delete(key);
    }

    // Evict LRU entry if at capacity
    if (this.map.size >= this.maxSize) {
      const lruKey = this.map.keys().next().value;
      if (lruKey !== undefined) {
        this.map.delete(lruKey);
      }
    }

    const now = Date.now();
    this.map.set(key, {
      value,
      createdAt: now,
      lastAccessed: now,
      hits: 0,
    });
  }

  /** Check whether a non-stale entry exists for `key`. */
  has(key: string): boolean {
    const entry = this.map.get(key);
    if (!entry) return false;
    if (this.ttlMs > 0 && Date.now() - entry.createdAt > this.ttlMs) {
      this.map.delete(key);
      return false;
    }
    return true;
  }

  /** Remove a specific entry. Returns `true` if it existed. */
  delete(key: string): boolean {
    return this.map.delete(key);
  }

  /** Remove all entries from the cache. */
  clear(): void {
    this.map.clear();
    this.totalHits = 0;
    this.totalMisses = 0;
  }

  /** Return the current number of entries (including possibly stale ones). */
  get size(): number {
    return this.map.size;
  }

  /** Collect and return cache statistics. */
  stats(): CacheStats {
    const total = this.totalHits + this.totalMisses;
    return {
      size: this.map.size,
      maxSize: this.maxSize,
      hits: this.totalHits,
      misses: this.totalMisses,
      hitRate: total === 0 ? 0 : this.totalHits / total,
    };
  }

  /**
   * Remove all entries that have exceeded the TTL.
   * Call this periodically if you want eager eviction instead of lazy.
   */
  prune(): number {
    if (this.ttlMs <= 0) return 0;
    const now = Date.now();
    let pruned = 0;
    for (const [key, entry] of this.map) {
      if (now - entry.createdAt > this.ttlMs) {
        this.map.delete(key);
        pruned++;
      }
    }
    return pruned;
  }
}

// ---------------------------------------------------------------------------
// Default key generator
// ---------------------------------------------------------------------------

const defaultKeyGenerator: KeyGenerator = (toolName, args) => {
  const sortedArgs = Object.keys(args)
    .sort()
    .reduce<Record<string, unknown>>((acc, k) => {
      acc[k] = args[k];
      return acc;
    }, {});
  return `${toolName}:${JSON.stringify(sortedArgs)}`;
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Wraps an MCP server with response caching middleware.
 *
 * Subsequent calls to the same tool with the same arguments will return the
 * cached result instead of re-executing the handler, until the cache entry
 * expires or is evicted.
 *
 * @param server - An MCP server instance (from `@modelcontextprotocol/sdk`).
 * @param options - Caching strategy configuration.
 * @returns The same server instance (for chaining).
 *
 * @example
 * ```ts
 * import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
 * import { withCache } from "@mcp-toolkit/cache";
 *
 * const server = new McpServer({ name: "demo", version: "1.0.0" });
 *
 * withCache(server, {
 *   strategy: "lru",
 *   ttl: 300,
 *   maxSize: 500,
 * });
 * ```
 */
export function withCache<T extends McpServerLike>(server: T, options: CacheOptions): T {
  const maxSize = options.maxSize ?? 1000;
  const ttl = options.ttl ?? 300;
  const keyGen = options.keyGenerator ?? defaultKeyGenerator;

  // Both strategies use the same LRU cache under the hood. The only
  // difference is cosmetic / for future extension.
  const cache = new LRUCache<unknown>(maxSize, ttl);

  // Expose cache instance on the server for inspection / manual invalidation
  (server as Record<string, unknown>)["__cache"] = cache;

  const originalTool = server.tool.bind(server);

  const wrappedTool = function toolWithCache(...args: unknown[]): unknown {
    // The handler is the last argument
    const handlerIndex = args.findIndex(
      (a, i) => typeof a === "function" && i === args.length - 1,
    );

    if (handlerIndex === -1) {
      return (originalTool as (...a: unknown[]) => unknown)(...args);
    }

    // Derive the tool name.  It is the first string argument.
    const toolName = args.find((a) => typeof a === "string") as string | undefined;

    const originalHandler = args[handlerIndex] as (...a: unknown[]) => unknown;

    args[handlerIndex] = async function cachedHandler(...handlerArgs: unknown[]) {
      // First positional arg to the handler is the parsed params object
      const params = (handlerArgs[0] ?? {}) as Record<string, unknown>;
      const cacheKey = keyGen(toolName ?? "unknown", params);

      const cached = cache.get(cacheKey);
      if (cached !== undefined) {
        return cached;
      }

      const result = await originalHandler(...handlerArgs);
      cache.set(cacheKey, result);
      return result;
    };

    return (originalTool as (...a: unknown[]) => unknown)(...args);
  };

  server.tool = wrappedTool as typeof server.tool;

  return server;
}

/**
 * Retrieve the underlying LRU cache instance attached by `withCache`.
 * Useful for manual invalidation or gathering statistics.
 */
export function getCache<T = unknown>(server: McpServerLike): LRUCache<T> | undefined {
  return (server as Record<string, unknown>)["__cache"] as LRUCache<T> | undefined;
}

// ---------------------------------------------------------------------------
// Minimal type for the MCP server
// ---------------------------------------------------------------------------

/** Minimal shape of an MCP server that `withCache` can wrap. */
export interface McpServerLike {
  tool: (...args: unknown[]) => unknown;
  [key: string]: unknown;
}
