/**
 * Tests for @mcp-toolkit/rate-limit.
 *
 * The middleware tests run against a minimal fake server rather than the real
 * `McpServer`, so the suite needs neither the SDK nor zod at test time.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  RateLimitError,
  redisRateLimitStore,
  TokenBucket,
  withRateLimit,
  type RateLimitInfo,
  type TokenBucketConfig,
} from "./index.js";

type Handler = (...args: unknown[]) => unknown;

interface FakeServer {
  tool: (...args: any[]) => any;
  registerTool: (...args: any[]) => any;
  handlers: Map<string, Handler>;
}

/** The `RegisteredTool` shape the SDK returns: `update` assigns to `handler`. */
interface FakeRegisteredTool {
  name: string;
  handler: Handler;
  update: (updates: { callback?: Handler }) => void;
}

function fakeServer(): FakeServer {
  const handlers = new Map<string, Handler>();
  const record = (...args: unknown[]): FakeRegisteredTool => {
    const name = args[0] as string;
    const registered: FakeRegisteredTool = {
      name,
      handler: args[args.length - 1] as Handler,
      update: (updates) => {
        if (updates.callback) registered.handler = updates.callback;
      },
    };
    handlers.set(name, registered.handler);
    return registered;
  };
  return { handlers, tool: record, registerTool: record };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const OK = { content: [{ type: "text", text: "ok" }] };

/** Number of buckets the manager attached to the server is currently holding. */
function bucketCount(server: object): number {
  const manager = (server as Record<string, unknown>)["__rateLimitManager"] as { size: number };
  return manager.size;
}

// ---------------------------------------------------------------------------
// TokenBucket
// ---------------------------------------------------------------------------

test("TokenBucket: starts full and drains one token per request", () => {
  const bucket = new TokenBucket(3, 1);

  assert.equal(bucket.peek(), 3);
  assert.equal(bucket.consume().remaining, 2);
  assert.equal(bucket.consume().remaining, 1);
  assert.equal(bucket.consume().remaining, 0);
});

test("TokenBucket: rejects once exhausted", () => {
  const bucket = new TokenBucket(1, 1);
  assert.equal(bucket.consume().allowed, true);

  const denied = bucket.consume();
  assert.equal(denied.allowed, false);
  assert.equal(denied.remaining, 0);
  assert.equal(denied.limit, 1);
});

test("TokenBucket: retryAfter reflects the deficit divided by the refill rate", () => {
  // 1 token capacity, 2 tokens/second: after exhausting it, one token is ~0.5s away.
  const bucket = new TokenBucket(1, 2);
  bucket.consume();

  const denied = bucket.consume();
  assert.equal(denied.allowed, false);
  assert.ok(
    denied.retryAfter > 0.4 && denied.retryAfter <= 0.5,
    `expected retryAfter near 0.5s, got ${denied.retryAfter}`,
  );
});

test("TokenBucket: refills over elapsed time", async () => {
  // 2 token capacity, 100 tokens/second: 20ms is enough to refill completely.
  const bucket = new TokenBucket(2, 100);
  bucket.consume();
  bucket.consume();
  assert.equal(bucket.consume().allowed, false);

  await sleep(40);
  assert.equal(bucket.consume().allowed, true);
});

test("TokenBucket: refill is capped at maxTokens", async () => {
  const bucket = new TokenBucket(2, 100);
  await sleep(30);
  assert.equal(bucket.peek(), 2);
});

test("TokenBucket: reset restores full capacity", () => {
  const bucket = new TokenBucket(2, 1);
  bucket.consume();
  bucket.reset();
  assert.equal(bucket.peek(), 2);
});

test("TokenBucket: rejects invalid configuration", () => {
  assert.throws(() => new TokenBucket(0, 1), RangeError);
  assert.throws(() => new TokenBucket(1, 0), RangeError);
  assert.throws(() => new TokenBucket(1, 1, 0), RangeError);
});

// ---------------------------------------------------------------------------
// withRateLimit
// ---------------------------------------------------------------------------

test("withRateLimit: throws RateLimitError once the bucket is empty", async () => {
  const server = withRateLimit(fakeServer(), {
    strategy: "token-bucket",
    maxTokens: 2,
    refillRate: 0.001, // effectively no refill during the test
  });
  server.tool("t", "d", {}, () => OK);

  const call = (): unknown => server.handlers.get("t")!({}, {});
  assert.deepEqual(await call(), OK);
  assert.deepEqual(await call(), OK);

  await assert.rejects(() => Promise.resolve(call()), RateLimitError);
});

test("withRateLimit: onLimited receives the tool name and retryAfter", async () => {
  const seen: Array<{ toolName: string; retryAfter: number }> = [];
  const server = withRateLimit(fakeServer(), {
    strategy: "token-bucket",
    maxTokens: 1,
    refillRate: 2,
    onLimited: (info) => seen.push({ toolName: info.toolName, retryAfter: info.retryAfter }),
  });
  server.tool("get-weather", "d", {}, () => OK);

  await server.handlers.get("get-weather")!({}, {});
  await assert.rejects(
    () => Promise.resolve(server.handlers.get("get-weather")!({}, {})),
    RateLimitError,
  );

  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.toolName, "get-weather");
  assert.ok(seen[0]!.retryAfter > 0);
});

