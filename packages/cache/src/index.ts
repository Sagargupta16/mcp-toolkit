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
// Caller identity extraction
// ---------------------------------------------------------------------------

/**
 * Pull the authenticated caller's subject out of the per-request `extra` object.
 *
 * When `withAuth` is composed it attaches an `AuthContext` at `extra.auth` whose
 * `payload.sub` is the caller identity. Returns `undefined` when no identity is
 * present so the cache key stays unchanged for unauthenticated setups.
 */
function extractSubject(extra: Record<string, unknown>): string | undefined {
  const auth = extra["auth"];
  if (!auth || typeof auth !== "object") return undefined;

  const payload = (auth as Record<string, unknown>)["payload"];
  if (!payload || typeof payload !== "object") return undefined;

  const sub = (payload as Record<string, unknown>)["sub"];
  return typeof sub === "string" ? sub : undefined;
}

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

  // Both `"lru"` and `"ttl"` are served by one LRU-with-TTL cache: entries leave
  // when they exceed `ttl` OR when `maxSize` is reached, whichever comes first.
  // The strategy field does not currently change eviction behaviour.
  const cache = new LRUCache<unknown>(maxSize, ttl);

  // Expose cache instance on the server for inspection / manual invalidation
  (server as unknown as Record<string, unknown>)["__cache"] = cache;

  patchToolRegistrars(server, (originalHandler, toolName) => {
    return async function cachedHandler(...handlerArgs: unknown[]) {
      // Params only exist when the tool declared an input schema; otherwise the
      // SDK passes the `extra` object alone. Keying off that object would mix
      // per-request internals such as `requestId` into the key, so a schema-less
      // tool could never hit its own cache entry.
      const { params, extra } = splitHandlerArgs(handlerArgs);
      let cacheKey = keyGen(toolName, params);

      // Scope the cache entry to the authenticated caller when identity is
      // available. `withAuth` attaches an AuthContext at `extra.auth` (the
      // last handler argument), where `payload.sub` is the caller's id.
      // Without this, identity-dependent responses would leak across users
      // when withCache is composed with withAuth. When no identity is present
      // (auth not composed / unauthenticated), the key is unchanged, so
      // behaviour is identical to before.
      const subject = extractSubject(extra);
      if (subject !== undefined) {
        cacheKey = `sub:${subject}|${cacheKey}`;
      }

      const cached = cache.get(cacheKey);
      if (cached !== undefined) {
        return cached;
      }

      const result = await originalHandler(...handlerArgs);
      cache.set(cacheKey, result);
      return result;
    };
  });

  return server;
}

/**
 * Retrieve the underlying LRU cache instance attached by `withCache`.
 * Useful for manual invalidation or gathering statistics.
 */
export function getCache<T = unknown>(server: McpServerLike): LRUCache<T> | undefined {
  return (server as unknown as Record<string, unknown>)["__cache"] as LRUCache<T> | undefined;
}

// ---------------------------------------------------------------------------
// Minimal MCP server type + registration patching
//
// This block is deliberately identical in every @mcp-toolkit package so each
// one stays publishable on its own, with no internal dependency and without
// requiring the SDK at compile time. Keep the four copies in sync.
// ---------------------------------------------------------------------------

/** A tool handler as the SDK invokes it: `(params, extra)` or `(extra)`. */
type ToolHandler = (...args: unknown[]) => unknown;

/** The parsed params and the per-request `extra` object of one handler call. */
interface HandlerCall {
  params: Record<string, unknown>;
  extra: Record<string, unknown>;
}

/**
 * Split the arguments the SDK passed to a tool handler.
 *
 * The arity depends on whether the tool declared an input schema: the SDK calls
 * `handler(params, extra)` when it did and `handler(extra)` when it did not, so
 * `extra` is always the LAST argument and params only exist from arity two up.
 * Reading `extra` only when more than one argument arrived made every
 * schema-less tool invisible to the credential and header lookups above.
 */
