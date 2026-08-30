import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import migrate from "node-pg-migrate";
import { join } from "node:path";
import { repoRoot, readText } from "./helpers";
import { createThrowawayDatabase, type ThrowawayDatabase } from "./pg-helpers";
import { createLogger } from "../packages/observability/src/logger";
import { redactValues, REDACTED } from "../packages/observability/src/redaction";
import { seedDemoData } from "../packages/db/src/seed";

/**
 * Sprint S3 foundation — the schema and prep the authentication stories build
 * on. Not a story in itself, so these are grouped by what they protect rather
 * than by acceptance criterion.
 */

const adminUrl = process.env.DATABASE_URL;
const hasDb = Boolean(adminUrl);

if (!hasDb) {
  console.warn(
    "[S3] DATABASE_URL not set — the auth-foundation schema tests are SKIPPED. Set DATABASE_URL to a Postgres admin connection to run them."
  );
}

describe("S3 - prep fixes", () => {
  // B1: CI never ran on the default branch.
  it("CI runs on pushes to the default branch", () => {
    const workflow = readText(".github/workflows/ci.yml");
    const trigger = workflow.slice(workflow.indexOf("on:"), workflow.indexOf("jobs:"));

    // The repository's default branch is master; the workflow said [main], so
    // every push to master ran no CI at all.
    expect(trigger, "CI must run on pushes to master").toMatch(/branches:.*master/);
    expect(trigger, "pull_request must still trigger CI").toContain("pull_request");
  });

  // B2: the logger replaced a repeated sibling with "[circular]".
  it("the logger keeps repeated objects and still breaks real cycles", () => {
    const lines: string[] = [];
    const log = createLogger({ name: "test", sink: (line) => lines.push(line) });

    // A before/after pair sharing a nested object is not a cycle. This is the
    // exact shape an audit-style log line takes, and the old visited-set
    // implementation replaced the second appearance with "[circular]".
    const shared = { id: "abc" };
    log.info("repeat", { before: { role: shared }, after: { role: shared } });

    const repeated = JSON.parse(lines[0]) as {
      before: { role: { id: string } };
      after: { role: { id: string } };
    };
    expect(repeated.before.role).toEqual({ id: "abc" });
    expect(repeated.after.role, "a repeated sibling is not a cycle").toEqual({ id: "abc" });

    // ...but a genuine cycle must still be broken rather than throwing.
    const cyclic: Record<string, unknown> = { name: "loop" };
    cyclic.self = cyclic;
    expect(() => log.info("cycle", { cyclic })).not.toThrow();
    expect(lines[1]).toContain("[circular]");

    // Dates survive as timestamps rather than collapsing to {}.
    log.info("dated", { when: new Date("2026-01-02T03:04:05.000Z") });
    expect(JSON.parse(lines[2]).when).toBe("2026-01-02T03:04:05.000Z");
  });

  // Found while writing the test above: redaction runs before serialisation, so
  // these two defects hit the audit log as well as the logger.
  it("redaction preserves timestamps and survives cycles", () => {
    // A Date has no enumerable fields, so recursing into it produced {} — the
    // audit log recorded that a timestamp changed and stored nothing for what
    // it changed to. Auth adds last_login_at, locked_until and
    // password_changed_at, all of which are audited before/after.
    const when = new Date("2026-01-02T03:04:05.000Z");
    expect(redactValues({ deletedAt: when })).toEqual({
      deletedAt: "2026-01-02T03:04:05.000Z"
    });
    expect(redactValues({ tenant: { deletedAt: when } })).toEqual({
      tenant: { deletedAt: "2026-01-02T03:04:05.000Z" }
    });

    // A cyclic value threw RangeError out of redaction — from inside the error
    // path that was trying to report something else.
    const cyclic: Record<string, unknown> = { name: "loop" };
    cyclic.self = cyclic;
    expect(() => redactValues({ cyclic })).not.toThrow();
    expect(redactValues({ cyclic })).toEqual({ cyclic: { name: "loop", self: "[circular]" } });

    // ...while a repeated sibling is still kept, and secrets still go.
    const shared = { id: "abc" };
    expect(redactValues({ a: shared, b: shared, token: "t" })).toEqual({
      a: { id: "abc" },
      b: { id: "abc" },
      token: REDACTED
    });

    // Redaction still reaches inside arrays, including nested ones.
    expect(redactValues({ items: [[{ password: "p", keep: 1 }]] })).toEqual({
      items: [[{ password: REDACTED, keep: 1 }]]
    });
  });
});

