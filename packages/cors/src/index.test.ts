/**
 * Tests for @mcp-toolkit/cors.
 *
 * These run against a minimal fake server rather than the real `McpServer`, so
 * the suite needs neither the SDK nor zod at test time.
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

function fakeServer(): FakeServer {
  const handlers = new Map<string, Handler>();
  const record = (...args: unknown[]): unknown => {
    const name = args[0] as string;
    handlers.set(name, args[args.length - 1] as Handler);
    return { name };
  };
  return { handlers, tool: record, registerTool: record };
}

const OK = { content: [{ type: "text", text: "ok" }] };
const ALLOWED = "https://claude.ai";

/** Register one tool behind withCors and return a callable for it. */
function guarded(options: Parameters<typeof withCors>[1]): (extra: unknown) => unknown {
  const server = withCors(fakeServer(), options);
  server.tool("t", "d", {}, () => OK);
  return (extra: unknown) => server.handlers.get("t")!({}, extra);
}

// ---------------------------------------------------------------------------
// Origin allowlist
// ---------------------------------------------------------------------------

test("origin: an allowed origin passes", async () => {
  const call = guarded({ allowedOrigins: [ALLOWED] });
  assert.deepEqual(await call({ headers: { origin: ALLOWED } }), OK);
});

test("origin: header lookup is case-insensitive", async () => {
  const call = guarded({ allowedOrigins: [ALLOWED] });
  assert.deepEqual(await call({ headers: { Origin: ALLOWED } }), OK);
});

test("origin: real HTTP headers at extra.requestInfo.headers are read", async () => {
  const call = guarded({ allowedOrigins: [ALLOWED] });
  assert.deepEqual(await call({ requestInfo: { headers: { Origin: ALLOWED } } }), OK);
});

test("origin: a disallowed origin is blocked", async () => {
  const call = guarded({ allowedOrigins: [ALLOWED] });
  await assert.rejects(
    () => Promise.resolve(call({ headers: { origin: "https://evil.example" } })),
    (error: unknown) => error instanceof CorsError && /evil\.example/.test((error as Error).message),
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
  assert.deepEqual(await call({ headers: { origin: "https://anything.example" } }), OK);
  assert.deepEqual(await call({}), OK);
});

test("origin: tools registered via registerTool are guarded too", async () => {
  const server = withCors(fakeServer(), { allowedOrigins: [ALLOWED] });
  server.registerTool("t", { description: "d", inputSchema: {} }, () => OK);

  await assert.rejects(() => Promise.resolve(server.handlers.get("t")!({}, {})), CorsError);
  assert.deepEqual(await server.handlers.get("t")!({}, { headers: { origin: ALLOWED } }), OK);
});

// ---------------------------------------------------------------------------
// Method allowlist
// ---------------------------------------------------------------------------

test("method: an undetectable method fails open", async () => {
  // No MCP transport surfaces the HTTP method to a tool handler, so requiring
  // one would reject every call. Absence must not block.
  const call = guarded({ allowedOrigins: [ALLOWED], allowedMethods: ["GET", "POST"] });
  assert.deepEqual(await call({ headers: { origin: ALLOWED } }), OK);
});

test("method: a disallowed method is blocked when one is present", async () => {
  const call = guarded({ allowedOrigins: [ALLOWED], allowedMethods: ["GET", "POST"] });
  await assert.rejects(
    () => Promise.resolve(call({ headers: { origin: ALLOWED, method: "DELETE" } })),
    CorsMethodError,
  );
});

test("method: comparison is case-insensitive on both sides", async () => {
  const call = guarded({ allowedOrigins: [ALLOWED], allowedMethods: ["post"] });
  assert.deepEqual(await call({ headers: { origin: ALLOWED, method: "POST" } }), OK);
});