test("withRateLimit: per-key buckets are isolated", async () => {
  const server = withRateLimit(fakeServer(), {
    strategy: "token-bucket",
    maxTokens: 1,
    refillRate: 0.001,
    bucketKey: (extra) => String(extra["client"]),
  });
  server.tool("t", "d", {}, () => OK);

  const call = (client: string): unknown => server.handlers.get("t")!({}, { client });

  assert.deepEqual(await call("alice"), OK);
  await assert.rejects(() => Promise.resolve(call("alice")), RateLimitError);
  // bob has his own bucket and is unaffected by alice exhausting hers.
  assert.deepEqual(await call("bob"), OK);
});

test("withRateLimit: tools registered via registerTool are limited too", async () => {
  const server = withRateLimit(fakeServer(), {
    strategy: "token-bucket",
    maxTokens: 1,
    refillRate: 0.001,
  });
  server.registerTool("t", { description: "d", inputSchema: {} }, () => OK);

  assert.deepEqual(await server.handlers.get("t")!({}, {}), OK);
  await assert.rejects(() => Promise.resolve(server.handlers.get("t")!({}, {})), RateLimitError);
});

test("withRateLimit: a schema-less tool is limited from its lone extra argument", async () => {
  // A tool registered without an inputSchema is invoked as handler(extra): one
  // argument, no params object. The extractor used to receive an empty object.
  const seen: string[] = [];
  const server = withRateLimit(fakeServer(), {
    strategy: "token-bucket",
    maxTokens: 1,
    refillRate: 0.001,
    bucketKey: (extra) => {
      const requestInfo = extra["requestInfo"] as { headers: Record<string, string> } | undefined;
      const key = String(requestInfo?.headers["x-forwarded-for"]);
      seen.push(key);
      return key;
    },
  });
  server.registerTool("t", { description: "d" }, () => OK);

  const call = (ip: string): unknown =>
    server.handlers.get("t")!({ requestInfo: { headers: { "x-forwarded-for": ip } } });

  assert.deepEqual(await call("1.2.3.4"), OK);
  await assert.rejects(() => Promise.resolve(call("1.2.3.4")), RateLimitError);
  // A different caller has its own bucket, so the HTTP header really keyed it.
  assert.deepEqual(await call("5.6.7.8"), OK);
  assert.deepEqual(seen, ["1.2.3.4", "1.2.3.4", "5.6.7.8"]);
});

test("withRateLimit: a handler swapped in after registration is still limited", async () => {
  const server = withRateLimit(fakeServer(), {
    strategy: "token-bucket",
    maxTokens: 1,
    refillRate: 0.001,
  });
  const registered = server.registerTool("t", {
    description: "d",
    inputSchema: {},
  }, () => OK) as FakeRegisteredTool;

  registered.update({ callback: () => OK });

  assert.deepEqual(await registered.handler({}, {}), OK);
  await assert.rejects(() => Promise.resolve(registered.handler({}, {})), RateLimitError);
});

test("withRateLimit: the per-key bucket map is bounded by maxBuckets", async () => {
  const server = withRateLimit(fakeServer(), {
    strategy: "token-bucket",
    maxTokens: 10,
    refillRate: 0.001, // long refill window, so idle eviction cannot fire
    maxBuckets: 3,
    bucketKey: (extra) => String(extra["client"]),
  });
  server.tool("t", "d", {}, () => OK);

  for (let i = 0; i < 50; i++) {
    await server.handlers.get("t")!({}, { client: `client-${i}` });
  }

  assert.equal(bucketCount(server), 3, "buckets beyond maxBuckets must be evicted");
});

