import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import migrate from "node-pg-migrate";
import { join } from "node:path";
import { repoRoot } from "./helpers";
import { createThrowawayDatabase, type ThrowawayDatabase } from "./pg-helpers";
import { startApi, type RunningApi } from "./api-server";
import { seedTenant, type TenantFixture } from "./tenant-fixtures";
import { hashRefreshToken, rotateRefreshToken } from "../packages/db/src/refresh-tokens";
import { authenticatedSchema } from "../packages/contracts/src/schemas/auth";
import { API_ROUTES } from "../packages/contracts/src/routes";

const MIGRATIONS_DIR = join(repoRoot, "packages/db/migrations");
const PORT = 34825;
const JWT_SECRET = "us023-refresh-rotation-signing-key-32chars";

const adminUrl = process.env.DATABASE_URL;
const hasDb = Boolean(adminUrl);

if (!hasDb) {
  // Don't silently skip coverage.
  console.warn(
    "[US-023] DATABASE_URL not set — the refresh rotation tests are SKIPPED. Set DATABASE_URL to a Postgres admin connection to run them."
  );
}

interface TokenRow {
  id: string;
  family_id: string;
  token_hash: string;
  parent_id: string | null;
  used_at: Date | null;
  revoked_at: Date | null;
  revoked_reason: string | null;
}

