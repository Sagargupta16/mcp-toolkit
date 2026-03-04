/**
 * Basic Auth Server Example
 *
 * Demonstrates how to create an MCP server with API key and JWT authentication
 * using @mcp-toolkit/auth.
 *
 * Usage:
 *   npx tsx examples/basic-auth-server.ts
 *
 * Environment variables:
 *   MCP_API_KEY  - A valid API key for authenticating requests
 *   JWT_SECRET   - Secret for verifying JWT tokens
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { withAuth, AuthError } from "@mcp-toolkit/auth";
import { createLogger } from "@mcp-toolkit/logger";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const API_KEYS = [
  process.env["MCP_API_KEY"] ?? "dev-api-key-12345",
];

const JWT_SECRET = process.env["JWT_SECRET"] ?? "super-secret-jwt-key";

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

const logger = createLogger({
  level: "info",
  format: "json",
  defaultMeta: { service: "basic-auth-server" },
});

// ---------------------------------------------------------------------------
// Server setup — API Key authentication
// ---------------------------------------------------------------------------

async function startApiKeyServer(): Promise<void> {
  const server = new McpServer({
    name: "basic-auth-api-key",
    version: "1.0.0",
  });

  // Apply API key authentication
  withAuth(server, {
    type: "api-key",
    keys: API_KEYS,
    header: "x-api-key",
  });

  // Register a simple tool
  server.tool(
    "greet",
    "Greet a user by name",
    {
      name: { type: "string", description: "The name to greet" },
    },
    async ({ name }: { name: string }) => {
      logger.info("Greeting user", { name });
      return {
        content: [
          {
            type: "text" as const,
            text: `Hello, ${name}! You have been successfully authenticated.`,
          },
        ],
      };
    },
  );

  // Register a tool that accesses auth context
  server.tool(
    "whoami",
    "Return information about the authenticated caller",
    {},
    async (_params: Record<string, unknown>, extra: Record<string, unknown>) => {
      const auth = extra?.["auth"] as
        | { authenticated: boolean; payload?: Record<string, unknown> }
        | undefined;

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                authenticated: auth?.authenticated ?? false,
                payload: auth?.payload ?? null,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  logger.info("Starting API Key auth server...");

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// ---------------------------------------------------------------------------
// Server setup — JWT authentication
// ---------------------------------------------------------------------------

async function startJwtServer(): Promise<void> {
  const server = new McpServer({
    name: "basic-auth-jwt",
    version: "1.0.0",
  });

  // Apply JWT authentication
  withAuth(server, {
    type: "jwt",
    secret: JWT_SECRET,
    algorithms: ["HS256"],
    clockTolerance: 5,
  });

  // Register tools
  server.tool(
    "get-secret-data",
    "Retrieve secret data (requires JWT auth)",
    {
      category: { type: "string", description: "Data category to fetch" },
    },
    async ({ category }: { category: string }) => {
      logger.info("Fetching secret data", { category });

      const secrets: Record<string, string> = {
        finance: "Q4 revenue: $1.2M",
        engineering: "Next release: v2.0 on March 15",
        hr: "Team size: 42 engineers",
      };

      const data = secrets[category] ?? "No data found for that category";

      return {
        content: [{ type: "text" as const, text: data }],
      };
    },
  );

  logger.info("Starting JWT auth server...");

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const mode = process.argv[2] ?? "api-key";

if (mode === "jwt") {
  startJwtServer().catch((err) => {
    logger.error("Failed to start JWT server", err as Error);
    process.exit(1);
  });
} else {
  startApiKeyServer().catch((err) => {
    logger.error("Failed to start API Key server", err as Error);
    process.exit(1);
  });
}
