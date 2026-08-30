import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import migrate from "node-pg-migrate";
import { createHmac } from "node:crypto";
import { join } from "node:path";
import { repoRoot } from "./helpers";
import { createThrowawayDatabase, type ThrowawayDatabase } from "./pg-helpers";
import { startApi, type RunningApi } from "./api-server";
import { seedTenant, FIXTURE_PASSWORD, type TenantFixture } from "./tenant-fixtures";
import { authenticatedSchema } from "../packages/contracts/src/schemas/auth";
import { API_ROUTES } from "../packages/contracts/src/routes";

const MIGRATIONS_DIR = join(repoRoot, "packages/db/migrations");
const PORT = 34824;
const JWT_SECRET = "us022-access-token-signing-key-at-least-32";

// Asserted rather than imported: these are part of what the token promises, so
// a change to either should fail here rather than pass silently.
const ISSUER = "growpath-admin-api";
const AUDIENCE = "growpath-admin-portal";

const adminUrl = process.env.DATABASE_URL;
const hasDb = Boolean(adminUrl);

if (!hasDb) {
  // Don't silently skip coverage.
  console.warn(
    "[US-022] DATABASE_URL not set — the access token tests are SKIPPED. Set DATABASE_URL to a Postgres admin connection to run them."
  );
}

const b64url = (value: string): string => Buffer.from(value, "utf8").toString("base64url");

/**
 * Mints an HS256 JWT by hand.
 *
 * Deliberately not the library the API signs with: a test that forges tokens
 * using the same code that validates them can only prove that code agrees with
 * itself. Hand-rolling also gives direct control over `exp`, `iss` and `aud`,
 * which is what AC3 needs.
 */
function forgeToken(payload: Record<string, unknown>, secret: string = JWT_SECRET): string {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(JSON.stringify(payload));
  const signature = createHmac("sha256", secret)
    .update(`${header}.${body}`)
    .digest("base64url");
  return `${header}.${body}.${signature}`;
}

/** The claims inside a token, read without trusting it. */
function decodePayload(token: string): Record<string, unknown> {
  const segment = token.split(".")[1];
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as Record<string, unknown>;
}

function decodeHeader(token: string): Record<string, unknown> {
  const segment = token.split(".")[0];
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as Record<string, unknown>;
}

/** Recomputes the signature, so AC1 does not take the API's word for it. */
function signatureIsValid(token: string, secret: string = JWT_SECRET): boolean {
  const [header, body, signature] = token.split(".");
  const expected = createHmac("sha256", secret).update(`${header}.${body}`).digest("base64url");
  return signature === expected;
}

