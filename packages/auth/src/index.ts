/**
 * @mcp-toolkit/auth
 *
 * Authentication middleware for MCP servers.
 * Supports API key, JWT, and custom verification strategies.
 */

// ---------------------------------------------------------------------------
// Types & Interfaces
// ---------------------------------------------------------------------------

/** Decoded payload returned after successful authentication. */
export interface AuthPayload {
  /** Unique identifier for the authenticated entity. */
  sub: string;
  /** Optional human-readable name. */
  name?: string;
  /** Arbitrary claims attached to the authentication. */
  [key: string]: unknown;
}

/** Context object passed to tool handlers after authentication. */
export interface AuthContext {
  /** Whether the current request has been authenticated. */
  authenticated: boolean;
  /** The decoded auth payload (undefined when not authenticated). */
  payload?: AuthPayload;
  /** The raw credential string that was verified. */
  credential?: string;
}

/** A function that extracts a credential string from incoming request metadata. */
export type CredentialExtractor = (meta: Record<string, unknown>) => string | undefined;

// -- Strategy option types --------------------------------------------------

export interface ApiKeyAuthOptions {
  type: "api-key";
  /** List of valid API keys. */
  keys: string[];
  /**
   * Name of the header / metadata key that carries the API key.
   * @default "x-api-key"
   */
  header?: string;
}

export interface JwtAuthOptions {
  type: "jwt";
  /** Secret used to verify HMAC-signed tokens. */
  secret: string;
  /**
   * Accepted algorithms.
   * @default ["HS256"]
   */
  algorithms?: string[];
  /**
   * Clock tolerance in seconds for expiry checks.
   * @default 0
   */
  clockTolerance?: number;
}

export interface CustomAuthOptions {
  type: "custom";
  /** User-supplied verification function. */
  verify: (token: string) => Promise<AuthPayload | boolean>;
  /**
   * Name of the header / metadata key that carries the credential.
   * @default "authorization"
   */
  header?: string;
}

export type AuthOptions = ApiKeyAuthOptions | JwtAuthOptions | CustomAuthOptions;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Minimal base64-url decoder (no external deps).
 * Handles the URL-safe alphabet and missing padding.
 */
function base64UrlDecode(input: string): string {
  let base64 = input.replace(/-/g, "+").replace(/_/g, "/");
  const pad = base64.length % 4;
  if (pad === 2) base64 += "==";
  else if (pad === 3) base64 += "=";
  return Buffer.from(base64, "base64").toString("utf-8");
}

/**
 * Very small JWT decoder.
 * It validates structure, parses header + payload, and checks `exp` / `nbf`.
 *
 * IMPORTANT: For production use you should bring a proper JWT library
 * (e.g. `jose`) that performs cryptographic signature verification.
 * This implementation verifies the signature using Node's built-in
 * `crypto.createHmac` for HMAC-based algorithms.
 */
