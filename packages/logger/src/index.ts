/**
 * @mcp-toolkit/logger
 *
 * Structured logging for MCP servers.
 * Supports JSON and text formats, multiple log levels, and pluggable transports.
 */

import { writeFileSync, appendFileSync, mkdirSync } from "fs";
import { dirname } from "path";

// ---------------------------------------------------------------------------
// Types & Interfaces
// ---------------------------------------------------------------------------

/** Available log levels, ordered by severity. */
export type LogLevel = "debug" | "info" | "warn" | "error";

/** Output format for log entries. */
export type LogFormat = "json" | "text";

/** A structured log entry. */
export interface LogEntry {
  /** ISO-8601 timestamp. */
  timestamp: string;
  /** Severity level. */
  level: LogLevel;
  /** Human-readable message. */
  message: string;
  /** Arbitrary structured data attached to the entry. */
  data?: Record<string, unknown>;
  /** Error information (if logging an error). */
  error?: {
    name: string;
    message: string;
    stack?: string;
  };
}

/** Configuration for a file transport. */
export interface FileTransport {
  type: "file";
  /** Path to the log file. */
  path: string;
}

/** Transport can be a simple string identifier or a config object. */
export type Transport = "stdout" | "stderr" | FileTransport;

/** Options for `createLogger`. */
export interface LoggerOptions {
  /**
   * Minimum log level.  Messages below this severity are discarded.
   * @default "info"
   */
  level?: LogLevel;
  /**
   * Output format.
   * @default "json"
   */
  format?: LogFormat;
  /**
   * Where to write log output.
   * @default ["stdout"]
   */
  transports?: Transport[];
  /**
   * Static fields merged into every log entry.
   */
  defaultMeta?: Record<string, unknown>;
}

/** The logger interface returned by `createLogger`. */
export interface Logger {
  debug(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, dataOrError?: Record<string, unknown> | Error): void;
  /** Create a child logger that inherits config and adds extra default metadata. */
  child(meta: Record<string, unknown>): Logger;
  /** Get the current minimum log level. */
  getLevel(): LogLevel;
  /** Change the minimum log level at runtime. */
  setLevel(level: LogLevel): void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LOG_LEVEL_VALUES: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const LEVEL_COLORS: Record<LogLevel, string> = {
  debug: "\x1b[36m", // cyan
  info: "\x1b[32m",  // green
  warn: "\x1b[33m",  // yellow
  error: "\x1b[31m", // red
};

const RESET = "\x1b[0m";

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function formatJson(entry: LogEntry, defaultMeta?: Record<string, unknown>): string {
  const obj: Record<string, unknown> = {
    timestamp: entry.timestamp,
    level: entry.level,
    message: entry.message,
    ...defaultMeta,
    ...entry.data,
  };
  if (entry.error) {
    obj["error"] = entry.error;
  }
  return JSON.stringify(obj);
}

function formatText(entry: LogEntry, defaultMeta?: Record<string, unknown>): string {
  const color = LEVEL_COLORS[entry.level];
  const levelTag = `${color}${entry.level.toUpperCase().padEnd(5)}${RESET}`;
  const ts = entry.timestamp;

  let line = `${ts} ${levelTag} ${entry.message}`;

  const merged = { ...defaultMeta, ...entry.data };
  if (Object.keys(merged).length > 0) {
    line += ` ${JSON.stringify(merged)}`;
  }

  if (entry.error) {
    line += `\n  Error: ${entry.error.name}: ${entry.error.message}`;
    if (entry.error.stack) {
      line += `\n  ${entry.error.stack.split("\n").slice(1).join("\n  ")}`;
    }
  }

  return line;
}

// ---------------------------------------------------------------------------
// Transport writers
// ---------------------------------------------------------------------------

function writeToTransport(transport: Transport, line: string): void {
  if (transport === "stdout") {
    process.stdout.write(line + "\n");
  } else if (transport === "stderr") {
    process.stderr.write(line + "\n");
  } else if (transport.type === "file") {
    try {
      mkdirSync(dirname(transport.path), { recursive: true });
      appendFileSync(transport.path, line + "\n", "utf-8");
    } catch {
      // If we can't write to the file, fall back to stderr
      process.stderr.write(`[logger] Failed to write to ${transport.path}: ${line}\n`);
    }
  }
}

// ---------------------------------------------------------------------------
// Logger implementation
// ---------------------------------------------------------------------------

function createLoggerImpl(
  level: LogLevel,
  format: LogFormat,
  transports: Transport[],
  defaultMeta: Record<string, unknown>,
): Logger {
  let currentLevel = level;

  function shouldLog(msgLevel: LogLevel): boolean {
    return LOG_LEVEL_VALUES[msgLevel] >= LOG_LEVEL_VALUES[currentLevel];
  }

  function emit(entry: LogEntry): void {
    const line =
      format === "json"
        ? formatJson(entry, defaultMeta)
        : formatText(entry, defaultMeta);

    for (const transport of transports) {
      writeToTransport(transport, line);
    }
  }

  function log(
    msgLevel: LogLevel,
    message: string,
    dataOrError?: Record<string, unknown> | Error,
  ): void {
    if (!shouldLog(msgLevel)) return;

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level: msgLevel,
      message,
    };

    if (dataOrError instanceof Error) {
      entry.error = {
        name: dataOrError.name,
        message: dataOrError.message,
        stack: dataOrError.stack,
      };
    } else if (dataOrError) {
      entry.data = dataOrError;
    }

    emit(entry);
  }

