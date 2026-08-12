import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import migrate from "node-pg-migrate";
import { join } from "node:path";
import { repoRoot } from "../helpers";
import { createThrowawayDatabase, type ThrowawayDatabase } from "../pg-helpers";
import { startApi, type RunningApi } from "../api-server";
import { coversRoute } from "../route-guard";
import { seedTenant, type TenantFixture } from "../tenant-fixtures";
import { resetMfaEncryptionKey, totpCodeForStep, totpStep } from "../../packages/db/src/totp";
import { API_ROUTES } from "../../packages/contracts/src/routes";

/**
 * Cross-tenant isolation for the MFA enrolment routes (US-013 / US-025).
 *
 * These routes take no id — the user comes from the token's claims — so the
 * question is not "can A name B's row" but "can A's enrolment reach B at all".
 * The guard requires the answer to be written down either way.
 */

const MIGRATIONS_DIR = join(repoRoot, "packages/db/migrations");
const PORT = 34828;
const JWT_SECRET = "mfa-isolation-signing-key-at-least-32ch";
const MFA_KEY = "mfa-isolation-encryption-key-32-chars-x";

process.env.AUTH_MFA_KEY = MFA_KEY;
resetMfaEncryptionKey();

const adminUrl = process.env.DATABASE_URL;
const hasDb = Boolean(adminUrl);

if (!hasDb) {
  console.warn(
    "[US-013] DATABASE_URL not set — the MFA isolation suite is SKIPPED. Set DATABASE_URL to a Postgres admin connection to run it."
  );
}

describe.skipIf(!hasDb)("US-013 - cross-tenant isolation for MFA enrolment", () => {
  let db: ThrowawayDatabase | undefined;
  let pool: Pool;
  let api: RunningApi | undefined;
  let tenantA: TenantFixture;
  let tenantB: TenantFixture;

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

    tenantA = await seedTenant(pool, api.baseUrl, "acme-mfa-iso", {});
    tenantB = await seedTenant(pool, api.baseUrl, "globex-mfa-iso", {});
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
    token?: string,
    headers: Record<string, string> = {}
  ): Promise<Response> =>
    fetch(`${api!.baseUrl}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...headers
      },
      body: JSON.stringify(body)
    });

  const mfaStateOf = async (userId: string): Promise<{ secret: string | null; enabled: boolean }> => {
    const res = await pool.query<{ mfa_secret: string | null; mfa_enabled_at: Date | null }>(
      'SELECT mfa_secret, mfa_enabled_at FROM "user" WHERE id = $1',
      [userId]
    );
    return { secret: res.rows[0].mfa_secret, enabled: Boolean(res.rows[0].mfa_enabled_at) };
  };

  describe(coversRoute("POST /auth/mfa/enrol"), () => {
    it("enrols only the token's own user, whatever the caller supplies", async () => {
      const before = await mfaStateOf(tenantB.userId);
      expect(before.secret, "tenant B must start un-enrolled").toBeNull();

      // Every channel a caller controls, aimed at tenant B's user, with tenant
      // A's token. The route takes no id, so these are the only levers there are.
      const res = await post(
        `${API_ROUTES.enrolMfa}?userId=${tenantB.userId}`,
        { userId: tenantB.userId, tenantId: tenantB.tenantId },
        tenantA.accessToken,
        { "x-tenant-id": tenantB.tenantId, "x-user-id": tenantB.userId }
      );
      expect(res.status).toBe(200);

      // A was enrolled; B was not touched.
      expect((await mfaStateOf(tenantA.userId)).secret).not.toBeNull();
      expect(
        (await mfaStateOf(tenantB.userId)).secret,
        "another tenant's user must be untouched"
      ).toBeNull();
    });

    it("refuses an unauthenticated caller rather than defaulting to a user", async () => {
      expect((await post(API_ROUTES.enrolMfa, {})).status).toBe(401);
      expect((await post(API_ROUTES.enrolMfa, {}, "not.a.real.token")).status).toBe(401);
    });
  });

  describe(coversRoute("POST /auth/mfa/confirm"), () => {
    it("confirms only the token's own user, and leaves other tenants alone", async () => {
      // Start B's enrolment properly, so there is a real secret to steal.
      const startedB = await post(API_ROUTES.enrolMfa, {}, tenantB.accessToken);
      expect(startedB.status).toBe(200);
      const secretB = ((await startedB.json()) as { secret: string }).secret;

      // Start A's too.
      const startedA = await post(API_ROUTES.enrolMfa, {}, tenantA.accessToken);
      const secretA = ((await startedA.json()) as { secret: string }).secret;

      // Tenant A confirms with *tenant B's* code, naming B everywhere it can.
      const stolen = await post(
        API_ROUTES.confirmMfa,
        { code: totpCodeForStep(secretB, totpStep() + 1), userId: tenantB.userId },
        tenantA.accessToken,
        { "x-tenant-id": tenantB.tenantId }
      );
      // B's code is not A's code, so it is simply wrong — and it enables nothing.
      expect(stolen.status).toBe(400);
      expect((await mfaStateOf(tenantB.userId)).enabled, "B must not be enabled by A").toBe(false);
      expect((await mfaStateOf(tenantA.userId)).enabled).toBe(false);

      // A confirming with A's own code enables A, and still not B.
      const own = await post(
        API_ROUTES.confirmMfa,
        { code: totpCodeForStep(secretA, totpStep() + 1) },
        tenantA.accessToken
      );
      expect(own.status).toBe(200);
      expect((await mfaStateOf(tenantA.userId)).enabled).toBe(true);
      expect((await mfaStateOf(tenantB.userId)).enabled).toBe(false);

      // A's recovery codes belong to A alone.
      const codes = await pool.query<{ tenant_id: string }>(
        "SELECT tenant_id FROM mfa_recovery_code"
      );
      expect(codes.rowCount).toBeGreaterThan(0);
      expect(codes.rows.every((r) => r.tenant_id === tenantA.tenantId)).toBe(true);
    });

    it("refuses an unauthenticated caller", async () => {
      expect((await post(API_ROUTES.confirmMfa, { code: "123456" })).status).toBe(401);
    });
  });
});