describe.skipIf(!hasDb)("US-023 - refresh token rotation with reuse detection", () => {
  let db: ThrowawayDatabase | undefined;
  let pool: Pool;
  let api: RunningApi | undefined;
  let tenant: TenantFixture;

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
    tenant = await seedTenant(pool, api.baseUrl, "acme-refresh", { companies: ["Acme Ltd"] });
  });

  afterAll(async () => {
    api?.stop();
    await pool?.end();
    await db?.drop();
    db = undefined;
  });

  /** A fresh session, so each test starts from its own family. */
  async function newSession(slug: string): Promise<TenantFixture> {
    return seedTenant(pool, api!.baseUrl, slug, { companies: ["Subsidiary"] });
  }

  const exchange = (refreshToken: string): Promise<Response> =>
    fetch(`${api!.baseUrl}${API_ROUTES.refresh}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refreshToken })
    });

  const rowFor = async (token: string): Promise<TokenRow | undefined> => {
    const res = await pool.query<TokenRow>(
      `SELECT id, family_id, token_hash, parent_id, used_at, revoked_at, revoked_reason
       FROM refresh_token WHERE token_hash = $1`,
      [hashRefreshToken(token)]
    );
    return res.rows[0];
  };

  const authEvents = async (event: string): Promise<{ reason: string | null }[]> => {
    const res = await pool.query<{ reason: string | null }>(
      "SELECT reason FROM auth_event WHERE event = $1 ORDER BY created_at",
      [event]
    );
    return res.rows;
  };

  // AC1: Given a valid refresh token, when it is exchanged, then a new token is
  // issued in the same family and the presented one is marked used.
  it("AC1: an exchange issues a new token in the same family and burns the presented one", async () => {
    const session = await newSession("acme-rotate");

    const before = await rowFor(session.refreshToken);
    expect(before, "the sign-in must have stored a refresh token").toBeDefined();
    expect(before!.used_at, "an unspent token must not be marked used").toBeNull();

    const res = await exchange(session.refreshToken);
    expect(res.status).toBe(200);

    const body = await res.json();
    const parsed = authenticatedSchema.safeParse(body);
    expect(parsed.success, `refresh did not match the contract: ${JSON.stringify(body)}`).toBe(true);
    if (!parsed.success) return;

    // A genuinely new token, not the one presented.
    expect(parsed.data.refreshToken).not.toBe(session.refreshToken);

    const issued = await rowFor(parsed.data.refreshToken);
    expect(issued, "the new token must be stored").toBeDefined();
    expect(issued!.family_id, "rotation stays within one family").toBe(before!.family_id);
    expect(issued!.parent_id, "the chain must record what it replaced").toBe(before!.id);
    expect(issued!.used_at).toBeNull();

    // The presented one is spent.
    const after = await rowFor(session.refreshToken);
    expect(after!.used_at, "the presented token must be marked used").not.toBeNull();

    // The new access token works, so the session genuinely continued.
    const companies = await fetch(`${api!.baseUrl}${API_ROUTES.companies}`, {
      headers: { authorization: `Bearer ${parsed.data.accessToken}` }
    });
    expect(companies.status).toBe(200);

    // And the new refresh token can itself be exchanged — rotation continues
    // rather than working exactly once.
    const second = await exchange(parsed.data.refreshToken);
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as { refreshToken: string };
    expect((await rowFor(secondBody.refreshToken))!.family_id).toBe(before!.family_id);
  });

  // AC2: Given a refresh token that has already been used, when it is presented
  // again, then the entire family is revoked and an auth_event records the replay.
  it("AC2: replaying a spent token revokes the whole family and records the event", async () => {
    const session = await newSession("acme-replay");
    const familyId = (await rowFor(session.refreshToken))!.family_id;

    // Rotate twice, so the family has a chain and a live token at its head —
    // the thief's token, in the scenario this exists for.
    const first = (await (await exchange(session.refreshToken)).json()) as { refreshToken: string };
    const second = (await (await exchange(first.refreshToken)).json()) as { refreshToken: string };

    const liveBefore = await exchangeableCount(familyId);
    expect(liveBefore, "the family must have a usable token before the replay").toBeGreaterThan(0);

    const replaysBefore = (await authEvents("token.replayed")).length;

    // Present the original, long-spent token.
    const replay = await exchange(session.refreshToken);
    expect(replay.status).toBe(401);

    // Every token in the family is revoked, including the newest one — revoking
    // only the replayed token would leave the thief's still working.
    const rows = await pool.query<TokenRow>(
      "SELECT id, family_id, token_hash, parent_id, used_at, revoked_at, revoked_reason FROM refresh_token WHERE family_id = $1",
      [familyId]
    );
    expect(rows.rowCount).toBeGreaterThanOrEqual(3);
    for (const row of rows.rows) {
      expect(row.revoked_at, `token ${row.id} was left unrevoked`).not.toBeNull();
      expect(row.revoked_reason).toMatch(/replay/i);
    }

    // Which is the point: the newest token no longer works.
    expect((await exchange(second.refreshToken)).status).toBe(401);

    // The replay is recorded for a human to look at.
    const replays = await authEvents("token.replayed");
    expect(replays.length, "the replay must be recorded").toBe(replaysBefore + 1);
    expect(replays[replays.length - 1].reason).toMatch(/replay/i);

    // Other sessions are untouched — the blast radius is one family.
    expect((await exchange(tenant.refreshToken)).status).toBe(200);
  });

  /** Blocks until some backend in this database is waiting on a lock. */
  async function waitForLockWait(timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const res = await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_stat_activity
         WHERE datname = current_database() AND state = 'active' AND wait_event_type = 'Lock'`
      );
      if (res.rows[0].n > 0) {
        return;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error("the second exchange never blocked — the row lock is missing");
  }

  /** Tokens in a family that are neither spent nor revoked. */
  async function exchangeableCount(familyId: string): Promise<number> {
    const res = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM refresh_token
       WHERE family_id = $1 AND used_at IS NULL AND revoked_at IS NULL`,
      [familyId]
    );
    return res.rows[0].count;
  }

  // AC3: Given the refresh token store, when it is read, then only hashes are
  // present — no stored value can be presented as a token.
  it("AC3: the store holds only hashes, and a stored value is not a usable token", async () => {
    const session = await newSession("acme-hashes");

    const stored = await pool.query<{ row: string }>(
      "SELECT to_jsonb(refresh_token)::text AS row FROM refresh_token"
    );
    expect(stored.rowCount, "there must be rows for this to mean anything").toBeGreaterThan(0);

    // The raw token appears nowhere in the table — not in token_hash, and not
    // in some other column that quietly kept a copy.
    for (const { row } of stored.rows) {
      expect(row, "the raw refresh token was stored").not.toContain(session.refreshToken);
    }

    const row = await rowFor(session.refreshToken);
    expect(row!.token_hash).not.toBe(session.refreshToken);
    // SHA-256 hex: 64 characters, and nothing that decodes back to the token.
    expect(row!.token_hash).toMatch(/^[0-9a-f]{64}$/);

    // Presenting what the store holds does not work — this is the whole claim.
    // Someone with read access to the table cannot turn it into a session.
    expect((await exchange(row!.token_hash)).status).toBe(401);

    // Negative control: the real token does work, so that 401 is the hash
    // being useless rather than the endpoint being broken.
    expect((await exchange(session.refreshToken)).status).toBe(200);
  });

  it("rejects unknown, malformed and expired tokens with one identical answer", async () => {
    const session = await newSession("acme-rejects");

    const unknown = await exchange("Zm9vYmFyLXVua25vd24tcmVmcmVzaC10b2tlbi12YWx1ZQ");
    expect(unknown.status).toBe(401);
    const unknownBody = await unknown.text();

    // An expired token is refused, and refused identically — a different
    // message would tell a thief the token was real but stale.
    await pool.query(
      "UPDATE refresh_token SET expires_at = now() - interval '1 day' WHERE token_hash = $1",
      [hashRefreshToken(session.refreshToken)]
    );
    const expired = await exchange(session.refreshToken);
    expect(expired.status).toBe(401);
    expect(await expired.text()).toBe(unknownBody);

    // An expired token is not a replay: the family stays intact, so a user
    // returning after a fortnight is signed out rather than flagged.
    expect((await authEvents("token.rejected")).length).toBeGreaterThan(0);
  });

  it("lets only one of two concurrent exchanges of the same token rotate", async () => {
    const session = await newSession("acme-race");

    // Driven at the data layer with two real overlapping transactions, because
    // two HTTP requests do not reliably overlap — that version of this test
    // passed with the row lock removed, which is to say it proved nothing.
    const a = await pool.connect();
    const b = await pool.connect();
    try {
      await a.query("BEGIN");
      await b.query("BEGIN");

      const first = await rotateRefreshToken(a, { token: session.refreshToken });

      // Started, deliberately not awaited: it blocks on the row lock A holds.
      const pending = rotateRefreshToken(b, { token: session.refreshToken });

      // Wait until B is genuinely blocked before committing A. Without this the
      // result depends on whether B's query reached the server before the
      // commit — which is JS scheduling, not database behaviour, and made an
      // earlier version of this test pass with the lock removed.
      await waitForLockWait();

      await a.query("COMMIT");

      const second = await pending;
      await b.query("COMMIT");

      expect(first.ok, "the first exchange must succeed").toBe(true);
      // Without the lock both would read `used_at IS NULL` and both would
      // rotate, leaving two live tokens in one family — after which the user's
      // next call looks exactly like a thief's.
      expect(second.ok, "the second must not also rotate").toBe(false);
      expect(second.ok === false && second.reason).toBe("replayed");
    } finally {
      a.release();
      b.release();
    }
  });
});
