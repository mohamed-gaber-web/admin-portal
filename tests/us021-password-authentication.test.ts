import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import migrate from "node-pg-migrate";
import { join } from "node:path";
import { repoRoot } from "./helpers";
import { createThrowawayDatabase, type ThrowawayDatabase } from "./pg-helpers";
import { startApi, type RunningApi } from "./api-server";
import { issueInvitation, acceptInvitation } from "../packages/db/src/invitations";
import { createTenant, softDeleteTenant } from "../packages/db/src/tenancy";
import { authenticatedSchema } from "../packages/contracts/src/schemas/auth";
import { API_ROUTES } from "../packages/contracts/src/routes";

const adminUrl = process.env.DATABASE_URL;
const hasDb = Boolean(adminUrl);

if (!hasDb) {
  // Don't silently skip coverage.
  console.warn(
    "[US-021] DATABASE_URL not set — the sign-in tests are SKIPPED. Set DATABASE_URL to a Postgres admin connection to run them."
  );
}

const PASSWORD = "correct-horse-battery-staple";

interface AuthEventRow {
  tenant_id: string | null;
  user_id: string | null;
  claimed_slug: string | null;
  claimed_email: string | null;
  event: string;
  outcome: string;
  reason: string | null;
  ip: string | null;
  user_agent: string | null;
}

