/**
 * @mcp-toolkit/rate-limit
 *
 * Rate limiting middleware for MCP servers.
 * Implements the Token Bucket algorithm.
 */

// ---------------------------------------------------------------------------
// Types & Interfaces
// ---------------------------------------------------------------------------

/** Information about the current rate limit state (returned on each request). */
export interface RateLimitInfo {
  /** Whether the request was allowed. */
  allowed: boolean;
  /** Number of tokens remaining in the bucket. */
  remaining: number;
  /** Maximum number of tokens the bucket can hold. */
  limit: number;
  /** Seconds until the next token is added. */
  retryAfter: number;
}

/** Callback invoked when a request is rate-limited. */
export type OnLimitedCallback = (info: RateLimitInfo & { toolName: string }) => void;

/**
 * Function that derives a bucket key from the SDK's per-request `extra` object
 * (for per-caller limiting).
 *
 * `extra.requestInfo.headers` holds the real HTTP headers on the Streamable HTTP
 * and SSE transports; `extra._meta` holds the request's `params._meta`;
 * `extra.sessionId` is set only by transports that have a session. Anything the
 * caller can choose is a bucket the caller can rotate, so prefer a value the
 * transport or `withAuth` established.
 */
export type BucketKeyExtractor = (extra: Record<string, unknown>) => string;

// -- Strategy options -------------------------------------------------------

export interface TokenBucketOptions {
  strategy: "token-bucket";
  /**
   * Maximum number of tokens the bucket can hold.
   * @default 100
   */
  maxTokens?: number;
  /**
   * Number of tokens added per second.
   * @default 10
   */
  refillRate?: number;
  /**
   * Cost in tokens per request.
   * @default 1
   */
  tokensPerRequest?: number;
  /**
   * Optional callback fired when a request is rate-limited.
   */
  onLimited?: OnLimitedCallback;
  /**
   * Optional function to derive per-client bucket keys from the SDK's
   * per-request `extra` object. When omitted a single global bucket is used.
   *
   * A key that resolves to the same string for every caller (for example
   * `extra.sessionId` under stdio, where no session exists) puts every caller in
   * one shared bucket.
   */
  bucketKey?: BucketKeyExtractor;
  /**
   * Maximum number of per-key buckets to retain at once.
   *
   * Only relevant when `bucketKey` is set. Because bucket keys are derived from
   * caller-supplied data, an unbounded map lets a caller mint buckets until the
   * process runs out of memory. Beyond this many buckets the least recently
   * used one is discarded; a discarded bucket is recreated full, which is
   * indistinguishable from one that had refilled while idle.
   * @default 5000
   */
  maxBuckets?: number;
}

export type RateLimitOptions = TokenBucketOptions;

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

/** Error thrown when a request is rate-limited. */
export class RateLimitError extends Error {
  public readonly code = "RATE_LIMITED";
  public readonly retryAfter: number;

  constructor(retryAfter: number) {
    super(`Rate limited. Retry after ${retryAfter.toFixed(1)}s`);
    this.name = "RateLimitError";
    this.retryAfter = retryAfter;
  }
}

// ---------------------------------------------------------------------------
// Token Bucket implementation
// ---------------------------------------------------------------------------

/**
 * Classic token bucket rate limiter.
 *
 * Tokens are added to the bucket at a fixed `refillRate` (tokens / second) up
 * to `maxTokens`.  Each request consumes a configurable number of tokens. When
 * the bucket is empty, requests are rejected.
 */
export class TokenBucket {
  private tokens: number;
  private readonly maxTokens: number;
  private readonly refillRate: number;
  private readonly tokensPerRequest: number;
  private lastRefill: number;

  constructor(
    maxTokens: number = 100,
    refillRate: number = 10,
    tokensPerRequest: number = 1,
  ) {
    if (maxTokens < 1) throw new RangeError("maxTokens must be >= 1");
    if (refillRate <= 0) throw new RangeError("refillRate must be > 0");
    if (tokensPerRequest < 1) throw new RangeError("tokensPerRequest must be >= 1");

    this.maxTokens = maxTokens;
    this.refillRate = refillRate;
    this.tokensPerRequest = tokensPerRequest;
    this.tokens = maxTokens; // start full
    this.lastRefill = Date.now();
  }

  /** Refill tokens based on elapsed time since last refill. */
  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000; // seconds
    const newTokens = elapsed * this.refillRate;

    this.tokens = Math.min(this.maxTokens, this.tokens + newTokens);
    this.lastRefill = now;
  }

  /**
   * Attempt to consume tokens for a single request.
   *
   * @returns A `RateLimitInfo` object describing the outcome.
   */
  consume(): RateLimitInfo {
    this.refill();

    if (this.tokens >= this.tokensPerRequest) {
      this.tokens -= this.tokensPerRequest;
      return {
        allowed: true,
        remaining: Math.floor(this.tokens),
        limit: this.maxTokens,
        retryAfter: 0,
      };
    }

    // Not enough tokens -- calculate when they'll be available
    const deficit = this.tokensPerRequest - this.tokens;
    const retryAfter = deficit / this.refillRate;

    return {
      allowed: false,
      remaining: 0,
      limit: this.maxTokens,
      retryAfter,
    };
  }

  /** Peek at the current token count (after refilling). */
  peek(): number {
    this.refill();
    return Math.floor(this.tokens);
  }

  /** Reset the bucket to full capacity. */
  reset(): void {
    this.tokens = this.maxTokens;
    this.lastRefill = Date.now();
  }
}

// ---------------------------------------------------------------------------
// Bucket manager (per-key buckets)
// ---------------------------------------------------------------------------

