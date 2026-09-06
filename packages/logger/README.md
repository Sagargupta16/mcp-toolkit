# @mcp-toolkit/logger

Structured logging for MCP servers. JSON or text, log levels, pluggable transports.

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
import { createLogger } from "@mcp-toolkit/logger";

const logger = createLogger({
  level: "info",
  format: "json",
  defaultMeta: { service: "my-mcp-server" },
});

logger.info("Server started", { port: 3000 });
logger.error("Something failed", new Error("oops"));

const requestLogger = logger.child({ requestId: "r-1" });
requestLogger.debug("handling request");
```

This is a standalone helper, not server middleware: there is no `withLogger`. It never
touches the MCP server object.

## Options

```typescript
createLogger({
  level: "info",            // "debug" | "info" | "warn" | "error", default "info"
  format: "json",           // "json" | "text", default "json"
  transports: ["stderr"],   // default ["stderr"]
  defaultMeta: {},          // merged into every entry
});
```

Transports are `"stdout"`, `"stderr"`, or `{ type: "file", path: "./app.log" }`, and you
can pass several. A file transport creates parent directories and falls back to stderr
if the write fails. `nullLogger` is exported for tests.

## Do not log to stdout on a stdio server

The default is `stderr` on purpose. Per the
[MCP transports spec](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports),
a stdio server "MUST NOT write anything to its `stdout` that is not a valid MCP
message", and "MAY write UTF-8 strings to its standard error (`stderr`) for logging
purposes". A JSON log line on stdout is interleaved into the JSON-RPC stream and
corrupts the session. Only choose `"stdout"` when the server does not speak MCP over
stdio.

## Caveats

- **Synchronous writes.** Entries are written with `process.stderr.write` and
  `appendFileSync`, so a slow disk blocks the event loop. There is no batching or
  rotation.
- **No redaction.** Whatever you pass in `data` is serialised verbatim; do not hand it
  credentials or tokens.
- **`setLevel` is per logger instance.** Children created before the change keep the
  level they were created with.

## License

[MIT](../../LICENSE)
