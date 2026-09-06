/**
 * Full middleware stack example
 *
 * Combines auth, rate-limit, cache, cors, and logger into a single
 * MCP server. Shows how all 5 packages work together.
 *
 * Usage:
 *   npx tsx examples/full-middleware-stack.ts
 *
 * Environment variables:
 *   MCP_API_KEY          - A valid API key for authenticating requests
 *   MCP_ALLOWED_ORIGINS  - Comma-separated origin allowlist. Only meaningful on
 *                          an HTTP/SSE transport; leave unset for stdio.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { withAuth } from "@mcp-toolkit/auth";
import { withCache } from "@mcp-toolkit/cache";
import { withRateLimit } from "@mcp-toolkit/rate-limit";
import { withCors } from "@mcp-toolkit/cors";
import { createLogger } from "@mcp-toolkit/logger";

// Logger is a standalone helper (not server middleware); create it up front.
const logger = createLogger({
  level: "info",
  format: "json",
  defaultMeta: { service: "my-mcp-server" },
});

const server = new McpServer({
  name: "my-mcp-server",
  version: "1.0.0",
});

// Compose middleware. Each `with*` wraps the registration methods, so tools
// registered afterwards run through the whole stack -- and the LAST middleware
// applied is the INNERMOST one at call time. Apply auth before cache, never
// after, or a cache hit is served without authenticating the caller.

// 1. CORS (HTTP/SSE transport only) - validate request origins.
// Under stdio there is no Origin header to inspect, so an allowlist would reject
// every call. Apply it only when origins have actually been configured.
const allowedOrigins = process.env["MCP_ALLOWED_ORIGINS"]
  ?.split(",")
  .map((origin) => origin.trim())
  .filter((origin) => origin.length > 0);

if (allowedOrigins && allowedOrigins.length > 0) {
  withCors(server, { allowedOrigins });
}

// 2. Authentication
withAuth(server, {
  type: "api-key",
  keys: [process.env["MCP_API_KEY"] ?? "dev-api-key-12345"],
  header: "x-api-key",
});

// 3. Rate limiting (token bucket)
withRateLimit(server, {
  strategy: "token-bucket",
  maxTokens: 100,
  refillRate: 10, // tokens per second
});

// 4. Caching (caches tool results)
withCache(server, {
  strategy: "lru",
  ttl: 300, // 5 minutes
  maxSize: 1000,
});

// Define your tools
server.tool(
  "get-data",
  "Fetch data with auth + cache + rate limiting",
  {
    query: z.string().describe("Search query"),
  },
  async ({ query }) => {
    // This result will be cached for 5 minutes
    logger.info("Fetching data", { query });
    const data = await fetchExpensiveData(query);
    return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
  },
);

async function fetchExpensiveData(query: string) {
  // Simulate an expensive operation
  return { result: `Data for: ${query}`, timestamp: Date.now() };
}

// Start server
async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("Server is running and accepting connections");
}

main().catch((err) => {
  logger.error("Fatal error during startup", err as Error);
  process.exit(1);
});