interface BucketEntry {
  bucket: TokenBucket;
  /** Timestamp (ms) of the most recent request routed to this bucket. */
  lastSeen: number;
}

/**
 * Keeps one bucket per key, with a bounded number of keys.
 *
 * Bucket keys come from caller-supplied data, so an unbounded map is a memory
 * exhaustion vector: the traffic the limiter exists to throttle can allocate
 * buckets until the process dies. Two bounds apply, cheapest first:
 *
 *  - **Idle eviction.** A bucket untouched for a full refill window
 *    (`maxTokens / refillRate` seconds) has necessarily refilled to capacity, so
 *    it is indistinguishable from a fresh bucket and safe to discard.
 *  - **LRU cap.** Beyond `maxBuckets` live keys the least recently used bucket
 *    is dropped, which at worst hands one client a full bucket early.
 */
class BucketManager {
  private readonly entries = new Map<string, BucketEntry>();
  private readonly maxTokens: number;
  private readonly refillRate: number;
  private readonly tokensPerRequest: number;
  private readonly maxBuckets: number;
  /** Inactivity (ms) after which a bucket is guaranteed to be full again. */
  private readonly idleMs: number;

  constructor(
    maxTokens: number,
    refillRate: number,
    tokensPerRequest: number,
    maxBuckets: number = 5000,
  ) {
    if (maxBuckets < 1) throw new RangeError("maxBuckets must be >= 1");

    this.maxTokens = maxTokens;
    this.refillRate = refillRate;
    this.tokensPerRequest = tokensPerRequest;
    this.maxBuckets = maxBuckets;
    this.idleMs = Math.ceil((maxTokens / refillRate) * 1000);
  }

  /** Get or create a bucket for the given key, marking it most recently used. */
  getBucket(key: string): TokenBucket {
    const now = Date.now();
    const existing = this.entries.get(key);

    if (existing) {
      // Delete then re-insert so Map iteration order stays least-recently-used first.
      this.entries.delete(key);
      existing.lastSeen = now;
      this.entries.set(key, existing);
      return existing.bucket;
    }

    this.pruneIdle(now);

    while (this.entries.size >= this.maxBuckets) {
      const lruKey = this.entries.keys().next().value;
      if (lruKey === undefined) break;
      this.entries.delete(lruKey);
    }

    const entry: BucketEntry = {
      bucket: new TokenBucket(this.maxTokens, this.refillRate, this.tokensPerRequest),
      lastSeen: now,
    };
    this.entries.set(key, entry);
    return entry.bucket;
  }

  /**
   * Drop buckets untouched for at least a full refill window.
   * Iteration order is least-recently-used first, so we stop at the first live entry.
   */
  private pruneIdle(now: number): void {
    for (const [key, entry] of this.entries) {
      if (now - entry.lastSeen < this.idleMs) break;
      this.entries.delete(key);
    }
  }

  /** Remove all tracked buckets. */
  clear(): void {
    this.entries.clear();
  }

  /** Number of tracked buckets. */
  get size(): number {
    return this.entries.size;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Wraps an MCP server with rate limiting middleware.
 *
 * Every tool invocation will consume tokens from a bucket.  When the bucket
 * is exhausted a `RateLimitError` is thrown (surfaced as an MCP error response).
 *
 * @param server - An MCP server instance (from `@modelcontextprotocol/sdk`).
 * @param options - Rate limiting strategy configuration.
 * @returns The same server instance (for chaining).
 *
 * @example
 * ```ts
 * import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
 * import { withRateLimit } from "@mcp-toolkit/rate-limit";
 *
 * const server = new McpServer({ name: "demo", version: "1.0.0" });
 *
 * withRateLimit(server, {
 *   strategy: "token-bucket",
 *   maxTokens: 60,
 *   refillRate: 5,
 * });
 * ```
 */
export function withRateLimit<T extends McpServerLike>(
  server: T,
  options: RateLimitOptions,
): T {
  const maxTokens = options.maxTokens ?? 100;
  const refillRate = options.refillRate ?? 10;
  const tokensPerRequest = options.tokensPerRequest ?? 1;
  const onLimited = options.onLimited;
  const bucketKeyExtractor = options.bucketKey;
  const maxBuckets = options.maxBuckets ?? 5000;

  // Either a single global bucket or per-key manager
  const manager = new BucketManager(maxTokens, refillRate, tokensPerRequest, maxBuckets);
  const globalBucket = new TokenBucket(maxTokens, refillRate, tokensPerRequest);

  // Expose for inspection
  (server as unknown as Record<string, unknown>)["__rateLimitBucket"] = globalBucket;
  (server as unknown as Record<string, unknown>)["__rateLimitManager"] = manager;

  patchToolRegistrars(server, (originalHandler, toolName) => {
    return async function rateLimitedHandler(...handlerArgs: unknown[]) {
      // Determine which bucket to use
      let bucket = globalBucket;

      if (bucketKeyExtractor) {
        // The extractor receives the SDK's per-request `extra` object, which is
        // the LAST handler argument -- and the only argument when the tool
        // declared no input schema.
        const { extra } = splitHandlerArgs(handlerArgs);
        const key = bucketKeyExtractor(extra);
        bucket = manager.getBucket(key);
      }

      const info = bucket.consume();

      if (!info.allowed) {
        if (onLimited) {
          onLimited({ ...info, toolName });
        }
        throw new RateLimitError(info.retryAfter);
      }

      return originalHandler(...handlerArgs);
    };
  });

  return server;
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
 * Minimal shape of an MCP server that `withRateLimit` can wrap.
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
