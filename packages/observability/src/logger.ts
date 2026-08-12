import { getRequestContext } from "./context";
import { redactValues, type RedactableValues } from "./redaction";

/**
 * Structured logging (US-007).
 *
 * One JSON object per line, and every line carries the correlation, tenant and
 * user IDs from the request context automatically — a field that has to be
 * passed by hand is a field that is missing from the line you need.
 *
 * Two rules keep secrets out (AC3):
 *   1. Fields are redacted by key, using the same rule as the audit log.
 *   2. Nothing serialises a whole request body or header bag. Callers log named
 *      fields; there is no `log(req)`.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** A logger with extra fields merged into every line it writes. */
  child(bindings: LogFields): Logger;
}

export interface LoggerOptions {
  /** Component name, e.g. "api" or "db". */
  name?: string;
  /** Lines below this level are dropped. Defaults to LOG_LEVEL, else "info". */
  level?: LogLevel;
  /** Where a formatted line goes. Defaults to stdout. */
  sink?: (line: string) => void;
  /** Injected by tests so timestamps are predictable. */
  now?: () => Date;
  /** Fields merged into every line. */
  bindings?: LogFields;
}

function defaultLevel(): LogLevel {
  const fromEnv = process.env.LOG_LEVEL?.toLowerCase();
  return fromEnv && fromEnv in LEVEL_ORDER ? (fromEnv as LogLevel) : "info";
}

/**
 * Looked up at call time rather than captured, so a test spying on
 * `process.stdout.write` sees the real default path.
 */
function writeToStdout(line: string): void {
  process.stdout.write(`${line}\n`);
}

/** Serialises an Error without letting a circular `cause` chain throw. */
function serializeError(err: unknown): LogFields {
  if (!(err instanceof Error)) {
    return { message: String(err) };
  }
  return { name: err.name, message: err.message, stack: err.stack };
}

/** JSON.stringify that survives circular references and BigInt. */
function safeStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(value, (_key, val: unknown) => {
    if (typeof val === "bigint") {
      return val.toString();
    }
    if (typeof val === "object" && val !== null) {
      if (seen.has(val)) {
        return "[circular]";
      }
      seen.add(val);
    }
    return val;
  });
}

function normalizeFields(fields: LogFields | undefined): RedactableValues {
  if (!fields) {
    return {};
  }
  const prepared: RedactableValues = {};
  for (const [key, value] of Object.entries(fields)) {
    prepared[key] = value instanceof Error ? serializeError(value) : value;
  }
  return redactValues(prepared) ?? {};
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const name = options.name ?? "app";
  const threshold = LEVEL_ORDER[options.level ?? defaultLevel()];
  const sink = options.sink ?? writeToStdout;
  const now = options.now ?? ((): Date => new Date());
  const bindings = options.bindings ?? {};

  const emit = (level: LogLevel, message: string, fields?: LogFields): void => {
    if (LEVEL_ORDER[level] < threshold) {
      return;
    }
    const context = getRequestContext();
    const line = {
      ts: now().toISOString(),
      level,
      name,
      msg: message,
      // Present on every line even when null, so "no correlation ID" is a
      // visible fact rather than a missing key you have to interpret.
      correlationId: context?.correlationId ?? null,
      tenantId: context?.tenantId ?? null,
      userId: context?.userId ?? null,
      ...normalizeFields(bindings),
      ...normalizeFields(fields)
    };
    sink(safeStringify(line));
  };

  return {
    debug: (message, fields) => emit("debug", message, fields),
    info: (message, fields) => emit("info", message, fields),
    warn: (message, fields) => emit("warn", message, fields),
    error: (message, fields) => emit("error", message, fields),
    child: (extra) =>
      createLogger({
        ...options,
        name,
        sink,
        now,
        bindings: { ...bindings, ...extra }
      })
  };
}

/** The default logger, for code with nowhere better to get one. */
export const logger = createLogger();
