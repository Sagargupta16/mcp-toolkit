# @mcp-toolkit/rate-limit

Rate limiting middleware for MCP servers. Token bucket, global or per key, in memory or
shared through Redis / Valkey.

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
import { withRateLimit } from "@mcp-toolkit/rate-limit";

const server = new McpServer({ name: "demo", version: "1.0.0" });

withRateLimit(server, {
  strategy: "token-bucket",
  maxTokens: 60,   // burst capacity
  refillRate: 5,   // tokens added per second
  onLimited: (info) => console.error("rate limited", info.toolName, info.retryAfter),
});

server.registerTool(
  "get-data",
  { description: "Fetch data", inputSchema: { query: z.string() } },
  async ({ query }) => ({ content: [{ type: "text" as const, text: query }] }),
);
```

When the bucket is empty the call rejects with `RateLimitError`, whose `retryAfter`
field is the number of seconds until enough tokens exist for the next request.

## Options

```typescript
withRateLimit(server, {
  strategy: "token-bucket",
  maxTokens: 100,          // bucket capacity, default 100
  refillRate: 10,          // tokens per second, default 10
  tokensPerRequest: 1,     // cost per call, default 1
  bucketKey: (extra) => String(extra.sessionId), // omit for one global bucket
  maxBuckets: 5000,        // cap on retained per-key buckets, default 5000
  onLimited: (info) => {}, // called on every rejection
  store: undefined,        // a RateLimitStore; default is in-process memory
});
```

`TokenBucket` is exported if you want the algorithm without the middleware.

## What `bucketKey` receives

`bucketKey` is handed the SDK's per-request `extra` object -- the last handler argument,
and the only argument when the tool declared no `inputSchema`. The values worth keying on
live in different places depending on the transport:

```typescript
// Streamable HTTP or SSE: real HTTP headers.
bucketKey: (extra) => {
  const requestInfo = extra["requestInfo"] as { headers: Record<string, string> } | undefined;
  return String(requestInfo?.headers["x-forwarded-for"] ?? "unknown");
},

// After withAuth, the verified caller identity.
bucketKey: (extra) => {
  const auth = extra["auth"] as { payload?: { sub?: string } } | undefined;
  return auth?.payload?.sub ?? "anonymous";
},
```

Check that the key actually varies per caller. `extra.sessionId` is only set by transports
that have a session, so under stdio it is `undefined` for everyone and every caller shares
one `"undefined"` bucket. The `api-key` auth strategy has the same problem: it reports one
`sub` for all keys.

## Per-key buckets are bounded

`bucketKey` derives the bucket from caller-supplied data, so an unbounded map would let
a caller allocate buckets until the process runs out of memory. Two bounds apply:

- A bucket untouched for a full refill window (`maxTokens / refillRate` seconds) has
  necessarily refilled to capacity, so it is dropped -- it is indistinguishable from a
  fresh bucket.
- Beyond `maxBuckets` live keys, the least recently used bucket is evicted. Worst case,
  one client gets a full bucket earlier than it should.

## One limit across replicas

In-memory buckets are per process: three replicas behind a load balancer allow three
times the limit. Pass a `store` to make the bucket shared. `redisRateLimitStore` is built
in and works with Redis 5+ and Valkey:

```typescript
import { createClient } from "redis";
import { withRateLimit, redisRateLimitStore } from "@mcp-toolkit/rate-limit";

const redis = await createClient({ url: process.env.REDIS_URL }).connect();

withRateLimit(server, {
  strategy: "token-bucket",
  maxTokens: 60,
  refillRate: 1,
  bucketKey: (extra) => (extra["auth"] as { payload?: { sub?: string } })?.payload?.sub ?? "anonymous",
  store: redisRateLimitStore((args) => redis.sendCommand(args)),
});
```

How it works:

- **One Lua script per call.** Refill, take and write back run as a single `EVAL`, so
  the check is atomic on the Redis server. Two replicas cannot both spend the last token.
- **Redis time, not host time.** The script reads the clock with `TIME`, so clock skew
  between replicas cannot mint extra tokens.
- **Bounded keys.** Each bucket gets a `PEXPIRE` of one full refill window
  (`maxTokens / refillRate` seconds). An expired bucket would have been full anyway, so
  `maxBuckets` does not apply with a store.
- **Fails closed.** A Redis error fails the tool call rather than letting it through.
- Keys are `<prefix><bucketKey>`, prefix default `mcp-toolkit:rl:`. Without `bucketKey`
  every call uses the key `global`.

The store takes a function that sends one command, so any client works and the package
keeps zero runtime dependencies. With ioredis: `(args) => redis.call(args[0]!, ...args.slice(1))`.
Any object with `consume(key, config)` returning a `RateLimitInfo` is a `RateLimitStore`.

## Caveats

- **Per-process by default.** Without a `store`, buckets live in the current Node
  process, so limits are not shared across workers or replicas and reset on restart.
- **Tools only.** Resources, prompts, and completions are not intercepted.
- **Apply after `withAuth`** if you key buckets off an authenticated identity, so the
  auth context exists by the time the limiter runs.

## License

[MIT](../../LICENSE)
