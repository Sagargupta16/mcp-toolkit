/**
 * Full middleware stack example
 *
 * Combines auth, rate-limit, cache, cors, and logger into a single
 * MCP server. Shows how all 5 packages work together.
 */

import { createServer } from "@modelcontextprotocol/sdk/server";
import { withAuth } from "@mcp-toolkit/auth";
import { withCache } from "@mcp-toolkit/cache";
import { withRateLimit } from "@mcp-toolkit/rate-limit";
import { withCors } from "@mcp-toolkit/cors";
import { withLogger } from "@mcp-toolkit/logger";

// Compose middleware (innermost runs first)
const server = createServer({
  name: "my-mcp-server",
  version: "1.0.0",
});

// 1. Logger (outermost - logs everything)
withLogger(server, {
  level: "info",
  format: "json",
});

// 2. CORS (for HTTP/SSE transport)
withCors(server, {
  allowedOrigins: ["https://claude.ai", "http://localhost:*"],
  allowedMethods: ["GET", "POST"],
});

// 3. Rate limiting (per API key)
withRateLimit(server, {
  windowMs: 60_000, // 1 minute
  maxRequests: 100,
  keyGenerator: (req) => req.headers["x-api-key"] || req.ip,
});

// 4. Authentication
withAuth(server, {
  type: "bearer",
  validate: async (token) => {
    // Validate against your auth provider
    return token === process.env.MCP_API_TOKEN;
  },
});

// 5. Caching (innermost - caches tool results)
withCache(server, {
  ttl: 300, // 5 minutes
  maxSize: 1000,
  keyGenerator: (toolName, args) => `${toolName}:${JSON.stringify(args)}`,
});

// Define your tools
server.tool("get-data", { query: "string" }, async ({ query }) => {
  // This result will be cached for 5 minutes
  const data = await fetchExpensiveData(query);
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
});

async function fetchExpensiveData(query: string) {
  // Simulate an expensive operation
  return { result: `Data for: ${query}`, timestamp: Date.now() };
}

// Start server
server.listen({ transport: "stdio" });
