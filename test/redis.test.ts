/**
 * Integration tests for the Redis / Valkey stores against a real server.
 *
 * Skipped unless `REDIS_URL` is set. CI runs them against a Redis service
 * container; locally, point `REDIS_URL` at any Redis 5+ or Valkey instance.
 * Every key is written under a random prefix and deleted afterwards.
 */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { createClient } from "redis";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";

import { redisCacheStore, withCache } from "@mcp-toolkit/cache";
import { redisRateLimitStore, withRateLimit } from "@mcp-toolkit/rate-limit";

const url = process.env["REDIS_URL"];
const skip = url ? false : "REDIS_URL is not set";
const prefix = `mcp-toolkit-test:${randomUUID()}:`;

const client = url ? createClient({ url }) : undefined;
const connected = client?.connect();
const command = async (args: string[]): Promise<unknown> => {
  await connected;
  return client!.sendCommand(args);
};

after(async () => {
  if (!client) return;
  await connected;
  const keys = await client.keys(`${prefix}*`);
  if (keys.length > 0) await client.del(keys);
  client.destroy();
});

/**
 * Two independent McpServer instances sharing one store, standing in for two
 * replicas behind a load balancer.
 */
async function replica(
  configure: (server: McpServer) => void,
  onCall: () => void,
): Promise<Client> {
  const server = new McpServer({ name: "replica", version: "1.0.0" });
  configure(server);
  server.registerTool("echo", { inputSchema: { msg: z.string() } }, async ({ msg }) => {
    onCall();
    return { content: [{ type: "text" as const, text: `echo:${msg}` }] };
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: "lb", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), mcp.connect(clientTransport)]);
  return mcp;
}

test("redis: a cache entry written by one replica is a hit on the other", { skip }, async () => {
  let calls = 0;
  const store = redisCacheStore(command, { prefix: `${prefix}cache:` });
  const configure = (s: McpServer) => withCache(s, { strategy: "ttl", ttl: 60, store });
  const a = await replica(configure, () => calls++);
  const b = await replica(configure, () => calls++);

  const first = await a.callTool({ name: "echo", arguments: { msg: "shared" } });
  const second = await b.callTool({ name: "echo", arguments: { msg: "shared" } });

  assert.deepEqual(second.content, first.content);
  assert.equal(calls, 1, "replica b was served from the shared cache");
  const ttl = Number(await command(["PTTL", `${prefix}cache:echo:{"msg":"shared"}`]));
  assert.ok(ttl > 0 && ttl <= 60_000, `the entry expires in Redis (PTTL ${ttl})`);
  await Promise.all([a.close(), b.close()]);
});

test("redis: the token bucket is global across replicas", { skip }, async () => {
  const store = redisRateLimitStore(command, { prefix: `${prefix}rl:` });
  const configure = (s: McpServer) =>
    withRateLimit(s, { strategy: "token-bucket", maxTokens: 3, refillRate: 0.01, store });
  const a = await replica(configure, () => {});
  const b = await replica(configure, () => {});

  const results = [];
  for (const mcp of [a, b, a, b]) {
    results.push(await mcp.callTool({ name: "echo", arguments: { msg: "x" } }));
  }

  assert.deepEqual(
    results.map((r) => r.isError === true),
    [false, false, false, true],
    "3 tokens total, not 3 per replica",
  );
  await Promise.all([a.close(), b.close()]);
});

test("redis: concurrent consumes never spend more tokens than the bucket holds", { skip }, async () => {
  const store = redisRateLimitStore(command, { prefix: `${prefix}rl:` });
  const config = { maxTokens: 10, refillRate: 0.001, tokensPerRequest: 1 };

  const outcomes = await Promise.all(
    Array.from({ length: 50 }, () => store.consume("burst", config)),
  );

  assert.equal(outcomes.filter((o) => o.allowed).length, 10);
  const denied = outcomes.find((o) => !o.allowed)!;
  assert.ok(denied.retryAfter > 0, "a denied call reports when to retry");
});

test("redis: tokens refill with time measured by the Redis server", { skip }, async () => {
  const store = redisRateLimitStore(command, { prefix: `${prefix}rl:` });
  const config = { maxTokens: 1, refillRate: 20, tokensPerRequest: 1 };

  assert.equal((await store.consume("refill", config)).allowed, true);
  assert.equal((await store.consume("refill", config)).allowed, false);
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal((await store.consume("refill", config)).allowed, true);

  const ttl = Number(await command(["PTTL", `${prefix}rl:refill`]));
  assert.ok(ttl > 0 && ttl <= 50, `the bucket expires after one refill window (PTTL ${ttl})`);
});