function verifyJwt(
  token: string,
  secret: string,
  algorithms: string[],
  clockTolerance: number,
): AuthPayload {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new AuthError("Malformed JWT: expected 3 parts");
  }

  const [headerB64, payloadB64, signatureB64] = parts;

  // Decode header
  let header: { alg?: string; typ?: string };
  try {
    header = JSON.parse(base64UrlDecode(headerB64));
  } catch {
    throw new AuthError("Malformed JWT: invalid header");
  }

  if (!header.alg || !algorithms.includes(header.alg)) {
    throw new AuthError(
      `JWT algorithm "${header.alg}" is not in the allowed list: ${algorithms.join(", ")}`,
    );
  }

  // Verify HMAC signature for HS* algorithms
  const alg = header.alg;
  if (alg.startsWith("HS")) {
    const crypto = require("crypto") as typeof import("crypto");
    const hashBits = alg.slice(2); // "256", "384", "512"
    const hmacAlg = `sha${hashBits}`;

    const signingInput = `${headerB64}.${payloadB64}`;
    const expectedSig = crypto
      .createHmac(hmacAlg, secret)
      .update(signingInput)
      .digest("base64url");

    // Constant-time comparison
    const sigBuffer = Buffer.from(signatureB64);
    const expectedBuffer = Buffer.from(expectedSig);

    if (
      sigBuffer.length !== expectedBuffer.length ||
      !crypto.timingSafeEqual(sigBuffer, expectedBuffer)
    ) {
      throw new AuthError("JWT signature verification failed");
    }
  } else {
    // For RS*, ES*, PS* algorithms, a full library like `jose` is recommended.
    throw new AuthError(
      `Algorithm "${alg}" is not supported by the built-in verifier. ` +
        `Use a custom auth strategy with a library like "jose" for asymmetric algorithms.`,
    );
  }

  // Decode payload
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(base64UrlDecode(payloadB64));
  } catch {
    throw new AuthError("Malformed JWT: invalid payload");
  }

  const now = Math.floor(Date.now() / 1000);

  // Check expiry
  if (typeof payload["exp"] === "number" && now > payload["exp"] + clockTolerance) {
    throw new AuthError("JWT has expired");
  }

  // Check not-before
  if (typeof payload["nbf"] === "number" && now < payload["nbf"] - clockTolerance) {
    throw new AuthError("JWT is not yet valid (nbf)");
  }

  return {
    sub: String(payload["sub"] ?? "unknown"),
    ...payload,
  } as AuthPayload;
}

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

