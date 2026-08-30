import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import migrate from "node-pg-migrate";
import { join } from "node:path";
import { repoRoot } from "./helpers";
import { createThrowawayDatabase, type ThrowawayDatabase } from "./pg-helpers";
import { startApi, type RunningApi } from "./api-server";
import { seedPlatformAdmin, type PlatformAdminFixture } from "./tenant-fixtures";
import { recordAuditEntry, listAuditEntries, REDACTED } from "../packages/db/src/audit";
import { createTenant, softDeleteTenant } from "../packages/db/src/tenancy";
import {
  discoverAuditActions,
  findAuditGuardProblems,
  type DiscoveredAuditAction
} from "./audit-guard";
import {
  DECLARED_ROUTES,
  NON_ROUTE_AUDIT_ACTIONS,
  type DeclaredRoute
} from "./route-manifest";

const adminUrl = process.env.DATABASE_URL;
const hasDb = Boolean(adminUrl);

if (!hasDb) {
  // Don't silently skip coverage.
  console.warn(
    "[US-015] DATABASE_URL not set — the audit log tests are SKIPPED. Set DATABASE_URL to a Postgres admin connection to run them."
  );
}

describe.skipIf(!hasDb)("US-015 - append-only audit log", () => {
  const PORT = 34813;
  const JWT_SECRET = "us015-suite-signing-key-at-least-32-characters";
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
    operator = await seedPlatformAdmin(pool, api.baseUrl);
  });

  afterAll(async () => {
    api?.stop();
    await pool?.end();
    await db?.drop();
    db = undefined;
  });

  // AC1: Given a config or permission change, when it is committed, then an
  // audit entry records actor, action, target, before and after values, IP and
  // timestamp.
  it("AC1: a permission change records actor, action, target, before/after, IP and timestamp", async () => {
    // Driven over real HTTP so the IP is genuinely observed, not stubbed.
    const res = await fetch(`${api!.baseUrl}/tenants`, {
      method: "POST",
      headers: { "content-type": "application/json", ...operator.headers },
      body: JSON.stringify({ name: "Initech", slug: "initech" })
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as { tenant: { id: string }; adminUser: { id: string } };

    const entries = await listAuditEntries(pool, created.tenant.id);

    // Granting the admin role is a permission change.
    const roleAssigned = entries.find((e) => e.action === "role.assigned");
    expect(roleAssigned, "expected a role.assigned audit entry").toBeDefined();

    // The operator who provisioned it, from their verified token claims. This
    // used to be the fixed label "platform-admin" with the *new* tenant's admin
    // standing in as the actor id — truthful while the route was
    // unauthenticated and there was nobody to name, and misleading now that
    // there is: it credited the change to the person it was made for.
    expect(roleAssigned!.actorLabel).toBe(operator.email); // actor
    expect(roleAssigned!.actorUserId).toBe(operator.userId); // actor identity
    expect(roleAssigned!.entityType).toBe("user_role"); // target
    expect(roleAssigned!.entityId).toBe(created.adminUser.id); // target id
    expect(roleAssigned!.afterValues).toMatchObject({ role: "admin" }); // after
    expect(roleAssigned!.beforeValues).toBeNull(); // before (nothing existed)
    expect(roleAssigned!.actorIp, "the client IP must be recorded").toMatch(/127\.0\.0\.1|::1/); // IP
    expect(roleAssigned!.createdAt).toBeInstanceOf(Date); // timestamp
    expect(roleAssigned!.changedFields).toContain("role");

    // A config change with a genuine before -> after transition.
    const tenant = await createTenant(pool, { name: "Umbrella", slug: "umbrella" });
    await softDeleteTenant(pool, tenant.id, { label: "platform-admin", ip: "203.0.113.7" });

    const deletion = (await listAuditEntries(pool, tenant.id)).find(
      (e) => e.action === "tenant.soft_deleted"
    );
    expect(deletion, "expected a tenant.soft_deleted audit entry").toBeDefined();
    expect(deletion!.beforeValues).toEqual({ deletedAt: null });
    expect(deletion!.afterValues?.deletedAt).toBeTruthy();
    expect(deletion!.changedFields).toEqual(["deletedAt"]);
    expect(deletion!.actorIp).toBe("203.0.113.7");
  });

  // AC2: Given an audit entry, when an update or delete is attempted, then it
  // is rejected.
  it("AC2: updating, deleting or truncating an audit entry is rejected", async () => {
    const tenant = await createTenant(pool, { name: "Cyberdyne", slug: "cyberdyne" });
    const entry = await recordAuditEntry(pool, {
      tenantId: tenant.id,
      action: "config.changed",
      entityType: "tenant",
      entityId: tenant.id,
      actor: { label: "platform-admin" },
      before: { retentionDays: 30 },
      after: { retentionDays: 90 }
    });

    // As the admin connection — a superuser, which privilege revocation alone
    // would not stop.
    await expect(
      pool.query("UPDATE audit_log SET action = 'tampered' WHERE id = $1", [entry.id])
    ).rejects.toThrow(/append-only/i);

    await expect(pool.query("DELETE FROM audit_log WHERE id = $1", [entry.id])).rejects.toThrow(
      /append-only/i
    );

    await expect(pool.query("TRUNCATE audit_log")).rejects.toThrow(/append-only/i);

    // And as the application role.
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE app_user");
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenant.id]);
      await expect(
        client.query("DELETE FROM audit_log WHERE id = $1", [entry.id])
      ).rejects.toThrow();
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }

    // The entry is untouched.
    const after = await listAuditEntries(pool, tenant.id);
    const survivor = after.find((e) => e.id === entry.id);
    expect(survivor, "the entry must survive every attempt").toBeDefined();
    expect(survivor!.action).toBe("config.changed");
  });

  // AC3: Given a secret field, when audited, then only the fact of change is
  // stored, never the value.
  it("AC3: a secret field records that it changed, never its value", async () => {
    const tenant = await createTenant(pool, { name: "Hooli", slug: "hooli" });

    const OLD_SECRET = "old-super-secret-value-11111";
    const NEW_SECRET = "new-super-secret-value-22222";

    const entry = await recordAuditEntry(pool, {
      tenantId: tenant.id,
      action: "connection.updated",
      entityType: "d365_environment",
      entityId: tenant.id,
      actor: { label: "platform-admin" },
      before: { name: "PROD", clientSecret: OLD_SECRET, nested: { apiKey: "old-key-33333" } },
      after: { name: "PROD", clientSecret: NEW_SECRET, nested: { apiKey: "new-key-44444" } },
      context: { authorization: "Bearer tok-55555" }
    });

    // The fact of change survives...
    expect(entry.changedFields).toContain("clientSecret");
    expect(entry.changedFields).toContain("nested");
    expect(entry.changedFields).not.toContain("name"); // unchanged fields are not listed

    // ...but the values do not.
    expect(entry.beforeValues).toMatchObject({ name: "PROD", clientSecret: REDACTED });
    expect(entry.afterValues).toMatchObject({ name: "PROD", clientSecret: REDACTED });
    expect((entry.beforeValues?.nested as Record<string, unknown>).apiKey).toBe(REDACTED);
    expect((entry.afterValues?.nested as Record<string, unknown>).apiKey).toBe(REDACTED);

    // Nothing secret anywhere in the stored row — including the `data` column,
    // which is the easiest place for a secret to survive unnoticed.
    const raw = await pool.query<{ row: string }>(
      "SELECT to_jsonb(audit_log)::text AS row FROM audit_log WHERE id = $1",
      [entry.id]
    );
    const stored = raw.rows[0].row;
    for (const secret of [OLD_SECRET, NEW_SECRET, "old-key-33333", "new-key-44444", "tok-55555"]) {
      expect(stored, `the stored row leaked "${secret}"`).not.toContain(secret);
    }
    // Non-secret values are still there, so this is redaction and not blanket erasure.
    expect(stored).toContain("PROD");
  });
});

