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

Pre-release (v0.1.0). Not yet published to npm -- users clone and build from source.

## Stack

- **Language**: TypeScript 5 (compiles to CommonJS -- no `"type": "module"`, tsconfig `module: Node16`), Node >= 20
- **Framework**: none -- plain library packages; peer dep `@modelcontextprotocol/sdk >= 1.0`
- **Database**: none
- **Package manager**: npm workspaces (see Repo-specific rules)
- **Deploy target**: none yet -- npm publish pending; CI via shared reusable workflows

## Run

```
npm install
npm run build        # tsc across all workspaces
npm run typecheck    # root tsc --noEmit
npm run lint         # per-package tsc --noEmit (no ESLint/Biome)
```

## Test

```
npm test
```

No test suite yet -- per-package `test` script looks for compiled `dist/**/*.test.js` via `node --test` and prints "No tests found, skipping". Tests must be compiled first (`npm run build`).

## Entry points

- `packages/<name>/src/index.ts` -- each package is a single-file module (auth, cache, cors, logger, rate-limit)
- `examples/*.ts` -- runnable usage examples (basic-auth-server, full-middleware-stack, production-server)

## Key files

- `package.json` (root) -- workspace definition and all shared scripts
- `packages/<name>/package.json` -- per-package metadata; keep versions in lockstep (all 0.1.0)
- `.github/workflows/ci.yml` -- delegates to `Sagargupta16/shared-workflows` (node-ci + security-scan)

## Gotchas

- `.nvmrc` pins Node 19 but `engines` requires >= 20 -- the engines field wins; `.nvmrc` is stale.
- A stray `.python-version` (3.14) exists in this TS-only repo; ignore it.
- Middleware wraps the server via `withAuth(server, ...)` style calls BEFORE tool registration -- README examples are the API contract.
- README documents features as shipped; verify against `packages/*/src/index.ts` before quoting behavior, status column says Beta for all packages.

## Repo-specific rules

- Uses npm workspaces with a committed `package-lock.json`, not pnpm. Keep npm here -- CI and scripts assume it.
