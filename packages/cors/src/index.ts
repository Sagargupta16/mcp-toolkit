/**
 * @mcp-toolkit/cors
 *
 * Origin validation middleware for MCP servers.
 * Rejects requests from disallowed origins based on metadata headers.
 */

// ---------------------------------------------------------------------------
// Types & Interfaces
// ---------------------------------------------------------------------------

export interface CorsOptions {
  /**
   * Allowed origins.
   * Use "*" to allow any origin.
   */
  allowedOrigins: string[] | "*";
}

/** Error thrown when a request origin is not allowed. */
export class CorsError extends Error {
  public readonly code = "CORS_ORIGIN_BLOCKED";

  constructor(origin?: string) {
    super(`Origin "${origin ?? "unknown"}" is not allowed`);
    this.name = "CorsError";
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Wraps an MCP server with origin validation middleware.
 *
 * Checks the `Origin` header from request metadata and blocks requests
 * from origins that are not in the allowed list.
 *
 * @param server - An MCP server instance
 * @param options - CORS configuration
 * @returns The same server instance (for chaining)
 */
export function withCors<T extends McpServerLike>(
  server: T,
  options: CorsOptions
): T {

  const allowed = options.allowedOrigins;

  const originalTool = server.tool.bind(server);

  const wrappedTool = function toolWithCors(...args: unknown[]): unknown {

    const handlerIndex = args.findIndex(
      (a, i) => typeof a === "function" && i === args.length - 1
    );

    if (handlerIndex === -1) {
      return (originalTool as (...a: unknown[]) => unknown)(...args);
    }

    const originalHandler = args[handlerIndex] as (...a: unknown[]) => unknown;

    args[handlerIndex] = async function corsHandler(...handlerArgs: unknown[]) {

      const extra =
        handlerArgs.length > 1
          ? handlerArgs[handlerArgs.length - 1]
          : {};

      const meta =
        (extra as Record<string, unknown>)?.["meta"] ??
        extra ??
        {};

      const headers =
        (meta as Record<string, unknown>)?.["headers"] as
          | Record<string, unknown>
          | undefined;

      const origin = headers?.["origin"] as string | undefined;

      if (allowed !== "*") {
        if (!origin || !allowed.includes(origin)) {
          throw new CorsError(origin);
        }
      }

      return originalHandler(...handlerArgs);
    };

    return (originalTool as (...a: unknown[]) => unknown)(...args);
  };

  server.tool = wrappedTool as typeof server.tool;

  return server;
}

// ---------------------------------------------------------------------------
// Minimal MCP server type
// ---------------------------------------------------------------------------

export interface McpServerLike {
  tool: (...args: unknown[]) => unknown;
  [key: string]: unknown;
}
