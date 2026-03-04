# Contributing to MCP Toolkit

Thank you for your interest in contributing to MCP Toolkit! This guide will help you get started.

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [Development Setup](#development-setup)
- [Project Structure](#project-structure)
- [Creating a New Middleware Package](#creating-a-new-middleware-package)
- [Coding Standards](#coding-standards)
- [Testing](#testing)
- [Submitting Changes](#submitting-changes)

## Code of Conduct

This project follows the [Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md). By participating, you are expected to uphold this code.

## Getting Started

1. Fork the repository on GitHub
2. Clone your fork locally:
   ```bash
   git clone https://github.com/<your-username>/mcp-toolkit.git
   cd mcp-toolkit
   ```
3. Install dependencies:
   ```bash
   npm install
   ```
4. Create a feature branch:
   ```bash
   git checkout -b feat/my-feature
   ```

## Development Setup

### Prerequisites

- **Node.js** >= 18.0.0
- **npm** >= 9.0.0
- **TypeScript** >= 5.0.0

### Install Dependencies

```bash
npm install
```

This installs dependencies for all packages in the monorepo using npm workspaces.

### Build All Packages

```bash
npm run build
```

### Run Tests

```bash
npm test
```

### Lint

```bash
npm run lint
```

## Project Structure

```
mcp-toolkit/
  packages/
    auth/           # @mcp-toolkit/auth - Authentication middleware
    cache/          # @mcp-toolkit/cache - Caching middleware
    rate-limit/     # @mcp-toolkit/rate-limit - Rate limiting middleware
    logger/         # @mcp-toolkit/logger - Structured logging
  examples/         # Example MCP servers using the toolkit
  package.json      # Root package.json (npm workspaces)
  tsconfig.json     # Root TypeScript configuration
```

Each package follows the same internal structure:

```
packages/<name>/
  src/
    index.ts        # Public API exports
  package.json
  tsconfig.json
```

## Creating a New Middleware Package

If you want to contribute a new middleware package, follow these steps:

### 1. Create the Package Directory

```bash
mkdir -p packages/my-middleware/src
```

### 2. Create `packages/my-middleware/package.json`

```json
{
  "name": "@mcp-toolkit/my-middleware",
  "version": "0.1.0",
  "description": "Brief description of what this middleware does",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc",
    "test": "node --test dist/**/*.test.js",
    "lint": "tsc --noEmit"
  },
  "keywords": ["mcp", "middleware", "my-middleware"],
  "license": "MIT",
  "peerDependencies": {
    "@modelcontextprotocol/sdk": ">=1.0.0"
  }
}
```

### 3. Create `packages/my-middleware/tsconfig.json`

```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

### 4. Implement the Middleware

Your middleware should follow the `with<Name>(server, options)` pattern:

```typescript
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export interface MyMiddlewareOptions {
  // Define your options here
}

export function withMyMiddleware(
  server: McpServer,
  options: MyMiddlewareOptions
): McpServer {
  // Intercept server.tool() to wrap handlers
  const originalTool = server.tool.bind(server);

  server.tool = function (...args: any[]) {
    // Wrap the handler to add your middleware logic
    return originalTool(...args);
  } as typeof server.tool;

  return server;
}
```

### 5. Add Tests

Create tests in `src/__tests__/` or alongside source files with `.test.ts` extension.

### 6. Update the Root README

Add your package to the packages table in `README.md`.

## Coding Standards

- **TypeScript**: All code must be written in TypeScript with strict mode enabled
- **Types**: Export all public types and interfaces. Avoid `any` wherever possible
- **Documentation**: Add JSDoc comments to all public functions, interfaces, and types
- **Naming**: Use `camelCase` for functions/variables, `PascalCase` for types/interfaces
- **Pattern**: Middleware functions should follow the `with<Name>(server, options)` convention
- **Side effects**: Middleware should not have unexpected side effects. Clearly document what the middleware modifies on the server
- **Error handling**: Always provide meaningful error messages. Never swallow errors silently

## Testing

- Write unit tests for all public API functions
- Test edge cases (invalid inputs, boundary conditions, error paths)
- Ensure tests pass on Node.js 18 and 20
- Run the full test suite before submitting:
  ```bash
  npm test
  ```

## Submitting Changes

### Pull Request Process

1. Ensure your code passes all checks:
   ```bash
   npm run lint
   npm test
   npm run build
   ```
2. Update documentation if you changed any public APIs
3. Push your branch and open a Pull Request against `main`
4. Fill out the PR template completely
5. Wait for review from a maintainer

### Commit Message Format

Use clear, descriptive commit messages:

```
feat(auth): add OAuth2 authentication strategy
fix(cache): handle expired entries correctly
docs: update contributing guidelines
test(rate-limit): add sliding window tests
chore: update dependencies
```

Prefixes:
- `feat` - New feature
- `fix` - Bug fix
- `docs` - Documentation only
- `test` - Adding or updating tests
- `chore` - Maintenance tasks
- `refactor` - Code change that neither fixes a bug nor adds a feature

### Review Process

- A maintainer will review your PR within a few days
- Address any feedback by pushing additional commits
- Once approved, a maintainer will merge your PR

## Questions?

Open an issue with the "question" label or start a discussion on GitHub Discussions.

Thank you for contributing!