describe.skipIf(!hasDb)("US-021 - password authentication", () => {
  const PORT = 34881;
  let db: ThrowawayDatabase | undefined;
  let pool: Pool;
  let api: RunningApi | undefined;

  /** Creates a tenant with one active user who can sign in. */
  async function makeSignedUpTenant(
    slug: string,
    email: string
  ): Promise<{ tenantId: string; userId: string }> {
    const tenant = await createTenant(pool, { name: slug, slug });
    const invitation = await issueInvitation(pool, {
      tenantId: tenant.id,
      email,
      actor: { label: "platform-admin" }
    });
    await acceptInvitation(pool, { token: invitation.token, password: PASSWORD });
    return { tenantId: tenant.id, userId: invitation.userId };
  }

  async function login(body: Record<string, string>): Promise<{ status: number; text: string }> {
    const res = await fetch(`${api!.baseUrl}${API_ROUTES.login}`, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "us021-test-agent" },
      body: JSON.stringify(body)
    });
    return { status: res.status, text: await res.text() };
  }

  async function authEvents(claimedEmail: string): Promise<AuthEventRow[]> {
    const res = await pool.query<AuthEventRow>(
      `SELECT tenant_id, user_id, claimed_slug, claimed_email, event, outcome, reason, ip::text, user_agent
       FROM auth_event WHERE lower(claimed_email) = lower($1) ORDER BY created_at, id`,
      [claimedEmail]
    );
    return res.rows;
  }

  beforeAll(async () => {
    db = await createThrowawayDatabase(adminUrl!);
    await migrate({
      databaseUrl: db.url,
      dir: join(repoRoot, "packages/db/migrations"),
      direction: "up",
      count: Infinity,
      migrationsTable: "pgmigrations",
      log: () => {}
    });
    pool = new Pool({ connectionString: db.url });
    api = await startApi(PORT, { DATABASE_URL: db.url });
  });

  afterAll(async () => {
    api?.stop();
    await pool?.end();
    await db?.drop();
    db = undefined;
  });

  // AC1: Given an active user, when they sign in with the correct email and
  // password, then the sign-in succeeds, the response names the workspace the
  // address resolved to, and last_login_at is recorded.
  it("AC1: a correct email and password signs in and records last_login_at", async () => {
    const { tenantId, userId } = await makeSignedUpTenant("initech", "owner@initech.test");

    const before = await pool.query<{ last_login_at: Date | null }>(
      `SELECT last_login_at FROM "user" WHERE id = $1`,
      [userId]
    );
    expect(before.rows[0].last_login_at, "a user who has never signed in has no timestamp").toBeNull();

    const res = await login({ email: "owner@initech.test", password: PASSWORD });
    expect(res.status).toBe(200);

    // strict() — a field added here later would widen what an unauthenticated
    // caller learns, so it fails the contract rather than shipping quietly.
    const body = authenticatedSchema.parse(JSON.parse(res.text));
    expect(body.status).toBe("authenticated");
    expect(body.user.id).toBe(userId);
    expect(body.user.email).toBe("owner@initech.test");

    // The workspace, which nothing in the request named. This is the half of
    // the story that makes email-only sign-in usable: the caller stopped saying
    // which tenant they meant, so the response has to say which one they got.
    expect(body.tenant.id).toBe(tenantId);
    expect(body.tenant.slug).toBe("initech");
    expect(body.tenant.name).toBe("initech");

    const after = await pool.query<{ last_login_at: Date | null; failed_login_count: number }>(
      `SELECT last_login_at, failed_login_count FROM "user" WHERE id = $1`,
      [userId]
    );
    expect(after.rows[0].last_login_at, "last_login_at must be recorded").toBeInstanceOf(Date);
    expect(after.rows[0].failed_login_count, "a success resets the failure count").toBe(0);

    // Email is matched case-insensitively — "Owner@" is the same person, not a
    // second account, which is what the unique index enforces on the way in.
    const mixedCase = await login({ email: "Owner@Initech.test", password: PASSWORD });
    expect(mixedCase.status).toBe(200);
  });

  // AC2: Given a wrong password, an unknown email, or a user who is invited,
  // disabled, or in a soft-deleted tenant, when sign-in is attempted, then every
  // case returns an identical response, and the elapsed time does not
  // distinguish them.
  //
  // The "unknown slug" case is gone because the field is: sign-in resolves the
  // tenant from the address, so there is no longer a tenant identifier a caller
  // could get wrong. What replaced it as the interesting case is a *soft-deleted
  // tenant*, which is the one remaining way a real address reaches no workspace.
  it("AC2: every failure is identical in body and in timing", async () => {
    await makeSignedUpTenant("umbrella", "ops@umbrella.test");

    // An invited user: exists, but has not set a password yet.
    const invitedTenant = await createTenant(pool, { name: "Hooli", slug: "hooli" });
    await issueInvitation(pool, {
      tenantId: invitedTenant.id,
      email: "pending@hooli.test",
      actor: { label: "platform-admin" }
    });

    // A disabled user: had a credential, then was switched off.
    const disabled = await makeSignedUpTenant("cyberdyne", "gone@cyberdyne.test");
    await pool.query(`UPDATE "user" SET status = 'disabled' WHERE id = $1`, [disabled.userId]);

    // A soft-deleted tenant must behave exactly like one that never existed.
    const deleted = await makeSignedUpTenant("vanished", "someone@vanished.test");
    await softDeleteTenant(pool, deleted.tenantId, { label: "platform-admin" });

    const cases = [
      { name: "wrong password", email: "ops@umbrella.test", password: "wrong-password-entirely" },
      { name: "unknown email", email: "nobody@umbrella.test", password: PASSWORD },
      { name: "invited user", email: "pending@hooli.test", password: PASSWORD },
      { name: "disabled user", email: "gone@cyberdyne.test", password: PASSWORD },
      { name: "deleted tenant", email: "someone@vanished.test", password: PASSWORD }
    ];

    // One untimed request first: the very first call pays for JIT, a fresh
    // connection and Argon2's first allocation, and letting that land inside a
    // measured case would make the timings describe warm-up rather than branch.
    await login({ email: "warm@up.test", password: PASSWORD });

    const results: { name: string; status: number; text: string; ms: number }[] = [];
    for (const testCase of cases) {
      const startedAt = performance.now();
      const res = await login(testCase);
      results.push({ name: testCase.name, ...res, ms: performance.now() - startedAt });
    }

    // Identical status and identical body. A differing message is the usual
    // leak: "no such user" tells an attacker which addresses are worth trying.
    const [first, ...rest] = results;
    expect(first.status).toBe(401);
    for (const result of rest) {
      expect(result.status, `${result.name}: status differs`).toBe(first.status);
      expect(result.text, `${result.name}: body differs`).toBe(first.text);
    }
    // And nothing in the body hints at the cause.
    expect(first.text).not.toMatch(/password|email|slug|tenant|user|exist|found|active|disabled/i);

    // Timing must not separate them either. A deliberately loose bound: a tight
    // threshold fails on a loaded CI runner and ends up muted, which is worse
    // than a loose one that holds. What it catches is the real failure — a
    // branch that returns before hashing and so comes back an order of
    // magnitude faster.
    const timings = results.map((r) => r.ms);
    const ratio = Math.max(...timings) / Math.min(...timings);
    expect(
      ratio,
      `failure timings must not separate the cases: ${results
        .map((r) => `${r.name} ${r.ms.toFixed(0)}ms`)
        .join(", ")}`
    ).toBeLessThan(5);

    // Not a blanket denial: the same account with the right password works, so
    // the assertions above are about credentials and not about everything
    // failing equally.
    const good = await login({ email: "ops@umbrella.test", password: PASSWORD });
    expect(good.status).toBe(200);
  });

  // AC3: Given any sign-in attempt, when it completes, then an auth_event
  // records the outcome, the claimed email, and never the password.
  //
  // `claimed_slug` is now null on every sign-in row, because there is no
  // claimed slug — the column stays because other events (and older rows) still
  // carry one, and rewriting history to drop it would destroy the record it
  // exists to keep.
  it("AC3: every attempt is recorded in auth_event, without the password", async () => {
    const { tenantId, userId } = await makeSignedUpTenant("globex", "owner@globex.test");

    await login({ email: "owner@globex.test", password: PASSWORD });
    await login({ email: "owner@globex.test", password: "wrong-password-entirely" });

    const events = await authEvents("owner@globex.test");
    expect(events.length, "both attempts must be recorded").toBe(2);

    const [success, failure] = events;
    expect(success.event).toBe("login.succeeded");
    expect(success.outcome).toBe("succeeded");
    expect(success.tenant_id).toBe(tenantId);
    expect(success.user_id).toBe(userId);
    expect(success.claimed_slug, "no slug is claimed any more").toBeNull();
    expect(success.claimed_email).toBe("owner@globex.test");
    expect(success.user_agent).toBe("us021-test-agent");
    expect(success.ip, "the client IP must be recorded").toMatch(/127\.0\.0\.1|::1/);

    expect(failure.event).toBe("login.failed");
    expect(failure.outcome).toBe("failed");
    // The cause is kept here, where only an operator sees it — never returned.
    expect(failure.reason).toBe("wrong password");

    // An attempt against an address that matches nothing still lands, with no
    // tenant and no user. This is the case audit_log could not hold at all —
    // its tenant_id is NOT NULL — and the reason auth_event exists. It matters
    // more now than it did: an unresolvable address is the *only* remaining
    // shape of a sign-in attributable to nobody.
    await login({ email: "ghost@nowhere.test", password: PASSWORD });
    const orphan = await authEvents("ghost@nowhere.test");
    expect(orphan.length, "a tenantless attempt must still be recorded").toBe(1);
    expect(orphan[0].tenant_id).toBeNull();
    expect(orphan[0].user_id).toBeNull();
    expect(orphan[0].claimed_slug).toBeNull();
    expect(orphan[0].reason).toBe("no such user");

    // The password appears nowhere in any stored row, checked against the whole
    // table rather than the columns we happened to think about.
    const rows = await pool.query<{ row: string }>("SELECT to_jsonb(auth_event)::text AS row FROM auth_event");
    for (const row of rows.rows) {
      expect(row.row, "an auth_event leaked the password").not.toContain(PASSWORD);
      expect(row.row).not.toContain("wrong-password-entirely");
    }

    // And the log is append-only, so an attacker who reaches the database
    // cannot erase the evidence of their own attempts.
    await expect(
      pool.query("UPDATE auth_event SET outcome = 'succeeded' WHERE claimed_email = $1", [
        "owner@globex.test"
      ])
    ).rejects.toThrow(/append-only/i);
  });
});
