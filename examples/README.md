# Examples

Three runnable MCP servers built with the toolkit.

| File | What it shows |
|------|---------------|
| [basic-auth-server.ts](basic-auth-server.ts) | API key auth, JWT auth, reading the auth context in a handler |
| [full-middleware-stack.ts](full-middleware-stack.ts) | All five packages composed on one server |
| [production-server.ts](production-server.ts) | Auth + rate limit + cache + logging with realistic tools and stats |

## Prerequisites

Build the workspace first. The examples import the packages by their published names
(`@mcp-toolkit/auth` and friends), which npm workspaces resolve to each package's
`dist/`, so an unbuilt checkout fails at import time:

```bash
npm install
npm run build
```

The examples are run with [`tsx`](https://github.com/privatenumber/tsx), which is not a
dependency of this repo. `npx tsx` fetches it on demand:

```bash
npx tsx examples/basic-auth-server.ts
```

`examples/` is typechecked by `npm run typecheck:examples`, which CI runs, so these
files stay compilable against the current SDK.

## Environment variables

| Variable | Used by | Default |
|----------|---------|---------|
| `MCP_API_KEY` | all three | `dev-api-key-12345` (basic, full), `prod-key-abc123` (production) |
| `JWT_SECRET` | basic-auth-server (`jwt` mode) | `super-secret-jwt-key` |
| `MCP_ALLOWED_ORIGINS` | full-middleware-stack | unset, so the origin allowlist is skipped |
| `LOG_LEVEL` | production-server | `info` |
| `LOG_FILE` | production-server | unset, so logs go to stderr only |

The defaults are development placeholders. Set real values before exposing any of these.

`basic-auth-server.ts` takes a mode argument: `npx tsx examples/basic-auth-server.ts jwt`
starts the JWT variant instead of the API key one.

## Exercising a running server

### With the MCP Inspector

```bash
npx @modelcontextprotocol/inspector npx tsx examples/production-server.ts
```

The Inspector lists the tools and calls them interactively. Note that a call it sends
carries no credential, so every tool answers with an auth error -- which is itself the
useful signal that the middleware is active.

### With raw JSON-RPC on stdin

To see auth accept and reject, the credential has to travel somewhere the server can
read it. Under stdio that is the request's `params._meta`:

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"1.0.0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"greet","arguments":{"name":"Sagar"},"_meta":{"x-api-key":"dev-api-key-12345"}}}' \
  '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"greet","arguments":{"name":"Sagar"}}}' \
  | npx tsx examples/basic-auth-server.ts
```

Request `2` returns the greeting; request `3` returns
`Missing API key in "x-api-key" header`. On a Streamable HTTP or SSE transport the same
credential arrives as a real HTTP header instead.

## What these examples do not show

Every example uses `StdioServerTransport`, so:

- Logs go to `stderr`. Writing them to `stdout` would corrupt the JSON-RPC stream, which
  is why the logger defaults to `stderr`.
- `withCors` has no `Origin` to validate. `full-middleware-stack.ts` applies it only when
  `MCP_ALLOWED_ORIGINS` is set, because an allowlist with no origin present rejects every
  call by design.

See the root [README](../README.md#limitations-and-compatibility) for the full list of
limitations.
