/**
 * Production Server Example
 *
 * A complete MCP server using all four middleware packages:
 *   - @mcp-toolkit/auth       (API key authentication)
 *   - @mcp-toolkit/cache      (LRU response caching)
 *   - @mcp-toolkit/rate-limit (Token bucket rate limiting)
 *   - @mcp-toolkit/logger     (Structured JSON logging)
 *
 * This example simulates a data-fetching server that might proxy external APIs.
 * Every tool call is authenticated, rate-limited, cached, and logged.
 *
 * Usage:
 *   npx tsx examples/production-server.ts
 *
 * Environment variables:
 *   MCP_API_KEY   - Valid API key (default: "prod-key-abc123")
 *   LOG_LEVEL     - Minimum log level (default: "info")
 *   LOG_FILE      - Optional path to a log file
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { withAuth } from "@mcp-toolkit/auth";
import { withCache, getCache } from "@mcp-toolkit/cache";
import { withRateLimit } from "@mcp-toolkit/rate-limit";
import { createLogger, type Logger, type LogLevel, type Transport } from "@mcp-toolkit/logger";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const CONFIG = {
  serverName: "production-mcp-server",
  serverVersion: "1.0.0",

  // Auth
  apiKeys: [process.env["MCP_API_KEY"] ?? "prod-key-abc123"],

  // Rate limiting
  maxTokens: 60,       // 60 requests capacity
  refillRate: 5,       // 5 tokens per second

  // Cache
  cacheTtl: 120,       // 2 minutes
  cacheMaxSize: 500,

  // Logging
  logLevel: (process.env["LOG_LEVEL"] ?? "info") as LogLevel,
  logFile: process.env["LOG_FILE"],
} as const;

// ---------------------------------------------------------------------------
// Logger setup
// ---------------------------------------------------------------------------

const transports: Transport[] = ["stdout"];
if (CONFIG.logFile) {
  transports.push({ type: "file", path: CONFIG.logFile });
}

const logger: Logger = createLogger({
  level: CONFIG.logLevel,
  format: "json",
  transports,
  defaultMeta: {
    service: CONFIG.serverName,
    version: CONFIG.serverVersion,
  },
});

// ---------------------------------------------------------------------------
// Simulated data sources
// ---------------------------------------------------------------------------

/** Simulate an external API call with some latency. */
async function simulateApiCall<T>(name: string, data: T, delayMs: number = 200): Promise<T> {
  logger.debug("External API call started", { api: name, delayMs });
  await new Promise((resolve) => setTimeout(resolve, delayMs));
  logger.debug("External API call completed", { api: name });
  return data;
}

interface WeatherData {
  city: string;
  temperature: number;
  unit: string;
  condition: string;
  humidity: number;
  updatedAt: string;
}

async function fetchWeather(city: string): Promise<WeatherData> {
  // Simulated weather data
  const conditions = ["Sunny", "Cloudy", "Rainy", "Partly Cloudy", "Windy"];
  const condition = conditions[Math.floor(Math.random() * conditions.length)];
  const temperature = Math.round(15 + Math.random() * 20);
  const humidity = Math.round(30 + Math.random() * 60);

  return simulateApiCall("weather", {
    city,
    temperature,
    unit: "celsius",
    condition,
    humidity,
    updatedAt: new Date().toISOString(),
  });
}

interface StockData {
  symbol: string;
  price: number;
  currency: string;
  change: number;
  changePercent: number;
  updatedAt: string;
}

async function fetchStockPrice(symbol: string): Promise<StockData> {
  const basePrice = symbol.length * 42.5 + 100;
  const change = Math.round((Math.random() - 0.5) * 10 * 100) / 100;

  return simulateApiCall("stocks", {
    symbol: symbol.toUpperCase(),
    price: Math.round((basePrice + change) * 100) / 100,
    currency: "USD",
    change,
    changePercent: Math.round((change / basePrice) * 10000) / 100,
    updatedAt: new Date().toISOString(),
  });
}

interface UserProfile {
  id: string;
  name: string;
  email: string;
  role: string;
  lastLogin: string;
}

async function fetchUserProfile(userId: string): Promise<UserProfile> {
  return simulateApiCall("users", {
    id: userId,
    name: `User ${userId}`,
    email: `user-${userId}@example.com`,
    role: "member",
    lastLogin: new Date().toISOString(),
  });
}

