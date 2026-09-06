# @mcp-toolkit/cors

Origin allowlist middleware for MCP servers on HTTP or SSE transports.

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
import { withCors } from "@mcp-toolkit/cors";

const server = new McpServer({ name: "demo", version: "1.0.0" });

withCors(server, { allowedOrigins: ["https://claude.ai"] });

server.tool("get-data", "Fetch data", { query: z.string() }, async ({ query }) => ({
  content: [{ type: "text" as const, text: query }],
}));
```

A call whose origin is missing or not in the list rejects with `CorsError`. The MCP
spec requires servers to validate the `Origin` header to prevent DNS rebinding, so an
absent origin is treated as a rejection rather than waved through.

## Options

```typescript
withCors(server, {
  allowedOrigins: ["https://myapp.com"], // or "*" to allow any origin
  allowedMethods: ["GET", "POST"],       // optional and best-effort, see caveats
});
```

The origin is read only from the real HTTP headers the SDK exposes at
`extra.requestInfo.headers`. Lookups are case-insensitive, so the capitalised `Origin`
that browsers actually send resolves, and a header delivered as a single-element array
resolves too.

Request metadata is deliberately not consulted for the origin. `params._meta` (which the
SDK surfaces at `extra._meta`) is JSON-RPC body content the caller writes, so an origin
taken from there is only what the caller claims, and any client could satisfy the
allowlist by naming an allowed origin. `allowedMethods` is the one check that also looks
at metadata, and only because an undetectable method fails open: a method found there can
tighten the check on the caller that supplied it, never loosen it.

## Caveats

- **This is not CORS.** It is an origin allowlist evaluated inside the tool handler.
  There is no preflight (`OPTIONS`) handling and no `Access-Control-*` response headers.
  If a browser talks to your server directly you still need real CORS at the HTTP layer.
- **Useless under stdio.** A stdio transport has no `Origin`, so an allowlist rejects
  every call. Apply this only on Streamable HTTP or SSE.
- **`allowedMethods` is best-effort.** The SDK's `RequestInfo` carries only `headers`
  and `url`, so a tool handler usually cannot see the HTTP method. When it is
  undetectable the request is allowed through, because rejecting everything is never
  what a method allowlist is meant to do. Enforce methods at your HTTP layer.
- **Tools only.** Resources, prompts, and completions are not intercepted.

## License

[MIT](../../LICENSE)
