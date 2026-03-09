# MCP Toolkit

> Reusable utilities and middleware for building production-ready MCP servers.

Stop reimplementing auth, caching, rate limiting, and logging for every MCP server. MCP Toolkit provides drop-in packages that work with both the TypeScript and Python SDKs.

## Packages

| Package | Description | Status |
|---------|-------------|--------|
| [`@mcp-toolkit/auth`](packages/auth/) | API key, OAuth, and JWT authentication | Beta |
| [`@mcp-toolkit/cache`](packages/cache/) | Response caching with TTL, LRU, and Redis support | Beta |
| [`@mcp-toolkit/rate-limit`](packages/rate-limit/) | Rate limiting with token bucket and sliding window | Beta |
| [`@mcp-toolkit/logger`](packages/logger/) | Structured logging with JSON output and log levels | Beta |
| [`@mcp-toolkit/cors`](packages/cors/) | Origin validation middleware | Beta |

## Quick Start

### Install

```bash
npm install @mcp-toolkit/auth @mcp-toolkit/cache @mcp-toolkit/rate-limit @mcp-toolkit/logger @mcp-toolkit/cors
```

### Usage with TypeScript SDK

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { withAuth } from "@mcp-toolkit/auth";
import { withCache } from "@mcp-toolkit/cache";
import { withRateLimit } from "@mcp-toolkit/rate-limit";
import { createLogger } from "@mcp-toolkit/logger";

const logger = createLogger({ level: "info", format: "json" });

const server = new McpServer({
  name: "my-server",
  version: "1.0.0",
});

// Add middleware
withAuth(server, {
  type: "api-key",
  keys: [process.env.MCP_API_KEY],
});

withRateLimit(server, {
  strategy: "token-bucket",
  maxTokens: 100,
  refillRate: 10,
});

withCache(server, {
  ttl: 300,
  maxSize: 1000,
  strategy: "lru",
});

// Define tools — middleware applies automatically
server.tool("get-data", "Fetch data with auth + cache + rate limiting", {
  query: { type: "string", description: "Search query" },
}, async ({ query }) => {
  logger.info("Fetching data", { query });
  const result = await fetchData(query);
  return { content: [{ type: "text", text: JSON.stringify(result) }] };
});

const transport = new StdioServerTransport();
await server.connect(transport);
```

### Usage with Python SDK

```python
from mcp.server import Server
from mcp_toolkit.auth import with_auth, ApiKeyAuth
from mcp_toolkit.cache import with_cache, LRUCache
from mcp_toolkit.rate_limit import with_rate_limit, TokenBucket
from mcp_toolkit.logger import create_logger

logger = create_logger(level="info", format="json")
server = Server("my-server")

with_auth(server, ApiKeyAuth(keys=[os.environ["MCP_API_KEY"]]))
with_rate_limit(server, TokenBucket(max_tokens=100, refill_rate=10))
with_cache(server, LRUCache(ttl=300, max_size=1000))

@server.tool()
async def get_data(query: str) -> str:
    """Fetch data with auth + cache + rate limiting."""
    logger.info("Fetching data", query=query)
    result = await fetch_data(query)
    return json.dumps(result)
```

## Package Details

### Auth

Multiple authentication strategies:

```typescript
// API Key
withAuth(server, { type: "api-key", header: "X-API-Key", keys: ["key1", "key2"] });

// JWT
withAuth(server, { type: "jwt", secret: process.env.JWT_SECRET, algorithms: ["HS256"] });

// Custom
withAuth(server, { type: "custom", verify: async (token) => isValid(token) });
```

### Cache

Response caching with multiple strategies:

```typescript
withCache(server, {
  strategy: "lru",       // lru | ttl | redis
  ttl: 300,              // seconds
  maxSize: 1000,         // max entries
  keyGenerator: (toolName, args) => `${toolName}:${JSON.stringify(args)}`,
});
```

### Rate Limit

Protect your server from abuse:

```typescript
withRateLimit(server, {
  strategy: "token-bucket",  // token-bucket | sliding-window | fixed-window
  maxTokens: 100,
  refillRate: 10,            // per second
  onLimited: (req) => logger.warn("Rate limited", { tool: req.toolName }),
});
```

### Logger

Structured logging built for MCP servers:

```typescript
const logger = createLogger({
  level: "info",             // debug | info | warn | error
  format: "json",           // json | text
  transports: ["stdout", { type: "file", path: "./mcp-server.log" }],
});
```

### CORS

Validate request origins when using HTTP or SSE transport:

```typescript
import { withCors } from "@mcp-toolkit/cors";

withCors(server, {
  allowedOrigins: ["https://myapp.com"]
});


## Architecture

```
MCP Client (Claude, Cursor, etc.)
        |
        v
MCP Client (Claude, Cursor, etc.)
        |
        v
+-------------------------+
|     MCP Transport       |
|   (stdio / SSE / HTTP)  |
+-------------------------+
|   @mcp-toolkit/cors     |  <-- Origin validation
+-------------------------+
|   @mcp-toolkit/auth     |  <-- Authentication layer
+-------------------------+
| @mcp-toolkit/rate-limit |  <-- Rate limiting layer
+-------------------------+
|   @mcp-toolkit/cache    |  <-- Caching layer
+-------------------------+
|  @mcp-toolkit/logger    |  <-- Logging (all layers)
+-------------------------+
|   Your MCP Server       |
|   (tools, resources)    |
+-------------------------+
```

## Examples

See the [`examples/`](examples/) directory:

- [Basic server with auth](examples/basic-auth-server.ts)
- [Cached API proxy](examples/cached-api-proxy.ts)
- [Rate-limited public server](examples/rate-limited-server.ts)
- [Full production setup](examples/production-server.ts)

## Contributing

Contributions welcome — new middleware, bug fixes, or docs improvements.

1. Fork this repo
2. Create a feature branch (`git checkout -b feat/my-middleware`)
3. Add your code with tests
4. Submit a PR

See [CONTRIBUTING.md](CONTRIBUTING.md) for full guidelines.

## License

[MIT](LICENSE)