  const logger: Logger = {
    debug(message: string, data?: Record<string, unknown>) {
      log("debug", message, data);
    },

    info(message: string, data?: Record<string, unknown>) {
      log("info", message, data);
    },

    warn(message: string, data?: Record<string, unknown>) {
      log("warn", message, data);
    },

    error(message: string, dataOrError?: Record<string, unknown> | Error) {
      log("error", message, dataOrError);
    },

    child(meta: Record<string, unknown>): Logger {
      return createLoggerImpl(currentLevel, format, transports, {
        ...defaultMeta,
        ...meta,
      });
    },

    getLevel(): LogLevel {
      return currentLevel;
    },

    setLevel(newLevel: LogLevel): void {
      if (!(newLevel in LOG_LEVEL_VALUES)) {
        throw new Error(
          `Invalid log level "${newLevel}". Must be one of: ${Object.keys(LOG_LEVEL_VALUES).join(", ")}`,
        );
      }
      currentLevel = newLevel;
    },
  };

  return logger;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create a structured logger instance.
 *
 * @param options - Logger configuration.
 * @returns A `Logger` object with `debug`, `info`, `warn`, and `error` methods.
 *
 * @example
 * ```ts
 * import { createLogger } from "@mcp-toolkit/logger";
 *
 * const logger = createLogger({
 *   level: "info",
 *   format: "json",
 *   transports: ["stdout", { type: "file", path: "./app.log" }],
 *   defaultMeta: { service: "my-mcp-server" },
 * });
 *
 * logger.info("Server started", { port: 3000 });
 * logger.error("Something failed", new Error("oops"));
 * ```
 */
export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? "info";
  const format = options.format ?? "json";
  const transports = options.transports ?? ["stdout"];
  const defaultMeta = options.defaultMeta ?? {};

  if (!(level in LOG_LEVEL_VALUES)) {
    throw new Error(
      `Invalid log level "${level}". Must be one of: ${Object.keys(LOG_LEVEL_VALUES).join(", ")}`,
    );
  }

  return createLoggerImpl(level, format, transports, defaultMeta);
}

/**
 * A no-op logger that silently discards all messages.
 * Useful for testing or when logging should be completely disabled.
 */
export const nullLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return nullLogger;
  },
  getLevel() {
    return "error" as LogLevel;
  },
  setLevel() {},
};