function splitHandlerArgs(handlerArgs: unknown[]): HandlerCall {
  const last = handlerArgs[handlerArgs.length - 1];
  const first = handlerArgs.length > 1 ? handlerArgs[0] : undefined;
  return {
    params: (first && typeof first === "object" ? first : {}) as Record<string, unknown>,
    extra: (last && typeof last === "object" ? last : {}) as Record<string, unknown>,
  };
}

/**
 * Minimal shape of an MCP server that `withCache` can wrap.
 *
 * The parameters are typed `any` on purpose. The SDK declares `tool()` as a set
 * of overloads starting with `tool(name: string, ...)`, and because function
 * parameters are contravariant, a narrower signature such as
 * `(...args: unknown[]) => unknown` makes a real `McpServer` *unassignable* to
 * this interface -- callers would need an `as any` cast to use the middleware
 * from strict TypeScript.
 */
export interface McpServerLike {
  /** Deprecated SDK entry point (`tool(name, ...rest, handler)`), still supported. */
  tool: (...args: any[]) => any;
  /** Current SDK entry point (`registerTool(name, config, handler)`). */
  registerTool?: (...args: any[]) => any;
}

/**
 * Wrap the handler of every tool registration call made on `server`.
 *
 * Both `tool(name, ...rest, handler)` and `registerTool(name, config, handler)`
 * take the handler as their last argument, so a single wrapper covers both.
 * Patching `registerTool` as well as `tool` matters: without it, tools
 * registered through the current SDK API bypass the middleware silently.
 *
 * @param server - The server to patch.
 * @param wrap - Receives the original handler and the tool name, and returns
 *   the handler to register in its place.
 */
function patchToolRegistrars(
  server: McpServerLike,
  wrap: (handler: ToolHandler, toolName: string) => ToolHandler,
): void {
  const target = server as unknown as Record<string, unknown>;

  for (const method of ["tool", "registerTool"] as const) {
    const original = target[method];
    if (typeof original !== "function") continue;

    const bound = (original as ToolHandler).bind(server);

    target[method] = function patched(...args: unknown[]): unknown {
      const handlerIndex = args.length - 1;
      if (handlerIndex < 0 || typeof args[handlerIndex] !== "function") {
        // Not a call we recognise (e.g. a partial registration) -- forward it.
        return bound(...args);
      }

      const toolName = (args.find((a) => typeof a === "string") as string | undefined) ?? "unknown";
      args[handlerIndex] = wrap(args[handlerIndex] as ToolHandler, toolName);
      const registered = bound(...args);
      guardRegisteredHandler(registered, wrap, toolName);
      return registered;
    };
  }
}

/**
 * Keep the middleware in place when a handler is replaced after registration.
 *
 * `registerTool` returns a `RegisteredTool`, and its `update({ callback })`
 * assigns straight to `registeredTool.handler`. Without this guard that call --
 * or a direct `registered.handler = fn` -- installs an unwrapped handler and
 * drops the middleware silently, the same bypass as an unpatched `registerTool`.
 *
 * A wrapping accessor covers both routes. It delegates to whatever accessor
 * another `withX` already installed, so composed middleware keeps its order.
 */
function guardRegisteredHandler(
  registered: unknown,
  wrap: (handler: ToolHandler, toolName: string) => ToolHandler,
  toolName: string,
): void {
  if (!registered || typeof registered !== "object") return;

  const target = registered as Record<string, unknown>;
  const existing = Object.getOwnPropertyDescriptor(target, "handler");
  if (!existing || existing.configurable === false) return;

  let own = existing.get ? undefined : existing.value;

  Object.defineProperty(target, "handler", {
    configurable: true,
    enumerable: existing.enumerable !== false,
    get: () => (existing.get ? existing.get.call(target) : own),
    set: (next: unknown) => {
      const wrapped = typeof next === "function" ? wrap(next as ToolHandler, toolName) : next;
      if (existing.set) existing.set.call(target, wrapped);
      else own = wrapped;
    },
  });
}
