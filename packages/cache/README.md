# @mcp-toolkit/cache

Response caching middleware for MCP servers. In-memory LRU with TTL, or a shared Redis /
Valkey store.

Part of [mcp-toolkit](https://github.com/Sagargupta16/mcp-toolkit). Beta.

## Install

Not yet published to npm. Clone the monorepo and build from source:

```bash
git clone https://github.com/Sagargupta16/mcp-toolkit.git
cd mcp-toolkit
npm install
npm run build
```

## Usage

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { withCache, getCache } from "@mcp-toolkit/cache";

const server = new McpServer({ name: "demo", version: "1.0.0" });

withCache(server, { strategy: "lru", ttl: 300, maxSize: 1000 });

// A repeat call with the same arguments returns without re-running the handler.
server.registerTool(
  "get-data",
  { description: "Fetch data", inputSchema: { query: z.string() } },
  async ({ query }) => ({
    content: [{ type: "text" as const, text: await fetchExpensive(query) }],
  }),
);

// Manual invalidation and stats
getCache(server)?.clear();
```

## Options

```typescript
withCache(server, {
  strategy: "lru",       // "lru" | "ttl" -- see caveats
  ttl: 300,              // seconds, default 300. 0 disables expiry
  maxSize: 1000,         // max entries, default 1000
  keyGenerator: (toolName, args) => `${toolName}:${JSON.stringify(args)}`,
  store: undefined,      // a CacheStore; default is the in-process LRU
});
```

The default key generator sorts argument keys, so `{ a: 1, b: 2 }` and `{ b: 2, a: 1 }`
hit the same entry. A tool registered without an `inputSchema` has no arguments at all,
so every call to it shares one entry.

## Sharing the cache across replicas

The default cache lives in one Node process. Pass a `store` to keep entries somewhere
every replica can reach. `redisCacheStore` is built in and works with Redis 5+ and
Valkey:

```typescript
import { createClient } from "redis";
import { withCache, redisCacheStore } from "@mcp-toolkit/cache";

const redis = await createClient({ url: process.env.REDIS_URL }).connect();

withCache(server, {
  strategy: "ttl",
  ttl: 300,
  store: redisCacheStore((args) => redis.sendCommand(args), { prefix: "my-server:" }),
});
```

It takes a function that sends one command, not a client, so the package still has no
runtime dependencies and any client fits. With ioredis that function is
`(args) => redis.call(args[0]!, ...args.slice(1))`.

- Values are stored as JSON with `SET key value PX <ttl>`, so Redis does the expiry and
  `ttl: 0` means no expiry. `maxSize` does not apply; eviction beyond the TTL follows the
  server's `maxmemory-policy`.
- Keys are `<prefix><key>`, prefix default `mcp-toolkit:cache:`.
- A Redis error fails the tool call. Wrap the store if you would rather fall through to
  the handler.
- `getCache(server)` returns `undefined` when a store is passed.

Any object with `get(key)` and `set(key, value, ttlSeconds)` is a `CacheStore`; either
method may return a promise.

## Per-caller scoping

When `withAuth` ran first it attaches an `AuthContext` at `extra.auth`, and the cache key
is prefixed with `sub:<payload.sub>`. Without that prefix, an identity-dependent response
cached for one caller would be served to the next.

How much that separates depends on the auth strategy, because the prefix is only as
specific as `payload.sub`:

- `api-key` reports the same `sub` (`"api-key-user"`) for every valid key, so all API key
  holders land in one namespace and still share entries.
- `jwt` uses the token's own `sub`, and a `custom` verifier uses whatever `sub` it
  returns, so those do separate callers.

Apply auth before the cache, never after. The last middleware applied runs innermost, so
calling `withCache` first puts the cache *outside* auth, where a cache hit returns before
authentication happens at all.

## Caveats

- **`strategy` does not change eviction.** `"lru"` and `"ttl"` both use one
  LRU-with-TTL cache: an entry leaves when it exceeds `ttl` or when `maxSize` is
  reached, whichever comes first.
- **In-process memory by default.** Without a `store`, nothing is shared across workers,
  replicas, or restarts.
- **Errors are not cached.** A handler that throws is not stored, and neither is a
  result with `isError: true` (how MCP tools report failure), so the next call re-runs
  the handler instead of replaying the failure for the whole TTL.
- **TTL eviction is lazy.** Stale entries are dropped when touched; call `prune()` on
  the instance from `getCache` for an eager sweep.
- **Tools only.** Resources, prompts, and completions are not intercepted.

## License

[MIT](../../LICENSE)
