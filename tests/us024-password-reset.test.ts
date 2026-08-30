import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import migrate from "node-pg-migrate";
import { join } from "node:path";
import { repoRoot } from "./helpers";
import { createThrowawayDatabase, type ThrowawayDatabase } from "./pg-helpers";
import { startApi, type RunningApi } from "./api-server";
import { seedTenant, FIXTURE_PASSWORD, type TenantFixture } from "./tenant-fixtures";
import { issueInvitation } from "../packages/db/src/invitations";
import { requestPasswordReset, hashResetToken } from "../packages/db/src/password-reset";
import { hashRefreshToken } from "../packages/db/src/refresh-tokens";
import { API_ROUTES } from "../packages/contracts/src/routes";
import {
  passwordResetRequestedSchema,
  passwordResetCompletedSchema
} from "../packages/contracts/src/schemas/auth";

const MIGRATIONS_DIR = join(repoRoot, "packages/db/migrations");
const PORT = 34826;
const JWT_SECRET = "us024-password-reset-signing-key-32chars";
const NEW_PASSWORD = "a-brand-new-password-nobody-guessed";

const adminUrl = process.env.DATABASE_URL;
const hasDb = Boolean(adminUrl);

if (!hasDb) {
  // Don't silently skip coverage.
  console.warn(
    "[US-024] DATABASE_URL not set — the password reset tests are SKIPPED. Set DATABASE_URL to a Postgres admin connection to run them."
  );
}

