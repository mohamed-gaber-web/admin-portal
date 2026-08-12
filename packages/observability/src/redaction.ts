/**
 * Key-based redaction, shared by the audit log (US-015) and the logger (US-007).
 *
 * It lives here rather than in `@growpath/db` because both writers need exactly
 * the same rule. Two copies of a security regex is one copy that gets updated.
 */

/** Placeholder written in place of any secret value. */
export const REDACTED = "[redacted]";

/**
 * Field names whose values must never be persisted or logged. Matched on the
 * key, not the value: guessing at whether a string "looks like" a token is how
 * secrets get missed.
 */
const SECRET_KEY =
  /(secret|password|passwd|token|credential|api[-_]?key|authorization|cookie|private[-_]?key|connection[-_]?string)/i;

export type RedactableValues = Record<string, unknown>;

export function isSecretKey(key: string): boolean {
  return SECRET_KEY.test(key);
}

/** Written in place of a value that refers back to one of its own ancestors. */
export const CIRCULAR = "[circular]";

function isPlainObject(value: unknown): value is RedactableValues {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Values that carry their own serialised form and must be treated as leaves.
 *
 * Walking a Date with Object.entries yields nothing — its fields are internal —
 * so recursing into one silently replaced every timestamp with `{}`. That was
 * invisible in the audit log: a before/after pair recorded that a date changed
 * and stored `{}` for what it changed to.
 */
function selfSerialising(value: object): string | null {
  if (value instanceof Date) {
    return value.toISOString();
  }
  const candidate = (value as { toJSON?: unknown }).toJSON;
  return typeof candidate === "function"
    ? String((value as { toJSON: () => unknown }).toJSON())
    : null;
}

function redactUnknown(value: unknown, ancestors: Set<object>): unknown {
  if (typeof value !== "object" || value === null) {
    return value;
  }

  // A cycle, not a repeat: `ancestors` is unwound on the way out, so the same
  // object appearing twice side by side is kept both times.
  if (ancestors.has(value)) {
    return CIRCULAR;
  }

  if (Array.isArray(value)) {
    ancestors.add(value);
    try {
      return value.map((item) => redactUnknown(item, ancestors));
    } finally {
      ancestors.delete(value);
    }
  }

  const serialised = selfSerialising(value);
  if (serialised !== null) {
    return serialised;
  }

  if (!isPlainObject(value)) {
    return value;
  }

  ancestors.add(value);
  try {
    return redactObject(value, ancestors);
  } finally {
    ancestors.delete(value);
  }
}

function redactObject(values: RedactableValues, ancestors: Set<object>): RedactableValues {
  const out: RedactableValues = {};
  for (const [key, value] of Object.entries(values)) {
    out[key] = isSecretKey(key) ? REDACTED : redactUnknown(value, ancestors);
  }
  return out;
}

/**
 * Replaces every secret value with {@link REDACTED}, recursively.
 *
 * Survives cycles: without a guard this recursed until the stack overflowed, so
 * logging an object that referred to itself threw a RangeError out of the
 * logger — from inside the error path that was trying to report something else.
 */
export function redactValues(
  values: RedactableValues | null | undefined
): RedactableValues | null {
  if (!values) {
    return null;
  }
  return redactObject(values, new Set<object>());
}
