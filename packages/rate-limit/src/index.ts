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

/** Function that derives a bucket key from request metadata (for per-user limiting). */
export type BucketKeyExtractor = (meta: Record<string, unknown>) => string;

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
   * Optional function to derive per-client bucket keys.
   * When omitted a single global bucket is used.
   */
  bucketKey?: BucketKeyExtractor;
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

    // Not enough tokens — calculate when they'll be available
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

class BucketManager {
  private readonly buckets = new Map<string, TokenBucket>();
  private readonly maxTokens: number;
  private readonly refillRate: number;
  private readonly tokensPerRequest: number;

  constructor(maxTokens: number, refillRate: number, tokensPerRequest: number) {
    this.maxTokens = maxTokens;
    this.refillRate = refillRate;
    this.tokensPerRequest = tokensPerRequest;
  }

  /** Get or create a bucket for the given key. */
  getBucket(key: string): TokenBucket {
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = new TokenBucket(this.maxTokens, this.refillRate, this.tokensPerRequest);
      this.buckets.set(key, bucket);
    }
    return bucket;
  }

  /** Remove all tracked buckets. */
  clear(): void {
    this.buckets.clear();
  }

  /** Number of tracked buckets. */
  get size(): number {
    return this.buckets.size;
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

  // Either a single global bucket or per-key manager
  const manager = new BucketManager(maxTokens, refillRate, tokensPerRequest);
  const globalBucket = new TokenBucket(maxTokens, refillRate, tokensPerRequest);

  // Expose for inspection
  (server as Record<string, unknown>)["__rateLimitBucket"] = globalBucket;
  (server as Record<string, unknown>)["__rateLimitManager"] = manager;

  const originalTool = server.tool.bind(server);

  const wrappedTool = function toolWithRateLimit(...args: unknown[]): unknown {
    const handlerIndex = args.findIndex(
      (a, i) => typeof a === "function" && i === args.length - 1,
    );

    if (handlerIndex === -1) {
      return (originalTool as (...a: unknown[]) => unknown)(...args);
    }

    const toolName = args.find((a) => typeof a === "string") as string | undefined;
    const originalHandler = args[handlerIndex] as (...a: unknown[]) => unknown;

    args[handlerIndex] = async function rateLimitedHandler(...handlerArgs: unknown[]) {
      // Determine which bucket to use
      let bucket = globalBucket;

      if (bucketKeyExtractor) {
        const extra = (handlerArgs.length > 1
          ? handlerArgs[handlerArgs.length - 1]
          : {}) as Record<string, unknown>;
        const meta = (extra?.["meta"] ?? extra ?? {}) as Record<string, unknown>;
        const key = bucketKeyExtractor(meta);
        bucket = manager.getBucket(key);
      }

      const info = bucket.consume();

      if (!info.allowed) {
        if (onLimited) {
          onLimited({ ...info, toolName: toolName ?? "unknown" });
        }
        throw new RateLimitError(info.retryAfter);
      }

      return originalHandler(...handlerArgs);
    };

    return (originalTool as (...a: unknown[]) => unknown)(...args);
  };

  server.tool = wrappedTool as typeof server.tool;

  return server;
}

// ---------------------------------------------------------------------------
// Minimal type for the MCP server
// ---------------------------------------------------------------------------

/** Minimal shape of an MCP server that `withRateLimit` can wrap. */
export interface McpServerLike {
  tool: (...args: unknown[]) => unknown;
  [key: string]: unknown;
}
