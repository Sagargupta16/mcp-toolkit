/**
 * Tests for @mcp-toolkit/auth.
 *
 * These run against a minimal fake server rather than the real `McpServer`, so
 * the suite needs neither the SDK nor zod at test time. The fake mirrors the two
 * registration entry points the middleware patches, and records the handler that
 * was actually registered so we can invoke it directly.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

import { AuthError, withAuth } from "./index.js";

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
const handler: Handler = () => OK;

/** Build an HMAC-signed JWT with the given header/payload. */
function signJwt(
  payload: Record<string, unknown>,
  secret: string,
  alg: string = "HS256",
): string {
  const b64 = (value: unknown): string =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const signingInput = `${b64({ alg, typ: "JWT" })}.${b64(payload)}`;
  const signature = createHmac(`sha${alg.slice(2)}`, secret)
    .update(signingInput)
    .digest("base64url");
  return `${signingInput}.${signature}`;
}

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

// ---------------------------------------------------------------------------
// API key strategy
// ---------------------------------------------------------------------------

test("api key: accepts a valid key from request _meta", async () => {
  const server = withAuth(fakeServer(), { type: "api-key", keys: ["secret-key-1"] });
  server.tool("t", "d", {}, handler);

  const result = await server.handlers.get("t")!({}, { _meta: { "x-api-key": "secret-key-1" } });
  assert.deepEqual(result, OK);
});

test("api key: rejects a wrong key of equal length", async () => {
  const server = withAuth(fakeServer(), { type: "api-key", keys: ["secret-key-1"] });
  server.tool("t", "d", {}, handler);

  // Same length as the valid key, so this exercises the timingSafeEqual branch
  // rather than the cheap length mismatch.
  await assert.rejects(
    () => Promise.resolve(server.handlers.get("t")!({}, { _meta: { "x-api-key": "secret-key-9" } })),
    (error: unknown) => error instanceof AuthError && /Invalid API key/.test((error as Error).message),
  );
});

test("api key: rejects a missing credential", async () => {
  const server = withAuth(fakeServer(), { type: "api-key", keys: ["secret-key-1"] });
  server.tool("t", "d", {}, handler);

  await assert.rejects(
    () => Promise.resolve(server.handlers.get("t")!({}, {})),
    (error: unknown) => error instanceof AuthError && /Missing API key/.test((error as Error).message),
  );
});

test("api key: tools registered via registerTool are protected too", async () => {
  const server = withAuth(fakeServer(), { type: "api-key", keys: ["secret-key-1"] });
  let ran = false;
  server.registerTool("t", { description: "d", inputSchema: {} }, () => {
    ran = true;
    return OK;
  });

  await assert.rejects(() => Promise.resolve(server.handlers.get("t")!({}, {})), AuthError);
  assert.equal(ran, false, "handler must not run when authentication fails");
});

test("api key: reads HTTP headers from extra.requestInfo.headers, case-insensitively", async () => {
  const server = withAuth(fakeServer(), { type: "api-key", keys: ["secret-key-1"] });
  server.tool("t", "d", {}, handler);

  const result = await server.handlers.get("t")!(
    {},
    { requestInfo: { headers: { "X-API-Key": "secret-key-1" } } },
  );
  assert.deepEqual(result, OK);
});

test("api key: a schema-less tool gets its credential from the lone extra argument", async () => {
  // A tool registered without an inputSchema is invoked as handler(extra): one
  // argument, no params object. Treating that argument as params left the
  // credential unreadable and rejected every call.
  const server = withAuth(fakeServer(), { type: "api-key", keys: ["secret-key-1"] });
  server.registerTool("t", { description: "d" }, handler);

  const result = await server.handlers.get("t")!({ _meta: { "x-api-key": "secret-key-1" } });
  assert.deepEqual(result, OK);
  await assert.rejects(() => Promise.resolve(server.handlers.get("t")!({})), AuthError);
});

test("api key: a handler swapped in after registration is still guarded", async () => {
  // registerTool returns a RegisteredTool whose update({ callback }) assigns to
  // registered.handler, which would otherwise install an unwrapped handler.
  const server = withAuth(fakeServer(), { type: "api-key", keys: ["secret-key-1"] });
  const registered = server.registerTool("t", {
    description: "d",
    inputSchema: {},
  }, handler) as FakeRegisteredTool;

  let ran = false;
  registered.update({
    callback: () => {
      ran = true;
      return OK;
    },
  });

  await assert.rejects(() => Promise.resolve(registered.handler({}, {})), AuthError);
  assert.equal(ran, false, "a replacement handler must not run unauthenticated");

  assert.deepEqual(
    await registered.handler({}, { _meta: { "x-api-key": "secret-key-1" } }),
    OK,
  );
  assert.equal(ran, true, "the replacement handler runs once authenticated");
});

test("api key: a header delivered as a single-element array resolves", async () => {
  // The SDK types headers as Record<string, string | string[] | undefined>.
  const server = withAuth(fakeServer(), { type: "api-key", keys: ["secret-key-1"] });
  server.tool("t", "d", {}, handler);

  const result = await server.handlers.get("t")!(
    {},
    { requestInfo: { headers: { "x-api-key": ["secret-key-1"] } } },
  );
  assert.deepEqual(result, OK);
});

