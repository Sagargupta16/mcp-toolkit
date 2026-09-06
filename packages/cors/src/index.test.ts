/**
 * Tests for @mcp-toolkit/cors.
 *
 * These run against a minimal fake server rather than the real `McpServer`, so
 * the suite needs neither the SDK nor zod.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { CorsError, CorsMethodError, withCors } from "./index.js";

type Handler = (...args: unknown[]) => unknown;

interface FakeServer {
  tool: (...args: any[]) => any;
  registerTool: (...args: any[]) => any;
  handlers: Map<string, Handler>;
}

/** The `RegisteredTool` shape the SDK returns: `update` assigns to `handler`. */
interface FakeRegisteredTool {
  name: string;
  handler: Handler;
  update: (updates: { callback?: Handler }) => void;
}

function fakeServer(): FakeServer {
  const handlers = new Map<string, Handler>();
  const record = (...args: unknown[]): FakeRegisteredTool => {
    const name = args[0] as string;
    const registered: FakeRegisteredTool = {
      name,
      handler: args[args.length - 1] as Handler,
      update: (updates) => {
        if (updates.callback) registered.handler = updates.callback;
      },
    };
    handlers.set(name, registered.handler);
    return registered;
  };
  return { handlers, tool: record, registerTool: record };
}

const OK = { content: [{ type: "text", text: "ok" }] };
const ALLOWED = "https://claude.ai";

/** An `extra` carrying the given HTTP headers where the transport puts them. */
function httpExtra(headers: Record<string, unknown>): Record<string, unknown> {
  return { requestInfo: { headers, url: "https://server.example/mcp" } };
}

/** Register one tool behind withCors and return a callable for it. */
function guarded(options: Parameters<typeof withCors>[1]): (extra: unknown) => unknown {
  const server = withCors(fakeServer(), options);
  server.tool("t", "d", {}, () => OK);
  return (extra: unknown) => server.handlers.get("t")!({}, extra);
}

// ---------------------------------------------------------------------------
// Origin allowlist
// ---------------------------------------------------------------------------

test("origin: an allowed origin in the real HTTP headers passes", async () => {
  const call = guarded({ allowedOrigins: [ALLOWED] });
  assert.deepEqual(await call(httpExtra({ origin: ALLOWED })), OK);
});

test("origin: header lookup is case-insensitive", async () => {
  const call = guarded({ allowedOrigins: [ALLOWED] });
  assert.deepEqual(await call(httpExtra({ Origin: ALLOWED })), OK);
});

test("origin: a header delivered as a single-element array resolves", async () => {
  // The SDK types headers as Record<string, string | string[] | undefined>.
  const call = guarded({ allowedOrigins: [ALLOWED] });
  assert.deepEqual(await call(httpExtra({ Origin: [ALLOWED] })), OK);
});

test("origin: a repeated Origin header is treated as absent, not resolved to one", async () => {
  const call = guarded({ allowedOrigins: [ALLOWED] });
  await assert.rejects(
    () => Promise.resolve(call(httpExtra({ Origin: [ALLOWED, "https://evil.example"] }))),
    CorsError,
  );
});

test("origin: a disallowed origin is blocked", async () => {
  const call = guarded({ allowedOrigins: [ALLOWED] });
  await assert.rejects(
    () => Promise.resolve(call(httpExtra({ origin: "https://evil.example" }))),
    (error: unknown) => error instanceof CorsError && /evil\.example/.test((error as Error).message),
  );
});

test("origin: request metadata cannot satisfy the allowlist", async () => {
  // params._meta is JSON-RPC body content the caller writes, so an origin read
  // from it would let any client claim an allowed origin. Origin is only ever
  // taken from the headers the transport captured.
  const call = guarded({ allowedOrigins: [ALLOWED] });
  await assert.rejects(() => Promise.resolve(call({ _meta: { origin: ALLOWED } })), CorsError);
  await assert.rejects(() => Promise.resolve(call({ origin: ALLOWED })), CorsError);
  await assert.rejects(
    () => Promise.resolve(call({ ...httpExtra({ host: "server.example" }), _meta: { origin: ALLOWED } })),
    CorsError,
  );
});

