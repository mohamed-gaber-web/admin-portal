import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual
} from "node:crypto";

/**
 * TOTP and secret encryption (US-025).
 *
 * RFC 6238 implemented directly on node:crypto rather than pulled in as a
 * dependency: it is thirty lines of HMAC, and a second factor is a poor place
 * to inherit someone else's supply chain.
 *
 * The shared secret is **encrypted, not hashed**. Unlike a password or a
 * refresh token, the server has to reproduce it to check a code, so a one-way
 * digest is not available — which makes the key management below the actual
 * security boundary.
 */

/** Seconds per code. 30 is what every authenticator app assumes. */
export const TOTP_PERIOD_SECONDS = 30;

/** Digits per code. */
export const TOTP_DIGITS = 6;

/**
 * How many periods either side of now are accepted.
 *
 * One step, so a code stays usable for roughly 30 seconds past its period —
 * enough for clock drift and slow typing. Wider would multiply the number of
 * codes valid at any moment, and each one is a code an attacker may guess.
 */
export const TOTP_WINDOW_STEPS = 1;

/** 160 bits, the RFC 4226 recommendation and what authenticator apps expect. */
const SECRET_BYTES = 20;

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** RFC 4648 base32, unpadded — the encoding `otpauth://` URIs use. */
export function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/=+$/, "").replace(/\s/g, "");
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) {
      throw new Error("invalid base32 character in TOTP secret");
    }
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** A fresh shared secret, base32 encoded for the enrolling user. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(SECRET_BYTES));
}

/** The time step a moment falls in. Also the replay key — see US-025 AC3. */
export function totpStep(at: Date = new Date()): number {
  return Math.floor(at.getTime() / 1000 / TOTP_PERIOD_SECONDS);
}

/** HOTP (RFC 4226) over a counter, which TOTP derives from the clock. */
export function totpCodeForStep(secretBase32: string, step: number): string {
  const key = base32Decode(secretBase32);

  const counter = Buffer.alloc(8);
  // 53-bit safe: writing the high and low halves separately avoids BigInt.
  counter.writeUInt32BE(Math.floor(step / 2 ** 32), 0);
  counter.writeUInt32BE(step >>> 0, 4);

  const digest = createHmac("sha1", key).update(counter).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    (digest[offset + 1] << 16) |
    (digest[offset + 2] << 8) |
    digest[offset + 3];

  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, "0");
}

/** The code valid right now. Used by tests and by nothing in production. */
export function totpCodeNow(secretBase32: string, at: Date = new Date()): string {
  return totpCodeForStep(secretBase32, totpStep(at));
}

/**
 * Checks a code against every step in the accepted window.
 *
 * Returns the step it matched — not just true — because the caller must record
 * that step to stop the same code being replayed inside its validity window
 * (AC3). A boolean here would make that impossible to do correctly.
 */
export function verifyTotpCode(
  secretBase32: string,
  code: string,
  at: Date = new Date()
): number | null {
  const candidate = code.trim();
  if (!/^\d+$/.test(candidate) || candidate.length !== TOTP_DIGITS) {
    return null;
  }

  const now = totpStep(at);
  for (let offset = -TOTP_WINDOW_STEPS; offset <= TOTP_WINDOW_STEPS; offset += 1) {
    const step = now + offset;
    if (constantTimeEquals(totpCodeForStep(secretBase32, step), candidate)) {
      return step;
    }
  }
  return null;
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

/** The `otpauth://` URI an authenticator app scans. */
export function totpUri(secretBase32: string, email: string, issuer = "Grow Path Admin"): string {
  const label = encodeURIComponent(`${issuer}:${email}`);
  const params = new URLSearchParams({
    secret: secretBase32,
    issuer,
    algorithm: "SHA1",
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS)
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

// --- Secret encryption -----------------------------------------------------

const CIPHER = "aes-256-gcm";
const ENCRYPTION_VERSION = "v1";
const IV_BYTES = 12;

/**
 * A visibly fake key used only outside production, matching how the JWT signing
 * key behaves. Production refuses to start without a real one.
 */
const DEVELOPMENT_ONLY_KEY = "insecure-development-only-mfa-key-do-not-use-in-production";

const MIN_KEY_LENGTH = 32;

let cachedKey: Buffer | undefined;

/**
 * The AES key, from AUTH_MFA_KEY.
 *
 * Fails closed in production: falling back to a value published in this file
 * would make every enrolled second factor forgeable by anyone who has read the
 * repository, which is worse than having no second factor at all — it is a
 * second factor everyone believes in.
 */
function encryptionKey(): Buffer {
  if (cachedKey) {
    return cachedKey;
  }

  const configured = process.env.AUTH_MFA_KEY?.trim();
  if (!configured) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "AUTH_MFA_KEY is not set. Refusing to encrypt MFA secrets with the development key."
      );
    }
    cachedKey = createHash("sha256").update(DEVELOPMENT_ONLY_KEY).digest();
    return cachedKey;
  }

  if (configured.length < MIN_KEY_LENGTH) {
    throw new Error(`AUTH_MFA_KEY must be at least ${MIN_KEY_LENGTH} characters.`);
  }

  // SHA-256 to reach exactly 32 bytes from a passphrase of any length.
  cachedKey = createHash("sha256").update(configured, "utf8").digest();
  return cachedKey;
}

/** Test seam: forget the cached key after changing AUTH_MFA_KEY. */
export function resetMfaEncryptionKey(): void {
  cachedKey = undefined;
}

/**
 * Encrypts a secret for storage.
 *
 * AES-256-GCM, so the stored value is authenticated as well as confidential —
 * an attacker with write access to the column cannot swap in a secret of their
 * own without the tag failing.
 *
 * Versioned, so a key rotation can re-encrypt without guessing the old format.
 */
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(CIPHER, encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    ENCRYPTION_VERSION,
    iv.toString("base64url"),
    tag.toString("base64url"),
    ciphertext.toString("base64url")
  ].join(".");
}

/** Decrypts a stored secret, or null if it cannot be trusted. */
export function decryptSecret(stored: string): string | null {
  try {
    const [version, iv, tag, ciphertext] = stored.split(".");
    if (version !== ENCRYPTION_VERSION || !iv || !tag || !ciphertext) {
      return null;
    }
    const decipher = createDecipheriv(CIPHER, encryptionKey(), Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertext, "base64url")),
      decipher.final()
    ]).toString("utf8");
  } catch {
    // A wrong key, a truncated value or a tampered tag all read the same.
    return null;
  }
}
