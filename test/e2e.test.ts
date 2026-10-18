/**
 * End-to-end tests: a real `McpServer` and a real `Client` from the SDK.
 *
 * The package unit tests drive a fake server, which cannot catch the SDK
 * changing how it calls a handler, where it puts headers, or how it turns a
 * thrown error into a result. These tests go through the SDK's own request
 * path, so a Renovate bump that breaks the middleware fails here.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";

import { withAuth } from "@mcp-toolkit/auth";
import { withCache } from "@mcp-toolkit/cache";
import { withCors } from "@mcp-toolkit/cors";
import { withRateLimit } from "@mcp-toolkit/rate-limit";

const API_KEY = "e2e-key";

interface CallResult {
  isError?: boolean;
  content: Array<{ type: string; text?: string }>;
}

/** The text of a tool result's first content block. */
function text(result: unknown): string {
  return (result as CallResult).content[0]?.text ?? "";
}

/** A server with auth, rate limit and cache in the documented order. */
function stackedServer(maxTokens = 100): { server: McpServer; calls: () => number } {
  const server = new McpServer({ name: "e2e", version: "1.0.0" });
  withAuth(server, { type: "api-key", keys: [API_KEY] });
  withRateLimit(server, { strategy: "token-bucket", maxTokens, refillRate: 0.001 });
  withCache(server, { strategy: "lru", ttl: 60, maxSize: 100 });

  let calls = 0;
  server.registerTool(
    "echo",
    { description: "Echo the input", inputSchema: { msg: z.string() } },
    async ({ msg }) => {
      calls += 1;
      return { content: [{ type: "text" as const, text: `echo:${msg}:${calls}` }] };
    },
  );
  server.registerTool("ping", { description: "No input schema" }, async () => {
    calls += 1;
    return { content: [{ type: "text" as const, text: `pong:${calls}` }] };
  });
  return { server, calls: () => calls };
}

/** Connect a client to `server` over the SDK's in-memory transport pair. */
async function connectInMemory(server: McpServer): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "e2e-client", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

// ---------------------------------------------------------------------------
// In-memory transport: credentials travel in params._meta, as under stdio
// ---------------------------------------------------------------------------

test("e2e: a call with no credential is rejected and the handler never runs", async () => {
  const { server, calls } = stackedServer();
  const client = await connectInMemory(server);

  const result = await client.callTool({ name: "echo", arguments: { msg: "hi" } });

  assert.equal((result as CallResult).isError, true);
  assert.match(text(result), /Missing API key/);
  assert.equal(calls(), 0);
  await client.close();
});

test("e2e: a valid key in _meta is accepted and the repeat call is a cache hit", async () => {
  const { server, calls } = stackedServer();
  const client = await connectInMemory(server);
  const call = () =>
    client.callTool({ name: "echo", arguments: { msg: "hi" }, _meta: { "x-api-key": API_KEY } });

  const first = await call();
  const second = await call();

  assert.equal((first as CallResult).isError, undefined);
  assert.equal(text(first), "echo:hi:1");
  assert.equal(text(second), "echo:hi:1", "served from the cache");
  assert.equal(calls(), 1);
  await client.close();
});

test("e2e: a schema-less tool registered with registerTool is wrapped too", async () => {
  const { server } = stackedServer();
  const client = await connectInMemory(server);

  const denied = await client.callTool({ name: "ping" });
  const allowed = await client.callTool({ name: "ping", _meta: { "x-api-key": API_KEY } });

  assert.equal((denied as CallResult).isError, true);
  assert.equal(text(allowed), "pong:1");
  await client.close();
});

test("e2e: the rate limit rejects once the bucket is empty", async () => {
  const { server } = stackedServer(2);
  const client = await connectInMemory(server);
  const call = (msg: string) =>
    client.callTool({ name: "echo", arguments: { msg }, _meta: { "x-api-key": API_KEY } });

  await call("a");
  await call("b");
  const limited = await call("c");

  assert.equal((limited as CallResult).isError, true);
  assert.match(text(limited), /Rate limited/);
  await client.close();
});

test("e2e: a handler swapped in through RegisteredTool.update stays wrapped", async () => {
  const server = new McpServer({ name: "e2e", version: "1.0.0" });
  withAuth(server, { type: "api-key", keys: [API_KEY] });
  const tool = server.registerTool("swap", { description: "d" }, async () => ({
    content: [{ type: "text" as const, text: "old" }],
  }));
  tool.update({ callback: async () => ({ content: [{ type: "text" as const, text: "new" }] }) });
  const client = await connectInMemory(server);

  const denied = await client.callTool({ name: "swap" });
  const allowed = await client.callTool({ name: "swap", _meta: { "x-api-key": API_KEY } });

  assert.equal((denied as CallResult).isError, true);
  assert.equal(text(allowed), "new");
  await client.close();
});

// ---------------------------------------------------------------------------
// Streamable HTTP: credential and Origin travel as real HTTP headers
// ---------------------------------------------------------------------------

/**
 * Serve over stateless Streamable HTTP on an ephemeral localhost port.
 *
 * Stateless mode builds a fresh server and transport per request, the pattern
 * the SDK documents for it, so `makeServer` applies the middleware each time.
 */
async function serveHttp(
  makeServer: () => McpServer,
): Promise<{ url: URL; close: () => Promise<void> }> {
  const http: Server = createServer(async (req, res) => {
    const server = makeServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const { port } = http.address() as AddressInfo;
  return {
    url: new URL(`http://127.0.0.1:${port}/mcp`),
    close: () => new Promise<void>((resolve) => http.close(() => resolve())),
  };
}

async function httpCall(url: URL, headers: Record<string, string>): Promise<unknown> {
  const client = new Client({ name: "e2e-http", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers } }));
  try {
    return await client.callTool({ name: "echo", arguments: { msg: "hi" } });
  } finally {
    await client.close();
  }
}

test("e2e (HTTP): Origin and API key headers are checked on the real request", async () => {
  const { url, close } = await serveHttp(() => {
    const server = new McpServer({ name: "e2e-http", version: "1.0.0" });
    withCors(server, { allowedOrigins: ["https://allowed.example"] });
    withAuth(server, { type: "api-key", keys: [API_KEY] });
    server.registerTool("echo", { inputSchema: { msg: z.string() } }, async ({ msg }) => ({
      content: [{ type: "text" as const, text: `echo:${msg}` }],
    }));
    return server;
  });

  try {
    const ok = await httpCall(url, { Origin: "https://allowed.example", "X-API-Key": API_KEY });
    assert.equal(text(ok), "echo:hi");

    const badOrigin = await httpCall(url, { Origin: "https://evil.example", "X-API-Key": API_KEY });
    assert.equal((badOrigin as CallResult).isError, true);
    assert.match(text(badOrigin), /evil\.example/);

    const noKey = await httpCall(url, { Origin: "https://allowed.example" });
    assert.equal((noKey as CallResult).isError, true);
    assert.match(text(noKey), /Missing API key/);
  } finally {
    await close();
  }
});
