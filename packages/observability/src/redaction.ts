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

function isPlainObject(value: unknown): value is RedactableValues {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function redactObject(values: RedactableValues): RedactableValues {
  const out: RedactableValues = {};
  for (const [key, value] of Object.entries(values)) {
    if (isSecretKey(key)) {
      out[key] = REDACTED;
    } else if (Array.isArray(value)) {
      out[key] = value.map((item) => (isPlainObject(item) ? redactObject(item) : item));
    } else if (isPlainObject(value)) {
      out[key] = redactObject(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** Replaces every secret value with {@link REDACTED}, recursively. */
export function redactValues(
  values: RedactableValues | null | undefined
): RedactableValues | null {
  if (!values) {
    return null;
  }
  return redactObject(values);
}