describe.skipIf(!hasDb)("S3 - authentication schema foundation", () => {
  let db: ThrowawayDatabase | undefined;
  let pool: Pool;

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
    // The demo data is the fixture: two tenants, so every isolation assertion
    // below has a second tenant to fail against.
    await seedDemoData(pool);
  });

  afterAll(async () => {
    await pool?.end();
    await db?.drop();
    db = undefined;
  });

  async function tenantId(slug: string): Promise<string> {
    const res = await pool.query<{ id: string }>("SELECT id FROM tenant WHERE slug = $1", [slug]);
    return res.rows[0].id;
  }

  it("an active user cannot exist without a credential", async () => {
    const tenant = await pool.query<{ id: string }>(
      "INSERT INTO tenant (name, slug) VALUES ('Cred Co', 'cred-co') RETURNING id"
    );
    const id = tenant.rows[0].id;

    // The contradiction is rejected by the database, not left to surface later
    // as a confusing login failure.
    await expect(
      pool.query(`INSERT INTO "user" (tenant_id, email, status) VALUES ($1, $2, 'active')`, [
        id,
        "nopass@cred-co.test"
      ])
    ).rejects.toThrow(/user_active_requires_credential_check/);

    // The same row with a credential is fine, and so is an invited user without.
    await expect(
      pool.query(
        `INSERT INTO "user" (tenant_id, email, status, password_hash)
         VALUES ($1, $2, 'active', '$argon2id$fake')`,
        [id, "haspass@cred-co.test"]
      )
    ).resolves.toBeDefined();
    await expect(
      pool.query(`INSERT INTO "user" (tenant_id, email) VALUES ($1, $2)`, [
        id,
        "invited@cred-co.test"
      ])
    ).resolves.toBeDefined();

    // An unknown status is refused too.
    await expect(
      pool.query(`INSERT INTO "user" (tenant_id, email, status) VALUES ($1, $2, 'pending')`, [
        id,
        "bogus@cred-co.test"
      ])
    ).rejects.toThrow(/user_status_check/);
  });

  it("email is unique across the installation, case-insensitively", async () => {
    const acme = await tenantId("acme");
    const globex = await tenantId("globex");

    await expect(
      pool.query(`INSERT INTO "user" (tenant_id, email) VALUES ($1, 'shared@example.test')`, [acme])
    ).resolves.toBeDefined();

    // Not even in a different tenant. An address is the whole of the identity
    // now — sign-in takes no slug, so a second row holding this address would be
    // a second answer to a question that must have exactly one.
    await expect(
      pool.query(`INSERT INTO "user" (tenant_id, email) VALUES ($1, 'shared@example.test')`, [
        globex
      ])
    ).rejects.toThrow(/user_email_global_unique/);

    // And differing case is the same address — otherwise "Shared@" becomes a
    // second account nobody expects, and one that sign-in could never reach.
    await expect(
      pool.query(`INSERT INTO "user" (tenant_id, email) VALUES ($1, 'Shared@Example.test')`, [
        globex
      ])
    ).rejects.toThrow(/user_email_global_unique/);
  });

  it("roles carry permissions, and a role from another tenant is rejected", async () => {
    const acme = await tenantId("acme");
    const globex = await tenantId("globex");

    // The seed grants the whole catalogue to admin and the read half to viewer.
    const granted = await pool.query<{ name: string; key: string }>(
      `SELECT r.name, p.key
       FROM role_permission rp
       JOIN role r ON r.id = rp.role_id
       JOIN permission p ON p.id = rp.permission_id
       WHERE rp.tenant_id = $1`,
      [acme]
    );
    const adminKeys = granted.rows.filter((r) => r.name === "admin").map((r) => r.key);
    const viewerKeys = granted.rows.filter((r) => r.name === "viewer").map((r) => r.key);

    expect(adminKeys, "admin must hold write permissions").toContain("tenant.write");
    expect(viewerKeys.length, "viewer must hold some permissions").toBeGreaterThan(0);
    expect(viewerKeys, "viewer must not hold write permissions").not.toContain("tenant.write");

    // The composite foreign key stops a grant crossing tenants, rather than
    // trusting application code to check.
    //
    // A fresh role, deliberately: reusing a seeded one would hit the
    // (role_id, permission_id) unique constraint first and the foreign key —
    // the thing under test — would never be reached.
    const globexRole = await pool.query<{ id: string }>(
      "INSERT INTO role (tenant_id, name) VALUES ($1, 'auditor') RETURNING id",
      [globex]
    );
    // Not `LIMIT 1` over the whole catalogue: a `platform.*` key would be
    // refused first by the platform-scope trigger, and this test would pass on
    // the wrong error while the composite foreign key went unexercised.
    const permission = await pool.query<{ id: string }>(
      "SELECT id FROM permission WHERE key NOT LIKE 'platform.%' LIMIT 1"
    );
    await expect(
      pool.query(
        "INSERT INTO role_permission (tenant_id, role_id, permission_id) VALUES ($1, $2, $3)",
        [acme, globexRole.rows[0].id, permission.rows[0].id]
      )
    ).rejects.toThrow(/role_permission_role_fk/);
  });

  it("a failed sign-in with no tenant is recordable, and immutable once written", async () => {
    // The whole reason auth_event exists rather than reusing audit_log: this
    // insert is impossible there, because audit_log.tenant_id is NOT NULL.
    await expect(
      pool.query(
        `INSERT INTO audit_log (tenant_id, actor_label, action, entity_type)
         VALUES (NULL, 'anonymous', 'login.failed', 'user')`
      )
    ).rejects.toThrow(/null value in column "tenant_id"/);

    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO auth_event (claimed_slug, claimed_email, event, outcome, reason)
       VALUES ('ghost', 'nobody@example.test', 'login.failed', 'failed', 'no such tenant')
       RETURNING id`
    );
    const id = inserted.rows[0].id;

    // Append-only, enforced by triggers so a superuser is bound too.
    await expect(
      pool.query("UPDATE auth_event SET outcome = 'succeeded' WHERE id = $1", [id])
    ).rejects.toThrow(/append-only/i);
    await expect(pool.query("DELETE FROM auth_event WHERE id = $1", [id])).rejects.toThrow(
      /append-only/i
    );
    await expect(pool.query("TRUNCATE auth_event")).rejects.toThrow(/append-only/i);

    // An unknown outcome is refused.
    await expect(
      pool.query(
        `INSERT INTO auth_event (event, outcome) VALUES ('login.failed', 'maybe')`
      )
    ).rejects.toThrow(/auth_event_outcome_check/);
  });

  it("auth events are appendable without a tenant context but readable only within one", async () => {
    const acme = await tenantId("acme");
    const client = await pool.connect();

    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE app_user");

      // No tenant in the session — the state every sign-in starts in. The
      // append must still succeed, or failed logins are unrecordable.
      await expect(
        client.query(
          `INSERT INTO auth_event (claimed_slug, claimed_email, event, outcome)
           VALUES ('whoever', 'someone@example.test', 'login.failed', 'failed')`
        )
      ).resolves.toBeDefined();

      // ...but reads return nothing without a tenant.
      const unscoped = await client.query("SELECT * FROM auth_event");
      expect(unscoped.rowCount, "no tenant context must reveal no events").toBe(0);

      // Scoped to acme, only acme's events are visible — never the tenantless
      // platform rows, which stay behind withoutTenantScope().
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [acme]);
      const scoped = await client.query<{ tenant_id: string | null }>(
        "SELECT tenant_id FROM auth_event"
      );
      expect(scoped.rowCount, "acme's own events must be visible").toBeGreaterThan(0);
      expect(
        scoped.rows.every((row) => row.tenant_id === acme),
        "auth_event leaked another tenant's rows"
      ).toBe(true);

      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });

  it("refresh tokens and invitations are tenant-isolated", async () => {
    const acme = await tenantId("acme");
    const globex = await tenantId("globex");
    const client = await pool.connect();

    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE app_user");
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [acme]);

      for (const table of ["refresh_token", "user_invitation"]) {
        const rows = await client.query<{ tenant_id: string }>(
          `SELECT tenant_id FROM "${table}"`
        );
        expect(rows.rowCount, `${table} must hold acme rows`).toBeGreaterThan(0);
        expect(
          rows.rows.every((row) => row.tenant_id === acme),
          `${table} leaked another tenant's rows`
        ).toBe(true);
      }

      // Writes are fenced by the same policy, not just reads.
      const globexUser = await pool.query<{ id: string }>(
        `SELECT id FROM "user" WHERE tenant_id = $1 LIMIT 1`,
        [globex]
      );
      await expect(
        client.query(
          `INSERT INTO refresh_token (tenant_id, user_id, family_id, token_hash, expires_at)
           VALUES ($1, $2, gen_random_uuid(), 'smuggled', now() + interval '1 day')`,
          [globex, globexUser.rows[0].id]
        )
      ).rejects.toThrow(/row-level security/i);

      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });
});