/** Error thrown when authentication fails. */
export class AuthError extends Error {
  public readonly code = "AUTH_ERROR";
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

// ---------------------------------------------------------------------------
// Strategy implementations
// ---------------------------------------------------------------------------

/**
 * Constant-time check of a candidate credential against a set of valid keys.
 *
 * A plain `Set.has()` / `===` comparison short-circuits on the first differing
 * byte, leaking key material through response timing when the server is exposed
 * over a network transport (HTTP/SSE). We compare against every key with
 * `crypto.timingSafeEqual` so the running time does not depend on how many
 * leading bytes matched.
 */
function isValidApiKey(candidate: string, validKeys: string[]): boolean {
  const crypto = require("crypto") as typeof import("crypto");
  const candidateBuf = Buffer.from(candidate);
  let match = false;
  for (const key of validKeys) {
    const keyBuf = Buffer.from(key);
    // timingSafeEqual requires equal lengths; the length comparison itself is
    // not secret-dependent, and we always run the full loop.
    if (keyBuf.length === candidateBuf.length && crypto.timingSafeEqual(keyBuf, candidateBuf)) {
      match = true;
    }
  }
  return match;
}

function createApiKeyVerifier(options: ApiKeyAuthOptions) {
  const header = (options.header ?? "x-api-key").toLowerCase();

  // Reject a bad key list at configuration time. Callers commonly write
  // `keys: [process.env.MCP_API_KEY]`, which is `(string | undefined)[]` and
  // reaches `Buffer.from(undefined)` inside isValidApiKey when the variable is
  // unset -- a confusing TypeError on the first request instead of a clear
  // setup error here.
  const validKeys = options.keys.filter(
    (key): key is string => typeof key === "string" && key.length > 0,
  );
  if (validKeys.length === 0) {
    throw new Error(
      'withAuth: `keys` must contain at least one non-empty string (check that your API key environment variable is set)',
    );
  }

  return async (extra: Record<string, unknown>): Promise<AuthContext> => {
    const key = extractFromRequest(extra, header);
    if (!key) {
      throw new AuthError(`Missing API key in "${header}" header`);
    }
    if (!isValidApiKey(key, validKeys)) {
      throw new AuthError("Invalid API key");
    }
    return {
      authenticated: true,
      payload: { sub: "api-key-user", keyPrefix: key.slice(0, 8) + "..." },
      credential: key,
    };
  };
}

function createJwtVerifier(options: JwtAuthOptions) {
  const algorithms = options.algorithms ?? ["HS256"];
  const clockTolerance = options.clockTolerance ?? 0;

  return async (extra: Record<string, unknown>): Promise<AuthContext> => {
    const raw = extractFromRequest(extra, "authorization");
    if (!raw) {
      throw new AuthError("Missing Authorization header");
    }

    const token = raw.startsWith("Bearer ") ? raw.slice(7) : raw;
    const payload = verifyJwt(token, options.secret, algorithms, clockTolerance);

    return {
      authenticated: true,
      payload,
      credential: token,
    };
  };
}

function createCustomVerifier(options: CustomAuthOptions) {
  const header = (options.header ?? "authorization").toLowerCase();

  return async (extra: Record<string, unknown>): Promise<AuthContext> => {
    const credential = extractFromRequest(extra, header);
    if (!credential) {
      throw new AuthError(`Missing credential in "${header}" header`);
    }

    const result = await options.verify(credential);
    if (result === false) {
      throw new AuthError("Custom authentication rejected the credential");
    }

    const payload: AuthPayload =
      typeof result === "object" ? result : { sub: "custom-user" };

    return {
      authenticated: true,
      payload,
      credential,
    };
  };
}

/**
 * Credential containers to search, in priority order, given the `extra` object
 * the SDK passes as the last handler argument.
 *
 * The SDK does not hand a handler a flat header bag, so there is more than one
 * place a credential can arrive:
 *
 *  - `extra.requestInfo.headers` -- the real HTTP request headers, present on
 *    the Streamable HTTP and SSE transports.
 *  - `extra._meta` -- the MCP request's `params._meta`, the only per-request
 *    channel that exists under the stdio transport.
 *  - `extra.meta` and `extra` itself -- kept so hand-built metadata and the
 *    previous shape keep working.
 */
function credentialSources(extra: Record<string, unknown>): Record<string, unknown>[] {
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
  for (const source of credentialSources(extra)) {
    const found = extractFromMeta(source, key);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** Extract a value from metadata, doing a case-insensitive key lookup. */
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
 * Wraps an MCP server with authentication middleware.
 *
 * After calling `withAuth`, every tool invocation on the server will first
 * verify the caller's credentials according to the chosen strategy.  If
 * authentication fails an `AuthError` is thrown, which the MCP transport
 * surfaces as a standard error response.
 *
 * @param server - An MCP server instance (from `@modelcontextprotocol/sdk`).
 * @param options - Authentication strategy configuration.
 * @returns The same server instance (for chaining).
 *
 * @example
 * ```ts
 * import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
 * import { withAuth } from "@mcp-toolkit/auth";
 *
 * const server = new McpServer({ name: "demo", version: "1.0.0" });
 *
 * withAuth(server, {
 *   type: "api-key",
 *   keys: [process.env.API_KEY!],
 * });
 * ```
 */
export function withAuth<T extends McpServerLike>(server: T, options: AuthOptions): T {
  // Build the appropriate verifier
  let verify: (extra: Record<string, unknown>) => Promise<AuthContext>;

  switch (options.type) {
    case "api-key":
      verify = createApiKeyVerifier(options);
      break;
    case "jwt":
      verify = createJwtVerifier(options);
      break;
    case "custom":
      verify = createCustomVerifier(options);
      break;
    default:
      throw new Error(`Unknown auth type: ${(options as AuthOptions).type}`);
  }

  // Patch every tool registration entry point so each registered handler goes
  // through the auth verifier before executing.
  patchToolRegistrars(server, (originalHandler) => {
    return async function authHandler(...handlerArgs: unknown[]) {
      // The MCP SDK passes an "extra" object as the last argument that may
      // contain transport metadata.  We try to pull auth info from there.
      const extra = (handlerArgs.length > 1 ? handlerArgs[handlerArgs.length - 1] ?? {} : {}) as Record<string, unknown>;

      // Run authentication
      const authCtx = await verify(extra);

      // Attach auth context so downstream handlers can access it
      if (typeof extra === "object" && extra !== null) {
        (extra as Record<string, unknown>)["auth"] = authCtx;
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
 * Minimal shape of an MCP server that `withAuth` can wrap.
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