test("origin: a missing origin is blocked when an allowlist is configured", async () => {
  // Blocking here is deliberate: the MCP spec requires servers to validate the
  // Origin header to prevent DNS rebinding, so an absent origin cannot pass.
  const call = guarded({ allowedOrigins: [ALLOWED] });
  await assert.rejects(() => Promise.resolve(call({})), CorsError);
});

test('origin: "*" allows any origin, including none', async () => {
  const call = guarded({ allowedOrigins: "*" });
  assert.deepEqual(await call(httpExtra({ origin: "https://anything.example" })), OK);
  assert.deepEqual(await call({}), OK);
});

test("origin: tools registered via registerTool are guarded too", async () => {
  const server = withCors(fakeServer(), { allowedOrigins: [ALLOWED] });
  server.registerTool("t", { description: "d", inputSchema: {} }, () => OK);

  await assert.rejects(() => Promise.resolve(server.handlers.get("t")!({}, {})), CorsError);
  assert.deepEqual(await server.handlers.get("t")!({}, httpExtra({ origin: ALLOWED })), OK);
});

test("origin: a schema-less tool is guarded from its lone extra argument", async () => {
  // A tool registered without an inputSchema is invoked as handler(extra): one
  // argument, no params object. Treating that argument as params left the origin
  // unreadable, so every call was rejected even from an allowed origin.
  const server = withCors(fakeServer(), { allowedOrigins: [ALLOWED] });
  server.registerTool("t", { description: "d" }, () => OK);

  assert.deepEqual(await server.handlers.get("t")!(httpExtra({ origin: ALLOWED })), OK);
  await assert.rejects(
    () => Promise.resolve(server.handlers.get("t")!(httpExtra({ origin: "https://evil.example" }))),
    CorsError,
  );
});

test("origin: a handler swapped in after registration is still guarded", async () => {
  const server = withCors(fakeServer(), { allowedOrigins: [ALLOWED] });
  const registered = server.registerTool("t", {
    description: "d",
    inputSchema: {},
  }, () => OK) as FakeRegisteredTool;

  let ran = false;
  registered.update({
    callback: () => {
      ran = true;
      return OK;
    },
  });

  await assert.rejects(() => Promise.resolve(registered.handler({}, {})), CorsError);
  assert.equal(ran, false, "a replacement handler must not run for a blocked origin");
  assert.deepEqual(await registered.handler({}, httpExtra({ origin: ALLOWED })), OK);
  assert.equal(ran, true, "the replacement handler runs for an allowed origin");
});

// ---------------------------------------------------------------------------
// Method allowlist
// ---------------------------------------------------------------------------

test("method: an undetectable method fails open", async () => {
  // No MCP transport surfaces the HTTP method to a tool handler, so requiring
  // one would reject every call. Absence must not block.
  const call = guarded({ allowedOrigins: [ALLOWED], allowedMethods: ["GET", "POST"] });
  assert.deepEqual(await call(httpExtra({ origin: ALLOWED })), OK);
});

test("method: a disallowed method is blocked when one is present", async () => {
  const call = guarded({ allowedOrigins: [ALLOWED], allowedMethods: ["GET", "POST"] });
  await assert.rejects(
    () =>
      Promise.resolve(
        call({ ...httpExtra({ origin: ALLOWED }), _meta: { method: "DELETE" } }),
      ),
    CorsMethodError,
  );
});

test("method: comparison is case-insensitive on both sides", async () => {
  const call = guarded({ allowedOrigins: [ALLOWED], allowedMethods: ["post"] });
  assert.deepEqual(
    await call({ ...httpExtra({ origin: ALLOWED }), _meta: { method: "POST" } }),
    OK,
  );
});
