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

function createApiKeyVerifier(options: ApiKeyAuthOptions) {
  const header = (options.header ?? "x-api-key").toLowerCase();
  const validKeys = new Set(options.keys);

  return async (meta: Record<string, unknown>): Promise<AuthContext> => {
    const key = extractFromMeta(meta, header);
    if (!key) {
      throw new AuthError(`Missing API key in "${header}" header`);
    }
    if (!validKeys.has(key)) {
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

  return async (meta: Record<string, unknown>): Promise<AuthContext> => {
    const raw = extractFromMeta(meta, "authorization");
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

  return async (meta: Record<string, unknown>): Promise<AuthContext> => {
    const credential = extractFromMeta(meta, header);
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
  let verify: (meta: Record<string, unknown>) => Promise<AuthContext>;

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

  // Monkey-patch `server.tool` so every registered tool handler goes through
  // the auth verifier before executing.
  const originalTool = server.tool.bind(server);

  const wrappedTool = function toolWithAuth(...args: unknown[]): unknown {
    // server.tool() has several overloads.  The handler is always the last
    // argument and is a function.
    const handlerIndex = args.findIndex(
      (a, i) => typeof a === "function" && i === args.length - 1,
    );

    if (handlerIndex === -1) {
      // No handler found -- just forward (e.g. partial registration)
      return (originalTool as (...a: unknown[]) => unknown)(...args);
    }

    const originalHandler = args[handlerIndex] as (...a: unknown[]) => unknown;

    args[handlerIndex] = async function authHandler(...handlerArgs: unknown[]) {
      // The MCP SDK passes an "extra" object as the last argument that may
      // contain transport metadata.  We try to pull auth info from there.
      const extra = (handlerArgs.length > 1 ? handlerArgs[handlerArgs.length - 1] : {}) as Record<string, unknown>;
      const meta: Record<string, unknown> = (extra?.["meta"] ?? extra ?? {}) as Record<string, unknown>;

      // Run authentication
      const authCtx = await verify(meta);

      // Attach auth context so downstream handlers can access it
      if (typeof extra === "object" && extra !== null) {
        (extra as Record<string, unknown>)["auth"] = authCtx;
      }

      return originalHandler(...handlerArgs);
    };

    return (originalTool as (...a: unknown[]) => unknown)(...args);
  };

  server.tool = wrappedTool as typeof server.tool;

  return server;
}

// ---------------------------------------------------------------------------
// Minimal type for the MCP server so we don't require the SDK at compile time
// ---------------------------------------------------------------------------

/** Minimal shape of an MCP server that `withAuth` can wrap. */
export interface McpServerLike {
  tool: (...args: unknown[]) => unknown;
  [key: string]: unknown;
}