test("api key: a repeated header is treated as absent rather than picking one", async () => {
  const server = withAuth(fakeServer(), { type: "api-key", keys: ["secret-key-1"] });
  server.tool("t", "d", {}, handler);

  await assert.rejects(
    () =>
      Promise.resolve(
        server.handlers.get("t")!(
          {},
          { requestInfo: { headers: { "x-api-key": ["secret-key-1", "other"] } } },
        ),
      ),
    (error: unknown) => error instanceof AuthError && /Missing API key/.test((error as Error).message),
  );
});

test("api key: an empty key list fails at configuration time", () => {
  assert.throws(
    () => withAuth(fakeServer(), { type: "api-key", keys: [undefined as unknown as string] }),
    /must contain at least one non-empty string/,
  );
});

test("api key: attaches the auth context to extra for downstream middleware", async () => {
  const server = withAuth(fakeServer(), { type: "api-key", keys: ["secret-key-1"] });
  server.tool("t", "d", {}, handler);

  const extra: Record<string, unknown> = { _meta: { "x-api-key": "secret-key-1" } };
  await server.handlers.get("t")!({}, extra);

  const auth = extra["auth"] as { authenticated: boolean; payload?: { sub?: string } };
  assert.equal(auth.authenticated, true);
  assert.equal(auth.payload?.sub, "api-key-user");
});

// ---------------------------------------------------------------------------
// JWT strategy
// ---------------------------------------------------------------------------

const SECRET = "test-secret";

async function callWithToken(token: string, options: Record<string, unknown> = {}): Promise<unknown> {
  const server = withAuth(fakeServer(), {
    type: "jwt",
    secret: SECRET,
    ...options,
  } as Parameters<typeof withAuth>[1]);
  server.tool("t", "d", {}, handler);
  return server.handlers.get("t")!({}, { _meta: { authorization: `Bearer ${token}` } });
}

test("jwt: accepts a valid HS256 token", async () => {
  const token = signJwt({ sub: "user-1", exp: nowSeconds() + 60 }, SECRET);
  assert.deepEqual(await callWithToken(token), OK);
});

test("jwt: rejects an expired token", async () => {
  const token = signJwt({ sub: "user-1", exp: nowSeconds() - 1 }, SECRET);
  await assert.rejects(() => callWithToken(token), /JWT has expired/);
});

test("jwt: honours clockTolerance for a just-expired token", async () => {
  const token = signJwt({ sub: "user-1", exp: nowSeconds() - 5 }, SECRET);
  await assert.rejects(() => callWithToken(token), /JWT has expired/);
  assert.deepEqual(await callWithToken(token, { clockTolerance: 30 }), OK);
});

test("jwt: rejects a token that is not valid yet (nbf)", async () => {
  const token = signJwt({ sub: "user-1", nbf: nowSeconds() + 60 }, SECRET);
  await assert.rejects(() => callWithToken(token), /not yet valid/);
});

test("jwt: rejects an algorithm outside the allowlist", async () => {
  const token = signJwt({ sub: "user-1" }, SECRET, "HS512");
  await assert.rejects(() => callWithToken(token), /is not in the allowed list/);
  assert.deepEqual(await callWithToken(token, { algorithms: ["HS512"] }), OK);
});

test("jwt: rejects a tampered signature", async () => {
  const token = signJwt({ sub: "user-1", exp: nowSeconds() + 60 }, SECRET);
  const [header, payload, signature] = token.split(".");
  // Flip one character of the signature, keeping its length so the comparison
  // reaches timingSafeEqual instead of failing on length.
  const flipped = (signature[0] === "A" ? "B" : "A") + signature.slice(1);
  await assert.rejects(
    () => callWithToken(`${header}.${payload}.${flipped}`),
    /signature verification failed/,
  );
});

test("jwt: rejects a tampered payload", async () => {
  const token = signJwt({ sub: "user-1", exp: nowSeconds() + 60 }, SECRET);
  const [header, , signature] = token.split(".");
  const forged = Buffer.from(JSON.stringify({ sub: "admin", exp: nowSeconds() + 60 })).toString(
    "base64url",
  );
  await assert.rejects(() => callWithToken(`${header}.${forged}.${signature}`), AuthError);
});

test("jwt: asymmetric algorithms are refused with a pointer to a real library", async () => {
  const token = signJwt({ sub: "user-1" }, SECRET, "RS256");
  await assert.rejects(
    () => callWithToken(token, { algorithms: ["RS256"] }),
    /is not supported by the built-in verifier/,
  );
});

test("jwt: rejects a malformed token", async () => {
  await assert.rejects(() => callWithToken("not-a-jwt"), /expected 3 parts/);
});

// ---------------------------------------------------------------------------
// Custom strategy
// ---------------------------------------------------------------------------

test("custom: a rejecting verifier blocks the call", async () => {
  const server = withAuth(fakeServer(), {
    type: "custom",
    verify: async (token) => token === "good",
  });
  server.tool("t", "d", {}, handler);

  assert.deepEqual(await server.handlers.get("t")!({}, { _meta: { authorization: "good" } }), OK);
  await assert.rejects(
    () => Promise.resolve(server.handlers.get("t")!({}, { _meta: { authorization: "bad" } })),
    /rejected the credential/,
  );
});