describe.skipIf(!hasDb)("US-022 - access token issuance with tenancy claims", () => {
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
    api = await startApi(PORT, { DATABASE_URL: db.url, AUTH_JWT_SECRET: JWT_SECRET });

    tenantA = await seedTenant(pool, api.baseUrl, "acme-tok", {
      companies: ["Acme Manufacturing"],
      permissions: ["company.read", "tenant.manage"]
    });
    tenantB = await seedTenant(pool, api.baseUrl, "globex-tok", {
      companies: ["Globex Holdings"]
    });
  });

  afterAll(async () => {
    api?.stop();
    await pool?.end();
    await db?.drop();
    db = undefined;
  });

  const companies = (token: string, query = "", headers: Record<string, string> = {}) =>
    fetch(`${api!.baseUrl}${API_ROUTES.companies}${query}`, {
      headers: { authorization: `Bearer ${token}`, ...headers }
    });

  // AC1: Given a successful sign-in, when an access token is issued, then it
  // carries the user, the tenant and the granted permissions, and a short expiry.
  it("AC1: the token carries user, tenant, permissions and a short expiry", async () => {
    const res = await fetch(`${api!.baseUrl}${API_ROUTES.login}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        slug: tenantA.slug,
        email: tenantA.email,
        password: FIXTURE_PASSWORD
      })
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    // Checked against the shared schema, so the response tracks the contract
    // rather than one snapshot of it.
    const parsed = authenticatedSchema.safeParse(body);
    expect(parsed.success, `response did not match the contract: ${JSON.stringify(body)}`).toBe(
      true
    );
    if (!parsed.success) return;

    expect(parsed.data.tokenType).toBe("Bearer");
    expect(parsed.data.expiresIn).toBe(15 * 60);

    // Read and checked without the implementation's own verifier.
    const token = parsed.data.accessToken;
    expect(signatureIsValid(token), "the token must be signed with the configured key").toBe(true);
    expect(decodeHeader(token).alg).toBe("HS256");

    const payload = decodePayload(token);
    expect(payload.sub).toBe(tenantA.userId);
    expect(payload.tenantId).toBe(tenantA.tenantId);
    expect(payload.tenantSlug).toBe(tenantA.slug);
    expect(payload.email).toBe(tenantA.email);
    expect(payload.permissions).toEqual(["company.read", "tenant.manage"]);
    expect(payload.iss).toBe(ISSUER);
    expect(payload.aud).toBe(AUDIENCE);

    // Short: minutes, because a revoked permission keeps working until expiry.
    const lifetime = Number(payload.exp) - Number(payload.iat);
    expect(lifetime).toBe(15 * 60);
    expect(lifetime).toBeLessThanOrEqual(60 * 60);

    // The credential itself never travels in the token.
    expect(parsed.data.accessToken).not.toContain(FIXTURE_PASSWORD);
  });

  // AC2: Given a request bearing a valid token, when it reaches a tenant-scoped
  // route, then the tenant context comes from the token and never from a header,
  // query parameter or route parameter.
  it("AC2: the tenant comes from the token, and caller-supplied values cannot move it", async () => {
    const baseline = await companies(tenantA.accessToken);
    expect(baseline.status).toBe(200);
    const expected = (await baseline.json()) as { id: string; name: string }[];
    expect(expected.map((c) => c.name)).toEqual(["Acme Manufacturing"]);

    // Every channel a caller controls, aimed at tenant B, with tenant A's token.
    const attempts = [
      await companies(tenantA.accessToken, `?tenantId=${tenantB.tenantId}`),
      await companies(tenantA.accessToken, `?slug=${tenantB.slug}`),
      await companies(tenantA.accessToken, "", { "x-tenant-id": tenantB.tenantId }),
      await companies(tenantA.accessToken, "", { "x-tenant-slug": tenantB.slug }),
      await companies(tenantA.accessToken, `?tenantId=${tenantB.tenantId}`, {
        "x-tenant-id": tenantB.tenantId
      })
    ];

    for (const attempt of attempts) {
      expect(attempt.status).toBe(200);
      const rows = (await attempt.json()) as { id: string; name: string }[];
      expect(rows, "a caller-supplied tenant must change nothing").toEqual(expected);
    }

    // Nor can a route parameter reach across: B's company id is a 404 for A.
    const byId = await fetch(`${api!.baseUrl}/companies/${tenantB.companies[0].id}`, {
      headers: {
        authorization: `Bearer ${tenantA.accessToken}`,
        "x-tenant-id": tenantB.tenantId
      }
    });
    expect(byId.status).toBe(404);

    // Guard against a vacuous pass: B's token really does see B's data, so the
    // endpoint is capable of returning something other than A's rows.
    const asB = await companies(tenantB.accessToken);
    expect(((await asB.json()) as { name: string }[]).map((c) => c.name)).toEqual([
      "Globex Holdings"
    ]);
  });

  // AC3: Given a token that is expired, malformed, or signed with the wrong key,
  // when it is presented, then it is rejected and no tenant context is established.
  it("AC3: expired, forged and malformed tokens are all rejected identically", async () => {
    const now = Math.floor(Date.now() / 1000);
    const claims = {
      sub: tenantA.userId,
      tenantId: tenantA.tenantId,
      tenantSlug: tenantA.slug,
      email: tenantA.email,
      permissions: ["company.read"],
      iss: ISSUER,
      aud: AUDIENCE,
      iat: now,
      exp: now + 900
    };

    // Control first: the forging routine, with everything correct, produces a
    // token the API accepts. Without this the rejections below could all be a
    // broken forger rather than a working guard.
    expect(
      (await companies(forgeToken(claims))).status,
      "a correctly forged token must be accepted, or this test proves nothing"
    ).toBe(200);

    const rejected: Record<string, string> = {
      expired: forgeToken({ ...claims, iat: now - 3600, exp: now - 1 }),
      wrongKey: forgeToken(claims, "a-completely-different-signing-key-32ch"),
      wrongIssuer: forgeToken({ ...claims, iss: "some-other-service" }),
      wrongAudience: forgeToken({ ...claims, aud: "some-other-client" }),
      // Signed with the right key, but missing the claim that names the tenant.
      // A signature proves the payload was not altered, not that it has a shape.
      missingTenant: forgeToken({ ...claims, tenantId: undefined }),
      // Altering a claim invalidates the signature — the whole point of one.
      tamperedTenant: forgeToken({ ...claims, tenantId: tenantB.tenantId }, "wrong-key-so-unsigned"),
      malformed: "not.a.token",
      empty: ""
    };

    for (const [label, token] of Object.entries(rejected)) {
      const res = await companies(token);
      expect(res.status, `a ${label} token must be rejected`).toBe(401);

      // No tenant context was established: nothing leaked into the body.
      const text = await res.text();
      expect(text, `a ${label} token leaked data`).not.toContain("Acme Manufacturing");
      expect(text).not.toContain(tenantA.tenantId);
    }

    // The `Bearer` scheme is required, so a bare token is not accepted either.
    const bare = await fetch(`${api!.baseUrl}${API_ROUTES.companies}`, {
      headers: { authorization: tenantA.accessToken }
    });
    expect(bare.status).toBe(401);

    // Negative control: the same request with the genuine token succeeds, so
    // these 401s are the token being judged rather than the route being broken.
    expect((await companies(tenantA.accessToken)).status).toBe(200);
  });
});
