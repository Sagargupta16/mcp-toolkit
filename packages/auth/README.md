# @mcp-toolkit/auth

Authentication middleware for MCP servers. API key, JWT (HMAC), and custom strategies.

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
import { withAuth } from "@mcp-toolkit/auth";

const apiKey = process.env.MCP_API_KEY;
if (!apiKey) throw new Error("MCP_API_KEY is not set");

const server = new McpServer({ name: "demo", version: "1.0.0" });

withAuth(server, { type: "api-key", keys: [apiKey], header: "x-api-key" });

// Registered after withAuth, so this handler is guarded.
server.tool("greet", "Greet a user", { name: z.string() }, async ({ name }) => ({
  content: [{ type: "text" as const, text: `Hello, ${name}` }],
}));
```

An unauthenticated call rejects with `AuthError` before the handler runs. The verified
context is attached to the handler's `extra.auth` as an `AuthContext`, which is what
`@mcp-toolkit/cache` uses to scope cache entries by `payload.sub`.

## Options

```typescript
// API key: constant-time comparison against every configured key
withAuth(server, {
  type: "api-key",
  keys: ["key1", "key2"],   // required, at least one non-empty string
  header: "x-api-key",      // default "x-api-key"
});

// JWT: HMAC signature, exp / nbf, algorithm allowlist
withAuth(server, {
  type: "jwt",
  secret: process.env.JWT_SECRET!,
  algorithms: ["HS256"],    // default ["HS256"]
  clockTolerance: 0,        // seconds, default 0
});

// Custom: bring your own verifier
withAuth(server, {
  type: "custom",
  verify: async (token) => isValid(token), // return false, true, or an AuthPayload
  header: "authorization",  // default "authorization"
});
```

## Where the credential is read from

There is no single header bag on an MCP tool handler, so these are searched in order:

1. `extra.requestInfo.headers` -- the real HTTP headers (Streamable HTTP, SSE).
2. `extra._meta` -- the MCP request's `params._meta`, the only per-request channel
   available under the stdio transport.
3. `extra.meta` and `extra` itself, including a nested `headers` object.

`extra` is the last argument the SDK passes a handler, and the only argument when the
tool declared no `inputSchema`; both shapes are handled.

Lookups are case-insensitive, so `Authorization` and `authorization` both resolve. A
header delivered as a single-element array resolves too; a repeated header is treated as
absent rather than resolved to one of its values.

## Caveats

- **HMAC only.** `HS256`, `HS384`, `HS512` are verified. `RS*`, `ES*`, `PS*` throw an
  `AuthError` pointing at [`jose`](https://github.com/panva/jose); use `type: "custom"`
  for those.
- **`api-key` does not identify the caller.** Every valid key authenticates as
  `sub: "api-key-user"` (the payload also carries a `keyPrefix` of the first 8
  characters), so anything keyed off `payload.sub`, such as cache scoping, cannot tell
  two API key holders apart. Use `jwt` or `custom` when the caller identity matters.
- **Tools only.** Resources, prompts, and completions are not intercepted.
- **No session state.** Every call is verified independently; there is no session
  cache and no integration with the SDK's own OAuth support.
- **Apply before `withCache`.** The last middleware applied runs innermost, so
  applying a cache before auth serves cache hits to unauthenticated callers.

## License

[MIT](../../LICENSE)
