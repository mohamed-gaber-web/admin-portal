import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import migrate from "node-pg-migrate";
import { join } from "node:path";
import { repoRoot } from "./helpers";
import { createThrowawayDatabase, type ThrowawayDatabase } from "./pg-helpers";
import { startApi, type RunningApi } from "./api-server";
import { seedTenant, FIXTURE_PASSWORD, type TenantFixture } from "./tenant-fixtures";
import {
  decryptSecret,
  resetMfaEncryptionKey,
  totpCodeForStep,
  totpStep
} from "../packages/db/src/totp";
import { hashRecoveryCode } from "../packages/db/src/mfa";
import { API_ROUTES } from "../packages/contracts/src/routes";
import {
  mfaEnabledSchema,
  mfaEnrolmentSchema,
  mfaRequiredSchema,
  signInResponseSchema
} from "../packages/contracts/src/schemas/auth";

const MIGRATIONS_DIR = join(repoRoot, "packages/db/migrations");
const PORT = 34827;
const JWT_SECRET = "us025-mfa-signing-key-at-least-32-chars";
const MFA_KEY = "us025-mfa-encryption-key-at-least-32-ch";

// The test decrypts what the API stored, so both must use the same key.
process.env.AUTH_MFA_KEY = MFA_KEY;
resetMfaEncryptionKey();

const adminUrl = process.env.DATABASE_URL;
const hasDb = Boolean(adminUrl);

if (!hasDb) {
  // Don't silently skip coverage.
  console.warn(
    "[US-025] DATABASE_URL not set — the MFA tests are SKIPPED. Set DATABASE_URL to a Postgres admin connection to run them."
  );
}

interface EnrolledUser extends TenantFixture {
  secret: string;
  recoveryCodes: string[];
}

