import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync } from "node:child_process";
import migrate from "node-pg-migrate";
import { join } from "node:path";
import { repoRoot } from "./helpers";
import { startApi, type RunningApi } from "./api-server";
import { createThrowawayDatabase, type ThrowawayDatabase } from "./pg-helpers";
import { provisionedTenantSchema } from "../packages/contracts/src/schemas/tenant";
import { seedPlatformAdmin, type PlatformAdminFixture } from "./tenant-fixtures";
import { Client } from "pg";

const FIXTURES = join(repoRoot, "tests/fixtures/us003");

const adminUrl = process.env.DATABASE_URL;
const hasDb = Boolean(adminUrl);

if (!hasDb) {
  // AC2 needs a database since US-014 made POST /tenants persist. Don't skip silently.
  console.warn(
    "[US-003] DATABASE_URL not set — AC2 (API request validation) is SKIPPED. AC1 still runs."
  );
}

interface TscResult {
  ok: boolean;
  output: string;
}

function tscCheck(file: string): TscResult {
  const cmd = `pnpm exec tsc --noEmit --strict --skipLibCheck --module commonjs --moduleResolution node --esModuleInterop "${file}"`;
  try {
    const out = execSync(cmd, { cwd: repoRoot, encoding: "utf8", stdio: "pipe" });
    return { ok: true, output: out };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    return { ok: false, output: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

// AC1 needs no database, so it lives in its own block and always runs.
describe("US-003 - shared contracts package", () => {
  // AC1: Given a schema change, when I build, then consumers fail at compile time.
  it("AC1: consumers of the shared types fail at compile time on schema drift", () => {
    const valid = tscCheck(join(FIXTURES, "valid.ts"));
    expect(valid.ok, `expected valid fixture to compile:\n${valid.output}`).toBe(true);

    const invalid = tscCheck(join(FIXTURES, "invalid.ts"));
    expect(invalid.ok, "expected invalid fixture to FAIL compilation").toBe(false);
    expect(invalid.output).toMatch(/slug/); // the missing required field is named in the error
  });
});

describe.skipIf(!hasDb)("US-003 - shared contracts package (API validation)", () => {
  const PORT = 34611;
  const JWT_SECRET = "us003-suite-signing-key-at-least-32-characters";
  let api: RunningApi | undefined;
  let db: ThrowawayDatabase | undefined;
  let operator: PlatformAdminFixture;

  beforeAll(async () => {
    // US-014 made POST /tenants persist, so this needs a real schema. A
    // throwaway database keeps the assertions independent of dev data.
    db = await createThrowawayDatabase(adminUrl!);
    await migrate({
      databaseUrl: db.url,
      dir: join(repoRoot, "packages/db/migrations"),
      direction: "up",
      count: Infinity,
      migrationsTable: "pgmigrations",
      log: () => {}
    });
    api = await startApi(PORT, { DATABASE_URL: db.url, AUTH_JWT_SECRET: JWT_SECRET });

    // `POST /tenants` is platform-only now, so validating its schema needs a
    // caller who is allowed past the guard — otherwise every case below would
    // be a 403 and the assertions would prove nothing about validation.
    const client = new Client({ connectionString: db.url });
    await client.connect();
    try {
      operator = await seedPlatformAdmin(client, api.baseUrl);
    } finally {
      await client.end();
    }
  });

  afterAll(async () => {
    api?.stop();
    await db?.drop();
    db = undefined;
  });

  // AC2: Given any API request, when it is handled, then it is validated against the shared schema.
  it("AC2: the API validates requests against the shared schema", async () => {
    const base = api!.baseUrl;

    const good = await fetch(`${base}/tenants`, {
      method: "POST",
      headers: { "content-type": "application/json", ...operator.headers },
      body: JSON.stringify({ name: "Acme", slug: "acme" })
    });
    expect(good.status).toBe(201);

    // The response is checked against the shared schema rather than a literal
    // body, so this assertion tracks the contract instead of one snapshot of it.
    const body = await good.json();
    const parsed = provisionedTenantSchema.safeParse(body);
    expect(parsed.success, `response did not match the shared schema: ${JSON.stringify(body)}`).toBe(
      true
    );
    expect(parsed.success && parsed.data.tenant.slug).toBe("acme");

    // Missing required `slug` -> rejected by the shared schema.
    const bad = await fetch(`${base}/tenants`, {
      method: "POST",
      headers: { "content-type": "application/json", ...operator.headers },
      body: JSON.stringify({ name: "Acme" })
    });
    expect(bad.status).toBe(400);

    // Wrong shape for `slug` -> also rejected.
    const badSlug = await fetch(`${base}/tenants`, {
      method: "POST",
      headers: { "content-type": "application/json", ...operator.headers },
      body: JSON.stringify({ name: "Acme", slug: "Not A Slug!" })
    });
    expect(badSlug.status).toBe(400);

    // And the new optional field is validated too: a malformed address is
    // rejected before anything reaches the database.
    const badEmail = await fetch(`${base}/tenants`, {
      method: "POST",
      headers: { "content-type": "application/json", ...operator.headers },
      body: JSON.stringify({ name: "Acme Two", slug: "acme-two", adminEmail: "not-an-email" })
    });
    expect(badEmail.status).toBe(400);
  });
});

describe("the password floor is one rule, not two", () => {
  /**
   * `@growpath/contracts` rejects a short password at the HTTP edge and
   * `@growpath/db` rejects it again before writing a hash. The second check is
   * the one that matters — it is what a caller bypassing the schema would hit —
   * and because `db` cannot import the constant (it does not depend on the
   * contracts package), the two are separate declarations.
   *
   * Separate declarations drift. The dangerous direction is silent: raise the
   * contract to 16 and leave the database at 8, and every client looks strict
   * while the system still accepts eight characters from anything that talks to
   * the API directly.
   */
  it("agrees between the contract schema and the database layer", async () => {
    const { MIN_PASSWORD_LENGTH: contract } = await import(
      "../packages/contracts/src/schemas/invitation"
    );
    const { MIN_PASSWORD_LENGTH: database } = await import(
      "../packages/db/src/invitations"
    );

    expect(database).toBe(contract);
  });

  it("is actually enforced by the schema at that length", async () => {
    const { acceptInvitationSchema, MIN_PASSWORD_LENGTH } = await import(
      "../packages/contracts/src/schemas/invitation"
    );

    const attempt = (length: number) =>
      acceptInvitationSchema.safeParse({ token: "t", password: "a".repeat(length) }).success;

    expect(attempt(MIN_PASSWORD_LENGTH)).toBe(true);
    expect(attempt(MIN_PASSWORD_LENGTH - 1)).toBe(false);
  });
});
