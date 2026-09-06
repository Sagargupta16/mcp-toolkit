# Changelog

Versions before `0.2.0` were numbered inconsistently: entries below were tagged `1.0.0`,
`1.1.0` and `1.1.1` in this file while every published artifact stayed on `0.1.x`. They
are left as written rather than rewritten. From `0.2.0` on, the root `package.json` and
all five `packages/*/package.json` carry one version, and it matches the heading here.

## [0.2.0] - 2026-09-06

### Fixed

- `McpServerLike` no longer rejects a real `McpServer`. The `tool` signature was narrow
  enough that parameter contravariance made all five `withX(server, ...)` calls a type
  error from strict TypeScript.
- Middleware now wraps `server.registerTool()` in addition to the deprecated
  `server.tool()`. Tools registered through the current SDK API previously bypassed auth,
  rate limiting, caching and origin checks silently.
- Credentials and the `Origin` header are now resolved from the places the SDK actually
  puts them: HTTP headers at `extra.requestInfo.headers`, and the request's
  `params._meta`. Lookups are case-insensitive, so the capitalised `Origin` browsers send
  now resolves.
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

- Tests. 64 of them across the five packages, run by `node --test`. The per-package test
  script used a `dist/**/*.test.js` glob that `sh` cannot expand recursively, so it could
  never have matched a compiled test.
- A README per package, plus an `examples/README.md` covering prerequisites, environment
  variables and how to exercise a running server.
- README sections on middleware ordering and on the toolkit's limitations.
- `maxBuckets` option on `withRateLimit`.
- CI now typechecks the repo (`run-typecheck: true`) and compiles `examples/` in a
  dedicated job, on Node 24 to match `.nvmrc`.

### Changed

- All packages and the root are versioned `0.2.0`.
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