// AC1, enforced for the routes that do not exist yet.
//
// The three tests above prove the audit log works for the mutations written so
// far. They cannot prove the next mutation will use it, and that gap is not
// hypothetical: AC1 is about a category of change, the API is going to grow
// D365 connection endpoints carrying real client secrets, and an endpoint that
// forgets to audit fails silently — it works, it passes its own tests, and the
// history is simply absent when someone asks for it a year later.
//
// Static, so it runs without a database and can fail a pull request in the
// lint-and-typecheck job rather than only in the integration run.
describe("US-015 - audit coverage guard", () => {
  it("AC1: a mutating route added without an audit decision fails the guard", () => {
    // The API as it stands has an audit decision on record for every mutation.
    const problems = findAuditGuardProblems(
      DECLARED_ROUTES,
      discoverAuditActions(),
      NON_ROUTE_AUDIT_ACTIONS
    );
    expect(
      problems,
      `audit guard problems:\n${problems.map((p) => `  [${p.kind}] ${p.subject} — ${p.detail}`).join("\n")}`
    ).toEqual([]);

    // The scan found the real call sites. If the discovery regex silently broke,
    // every check below would pass against an empty set.
    const discovered = discoverAuditActions();
    expect(discovered.length).toBeGreaterThanOrEqual(4);
    expect(discovered.map((d) => d.action)).toContain("tenant.provisioned");
    expect(discovered.map((d) => d.action)).toContain("role.assigned");
    // And the declaration in audit.ts is not mistaken for a call site.
    expect(discovered.filter((d) => d.source.endsWith("packages/db/src/audit.ts"))).toEqual([]);

    // --- Negative controls -------------------------------------------------
    // Without these, this test would pass just as happily against a guard that
    // always returns an empty array.

    const written = (...actions: string[]): DiscoveredAuditAction[] =>
      actions.map((action) => ({
        action,
        rawArgument: `"${action}"`,
        source: "packages/db/src/x.ts"
      }));

    const route = (method: string, extra: Partial<DeclaredRoute> = {}): DeclaredRoute => ({
      method,
      path: "/connections",
      visibility: "tenant-scoped",
      note: "",
      ...extra
    });

    // 1. A new mutating route where nobody decided anything.
    const undecided = findAuditGuardProblems([route("POST")], written("connection.created"), [
      { action: "connection.created", note: "" }
    ]);
    expect(undecided.map((p) => p.kind)).toEqual(["undecided"]);

    // 2. Opting out is allowed, but only out loud.
    expect(
      findAuditGuardProblems([route("DELETE", { audits: [] })], [], []).map((p) => p.kind)
    ).toEqual(["unjustified"]);
    expect(
      findAuditGuardProblems(
        [route("DELETE", { audits: [], noAuditReason: "Idempotent cache purge; changes no state." })],
        [],
        []
      )
    ).toEqual([]);

    // 3. A route claiming an audit action that no code actually writes — the
    //    manifest saying the right thing while the endpoint does not.
    const lying = findAuditGuardProblems(
      [route("PATCH", { audits: ["connection.updated"] })],
      written("connection.created"),
      [{ action: "connection.created", note: "" }]
    );
    expect(lying.map((p) => p.kind)).toEqual(["unknown-action"]);
    expect(lying[0].subject).toBe("PATCH /connections -> connection.updated");

    // 4. The other direction: an action written in the source that nothing
    //    claims. This is what catches a route quietly dropping its audit call.
    const orphan = findAuditGuardProblems([], written("connection.deleted"), []);
    expect(orphan.map((p) => p.kind)).toEqual(["unclaimed-action"]);
    expect(orphan[0].subject).toBe("connection.deleted");

    // 5. An action the guard cannot read must fail loudly, not be skipped.
    const unresolvable = findAuditGuardProblems(
      [],
      [{ action: null, rawArgument: "input.action", source: "packages/db/src/x.ts" }],
      []
    );
    expect(unresolvable.map((p) => p.kind)).toEqual(["unresolvable-action"]);

    // 6. Read-only routes are not asked to audit anything.
    expect(findAuditGuardProblems([route("GET")], [], [])).toEqual([]);

    // 7. And the clean case really is clean — the guard is not simply always angry.
    expect(
      findAuditGuardProblems(
        [route("POST", { audits: ["connection.created"] })],
        written("connection.created"),
        []
      )
    ).toEqual([]);
  });
});
