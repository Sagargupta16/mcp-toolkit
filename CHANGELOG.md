# Changelog

Versions before `0.2.0` were numbered inconsistently: entries below were tagged `1.0.0`,
`1.1.0` and `1.1.1` in this file while every published artifact stayed on `0.1.x`. They
are left as written rather than rewritten. From `0.2.0` on, the root `package.json` and
all five `packages/*/package.json` carry one version, and it matches the heading here.

## [0.2.0] - 2026-09-06

### Fixed

- `McpServerLike` no longer rejects a real `McpServer`. The `tool` signature was narrow
  enough that parameter contravariance made all four `withX(server, ...)` calls a type
  error from strict TypeScript (`withAuth`, `withCache`, `withCors`, `withRateLimit`;
  the logger ships no server middleware).
- Middleware now wraps `server.registerTool()` in addition to the deprecated
  `server.tool()`. Tools registered through the current SDK API previously bypassed auth,
  rate limiting, caching and origin checks silently.
- A handler replaced after registration is wrapped too. `registerTool` returns a
  `RegisteredTool` whose `update({ callback })` assigns to `registered.handler`, which
  installed an unwrapped handler and dropped the middleware.
- Tools registered without an `inputSchema` are no longer skipped. The SDK invokes those
  handlers as `handler(extra)` with no params object, and every wrapper read `extra` only
  from arity two up: auth and origin checks saw no credential and no headers and rejected
  every call, and the cache keyed off request internals so it never hit.
- Credentials are resolved from the places the SDK actually puts them: HTTP headers at
  `extra.requestInfo.headers`, then the request's `params._meta`. Lookups are
  case-insensitive, and a header delivered as a single-element array now resolves
  (`IsomorphicHeaders` allows `string[]`); a repeated header is treated as absent rather
  than resolved to one of its values.
- `withCors` takes the `Origin` only from `extra.requestInfo.headers`. It previously fell
  back to `extra._meta`, which is JSON-RPC body content the caller writes, so any client
  could name an allowed origin and satisfy the allowlist.
- `withCors` no longer rejects every request when `allowedMethods` is set. A tool handler
  usually cannot see the HTTP method, so an undetectable method now fails open.
- `createLogger` defaults to the `stderr` transport instead of `stdout`. Under the stdio
  transport, stdout carries JSON-RPC only, so the previous default corrupted the session.
- Per-key rate limit buckets are now bounded by a `maxBuckets` cap (default 5000) plus
  idle eviction after a full refill window. The map previously grew without limit from
  caller-supplied keys.
- `withAuth` with an `api-key` strategy now rejects an empty or all-undefined `keys` list
  at configuration time instead of throwing a confusing `TypeError` on the first request.
- The README Quick Start and all three examples now pass Zod raw shapes for tool
  parameters. The JSON Schema objects they used threw at registration on SDK 1.x.
- Both `.github/PULL_REQUEST_TEMPLATE.md` and `.github/pull_request_template.md` were
  tracked; the duplicate index entry is gone.
- Issue template contact links pointed at a nonexistent `prsagar16` account.

### Added

- Tests. 76 of them across the five packages, run by `node --test`. The per-package test
  script used a `dist/**/*.test.js` glob that `sh` cannot expand recursively, so it could
  never have matched a compiled test.
- A README per package, plus an `examples/README.md` covering prerequisites, environment
  variables and how to exercise a running server.
- README sections on middleware ordering and on the toolkit's limitations.
- `maxBuckets` option on `withRateLimit`.
- CI now typechecks the repo (`run-typecheck: true`) and compiles `examples/` in a
  dedicated job, on Node 24 to match `.nvmrc`.

### Changed

- All packages and the root are versioned `0.2.0`, including in `package-lock.json`.
- `bucketKey` on `withRateLimit` receives the SDK's `extra` object directly. It used to be
  handed `extra.meta ?? extra`, a key the SDK never sets, and the README example keyed off
  `sessionId` without saying that stdio leaves it undefined for every caller.
- `.editorconfig` and `.prettierrc` now say 2-space indent, matching the code.
- Removed `.maintenance`, `.python-version` and `.dockerignore`, none of which applied to
  this repo.

## [1.1.1] - 2026-09-02

- Bump hono to 4.13.5, fast-uri to 3.1.7, ip-address to 10.7.0 to patch Dependabot security alerts

## [1.1.0] - 2026-03-16

- Add PR template for standardized PRs
- Fix repo URLs, update Node engine

## [1.0.0] - 2026-03-09

- Add CORS middleware package with configurable allowed methods

## [0.1.0] - 2026-03-04

- Initial release: MCP middleware monorepo
- Packages: auth, cache, rate-limit, logger
- Production-ready middleware for MCP servers
