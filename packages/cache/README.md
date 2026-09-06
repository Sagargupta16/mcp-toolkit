# @mcp-toolkit/cache

Response caching middleware for MCP servers. In-memory LRU with TTL.

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
server.tool("get-data", "Fetch data", { query: z.string() }, async ({ query }) => ({
  content: [{ type: "text" as const, text: await fetchExpensive(query) }],
}));

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
});
```

The default key generator sorts argument keys, so `{ a: 1, b: 2 }` and `{ b: 2, a: 1 }`
hit the same entry. A tool registered without an `inputSchema` has no arguments at all,
so every call to it shares one entry.

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
- **In-process memory only.** Nothing is shared across workers, replicas, or restarts.
- **Errors are not cached.** A handler that throws is not stored, so the next call
  re-runs it.
- **TTL eviction is lazy.** Stale entries are dropped when touched; call `prune()` on
  the instance from `getCache` for an eager sweep.
- **Tools only.** Resources, prompts, and completions are not intercepted.

## License

[MIT](../../LICENSE)
