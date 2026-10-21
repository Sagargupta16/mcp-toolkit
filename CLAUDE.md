# CLAUDE.md

> This file stacks on top of the workspace root at `C:\Code\GitHub\`:
> - Root [`CLAUDE.md`](../../CLAUDE.md) -- voice, rules, routing map, references, skills, slash commands, conventions.
> - Root [`MEMORY.md`](../../MEMORY.md) -- live facts across repos.
> - Root [`STATUS.md`](../../STATUS.md) -- live PR/CI/security dashboard.
> - [`.claude/resources/`](../../.claude/resources/README.md) -- deep reference for collaboration, workflow, git, OSS, debugging, voice.
>
> Read those first. The guidance below only adds **repo-specific context** -- it does not override anything in the root.

## Project

Public monorepo of reusable middleware packages (`@mcp-toolkit/*`) for building production MCP servers with the TypeScript SDK: auth, cache, rate-limit, logger, cors.

Beta (v0.3.1). Not yet published to npm -- users clone and build from source. The `@mcp-toolkit` npm scope is an existing npm org Sagar is not a member of (`npm team ls mcp-toolkit` returns 403), so publishing under these names fails; the scope (join the org or rename, e.g. `@sagargupta1610/*`) must be settled before any release workflow is added.

## Stack

- **Language**: TypeScript 7 (compiles to CommonJS -- no `"type": "module"`, tsconfig `module: Node16`), Node >= 20
- **Framework**: none -- plain library packages; peer dep `@modelcontextprotocol/sdk >= 1.0`
- **Database**: none
- **Package manager**: npm workspaces (see Repo-specific rules)
- **Deploy target**: none yet -- npm publish blocked on the scope (see above); CI via shared reusable workflows

## Run

```
npm install
npm run build        # tsc across all workspaces
npm run typecheck    # root tsc --noEmit (excludes examples/)
npm run lint         # per-package tsc --noEmit (no ESLint/Biome)
npm run typecheck:examples   # examples/ only; needs a build first
npm run bench        # bench/overhead.ts, middleware overhead per call; needs a build first
node scripts/check-release.mjs [vX.Y.Z]   # manifests, CHANGELOG heading and tag agree
```

## Test

```
npm test
```

85 unit tests across the five packages, run by `node --test "dist/**/*.test.js"`. They test against a small fake server object, not a real `McpServer`, so they need neither the SDK nor zod. Tests are compiled from `src/index.test.ts`, so `npm run build` must run first.

```
npm run test:e2e     # test/*.test.ts: 10 tests, real McpServer + Client; needs a build first
```

`test/` and `bench/` compile through `tsconfig.integration.json` into `build/` (gitignored) and are excluded from the root `typecheck`, because they import the packages' `dist/`. The 4 Redis tests in `test/redis.test.ts` skip unless `REDIS_URL` is set; CI's `e2e` job runs them against `redis:8-alpine` and `valkey/valkey:9-alpine`. Locally, without Docker, `uv run --with "fakeredis[lua]"` and `fakeredis.TcpFakeServer` give a RESP server that runs the Lua script.

## Entry points

- `packages/<name>/src/index.ts` -- each package is a single-file module (auth, cache, cors, logger, rate-limit), with tests alongside in `index.test.ts`
- `examples/*.ts` -- runnable usage examples (basic-auth-server, full-middleware-stack, production-server, shared-state-redis)

## Key files

- `package.json` (root) -- workspace definition and all shared scripts
- `packages/<name>/package.json` -- per-package metadata; keep versions in lockstep with the root (all 0.3.1); `scripts/check-release.mjs` enforces it
- `docs/diagrams/request-path.yaml` -- orrery spec behind the README architecture figure; edit it, never the SVGs, and re-render with the command in its header
- `.github/workflows/ci.yml` -- delegates to `Sagargupta16/shared-workflows` (node-ci with `run-typecheck: true` on Node 24 + security-scan), plus a local `examples` job that builds and typechecks `examples/`, and an `e2e` job (Redis and Valkey service matrix)
## Gotchas

- `.nvmrc` pins Node 24; `engines` requires >= 20. CI runs 24.
- Middleware wraps the server via `withAuth(server, ...)` style calls BEFORE tool registration -- README examples are the API contract. Each `withX` patches both `tool()` and `registerTool()`; the LAST one applied runs INNERMOST, so auth must be applied before cache.
- The shared block at the bottom of auth/cache/cors/rate-limit (`splitHandlerArgs`, `McpServerLike`, `patchToolRegistrars`, `guardRegisteredHandler`) is duplicated on purpose (no internal package dependency) and is byte-identical apart from the `withX` name in one doc comment. Change all four together.
- `RedisCommand` and the Redis store pattern live in both cache and rate-limit for the same reason (no shared package). The stores take a command function, never a client, so no package gains a runtime dependency; keep it that way.
- `extra` is the LAST handler argument and the ONLY one for a tool with no `inputSchema` -- use `splitHandlerArgs`, never `handlerArgs[0]`. Header extraction is per package and deliberately not shared: auth accepts a credential from `requestInfo.headers` or `params._meta`, cors takes the origin from `requestInfo.headers` only because `_meta` is caller-written.
- Tool params are Zod raw shapes, never JSON Schema. `examples/` is typechecked by `npm run typecheck:examples` (root `tsconfig.json` still excludes it).
- README documents features as shipped; verify against `packages/*/src/index.ts` before quoting behavior, status column says Beta for all packages.

## Repo-specific rules

- Uses npm workspaces with a committed `package-lock.json`, not pnpm. Keep npm here -- CI and scripts assume it.
