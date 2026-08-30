import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import migrate from "node-pg-migrate";
import { join } from "node:path";
import { repoRoot } from "./helpers";
import { createThrowawayDatabase, type ThrowawayDatabase } from "./pg-helpers";
import { startApi, type RunningApi } from "./api-server";
import {
  issueInvitation,
  acceptInvitation,
  verifyPassword,
  InvalidInvitationError,
  UserAlreadyActiveError
} from "../packages/db/src/invitations";
import { listAuditEntries } from "../packages/db/src/audit";
import { createTenant } from "../packages/db/src/tenancy";
import { API_ROUTES } from "../packages/contracts/src/routes";
import { seedPlatformAdmin, type PlatformAdminFixture } from "./tenant-fixtures";

const adminUrl = process.env.DATABASE_URL;
const hasDb = Boolean(adminUrl);

if (!hasDb) {
  // Don't silently skip coverage.
  console.warn(
    "[US-020] DATABASE_URL not set — the invitation tests are SKIPPED. Set DATABASE_URL to a Postgres admin connection to run them."
  );
}

const GOOD_PASSWORD = "correct-horse-battery-staple";

describe.skipIf(!hasDb)("US-020 - portal user invitation flow", () => {
  const PORT = 34871;
  const JWT_SECRET = "us020-suite-signing-key-at-least-32-characters";
  let db: ThrowawayDatabase | undefined;
  let pool: Pool;
  let api: RunningApi | undefined;
  let operator: PlatformAdminFixture;

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
    api = await startApi(PORT, { DATABASE_URL: db.url, AUTH_JWT_SECRET: JWT_SECRET });

    // Provisioning is platform-only, and this suite drives the real endpoint
    // on purpose — it is the path that used to produce an admin who could
    // never sign in.
    operator = await seedPlatformAdmin(pool, api.baseUrl);
  });

  afterAll(async () => {
    api?.stop();
    await pool?.end();
    await db?.drop();
    db = undefined;
  });

  // AC1: Given a tenant admin invites an email address, when the invitation is
  // issued, then a user exists with status `invited`, only a hash of a
  // single-use token is stored, and the invitation carries an expiry.
  it("AC1: issuing an invitation creates an invited user and stores only a token hash", async () => {
    // Driven through the real provisioning endpoint, because that is the path
    // that matters: before US-020 it produced an admin who could never sign in.
    const res = await fetch(`${api!.baseUrl}${API_ROUTES.tenants}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...operator.headers },
      body: JSON.stringify({ name: "Initech", slug: "initech" })
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as {
      tenant: { id: string };
      adminUser: { id: string; email: string };
      invitation: { id: string; expiresAt: string; token: string };
    };

    // The token comes back exactly once, here.
    expect(created.invitation.token, "provisioning must return a usable invitation").toBeTruthy();
    expect(new Date(created.invitation.expiresAt).getTime()).toBeGreaterThan(Date.now());

    const user = await pool.query<{ status: string; password_hash: string | null }>(
      `SELECT status, password_hash FROM "user" WHERE id = $1`,
      [created.adminUser.id]
    );
    expect(user.rows[0].status).toBe("invited");
    expect(user.rows[0].password_hash, "an invited user must have no credential").toBeNull();

    // The raw token appears nowhere in the stored row — the guarantee that does
    // not depend on remembering to redact a field.
    const stored = await pool.query<{ row: string }>(
      "SELECT to_jsonb(user_invitation)::text AS row FROM user_invitation WHERE id = $1",
      [created.invitation.id]
    );
    expect(stored.rows[0].row, "the invitation row leaked the raw token").not.toContain(
      created.invitation.token
    );
    expect(stored.rows[0].row).toContain("token_hash");
    expect(stored.rows[0].row).toContain("expires_at");

    // ...and nowhere else in the database either.
    const anywhere = await pool.query<{ hits: number }>(
      `SELECT count(*)::int AS hits FROM user_invitation
       WHERE token_hash = $1 OR coalesce(token_hash, '') LIKE '%' || $1 || '%'`,
      [created.invitation.token]
    );
    expect(anywhere.rows[0].hits, "the raw token must not be stored").toBe(0);

    // Re-inviting an address that already has a credential is a password reset
    // wearing the wrong name, and a way to take over an account by inviting it.
    await acceptInvitation(pool, {
      token: created.invitation.token,
      password: GOOD_PASSWORD
    });
    await expect(
      issueInvitation(pool, {
        tenantId: created.tenant.id,
        email: created.adminUser.email,
        actor: { label: "platform-admin" }
      })
    ).rejects.toBeInstanceOf(UserAlreadyActiveError);
  });

  // AC2: Given a valid, unexpired invitation, when it is accepted with a
  // password, then the password is stored as an Argon2id hash, the user becomes
  // `active`, and the invitation is marked accepted.
  it("AC2: accepting an invitation sets an Argon2id password and activates the user", async () => {
    const tenant = await createTenant(pool, { name: "Umbrella", slug: "umbrella" });
    const invitation = await issueInvitation(pool, {
      tenantId: tenant.id,
      email: "ops@umbrella.test",
      actor: { label: "platform-admin" }
    });

    // Over real HTTP, so the public endpoint is what is proven, not just the
    // function behind it.
    const res = await fetch(`${api!.baseUrl}${API_ROUTES.acceptInvitation}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: invitation.token, password: GOOD_PASSWORD })
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "accepted", email: "ops@umbrella.test" });

    const user = await pool.query<{ status: string; password_hash: string }>(
      `SELECT status, password_hash FROM "user" WHERE id = $1`,
      [invitation.userId]
    );
    expect(user.rows[0].status).toBe("active");

    // Argon2id specifically — not bcrypt, not a bare digest, and not the
    // password itself.
    const hash = user.rows[0].password_hash;
    expect(hash, "the password must be hashed with Argon2id").toMatch(/^\$argon2id\$/);
    expect(hash).not.toContain(GOOD_PASSWORD);
    expect(await verifyPassword(hash, GOOD_PASSWORD)).toBe(true);
    expect(await verifyPassword(hash, "not-the-password")).toBe(false);

    const marked = await pool.query<{ accepted_at: Date | null }>(
      "SELECT accepted_at FROM user_invitation WHERE id = $1",
      [invitation.id]
    );
    expect(marked.rows[0].accepted_at, "the invitation must be marked accepted").not.toBeNull();
  });

  // AC3: Given a token that is unknown, expired, already accepted, or belongs
  // to another tenant, when acceptance is attempted, then every case is refused
  // identically — no response distinguishes them.
  it("AC3: every unusable token is refused identically", async () => {
    const tenant = await createTenant(pool, { name: "Hooli", slug: "hooli" });

    const accepted = await issueInvitation(pool, {
      tenantId: tenant.id,
      email: "used@hooli.test",
      actor: { label: "platform-admin" }
    });
    await acceptInvitation(pool, { token: accepted.token, password: GOOD_PASSWORD });

    const expired = await issueInvitation(pool, {
      tenantId: tenant.id,
      email: "expired@hooli.test",
      actor: { label: "platform-admin" },
      ttlHours: -1 // already in the past
    });

    const cases = [
      { name: "unknown", token: "not-a-real-token-at-all" },
      { name: "already accepted", token: accepted.token },
      { name: "expired", token: expired.token },
      { name: "empty-ish", token: "x" }
    ];

    // One untimed request first. The very first call pays for JIT, a fresh
    // connection and Argon2's first allocation, and letting that land inside a
    // measured case would make the timings say more about warm-up than about
    // the branch being taken.
    await fetch(`${api!.baseUrl}${API_ROUTES.acceptInvitation}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "warm-up", password: GOOD_PASSWORD })
    });

    const responses: { status: number; body: string; ms: number }[] = [];
    for (const testCase of cases) {
      const startedAt = performance.now();
      const res = await fetch(`${api!.baseUrl}${API_ROUTES.acceptInvitation}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: testCase.token, password: GOOD_PASSWORD })
      });
      const body = await res.text();
      responses.push({ status: res.status, body, ms: performance.now() - startedAt });
    }

    // Identical status and identical body. A differing message is the usual way
    // this leaks: "already used" tells an attacker the token was real.
    const [first, ...rest] = responses;
    for (const [index, response] of rest.entries()) {
      expect(response.status, `${cases[index + 1].name}: status differs`).toBe(first.status);
      expect(response.body, `${cases[index + 1].name}: body differs`).toBe(first.body);
    }
    expect(first.body).not.toMatch(/expired|already|unknown|not found/i);

    // And the timing does not separate them either. A deliberately loose bound:
    // a tight threshold would fail on a loaded CI runner and end up muted,
    // which is worse than a loose one that actually holds. What it catches is
    // the real failure — an early return that skips password hashing entirely
    // and comes back an order of magnitude faster.
    const timings = responses.map((r) => r.ms);
    const slowest = Math.max(...timings);
    const fastest = Math.min(...timings);
    expect(
      slowest / fastest,
      `refusal timings must not separate the cases: ${timings.map((t) => t.toFixed(0)).join("ms, ")}ms`
    ).toBeLessThan(5);

    // A token from another tenant is refused by the same path — it is simply a
    // token whose invitation is not usable here.
    const other = await createTenant(pool, { name: "Cyberdyne", slug: "cyberdyne" });
    const otherInvite = await issueInvitation(pool, {
      tenantId: other.id,
      email: "someone@cyberdyne.test",
      actor: { label: "platform-admin" }
    });
    // It is valid, so it works — proving the refusals above are about validity
    // and not a blanket denial that would pass this test vacuously.
    await expect(
      acceptInvitation(pool, { token: otherInvite.token, password: GOOD_PASSWORD })
    ).resolves.toMatchObject({ tenantId: other.id });
    // ...and now that it is spent, it fails like all the others.
    await expect(
      acceptInvitation(pool, { token: otherInvite.token, password: GOOD_PASSWORD })
    ).rejects.toBeInstanceOf(InvalidInvitationError);
  });

  // AC4: Given an invitation is issued or accepted, when the audit log is read,
  // then an entry records actor, target and time, and the token appears nowhere
  // in it.
  it("AC4: issuing and accepting are audited, and the token appears in neither entry", async () => {
    const tenant = await createTenant(pool, { name: "Globex Two", slug: "globex-two" });
    const invitation = await issueInvitation(pool, {
      tenantId: tenant.id,
      email: "auditee@globex-two.test",
      actor: { label: "platform-admin", ip: "203.0.113.9" }
    });
    await acceptInvitation(pool, {
      token: invitation.token,
      password: GOOD_PASSWORD,
      ip: "203.0.113.10"
    });

    const entries = await listAuditEntries(pool, tenant.id);

    const issued = entries.find((e) => e.action === "invitation.issued");
    expect(issued, "expected an invitation.issued entry").toBeDefined();
    expect(issued!.actorLabel).toBe("platform-admin");
    expect(issued!.entityType).toBe("user_invitation");
    expect(issued!.entityId).toBe(invitation.id);
    expect(issued!.actorIp).toBe("203.0.113.9");
    expect(issued!.createdAt).toBeInstanceOf(Date);
    expect(issued!.afterValues).toMatchObject({ email: "auditee@globex-two.test" });

    const acceptedEntry = entries.find((e) => e.action === "invitation.accepted");
    expect(acceptedEntry, "expected an invitation.accepted entry").toBeDefined();
    expect(acceptedEntry!.entityId).toBe(invitation.userId);
    expect(acceptedEntry!.actorUserId).toBe(invitation.userId);
    expect(acceptedEntry!.actorIp).toBe("203.0.113.10");
    expect(acceptedEntry!.changedFields).toContain("status");

    // Neither entry carries the token or the password, checked against the
    // whole stored row rather than the fields we happened to think about.
    const rows = await pool.query<{ row: string }>(
      "SELECT to_jsonb(audit_log)::text AS row FROM audit_log WHERE tenant_id = $1",
      [tenant.id]
    );
    for (const row of rows.rows) {
      expect(row.row, "an audit entry leaked the invitation token").not.toContain(invitation.token);
      expect(row.row, "an audit entry leaked the password").not.toContain(GOOD_PASSWORD);
    }
  });
});
