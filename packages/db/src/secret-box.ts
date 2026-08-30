import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * Authenticated encryption for secrets the server must reproduce (US-041).
 *
 * Most credentials in this repository are hashed, and that is always the better
 * answer: a password, an invitation token and a refresh token are all things the
 * server only ever has to *recognise*. A D365 client secret is not. The API has
 * to present it to Entra to obtain a token, so a one-way digest is unavailable
 * and encryption is what is left.
 *
 * That makes `SECRET_ENCRYPTION_KEY` — not this file — the security boundary,
 * and it is what the sprint's exit criterion is really about: "no client secret
 * is recoverable from the database alone" is a claim that the key lives
 * somewhere the database does not.
 *
 * ### Why this is not `totp.ts`
 *
 * `encryptSecret`/`decryptSecret` there do the same job for MFA secrets, and
 * this deliberately does not replace them. Re-keying that column would drop
 * every existing enrolment on the floor — every enrolled user would have to
 * enrol again, on a deploy nobody warned them about — and a sealed value carries
 * no marker saying which scheme produced it. Two schemes with separate keys and
 * separate blast radii is the honest state; one shared scheme reached by
 * rewriting live ciphertext is not worth the tidiness.
 *
 * ### The upgrade path to a key vault
 *
 * US-041 asks for envelope encryption with the master key in a vault. The
 * version tag is the seam: `openSecret` dispatches on it, so a later `v2.` can
 * mean "a per-record data key, wrapped by a Key Vault key, prepended here" and
 * both formats can be read during the migration. Nothing outside this file
 * inspects the format, so that change stays inside it.
 */

const CIPHER = "aes-256-gcm";
const IV_BYTES = 12;

/** The only format written today. Read support is per-version, see `openSecret`. */
const CURRENT_VERSION = "v1";

const MIN_KEY_LENGTH = 32;

/**
 * A visibly fake key, used only outside production — the same arrangement
 * `AUTH_JWT_SECRET` and `AUTH_MFA_KEY` use, and for the same reason. A quiet
 * fallback would make every sealed secret readable by anyone who has read this
 * repository, which is worse than storing them in plaintext: plaintext at least
 * looks like what it is.
 */
const DEVELOPMENT_ONLY_KEY = "insecure-development-only-secret-key-do-not-use-in-production";

/**
 * What a sealed value is for.
 *
 * Bound into the ciphertext as additional authenticated data, so a value sealed
 * for one field cannot be moved to another and still open. Without it, someone
 * with UPDATE on the table could copy a working connection's sealed secret onto
 * an environment they control and have the API authenticate with a credential
 * they were never given — the ciphertext is valid, and only the purpose says it
 * does not belong there.
 *
 * A union rather than a string, so a typo is a compile error instead of a value
 * that seals fine and never opens.
 */
export type SecretPurpose = "d365.clientSecret";

let cachedKey: Buffer | undefined;

/**
 * The AES key, from `SECRET_ENCRYPTION_KEY`.
 *
 * Named generically because the box is generic: the purpose label, not the key,
 * is what separates one kind of secret from another. Fails closed in production.
 */
function encryptionKey(): Buffer {
  if (cachedKey) {
    return cachedKey;
  }

  const configured = process.env.SECRET_ENCRYPTION_KEY?.trim();
  if (!configured) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "SECRET_ENCRYPTION_KEY is not set. Refusing to seal credentials with the development key."
      );
    }
    cachedKey = createHash("sha256").update(DEVELOPMENT_ONLY_KEY).digest();
    return cachedKey;
  }

  if (configured.length < MIN_KEY_LENGTH) {
    throw new Error(`SECRET_ENCRYPTION_KEY must be at least ${MIN_KEY_LENGTH} characters.`);
  }

  // SHA-256 to reach exactly 32 bytes from a passphrase of any length.
  cachedKey = createHash("sha256").update(configured, "utf8").digest();
  return cachedKey;
}

/** Test seam: forget the cached key after changing SECRET_ENCRYPTION_KEY. */
export function resetSecretEncryptionKey(): void {
  cachedKey = undefined;
}

/**
 * Seals a secret for storage.
 *
 * AES-256-GCM, so the stored value is authenticated as well as confidential:
 * someone with write access to the column cannot substitute a credential of
 * their own without the tag failing.
 */
export function sealSecret(purpose: SecretPurpose, plaintext: string): string {
  if (!plaintext) {
    // Sealing "" produces a valid blob that opens to a falsy value, which reads
    // downstream as "no secret configured" — the check constraint says that is
    // a state a configured connection may not be in.
    throw new Error("cannot seal an empty secret");
  }

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(CIPHER, encryptionKey(), iv);
  cipher.setAAD(Buffer.from(purpose, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);

  return [
    CURRENT_VERSION,
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url")
  ].join(".");
}

/**
 * Opens a sealed secret, or null if it cannot be trusted.
 *
 * Null covers a wrong key, a rotated key, a truncated value, a tampered tag and
 * a value sealed for a different purpose — one answer, because the caller's
 * response to all five is the same: refuse, and do not use the connection.
 * Distinguishing them here would only produce error messages that describe the
 * key management to whoever reads the log.
 */
export function openSecret(purpose: SecretPurpose, sealed: string): string | null {
  try {
    const [version, iv, tag, ciphertext] = sealed.split(".");
    if (version !== CURRENT_VERSION || !iv || !tag || !ciphertext) {
      return null;
    }

    const decipher = createDecipheriv(CIPHER, encryptionKey(), Buffer.from(iv, "base64url"));
    decipher.setAAD(Buffer.from(purpose, "utf8"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));

    return Buffer.concat([
      decipher.update(Buffer.from(ciphertext, "base64url")),
      decipher.final()
    ]).toString("utf8");
  } catch {
    return null;
  }
}

/**
 * True for a value this module produced.
 *
 * Used by the guard test that asserts no plaintext credential reaches the
 * column: a value that is not sealed is a bug worth failing on, and "looks like
 * a GUID" is not something the schema can check.
 */
export function isSealed(value: string | null | undefined): boolean {
  return typeof value === "string" && /^v1\.[\w-]+\.[\w-]+\.[\w-]+$/.test(value);
}