// ---------------------------------------------------------------------------
// Server setup
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const server = new McpServer({
    name: CONFIG.serverName,
    version: CONFIG.serverVersion,
  });

  // -----------------------------------------------------------------------
  // Middleware stack (order matters!)
  //
  // 1. Auth runs first — reject unauthenticated requests immediately
  // 2. Rate limiting runs second — prevent abuse before doing real work
  // 3. Cache runs last — serve cached responses to avoid redundant computation
  // -----------------------------------------------------------------------

  logger.info("Applying middleware stack");

  // 1. Authentication
  withAuth(server, {
    type: "api-key",
    keys: [...CONFIG.apiKeys],
    header: "x-api-key",
  });
  logger.info("Auth middleware applied", { strategy: "api-key" });

  // 2. Rate limiting
  withRateLimit(server, {
    strategy: "token-bucket",
    maxTokens: CONFIG.maxTokens,
    refillRate: CONFIG.refillRate,
    onLimited: (info) => {
      logger.warn("Request rate-limited", {
        tool: info.toolName,
        retryAfter: info.retryAfter,
        remaining: info.remaining,
      });
    },
  });
  logger.info("Rate limit middleware applied", {
    maxTokens: CONFIG.maxTokens,
    refillRate: CONFIG.refillRate,
  });

  // 3. Caching
  withCache(server, {
    strategy: "lru",
    ttl: CONFIG.cacheTtl,
    maxSize: CONFIG.cacheMaxSize,
  });
  logger.info("Cache middleware applied", {
    ttl: CONFIG.cacheTtl,
    maxSize: CONFIG.cacheMaxSize,
  });

  // -----------------------------------------------------------------------
  // Tool: get-weather
  // -----------------------------------------------------------------------
  server.tool(
    "get-weather",
    "Get current weather for a city (cached for 2 minutes)",
    {
      city: { type: "string", description: "City name (e.g. 'London', 'Tokyo')" },
    },
    async ({ city }: { city: string }) => {
      logger.info("Tool invoked: get-weather", { city });

      const weather = await fetchWeather(city);

      logger.info("Weather data retrieved", {
        city: weather.city,
        temperature: weather.temperature,
      });

      return {
        content: [
          {
            type: "text" as const,
            text: [
              `Weather for ${weather.city}:`,
              `  Temperature: ${weather.temperature}°${weather.unit === "celsius" ? "C" : "F"}`,
              `  Condition:   ${weather.condition}`,
              `  Humidity:    ${weather.humidity}%`,
              `  Updated:     ${weather.updatedAt}`,
            ].join("\n"),
          },
        ],
      };
    },
  );

  // -----------------------------------------------------------------------
  // Tool: get-stock-price
  // -----------------------------------------------------------------------
  server.tool(
    "get-stock-price",
    "Get the current stock price for a ticker symbol (cached for 2 minutes)",
    {
      symbol: { type: "string", description: "Stock ticker symbol (e.g. 'AAPL', 'GOOGL')" },
    },
    async ({ symbol }: { symbol: string }) => {
      logger.info("Tool invoked: get-stock-price", { symbol });

      const stock = await fetchStockPrice(symbol);

      const direction = stock.change >= 0 ? "+" : "";
      logger.info("Stock data retrieved", {
        symbol: stock.symbol,
        price: stock.price,
      });

      return {
        content: [
          {
            type: "text" as const,
            text: [
              `${stock.symbol}: $${stock.price} ${stock.currency}`,
              `  Change: ${direction}${stock.change} (${direction}${stock.changePercent}%)`,
              `  Updated: ${stock.updatedAt}`,
            ].join("\n"),
          },
        ],
      };
    },
  );

  // -----------------------------------------------------------------------
  // Tool: get-user-profile
  // -----------------------------------------------------------------------
  server.tool(
    "get-user-profile",
    "Look up a user profile by ID",
    {
      userId: { type: "string", description: "User ID to look up" },
    },
    async ({ userId }: { userId: string }) => {
      logger.info("Tool invoked: get-user-profile", { userId });

      const profile = await fetchUserProfile(userId);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(profile, null, 2),
          },
        ],
      };
    },
  );

  // -----------------------------------------------------------------------
  // Tool: server-status (no external call — shows middleware stats)
  // -----------------------------------------------------------------------
  server.tool(
    "server-status",
    "Return server health and middleware statistics",
    {},
    async () => {
      logger.info("Tool invoked: server-status");

      const cache = getCache(server);
      const cacheStats = cache?.stats() ?? { size: 0, maxSize: 0, hits: 0, misses: 0, hitRate: 0 };

      const status = {
        server: {
          name: CONFIG.serverName,
          version: CONFIG.serverVersion,
          uptime: process.uptime(),
        },
        middleware: {
          auth: { strategy: "api-key", active: true },
          rateLimit: {
            strategy: "token-bucket",
            maxTokens: CONFIG.maxTokens,
            refillRate: CONFIG.refillRate,
          },
          cache: {
            strategy: "lru",
            entries: cacheStats.size,
            maxSize: cacheStats.maxSize,
            hits: cacheStats.hits,
            misses: cacheStats.misses,
            hitRate: `${(cacheStats.hitRate * 100).toFixed(1)}%`,
          },
          logger: {
            level: CONFIG.logLevel,
            format: "json",
          },
        },
      };

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(status, null, 2),
          },
        ],
      };
    },
  );

  // -----------------------------------------------------------------------
  // Start the server
  // -----------------------------------------------------------------------

  logger.info("All tools registered, starting transport");

  const transport = new StdioServerTransport();
  await server.connect(transport);

  logger.info("Server is running and accepting connections");
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

main().catch((err) => {
  logger.error("Fatal error during startup", err as Error);
  process.exit(1);
});