describe.skipIf(!hasDb)("US-024 - password reset", () => {
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
    api = await startApi(PORT, { DATABASE_URL: db.url, AUTH_JWT_SECRET: JWT_SECRET });
  });

  afterAll(async () => {
    api?.stop();
    await pool?.end();
    await db?.drop();
    db = undefined;
  });

  const forgot = (body: Record<string, string>): Promise<Response> =>
    fetch(`${api!.baseUrl}${API_ROUTES.requestPasswordReset}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });

  const reset = (body: Record<string, string>): Promise<Response> =>
    fetch(`${api!.baseUrl}${API_ROUTES.completePasswordReset}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });

  const login = (email: string, password: string): Promise<Response> =>
    fetch(`${api!.baseUrl}${API_ROUTES.login}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password })
    });

  /**
   * A reset token for a real account.
   *
   * Taken from the data layer because the API deliberately does not return it —
   * it would go out by email, and an endpoint that hands it back would make
   * every account resettable by anyone.
   */
  async function tokenFor(fixture: TenantFixture): Promise<string> {
    const issued = await requestPasswordReset(pool, { email: fixture.email });
    if (!issued) {
      throw new Error(`no reset token issued for ${fixture.slug}`);
    }
    return issued.token;
  }

  const authEvents = async (event: string): Promise<{ reason: string | null }[]> => {
    const res = await pool.query<{ reason: string | null }>(
      "SELECT reason FROM auth_event WHERE event = $1 ORDER BY created_at",
      [event]
    );
    return res.rows;
  };

  // AC1: Given a reset request for any address, when it is submitted, then the
  // response is identical whether or not an account exists.
  it("AC1: the response is identical whether or not the account exists", async () => {
    const real = await seedTenant(pool, api!.baseUrl, "acme-forgot", {});

    // Invited but never accepted, so the row exists with no credential to
    // replace. With the slug gone this is what keeps the test honest: without
    // it every non-real case would collapse into "no such user", and the
    // assertion below would prove only that one branch answers consistently
    // with itself.
    await issueInvitation(pool, {
      tenantId: real.tenantId,
      email: "pending@acme-forgot.local",
      actor: { label: "platform-admin" }
    });

    const responses = await Promise.all([
      forgot({ email: real.email }), // exists, resettable
      forgot({ email: "pending@acme-forgot.local" }), // exists, no credential
      forgot({ email: "nobody@nowhere.local" }) // no such address
    ]);

    const seen = new Set<string>();
    for (const res of responses) {
      // The status code is part of the answer — varying it would leak exactly
      // what the fixed body is there to hide.
      expect(res.status).toBe(202);
      const text = await res.text();
      expect(passwordResetRequestedSchema.safeParse(JSON.parse(text)).success).toBe(true);
      seen.add(`${res.status} ${text}`);
    }
    expect(seen.size, "every reset request must answer identically").toBe(1);

    // Guard against a vacuous pass: a token really was issued for the real
    // account, so the endpoint does distinguish internally — it just says
    // nothing about it.
    const issued = await pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM password_reset WHERE tenant_id = $1",
      [real.tenantId]
    );
    expect(issued.rows[0].count).toBeGreaterThan(0);

    // And the difference is visible where it should be: the log.
    const requests = await authEvents("password_reset.requested");
    expect(requests.length).toBeGreaterThanOrEqual(3);
    expect(requests.some((r) => r.reason === "no such user")).toBe(true);
    expect(requests.some((r) => r.reason === "user not active")).toBe(true);
  });

  // AC2: Given a valid single-use reset token, when a new password is set, then
  // it is stored as an Argon2id hash, the token cannot be reused, and every
  // refresh token family for that user is revoked.
  it("AC2: the password is re-hashed, the token is burnt, and every session is revoked", async () => {
    const user = await seedTenant(pool, api!.baseUrl, "acme-reset", {});

    // Two live sessions, so "every family" means more than one.
    const second = await login(user.email, FIXTURE_PASSWORD);
    expect(second.status).toBe(200);
    const secondSession = (await second.json()) as { refreshToken: string };

    const liveBefore = await pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM refresh_token WHERE user_id = $1 AND revoked_at IS NULL",
      [user.userId]
    );
    expect(liveBefore.rows[0].count, "the user must hold live sessions").toBeGreaterThanOrEqual(2);

    const before = await pool.query<{ password_hash: string }>(
      'SELECT password_hash FROM "user" WHERE id = $1',
      [user.userId]
    );

    const token = await tokenFor(user);
    const res = await reset({ token, password: NEW_PASSWORD });
    expect(res.status).toBe(200);
    expect(passwordResetCompletedSchema.safeParse(await res.json()).success).toBe(true);

    // Argon2id, and a different hash from the one before.
    const after = await pool.query<{ password_hash: string; password_changed_at: Date | null }>(
      'SELECT password_hash, password_changed_at FROM "user" WHERE id = $1',
      [user.userId]
    );
    expect(after.rows[0].password_hash).toMatch(/^\$argon2id\$/);
    expect(after.rows[0].password_hash).not.toBe(before.rows[0].password_hash);
    expect(after.rows[0].password_changed_at).not.toBeNull();
    // The password itself is nowhere in the row.
    expect(after.rows[0].password_hash).not.toContain(NEW_PASSWORD);

    // Every refresh token the user held is revoked — a reset is what someone
    // does when they think the account is compromised, so leaving the
    // attacker's session alive would make it theatre.
    //
    // Counted before signing in again: a fresh sign-in legitimately creates a
    // session, and checking afterwards would measure that instead.
    const live = await pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM refresh_token WHERE user_id = $1 AND revoked_at IS NULL",
      [user.userId]
    );
    expect(live.rows[0].count, "no session may survive a reset").toBe(0);

    // Proven over HTTP too, not just in the table.
    for (const stale of [user.refreshToken, secondSession.refreshToken]) {
      const exchange = await fetch(`${api!.baseUrl}${API_ROUTES.refresh}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ refreshToken: stale })
      });
      expect(exchange.status, "a pre-reset refresh token must not work").toBe(401);
    }

    // The token is single use.
    expect((await reset({ token, password: "another-password-entirely" })).status).toBe(400);

    // The new password works and the old one does not.
    expect((await login(user.email, NEW_PASSWORD)).status).toBe(200);
    expect((await login(user.email, FIXTURE_PASSWORD)).status).toBe(401);

    // The credential change is in the audit log, without either value.
    const audit = await pool.query<{ row: string; changed_fields: string[] }>(
      "SELECT to_jsonb(audit_log)::text AS row, changed_fields FROM audit_log WHERE action = 'password.reset' AND tenant_id = $1",
      [user.tenantId]
    );
    expect(audit.rowCount, "the reset must be audited").toBe(1);
    expect(audit.rows[0].changed_fields).toContain("passwordHash");
    expect(audit.rows[0].row).not.toContain(NEW_PASSWORD);
    expect(audit.rows[0].row).toContain("[redacted]");
  });

  // AC3: Given an expired or already-used reset token, when it is submitted,
  // then it is refused and an auth_event records the attempt.
  it("AC3: expired and already-used tokens are refused and recorded", async () => {
    const user = await seedTenant(pool, api!.baseUrl, "acme-stale", {});
    const failuresBefore = (await authEvents("password_reset.failed")).length;

    // Expired.
    const expiredToken = await tokenFor(user);
    await pool.query(
      "UPDATE password_reset SET expires_at = now() - interval '1 hour' WHERE token_hash = $1",
      [hashResetToken(expiredToken)]
    );
    const expired = await reset({ token: expiredToken, password: NEW_PASSWORD });
    expect(expired.status).toBe(400);
    const expiredBody = await expired.text();

    // Already used.
    const usedToken = await tokenFor(user);
    expect((await reset({ token: usedToken, password: NEW_PASSWORD })).status).toBe(200);
    const replayed = await reset({ token: usedToken, password: NEW_PASSWORD });
    expect(replayed.status).toBe(400);

    // Unknown. All three read identically — a per-reason message tells the
    // holder of a guessed token whether it was ever real.
    const unknown = await reset({ token: "not-a-real-reset-token-value", password: NEW_PASSWORD });
    expect(unknown.status).toBe(400);
    expect(await unknown.text()).toBe(expiredBody);
    expect(await replayed.text()).toBe(expiredBody);

    // Each refusal is recorded, with the reason kept where only an operator
    // sees it. This is the assertion that would fail if the refusal were
    // thrown from inside the transaction — the rollback would take the
    // auth_event with it.
    const failures = await authEvents("password_reset.failed");
    expect(failures.length).toBe(failuresBefore + 3);
    const reasons = failures.map((f) => f.reason);
    expect(reasons).toContain("reset token expired");
    expect(reasons).toContain("reset token already used");
    expect(reasons).toContain("unknown reset token");
  });

  it("stores only a digest, so the table cannot yield a working reset link", async () => {
    const user = await seedTenant(pool, api!.baseUrl, "acme-digest", {});
    const token = await tokenFor(user);

    const stored = await pool.query<{ row: string; token_hash: string }>(
      "SELECT to_jsonb(password_reset)::text AS row, token_hash FROM password_reset WHERE user_id = $1",
      [user.userId]
    );
    expect(stored.rowCount).toBe(1);
    expect(stored.rows[0].row, "the raw reset token was stored").not.toContain(token);
    expect(stored.rows[0].token_hash).toMatch(/^[0-9a-f]{64}$/);

    // Presenting what the store holds does not work.
    expect((await reset({ token: stored.rows[0].token_hash, password: NEW_PASSWORD })).status).toBe(
      400
    );
    // Negative control: the real token does.
    expect((await reset({ token, password: NEW_PASSWORD })).status).toBe(200);
  });

  it("burns a user's other outstanding reset links when one is redeemed", async () => {
    const user = await seedTenant(pool, api!.baseUrl, "acme-two-links", {});

    // Two links requested — a user clicking "forgot password" twice.
    const first = await tokenFor(user);
    const secondToken = await tokenFor(user);

    expect((await reset({ token: secondToken, password: NEW_PASSWORD })).status).toBe(200);

    // The older link is dead. Otherwise an attacker who triggered a reset
    // earlier keeps a usable takeover link after the user recovers.
    expect((await reset({ token: first, password: "yet-another-password" })).status).toBe(400);

    const outstanding = await pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM password_reset WHERE user_id = $1 AND used_at IS NULL",
      [user.userId]
    );
    expect(outstanding.rows[0].count).toBe(0);

    // And the password that won is the one from the redeemed link.
    expect((await login(user.email, NEW_PASSWORD)).status).toBe(200);
  });

  it("does not leave a stale refresh token usable after a reset", async () => {
    // Regression guard for the ordering inside the transaction: revoking
    // sessions before writing the new password would leave a window, and
    // revoking them in a separate transaction would leave them alive if the
    // password write failed.
    const user = await seedTenant(pool, api!.baseUrl, "acme-ordering", {});
    const stored = await pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM refresh_token WHERE token_hash = $1 AND revoked_at IS NULL",
      [hashRefreshToken(user.refreshToken)]
    );
    expect(stored.rows[0].count).toBe(1);

    const token = await tokenFor(user);
    expect((await reset({ token, password: NEW_PASSWORD })).status).toBe(200);

    const after = await pool.query<{ revoked_reason: string | null }>(
      "SELECT revoked_reason FROM refresh_token WHERE token_hash = $1",
      [hashRefreshToken(user.refreshToken)]
    );
    expect(after.rows[0].revoked_reason).toBe("password reset");
  });
});
