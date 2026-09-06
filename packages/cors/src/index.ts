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
 * The HTTP request headers the transport captured, which the SDK exposes at
 * `extra.requestInfo.headers` on the Streamable HTTP and SSE transports. Returns
 * `undefined` on a transport that has no HTTP request, such as stdio.
 *
 * This is the only origin source accepted. `params._meta` (and the rest of
 * `extra`) travels inside the JSON-RPC body the caller wrote, so an origin read
 * from there is only what the caller claims: any client could name an allowed
 * origin and satisfy the allowlist. Origin is a transport-level fact, so only
 * the transport's own headers are trusted for it.
 */
function transportHeaders(extra: Record<string, unknown>): unknown {
  const requestInfo = extra["requestInfo"];
  if (!requestInfo || typeof requestInfo !== "object") return undefined;
  return (requestInfo as Record<string, unknown>)["headers"];
}

/**
 * Read one header value as a string.
 *
 * The SDK types HTTP headers as `Record<string, string | string[] | undefined>`
 * (`IsomorphicHeaders`), so a header can arrive as an array. A single-element
 * array is that one value. A repeated header is ambiguous and picking a winner
 * is how an allowlist gets fooled, so it is treated as absent instead.
 */
function asHeaderValue(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.length === 1 && typeof value[0] === "string") {
    return value[0];
  }
  return undefined;
}

/**
 * Look a key up in one container, case-insensitively, plus a nested `headers`
 * object if there is one.
 *
 * Real HTTP sends `Origin` capitalised and not every transport lowercases header
 * names, so a plain `headers["origin"]` lookup misses. Mirrors the helper in
 * `@mcp-toolkit/auth` so header resolution behaves the same across the toolkit.
 */
function lookupHeader(source: unknown, key: string): string | undefined {
  if (!source || typeof source !== "object") return undefined;
  const record = source as Record<string, unknown>;

  // Direct match
  const direct = asHeaderValue(record[key]);
  if (direct !== undefined) return direct;

  // Case-insensitive search
  const lower = key.toLowerCase();
  for (const k of Object.keys(record)) {
    if (k.toLowerCase() === lower) {
      const value = asHeaderValue(record[k]);
      if (value !== undefined) return value;
    }
  }

  // Nested "headers" object (a common hand-built metadata shape)
  return lookupHeader(record["headers"], key);
}

/**
 * Look a key up in the trusted headers first, then in caller-written request
 * metadata (`extra._meta`, `extra.meta`, `extra` itself).
 *
 * Only the method check uses this. An undetectable method fails open, so a value
 * found in metadata can only tighten the check on the caller that supplied it,
 * never loosen it. The origin check must not use this -- see `transportHeaders`.
 */
function lookupAnywhere(extra: Record<string, unknown>, key: string): string | undefined {
  const sources: unknown[] = [transportHeaders(extra), extra["_meta"], extra["meta"], extra];
  for (const source of sources) {
    const value = lookupHeader(source, key);
    if (value !== undefined) return value;
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
      // The SDK passes the per-request "extra" object as the LAST argument, on
      // its own when the tool declared no input schema.
      const { extra } = splitHandlerArgs(handlerArgs);

      if (allowedSet) {
        // Trusted transport headers only: an origin from request metadata is
        // whatever the caller typed, which would void the allowlist.
        const origin = lookupHeader(transportHeaders(extra), "origin");
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
        const method = lookupAnywhere(extra, "method")?.toUpperCase();
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

/** A tool handler as the SDK invokes it: `(params, extra)` or `(extra)`. */
type ToolHandler = (...args: unknown[]) => unknown;

/** The parsed params and the per-request `extra` object of one handler call. */
interface HandlerCall {
  params: Record<string, unknown>;
  extra: Record<string, unknown>;
}

/**
 * Split the arguments the SDK passed to a tool handler.
 *
 * The arity depends on whether the tool declared an input schema: the SDK calls
 * `handler(params, extra)` when it did and `handler(extra)` when it did not, so
 * `extra` is always the LAST argument and params only exist from arity two up.
 * Reading `extra` only when more than one argument arrived made every
 * schema-less tool invisible to the credential and header lookups above.
 */
function splitHandlerArgs(handlerArgs: unknown[]): HandlerCall {
  const last = handlerArgs[handlerArgs.length - 1];
  const first = handlerArgs.length > 1 ? handlerArgs[0] : undefined;
  return {
    params: (first && typeof first === "object" ? first : {}) as Record<string, unknown>,
    extra: (last && typeof last === "object" ? last : {}) as Record<string, unknown>,
  };
}

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
      const registered = bound(...args);
      guardRegisteredHandler(registered, wrap, toolName);
      return registered;
    };
  }
}

/**
 * Keep the middleware in place when a handler is replaced after registration.
 *
 * `registerTool` returns a `RegisteredTool`, and its `update({ callback })`
 * assigns straight to `registeredTool.handler`. Without this guard that call --
 * or a direct `registered.handler = fn` -- installs an unwrapped handler and
 * drops the middleware silently, the same bypass as an unpatched `registerTool`.
 *
 * A wrapping accessor covers both routes. It delegates to whatever accessor
 * another `withX` already installed, so composed middleware keeps its order.
 */
function guardRegisteredHandler(
  registered: unknown,
  wrap: (handler: ToolHandler, toolName: string) => ToolHandler,
  toolName: string,
): void {
  if (!registered || typeof registered !== "object") return;

  const target = registered as Record<string, unknown>;
  const existing = Object.getOwnPropertyDescriptor(target, "handler");
  if (!existing || existing.configurable === false) return;

  let own = existing.get ? undefined : existing.value;

  Object.defineProperty(target, "handler", {
    configurable: true,
    enumerable: existing.enumerable !== false,
    get: () => (existing.get ? existing.get.call(target) : own),
    set: (next: unknown) => {
      const wrapped = typeof next === "function" ? wrap(next as ToolHandler, toolName) : next;
      if (existing.set) existing.set.call(target, wrapped);
      else own = wrapped;
    },
  });
}

