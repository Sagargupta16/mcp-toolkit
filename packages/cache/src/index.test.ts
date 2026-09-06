/**
 * Tests for @mcp-toolkit/cache.
 *
 * The middleware tests run against a minimal fake server rather than the real
 * `McpServer`, so the suite needs neither the SDK nor zod at test time.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { getCache, LRUCache, withCache } from "./index.js";

type Handler = (...args: unknown[]) => unknown;

interface FakeServer {
  tool: (...args: any[]) => any;
  registerTool: (...args: any[]) => any;
  handlers: Map<string, Handler>;
}

function fakeServer(): FakeServer {
  const handlers = new Map<string, Handler>();
  const record = (...args: unknown[]): unknown => {
    const name = args[0] as string;
    handlers.set(name, args[args.length - 1] as Handler);
    return { name };
  };
  return { handlers, tool: record, registerTool: record };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// LRUCache
// ---------------------------------------------------------------------------

test("LRUCache: hit and miss are counted", () => {
  const cache = new LRUCache<string>(10, 0);

  assert.equal(cache.get("a"), undefined);
  cache.set("a", "1");
  assert.equal(cache.get("a"), "1");

  const stats = cache.stats();
  assert.equal(stats.hits, 1);
  assert.equal(stats.misses, 1);
  assert.equal(stats.hitRate, 0.5);
});

test("LRUCache: entries go stale after the TTL", async () => {
  const cache = new LRUCache<string>(10, 0.02); // 20ms
  cache.set("a", "1");
  assert.equal(cache.has("a"), true);

  await sleep(40);
  assert.equal(cache.get("a"), undefined, "entry should be stale");
  assert.equal(cache.size, 0, "stale entry should be dropped on access");
});

test("LRUCache: ttl of 0 disables expiry", async () => {
  const cache = new LRUCache<string>(10, 0);
  cache.set("a", "1");
  await sleep(20);
  assert.equal(cache.get("a"), "1");
});

test("LRUCache: evicts the least recently used entry at capacity", () => {
  const cache = new LRUCache<string>(2, 0);
  cache.set("a", "1");
  cache.set("b", "2");

  // Touch "a" so "b" becomes the least recently used entry.
  assert.equal(cache.get("a"), "1");
  cache.set("c", "3");

  assert.equal(cache.size, 2);
  assert.equal(cache.get("b"), undefined, "b was least recently used");
  assert.equal(cache.get("a"), "1");
  assert.equal(cache.get("c"), "3");
});

test("LRUCache: prune removes every expired entry eagerly", async () => {
  const cache = new LRUCache<string>(10, 0.02);
  cache.set("a", "1");
  cache.set("b", "2");
  await sleep(40);

  assert.equal(cache.prune(), 2);
  assert.equal(cache.size, 0);
});

test("LRUCache: rejects a maxSize below 1", () => {
  assert.throws(() => new LRUCache(0), RangeError);
});

// ---------------------------------------------------------------------------
// withCache
// ---------------------------------------------------------------------------

test("withCache: a repeated call with the same args skips the handler", async () => {
  const server = withCache(fakeServer(), { strategy: "lru", ttl: 60, maxSize: 10 });
  let calls = 0;
  server.tool("get", "d", {}, () => {
    calls += 1;
    return { calls };
  });

  const first = await server.handlers.get("get")!({ q: "x" }, {});
  const second = await server.handlers.get("get")!({ q: "x" }, {});

  assert.equal(calls, 1, "second call should be served from cache");
  assert.deepEqual(first, second);
});

test("withCache: different args are cached separately", async () => {
  const server = withCache(fakeServer(), { strategy: "lru", ttl: 60, maxSize: 10 });
  let calls = 0;
  server.tool("get", "d", {}, () => {
    calls += 1;
    return { calls };
  });

  await server.handlers.get("get")!({ q: "x" }, {});
  await server.handlers.get("get")!({ q: "y" }, {});

  assert.equal(calls, 2);
});

test("withCache: argument order does not change the cache key", async () => {
  const server = withCache(fakeServer(), { strategy: "lru", ttl: 60, maxSize: 10 });
  let calls = 0;
  server.tool("get", "d", {}, () => {
    calls += 1;
    return { calls };
  });

  await server.handlers.get("get")!({ a: 1, b: 2 }, {});
  await server.handlers.get("get")!({ b: 2, a: 1 }, {});

  assert.equal(calls, 1);
});

test("withCache: entries are scoped to the authenticated caller", async () => {
  const server = withCache(fakeServer(), { strategy: "lru", ttl: 60, maxSize: 10 });
  const seen: string[] = [];
  server.tool("whoami", "d", {}, (_params: unknown, extra: Record<string, unknown>) => {
    const auth = extra["auth"] as { payload: { sub: string } };
    seen.push(auth.payload.sub);
    return { sub: auth.payload.sub };
  });

  const call = (sub: string): unknown =>
    server.handlers.get("whoami")!({}, { auth: { payload: { sub } } });

  const alice = await call("alice");
  const bob = await call("bob");

  assert.deepEqual(seen, ["alice", "bob"], "bob must not be served alice's cached response");
  assert.deepEqual(alice, { sub: "alice" });
  assert.deepEqual(bob, { sub: "bob" });
});

test("withCache: tools registered via registerTool are cached too", async () => {
  const server = withCache(fakeServer(), { strategy: "lru", ttl: 60, maxSize: 10 });
  let calls = 0;
  server.registerTool("get", { description: "d", inputSchema: {} }, () => {
    calls += 1;
    return { calls };
  });

  await server.handlers.get("get")!({ q: "x" }, {});
  await server.handlers.get("get")!({ q: "x" }, {});

  assert.equal(calls, 1);
});

test("withCache: getCache exposes the live cache for invalidation", async () => {
  const server = withCache(fakeServer(), { strategy: "lru", ttl: 60, maxSize: 10 });
  let calls = 0;
  server.tool("get", "d", {}, () => {
    calls += 1;
    return { calls };
  });

  await server.handlers.get("get")!({ q: "x" }, {});
  const cache = getCache(server);
  assert.ok(cache, "cache should be attached to the server");
  cache!.clear();
  await server.handlers.get("get")!({ q: "x" }, {});

  assert.equal(calls, 2, "clearing the cache should force a re-run");
});

test("withCache: a custom keyGenerator is used", async () => {
  const server = withCache(fakeServer(), {
    strategy: "lru",
    ttl: 60,
    maxSize: 10,
    keyGenerator: (toolName) => toolName, // ignore args entirely
  });
  let calls = 0;
  server.tool("get", "d", {}, () => {
    calls += 1;
    return { calls };
  });

  await server.handlers.get("get")!({ q: "x" }, {});
  await server.handlers.get("get")!({ q: "different" }, {});

  assert.equal(calls, 1, "the custom key ignores args, so this is a cache hit");
});
