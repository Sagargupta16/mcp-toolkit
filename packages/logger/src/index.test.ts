/**
 * Tests for @mcp-toolkit/logger.
 *
 * Output is captured by temporarily replacing `process.stdout.write` and
 * `process.stderr.write`, which also lets us assert that nothing lands on stdout
 * by default -- under the stdio transport stdout carries JSON-RPC only.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { createLogger, nullLogger } from "./index.js";

interface Captured {
  stdout: string[];
  stderr: string[];
}

/** Run `fn` with stdout/stderr captured instead of written. */
function capture(fn: () => void): Captured {
  const captured: Captured = { stdout: [], stderr: [] };
  const originalOut = process.stdout.write;
  const originalErr = process.stderr.write;

  process.stdout.write = ((chunk: string) => {
    captured.stdout.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string) => {
    captured.stderr.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;

  try {
    fn();
  } finally {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
  }

  return captured;
}

test("default transport is stderr, never stdout", () => {
  const captured = capture(() => {
    createLogger().info("hello");
  });

  assert.equal(captured.stdout.length, 0, "stdout must stay free of log output");
  assert.equal(captured.stderr.length, 1);
});

test("stdout can still be selected explicitly", () => {
  const captured = capture(() => {
    createLogger({ transports: ["stdout"] }).info("hello");
  });

  assert.equal(captured.stdout.length, 1);
  assert.equal(captured.stderr.length, 0);
});

test("json format emits one parsable object per line", () => {
  const captured = capture(() => {
    createLogger({ defaultMeta: { service: "svc" } }).info("started", { port: 3000 });
  });

  const line = captured.stderr[0]!;
  assert.ok(line.endsWith("\n"), "each entry should be newline delimited");

  const entry = JSON.parse(line) as Record<string, unknown>;
  assert.equal(entry["level"], "info");
  assert.equal(entry["message"], "started");
  assert.equal(entry["service"], "svc");
  assert.equal(entry["port"], 3000);
  assert.equal(typeof entry["timestamp"], "string");
});

test("entries below the configured level are discarded", () => {
  const captured = capture(() => {
    const logger = createLogger({ level: "warn" });
    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");
  });

  const levels = captured.stderr.map((line) => (JSON.parse(line) as { level: string }).level);
  assert.deepEqual(levels, ["warn", "error"]);
});

test("setLevel changes filtering at runtime and validates its input", () => {
  const logger = createLogger({ level: "error" });

  let captured = capture(() => logger.info("suppressed"));
  assert.equal(captured.stderr.length, 0);

  logger.setLevel("debug");
  assert.equal(logger.getLevel(), "debug");

  captured = capture(() => logger.info("emitted"));
  assert.equal(captured.stderr.length, 1);

  assert.throws(() => logger.setLevel("verbose" as never), /Invalid log level/);
});

test("createLogger rejects an invalid level", () => {
  assert.throws(() => createLogger({ level: "trace" as never }), /Invalid log level/);
});

test("an Error argument is serialised into an error field", () => {
  const captured = capture(() => {
    createLogger().error("boom", new TypeError("bad input"));
  });

  const entry = JSON.parse(captured.stderr[0]!) as {
    error: { name: string; message: string; stack?: string };
  };
  assert.equal(entry.error.name, "TypeError");
  assert.equal(entry.error.message, "bad input");
  assert.ok(entry.error.stack);
});

test("child loggers merge their metadata over the parent's", () => {
  const captured = capture(() => {
    const parent = createLogger({ defaultMeta: { service: "svc", scope: "root" } });
    parent.child({ scope: "child", requestId: "r-1" }).info("hi");
  });

  const entry = JSON.parse(captured.stderr[0]!) as Record<string, unknown>;
  assert.equal(entry["service"], "svc");
  assert.equal(entry["scope"], "child");
  assert.equal(entry["requestId"], "r-1");
});

test("text format includes the level and the message", () => {
  const captured = capture(() => {
    createLogger({ format: "text" }).warn("careful", { retries: 2 });
  });

  const line = captured.stderr[0]!;
  assert.match(line, /WARN/);
  assert.match(line, /careful/);
  assert.match(line, /"retries":2/);
});

test("nullLogger writes nothing anywhere", () => {
  const captured = capture(() => {
    nullLogger.error("ignored", new Error("ignored"));
    nullLogger.child({ a: 1 }).info("ignored");
  });

  assert.equal(captured.stdout.length, 0);
  assert.equal(captured.stderr.length, 0);
});
