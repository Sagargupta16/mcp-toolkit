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
 *   MCP_API_KEY - A valid API key for authenticating requests
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
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

// Compose middleware. Each `with*` wraps `server.tool` so tools registered
// afterwards run through the whole stack.

// 1. CORS (for HTTP/SSE transport) - validate request origins
withCors(server, {
  allowedOrigins: ["https://claude.ai"],
  allowedMethods: ["GET", "POST"],
});

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
    query: { type: "string", description: "Search query" },
  },
  async ({ query }: { query: string }) => {
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
