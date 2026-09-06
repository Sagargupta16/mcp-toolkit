# @mcp-toolkit/rate-limit

Rate limiting middleware for MCP servers. Token bucket, global or per key.

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

server.tool("get-data", "Fetch data", { query: z.string() }, async ({ query }) => ({
  content: [{ type: "text" as const, text: query }],
}));
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
  bucketKey: (meta) => String(meta.sessionId),  // omit for one global bucket
  maxBuckets: 5000,        // cap on retained per-key buckets, default 5000
  onLimited: (info) => {}, // called on every rejection
});
```

`TokenBucket` is exported if you want the algorithm without the middleware.

## Per-key buckets are bounded

`bucketKey` derives the bucket from caller-supplied data, so an unbounded map would let
a caller allocate buckets until the process runs out of memory. Two bounds apply:

- A bucket untouched for a full refill window (`maxTokens / refillRate` seconds) has
  necessarily refilled to capacity, so it is dropped -- it is indistinguishable from a
  fresh bucket.
- Beyond `maxBuckets` live keys, the least recently used bucket is evicted. Worst case,
  one client gets a full bucket earlier than it should.

## Caveats

- **Per-process, not global.** Buckets live in the current Node process, so limits are
  not shared across workers or replicas and reset on restart.
- **Tools only.** Resources, prompts, and completions are not intercepted.
- **Apply after `withAuth`** if you key buckets off an authenticated identity, so the
  auth context exists by the time the limiter runs.

## License

[MIT](../../LICENSE)