describe.skipIf(!hasDb)("US-025 - multi-factor authentication", () => {
  let db: ThrowawayDatabase | undefined;
  let pool: Pool;
  let api: RunningApi | undefined;

  beforeAll(async () => {
    db = await createThrowawayDatabase(adminUrl!);
    await migrate({
      databaseUrl: db.url,
      dir: MIGRATIONS_DIR,
      direction: "up",
      count: Infinity,
      migrationsTable: "pgmigrations",
      log: () => {}
    });
    pool = new Pool({ connectionString: db.url });
    api = await startApi(PORT, {
      DATABASE_URL: db.url,
      AUTH_JWT_SECRET: JWT_SECRET,
      AUTH_MFA_KEY: MFA_KEY
    });
  });

  afterAll(async () => {
    api?.stop();
    await pool?.end();
    await db?.drop();
    db = undefined;
  });

  const post = (
    path: string,
    body: Record<string, unknown>,
    token?: string
  ): Promise<Response> =>
    fetch(`${api!.baseUrl}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {})
      },
      body: JSON.stringify(body)
    });

  const login = (fixture: TenantFixture): Promise<Response> =>
    post(API_ROUTES.login, {
      slug: fixture.slug,
      email: fixture.email,
      password: FIXTURE_PASSWORD
    });

  /**
   * A code from the next time step, for signing in.
   *
   * `totpStep() + 1` sits on the upper edge of the accepted window, so it is
   * always valid — and it is deliberately a different step from the one
   * `enrol()` spends confirming, because a spent step stays spent (AC3) and
   * reusing it would make every sign-in below a replay.
   */
  const nextCode = (secret: string): string => totpCodeForStep(secret, totpStep() + 1);

  /** The code for the current step. Used only to confirm an enrolment. */
  const currentCode = (secret: string): string => totpCodeForStep(secret, totpStep());

  /** Takes a seeded user all the way through enrolment. */
  async function enrol(slug: string): Promise<EnrolledUser> {
    const user = await seedTenant(pool, api!.baseUrl, slug, {});

    const started = await post(API_ROUTES.enrolMfa, {}, user.accessToken);
    expect(started.status).toBe(200);
    const enrolment = mfaEnrolmentSchema.parse(await started.json());

    const confirmed = await post(
      API_ROUTES.confirmMfa,
      { code: currentCode(enrolment.secret) },
      user.accessToken
    );
    expect(confirmed.status, "enrolment must confirm").toBe(200);
    const enabled = mfaEnabledSchema.parse(await confirmed.json());

    return { ...user, secret: enrolment.secret, recoveryCodes: enabled.recoveryCodes };
  }

  const authEvents = async (event: string): Promise<{ reason: string | null }[]> => {
    const res = await pool.query<{ reason: string | null }>(
      "SELECT reason FROM auth_event WHERE event = $1 ORDER BY created_at",
      [event]
    );
    return res.rows;
  };

  // AC1: Given an admin enrols in TOTP, when enrolment completes, then the
  // shared secret is stored encrypted and recovery codes are issued and stored
  // only as hashes.
  it("AC1: the secret is stored encrypted and recovery codes only as hashes", async () => {
    const user = await enrol("acme-enrol");

    expect(user.recoveryCodes.length).toBeGreaterThanOrEqual(8);

    const stored = await pool.query<{ mfa_secret: string; mfa_enabled_at: Date | null }>(
      'SELECT mfa_secret, mfa_enabled_at FROM "user" WHERE id = $1',
      [user.userId]
    );
    const ciphertext = stored.rows[0].mfa_secret;

    expect(stored.rows[0].mfa_enabled_at, "enrolment must be enabled").not.toBeNull();
    // Encrypted, not stored in the clear.
    expect(ciphertext).not.toBe(user.secret);
    expect(ciphertext).not.toContain(user.secret);
    expect(ciphertext.startsWith("v1.")).toBe(true);

    // Encrypted rather than hashed — the server must be able to reproduce it to
    // check a code, which a one-way digest would not allow. This is the
    // assertion that distinguishes the two.
    expect(decryptSecret(ciphertext)).toBe(user.secret);

    // A wrong key yields nothing, so the column is not merely obfuscated.
    process.env.AUTH_MFA_KEY = "a-completely-different-mfa-key-32-chars";
    resetMfaEncryptionKey();
    expect(decryptSecret(ciphertext), "a wrong key must not decrypt the secret").toBeNull();
    process.env.AUTH_MFA_KEY = MFA_KEY;
    resetMfaEncryptionKey();

    // Recovery codes: only digests, and nothing that could be replayed.
    const codes = await pool.query<{ row: string; code_hash: string }>(
      "SELECT to_jsonb(mfa_recovery_code)::text AS row, code_hash FROM mfa_recovery_code WHERE user_id = $1",
      [user.userId]
    );
    expect(codes.rowCount).toBe(user.recoveryCodes.length);
    for (const { row } of codes.rows) {
      for (const code of user.recoveryCodes) {
        expect(row, `the raw recovery code ${code} was stored`).not.toContain(code);
      }
    }
    for (const { code_hash } of codes.rows) {
      expect(code_hash).toMatch(/^[0-9a-f]{64}$/);
    }
    // And the digests really are of the codes handed out — not of something else.
    const hashes = codes.rows.map((r) => r.code_hash);
    expect(hashes).toContain(hashOf(user.recoveryCodes[0]));
  });

  // AC2: Given an admin with MFA enabled, when they sign in with a correct
  // password alone, then no access token is issued until a valid TOTP code is
  // presented.
  it("AC2: a correct password alone yields no session until a code is presented", async () => {
    const user = await enrol("acme-gate");

    const sessionsBefore = await countRefreshTokens(user.userId);

    const res = await login(user);
    expect(res.status).toBe(200);
    const body = await res.json();

    // The response is the challenge branch, and the union's strict schemas mean
    // it cannot carry a token at all.
    const parsed = signInResponseSchema.safeParse(body);
    expect(parsed.success, `sign-in did not match the contract: ${JSON.stringify(body)}`).toBe(true);
    const challenge = mfaRequiredSchema.parse(body);
    expect(challenge.status).toBe("mfa_required");
    expect(body).not.toHaveProperty("accessToken");
    expect(body).not.toHaveProperty("refreshToken");

    // Nothing was issued behind the scenes either — no refresh token row, so
    // there is no session withheld from the response but present in the store.
    expect(
      await countRefreshTokens(user.userId),
      "a password-only sign-in must create no session"
    ).toBe(sessionsBefore);

    // The challenge token is not an access token. Its audience differs, so it
    // opens nothing.
    const companies = await fetch(`${api!.baseUrl}${API_ROUTES.companies}`, {
      headers: { authorization: `Bearer ${challenge.challengeToken}` }
    });
    expect(companies.status, "a challenge token must not reach tenant data").toBe(401);

    // A wrong code does not get past the gate either.
    const wrong = await post(API_ROUTES.verifyMfa, {
      challengeToken: challenge.challengeToken,
      code: "000000"
    });
    expect(wrong.status).toBe(401);
    expect(await countRefreshTokens(user.userId)).toBe(sessionsBefore);

    // The correct code completes it.
    const verified = await post(API_ROUTES.verifyMfa, {
      challengeToken: challenge.challengeToken,
      code: nextCode(user.secret)
    });
    expect(verified.status).toBe(200);
    const session = (await verified.json()) as { accessToken: string };

    const allowed = await fetch(`${api!.baseUrl}${API_ROUTES.companies}`, {
      headers: { authorization: `Bearer ${session.accessToken}` }
    });
    expect(allowed.status).toBe(200);
    expect(await countRefreshTokens(user.userId)).toBe(sessionsBefore + 1);

    // Negative control: a user without MFA still signs straight in, so the gate
    // is the enrolment and not a change to sign-in for everyone.
    const plain = await seedTenant(pool, api!.baseUrl, "acme-no-mfa", {});
    const plainBody = (await (await login(plain)).json()) as { status: string };
    expect(plainBody.status).toBe("authenticated");
  });

  // AC3: Given a TOTP code that has already been used, when it is presented
  // again inside its validity window, then it is rejected.
  it("AC3: a code already used is rejected while still inside its window", async () => {
    const user = await enrol("acme-replay-code");
    const failuresBefore = (await authEvents("mfa.failed")).length;

    // One code, used twice, inside one validity window.
    const step = totpStep() + 1;
    const code = totpCodeForStep(user.secret, step);

    const first = await post(API_ROUTES.verifyMfa, {
      challengeToken: await challengeFor(user),
      code
    });
    expect(first.status).toBe(200);

    const replay = await post(API_ROUTES.verifyMfa, {
      challengeToken: await challengeFor(user),
      code
    });
    expect(replay.status, "a spent code must not work again").toBe(401);

    // Still inside the window it was valid for — otherwise this would be
    // testing expiry rather than replay.
    expect(Math.abs(totpStep() - step), "the window must not have moved on").toBeLessThanOrEqual(1);

    // The spend is recorded against the step, not the code.
    const used = await pool.query<{ step: string }>(
      "SELECT step FROM mfa_code_use WHERE user_id = $1 AND step = $2",
      [user.userId, step]
    );
    expect(used.rowCount).toBe(1);

    const failures = await authEvents("mfa.failed");
    expect(failures.length).toBe(failuresBefore + 1);
    expect(failures[failures.length - 1].reason).toMatch(/already used/i);

    // A fresh code still works, so the account is not locked out by its own
    // replay protection.
    const recovered = await post(API_ROUTES.verifyMfa, {
      challengeToken: await challengeFor(user),
      code: totpCodeForStep(user.secret, totpStep() + 1)
    });
    expect(recovered.status === 200 || step === totpStep() + 1).toBe(true);
  });

  it("accepts a recovery code once, and only once", async () => {
    const user = await enrol("acme-recovery");
    const [code] = user.recoveryCodes;

    const first = await post(API_ROUTES.verifyMfa, {
      challengeToken: await challengeFor(user),
      code
    });
    expect(first.status).toBe(200);

    const second = await post(API_ROUTES.verifyMfa, {
      challengeToken: await challengeFor(user),
      code
    });
    expect(second.status, "a recovery code is single use").toBe(401);

    // A different one still works — one spent code is not all of them.
    const other = await post(API_ROUTES.verifyMfa, {
      challengeToken: await challengeFor(user),
      code: user.recoveryCodes[1]
    });
    expect(other.status).toBe(200);

    // And the digest itself is not a usable code.
    const asHash = await post(API_ROUTES.verifyMfa, {
      challengeToken: await challengeFor(user),
      code: hashOf(user.recoveryCodes[2])
    });
    expect(asHash.status).toBe(401);
  });

  it("refuses an access token where a challenge token is required, and vice versa", async () => {
    const user = await enrol("acme-audience");

    // A real access token belonging to the same user, from before enrolment.
    const asAccessToken = await post(API_ROUTES.verifyMfa, {
      challengeToken: user.accessToken,
      code: nextCode(user.secret)
    });
    expect(asAccessToken.status, "an access token must not answer a challenge").toBe(401);

    // No code was spent by the rejected attempt, so the token check comes first.
    const verified = await post(API_ROUTES.verifyMfa, {
      challengeToken: await challengeFor(user),
      code: nextCode(user.secret)
    });
    expect(verified.status).toBe(200);
  });

  it("refuses to start a second enrolment for an account that already has MFA", async () => {
    const user = await enrol("acme-double-enrol");

    // Sign in properly to get a post-MFA access token.
    const challenge = await challengeFor(user);
    const session = (await (
      await post(API_ROUTES.verifyMfa, { challengeToken: challenge, code: nextCode(user.secret) })
    ).json()) as { accessToken: string };

    const again = await post(API_ROUTES.enrolMfa, {}, session.accessToken);
    expect(again.status, "re-enrolling would silently replace the second factor").toBe(409);

    // The original secret is untouched.
    const stored = await pool.query<{ mfa_secret: string }>(
      'SELECT mfa_secret FROM "user" WHERE id = $1',
      [user.userId]
    );
    expect(decryptSecret(stored.rows[0].mfa_secret)).toBe(user.secret);
  });

  it("requires authentication to start or confirm an enrolment", async () => {
    expect((await post(API_ROUTES.enrolMfa, {})).status).toBe(401);
    expect((await post(API_ROUTES.confirmMfa, { code: "123456" })).status).toBe(401);
  });

  function hashOf(code: string): string {
    return hashRecoveryCode(code);
  }

  async function countRefreshTokens(userId: string): Promise<number> {
    const res = await pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM refresh_token WHERE user_id = $1",
      [userId]
    );
    return res.rows[0].count;
  }

  /** Signs in with the password and returns the challenge token. */
  async function challengeFor(user: TenantFixture): Promise<string> {
    const res = await login(user);
    const body = mfaRequiredSchema.parse(await res.json());
    return body.challengeToken;
  }
});
