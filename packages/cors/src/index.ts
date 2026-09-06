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

  /**
   * Allowed HTTP methods.
   *
   * Only enforced when the transport actually surfaces a method in request
   * metadata. A tool handler runs well after the HTTP layer, so under stdio
   * (and under HTTP transports that do not forward the method) there is nothing
   * to check and the request is allowed through. Do not rely on this as your
   * only method restriction -- enforce methods at your HTTP layer.
   */
  allowedMethods?: string[];
}

/** Error thrown when a request origin is not allowed. */
export class CorsError extends Error {
  public readonly code = "CORS_ORIGIN_BLOCKED";

  constructor(origin?: string) {
    super(`Origin "${origin ?? "unknown"}" is not allowed`);
    this.name = "CorsError";
  }
}

export class CorsMethodError extends Error {
  public readonly code = "CORS_METHOD_BLOCKED";

  constructor(method?: string) {
    super(`Method "${method ?? "unknown"}" is not allowed`);
    this.name = "CorsMethodError";
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Header containers to search, in priority order, given the `extra` object the
 * SDK passes as the last handler argument.
 *
 * The SDK does not hand a handler a flat header bag:
 *
 *  - `extra.requestInfo.headers` -- the real HTTP request headers, present on
 *    the Streamable HTTP and SSE transports. This is where a browser's `Origin`
 *    actually arrives.
 *  - `extra._meta` -- the MCP request's `params._meta`.
 *  - `extra.meta` and `extra` itself -- kept so hand-built metadata and the
 *    previous shape keep working.
 */
function headerSources(extra: Record<string, unknown>): Record<string, unknown>[] {
  const sources: Record<string, unknown>[] = [];

  const push = (value: unknown): void => {
    if (value && typeof value === "object") {
      sources.push(value as Record<string, unknown>);
    }
  };

  const requestInfo = extra["requestInfo"];
  if (requestInfo && typeof requestInfo === "object") {
    push((requestInfo as Record<string, unknown>)["headers"]);
  }
  push(extra["_meta"]);
  push(extra["meta"]);
  push(extra);

  return sources;
}

/** Look a header up across every place the SDK might have put it. */
function extractFromRequest(extra: Record<string, unknown>, key: string): string | undefined {
  for (const source of headerSources(extra)) {
    const found = extractFromMeta(source, key);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * Extract a value from metadata, doing a case-insensitive key lookup.
 *
 * Real HTTP sends `Origin` capitalised and not every transport lowercases
 * header names before handing metadata over, so a plain `meta["origin"]`
 * lookup misses. Mirrors the helper in `@mcp-toolkit/auth` so header
 * resolution behaves the same across the toolkit.
 */
function extractFromMeta(meta: Record<string, unknown>, key: string): string | undefined {
  // Direct match
  if (typeof meta[key] === "string") return meta[key] as string;

  // Case-insensitive search
  const lower = key.toLowerCase();
  for (const k of Object.keys(meta)) {
    if (k.toLowerCase() === lower && typeof meta[k] === "string") {
      return meta[k] as string;
    }
  }

  // Look inside nested "headers" object (common transport pattern)
  const headers = meta["headers"];
  if (headers && typeof headers === "object") {
    return extractFromMeta(headers as Record<string, unknown>, key);
  }

  return undefined;
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
 * This is an origin allowlist evaluated per tool call, not a full CORS
 * implementation: there is no preflight handling and no response headers.
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
  const allowedSet = allowed === "*" ? null : new Set(allowed);

  const allowedMethods = options.allowedMethods?.map(m => m.toUpperCase());

  patchToolRegistrars(server, (originalHandler) => {
    return async function corsHandler(...handlerArgs: unknown[]) {
      const extra = (handlerArgs.length > 1
        ? handlerArgs[handlerArgs.length - 1] ?? {}
        : {}) as Record<string, unknown>;

      if (allowedSet) {
        const origin = extractFromRequest(extra, "origin");
        if (!origin || !allowedSet.has(origin)) {
          throw new CorsError(origin);
        }
      }

      if (allowedMethods) {
        // A tool handler runs well after the HTTP layer, so the method is often
        // simply not there to check: the SDK's `RequestInfo` carries only
        // `headers` and `url`, and stdio has no HTTP method at all. Fail OPEN
        // when it is undetectable -- rejecting every call is never what a method
        // allowlist is meant to do.
        const method = extractFromRequest(extra, "method")?.toUpperCase();
        if (method && !allowedMethods.includes(method)) {
          throw new CorsMethodError(method);
        }
      }

      return originalHandler(...handlerArgs);
    };
  });

  return server;
}

// ---------------------------------------------------------------------------
// Minimal MCP server type + registration patching
//
// This block is deliberately identical in every @mcp-toolkit package so each
// one stays publishable on its own, with no internal dependency and without
// requiring the SDK at compile time. Keep the four copies in sync.
// ---------------------------------------------------------------------------

/** A tool handler as the SDK invokes it: `(params, extra)`. */
type ToolHandler = (...args: unknown[]) => unknown;

/**
 * Minimal shape of an MCP server that `withCors` can wrap.
 *
 * The parameters are typed `any` on purpose. The SDK declares `tool()` as a set
 * of overloads starting with `tool(name: string, ...)`, and because function
 * parameters are contravariant, a narrower signature such as
 * `(...args: unknown[]) => unknown` makes a real `McpServer` *unassignable* to
 * this interface -- callers would need an `as any` cast to use the middleware
 * from strict TypeScript.
 */
export interface McpServerLike {
  /** Deprecated SDK entry point (`tool(name, ...rest, handler)`), still supported. */
  tool: (...args: any[]) => any;
  /** Current SDK entry point (`registerTool(name, config, handler)`). */
  registerTool?: (...args: any[]) => any;
}

/**
 * Wrap the handler of every tool registration call made on `server`.
 *
 * Both `tool(name, ...rest, handler)` and `registerTool(name, config, handler)`
 * take the handler as their last argument, so a single wrapper covers both.
 * Patching `registerTool` as well as `tool` matters: without it, tools
 * registered through the current SDK API bypass the middleware silently.
 *
 * @param server - The server to patch.
 * @param wrap - Receives the original handler and the tool name, and returns
 *   the handler to register in its place.
 */
function patchToolRegistrars(
  server: McpServerLike,
  wrap: (handler: ToolHandler, toolName: string) => ToolHandler,
): void {
  const target = server as unknown as Record<string, unknown>;

  for (const method of ["tool", "registerTool"] as const) {
    const original = target[method];
    if (typeof original !== "function") continue;

    const bound = (original as ToolHandler).bind(server);

    target[method] = function patched(...args: unknown[]): unknown {
      const handlerIndex = args.length - 1;
      if (handlerIndex < 0 || typeof args[handlerIndex] !== "function") {
        // Not a call we recognise (e.g. a partial registration) -- forward it.
        return bound(...args);
      }

      const toolName = (args.find((a) => typeof a === "string") as string | undefined) ?? "unknown";
      args[handlerIndex] = wrap(args[handlerIndex] as ToolHandler, toolName);
      return bound(...args);
    };
  }
}

