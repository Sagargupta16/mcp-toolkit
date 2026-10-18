/**
 * Shared State Example
 *
 * The cache and the rate limit live in Redis (or Valkey) instead of process
 * memory, so every replica of this server sees the same cached results and
 * draws from the same token buckets. Start two copies against one Redis and
 * the limit holds across both.
 *
 * Usage:
 *   REDIS_URL=redis://localhost:6379 npx tsx examples/shared-state-redis.ts
 *
 * Environment variables:
 *   REDIS_URL     - Redis 5+ or Valkey (default: "redis://localhost:6379")
 *   MCP_API_KEY   - Valid API key (default: "dev-api-key-12345")
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createClient } from "redis";
import { z } from "zod";
import { withAuth } from "@mcp-toolkit/auth";
import { redisCacheStore, withCache } from "@mcp-toolkit/cache";
import { createLogger } from "@mcp-toolkit/logger";
import { redisRateLimitStore, withRateLimit } from "@mcp-toolkit/rate-limit";

const logger = createLogger({ level: "info", format: "json" });

const redis = createClient({ url: process.env["REDIS_URL"] ?? "redis://localhost:6379" });
redis.on("error", (error: Error) => logger.error("Redis error", error));

// Both stores take one function that sends a command, so neither package
// depends on a Redis client. With ioredis: (args) => redis.call(args[0]!, ...args.slice(1))
const command = (args: string[]) => redis.sendCommand(args);

const server = new McpServer({ name: "shared-state-server", version: "1.0.0" });

withAuth(server, { type: "api-key", keys: [process.env["MCP_API_KEY"] ?? "dev-api-key-12345"] });

withRateLimit(server, {
  strategy: "token-bucket",
  maxTokens: 5,
  refillRate: 0.5,
  store: redisRateLimitStore(command, { prefix: "shared-state-example:rl:" }),
  onLimited: (info) => logger.warn("Rate limited", { tool: info.toolName, retryAfter: info.retryAfter }),
});

withCache(server, {
  strategy: "ttl",
  ttl: 60,
  store: redisCacheStore(command, { prefix: "shared-state-example:cache:" }),
});

server.registerTool(
  "slow-square",
  {
    description: "Square a number slowly; repeat calls come from the shared cache",
    inputSchema: { n: z.number() },
  },
  async ({ n }) => {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const computedBy = process.pid;
    logger.info("Computed", { n, computedBy });
    return { content: [{ type: "text" as const, text: JSON.stringify({ n, square: n * n, computedBy }) }] };
  },
);

redis
  .connect()
  .then(() => server.connect(new StdioServerTransport()))
  .then(() => logger.info("Shared state server running on stdio"))
  .catch((error: Error) => {
    logger.error("Failed to start", error);
    process.exit(1);
  });