test("withRateLimit: idle buckets are dropped after a full refill window", async () => {
  const server = withRateLimit(fakeServer(), {
    strategy: "token-bucket",
    maxTokens: 1,
    refillRate: 100, // full refill window is 10ms
    bucketKey: (extra) => String(extra["client"]),
  });
  server.tool("t", "d", {}, () => OK);

  await server.handlers.get("t")!({}, { client: "alice" });
  assert.equal(bucketCount(server), 1);

  await sleep(30);
  // A new key triggers the idle sweep; alice's bucket has refilled and is dropped.
  await server.handlers.get("t")!({}, { client: "bob" });
  assert.equal(bucketCount(server), 1);
});

test("withRateLimit: rejects a maxBuckets below 1", () => {
  assert.throws(
    () =>
      withRateLimit(fakeServer(), {
        strategy: "token-bucket",
        maxBuckets: 0,
        bucketKey: () => "k",
      }),
    RangeError,
  );
});

// ---------------------------------------------------------------------------
// Pluggable store
// ---------------------------------------------------------------------------

test("withRateLimit: a custom store decides, with the resolved bucket config", async () => {
  const seen: Array<{ key: string; config: TokenBucketConfig }> = [];
  let left = 1;
  const server = withRateLimit(fakeServer(), {
    strategy: "token-bucket",
    maxTokens: 7,
    refillRate: 2,
    tokensPerRequest: 3,
    store: {
      consume: async (key, config): Promise<RateLimitInfo> => {
        seen.push({ key, config });
        const allowed = left-- > 0;
        return { allowed, remaining: 0, limit: config.maxTokens, retryAfter: allowed ? 0 : 1.5 };
      },
    },
  });
  server.tool("t", "d", {}, () => OK);

  assert.deepEqual(await server.handlers.get("t")!({}, {}), OK);
  await assert.rejects(() => Promise.resolve(server.handlers.get("t")!({}, {})), (err: unknown) => {
    assert.ok(err instanceof RateLimitError);
    assert.equal(err.retryAfter, 1.5);
    return true;
  });
  assert.deepEqual(seen[0], {
    key: "global",
    config: { maxTokens: 7, refillRate: 2, tokensPerRequest: 3 },
  });
});

test("withRateLimit: a custom store receives the bucketKey result", async () => {
  const keys: string[] = [];
  const server = withRateLimit(fakeServer(), {
    strategy: "token-bucket",
    bucketKey: (extra) => String(extra["client"]),
    store: {
      consume: (key, config) => {
        keys.push(key);
        return { allowed: true, remaining: 1, limit: config.maxTokens, retryAfter: 0 };
      },
    },
  });
  server.tool("t", "d", {}, () => OK);

  await server.handlers.get("t")!({}, { client: "alice" });
  await server.handlers.get("t")!({}, { client: "bob" });

  assert.deepEqual(keys, ["alice", "bob"]);
  assert.equal(bucketCount(server), 0, "the in-memory manager is not used with a store");
});

test("redisRateLimitStore: sends one EVAL and maps the reply", async () => {
  const sent: string[][] = [];
  const replies: unknown[] = [
    [1, "4.5"],
    [0, "0.25"],
  ];
  const store = redisRateLimitStore(
    async (args) => {
      sent.push(args);
      return replies.shift();
    },
    { prefix: "p:" },
  );
  const config = { maxTokens: 10, refillRate: 0.5, tokensPerRequest: 1 };

  assert.deepEqual(await store.consume("alice", config), {
    allowed: true,
    remaining: 4,
    limit: 10,
    retryAfter: 0,
  });
  assert.deepEqual(await store.consume("alice", config), {
    allowed: false,
    remaining: 0,
    limit: 10,
    retryAfter: 1.5,
  });

  assert.equal(sent.length, 2);
  const [cmd, , numKeys, key, ...argv] = sent[0]!;
  assert.equal(cmd, "EVAL");
  assert.equal(numKeys, "1");
  assert.equal(key, "p:alice");
  assert.deepEqual(argv, ["10", "0.5", "1"]);
});

test("redisRateLimitStore: an unexpected reply is an error, not an allow", async () => {
  const store = redisRateLimitStore(async () => "OK");
  await assert.rejects(
    () => Promise.resolve(store.consume("k", { maxTokens: 1, refillRate: 1, tokensPerRequest: 1 })),
    TypeError,
  );
});
