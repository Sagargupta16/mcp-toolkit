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

Beta (v0.2.0). Not yet published to npm -- users clone and build from source.

## Stack

- **Language**: TypeScript 7 (compiles to CommonJS -- no `"type": "module"`, tsconfig `module: Node16`), Node >= 20
- **Framework**: none -- plain library packages; peer dep `@modelcontextprotocol/sdk >= 1.0`
- **Database**: none
- **Package manager**: npm workspaces (see Repo-specific rules)
- **Deploy target**: none yet -- npm publish pending; CI via shared reusable workflows

## Run

```
npm install
npm run build        # tsc across all workspaces
npm run typecheck    # root tsc --noEmit (excludes examples/)
npm run lint         # per-package tsc --noEmit (no ESLint/Biome)
npm run typecheck:examples   # examples/ only; needs a build first
```

## Test

```
npm test
```

64 tests across the five packages, run by `node --test "dist/**/*.test.js"`. They test against a small fake server object, not a real `McpServer`, so they need neither the SDK nor zod. Tests are compiled from `src/index.test.ts`, so `npm run build` must run first.

## Entry points

- `packages/<name>/src/index.ts` -- each package is a single-file module (auth, cache, cors, logger, rate-limit), with tests alongside in `index.test.ts`
- `examples/*.ts` -- runnable usage examples (basic-auth-server, full-middleware-stack, production-server)

## Key files

- `package.json` (root) -- workspace definition and all shared scripts
- `packages/<name>/package.json` -- per-package metadata; keep versions in lockstep with the root (all 0.2.0)
- `.github/workflows/ci.yml` -- delegates to `Sagargupta16/shared-workflows` (node-ci with `run-typecheck: true` on Node 24 + security-scan), plus a local `examples` job that builds and typechecks `examples/`

## Gotchas

- `.nvmrc` pins Node 24; `engines` requires >= 20. CI runs 24.
- Middleware wraps the server via `withAuth(server, ...)` style calls BEFORE tool registration -- README examples are the API contract. Each `withX` patches both `tool()` and `registerTool()`; the LAST one applied runs INNERMOST, so auth must be applied before cache.
- The `McpServerLike` + `patchToolRegistrars` block at the bottom of auth/cache/cors/rate-limit is duplicated on purpose (no internal package dependency). Change all four together.
- Tool params are Zod raw shapes, never JSON Schema. `examples/` is typechecked by `npm run typecheck:examples` (root `tsconfig.json` still excludes it).
- README documents features as shipped; verify against `packages/*/src/index.ts` before quoting behavior, status column says Beta for all packages.

## Repo-specific rules

- Uses npm workspaces with a committed `package-lock.json`, not pnpm. Keep npm here -- CI and scripts assume it.
