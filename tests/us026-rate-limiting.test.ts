import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import migrate from "node-pg-migrate";
import { join } from "node:path";
import { repoRoot } from "./helpers";
import { createThrowawayDatabase, type ThrowawayDatabase } from "./pg-helpers";
import { startApi, type RunningApi } from "./api-server";
import { issueInvitation, acceptInvitation } from "../packages/db/src/invitations";
import { createTenant } from "../packages/db/src/tenancy";
import {
  LOCKOUT_THRESHOLD,
  LOCKOUT_MINUTES,
  isLocked,
  registerFailedAttempt,
  clearFailedAttempts
} from "../packages/db/src/lockout";
import { authenticate } from "../packages/db/src/authentication";
import { API_ROUTES } from "../packages/contracts/src/routes";
import {
  AUTH_RATE_LIMIT,
  AUTH_RATE_WINDOW_MS
} from "../apps/api/src/common/rate-limit.guard";

/**
 * US-026 — Rate limiting and lockout on auth endpoints.
 *
 * AC1: repeated failures for one account lock it, and `auth_event` records it.
 * AC2: many requests from one source are refused with 429, and that mechanism
 *      cannot be turned into a way to lock a victim's account on demand.
 * AC3: neither response reveals whether the account exists.
 *
 * AC2 is the one worth reading closely. Naive per-account lockout hands an
 * attacker a denial-of-service tool, so the test below asserts the *relationship*
 * between the two limits — that a single source is refused long before it can
 * accumulate enough failures to lock anyone out.
 */

const adminUrl = process.env.DATABASE_URL;
const hasDb = Boolean(adminUrl);

if (!hasDb) {
  console.warn(
    "[US-026] DATABASE_URL not set — the rate-limiting tests are SKIPPED. Set DATABASE_URL to a Postgres admin connection to run them."
  );
}

const PASSWORD = "correct-horse-battery-staple";

interface AuthEventRow {
  event: string;
  outcome: string;
  reason: string | null;
  user_id: string | null;
}

describe.skipIf(!hasDb)("US-026 - rate limiting and lockout", () => {
  const PORT = 34893;
  let db: ThrowawayDatabase | undefined;
  let pool: Pool;
  let api: RunningApi | undefined;

  /** A tenant with one active user who can sign in. */
  async function makeUser(slug: string, email: string): Promise<string> {
    const tenant = await createTenant(pool, { name: slug, slug });
    const invitation = await issueInvitation(pool, {
      tenantId: tenant.id,
      email,
      actor: { label: "platform-admin" }
    });
    await acceptInvitation(pool, { token: invitation.token, password: PASSWORD });
    return invitation.userId;
  }

  async function signIn(body: unknown): Promise<Response> {
    return fetch(`${api!.baseUrl}${API_ROUTES.login}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
  }

  beforeAll(async () => {
    db = await createThrowawayDatabase(adminUrl!, "us026");
    await migrate({
      databaseUrl: db.url,
      dir: join(repoRoot, "packages/db/migrations"),
      direction: "up",
      migrationsTable: "pgmigrations",
      log: () => {}
    });
    pool = new Pool({ connectionString: db.url });
    // Overrides the harness default, which all-but-disables throttling so the
    // other auth suites can run. This is the one suite that needs it real.
    api = await startApi(PORT, {
      DATABASE_URL: db.url,
      AUTH_RATE_WINDOW_MS: String(AUTH_RATE_WINDOW_MS)
    });
  }, 120000);

  afterAll(async () => {
    await api?.stop();
    await pool?.end();
    await db?.drop();
  });

  // ── AC1 ───────────────────────────────────────────────────────────────────

  it("AC1: locks an account after repeated failures and records the lockout", async () => {
    const userId = await makeUser("lock-ac1", "victim@lock-ac1.test");

    expect(await isLocked(pool, userId)).toBe(false);

    // Driven through the data layer rather than HTTP, because the per-source
    // limit would refuse these long before the threshold — which is the point
    // of AC2 and is asserted separately below.
    for (let attempt = 1; attempt < LOCKOUT_THRESHOLD; attempt++) {
      const outcome = await registerFailedAttempt(pool, userId);
      expect(outcome.justLocked).toBe(false);
    }
    expect(await isLocked(pool, userId)).toBe(false);

    const crossing = await registerFailedAttempt(pool, userId);
    expect(crossing.justLocked).toBe(true);
    expect(crossing.failedCount).toBe(LOCKOUT_THRESHOLD);
    expect(await isLocked(pool, userId)).toBe(true);

    // Locked for the cool-off, not indefinitely: a lock needing an administrator
    // to clear it turns an attacker's nuisance into an outage.
    const lockedUntil = crossing.lockedUntil!;
    const minutesOut = (lockedUntil.getTime() - Date.now()) / 60000;
    expect(minutesOut).toBeGreaterThan(LOCKOUT_MINUTES - 2);
    expect(minutesOut).toBeLessThanOrEqual(LOCKOUT_MINUTES + 1);
  });

  it("AC1: a locked account is refused even with the correct password", async () => {
    const userId = await makeUser("lock-ac1b", "victim@lock-ac1b.test");

    for (let attempt = 0; attempt < LOCKOUT_THRESHOLD; attempt++) {
      await registerFailedAttempt(pool, userId);
    }

    const result = await authenticate(pool, {
      slug: "lock-ac1b",
      email: "victim@lock-ac1b.test",
      password: PASSWORD
    });
    expect(result.ok).toBe(false);

    const events = await pool.query<AuthEventRow>(
      `SELECT event, outcome, reason, user_id FROM auth_event
       WHERE user_id = $1 ORDER BY created_at`,
      [userId]
    );
    const reasons = events.rows.map((row) => row.reason);
    expect(reasons).toContain("account locked");
  });

  it("AC1: the lockout itself is written to auth_event", async () => {
    const userId = await makeUser("lock-ac1c", "victim@lock-ac1c.test");

    for (let attempt = 0; attempt < LOCKOUT_THRESHOLD; attempt++) {
      await authenticate(pool, {
        slug: "lock-ac1c",
        email: "victim@lock-ac1c.test",
        password: "wrong-password"
      });
    }

    const locked = await pool.query<AuthEventRow>(
      `SELECT event, outcome, reason, user_id FROM auth_event
       WHERE user_id = $1 AND event = 'login.locked'`,
      [userId]
    );
    expect(locked.rows).toHaveLength(1);
    expect(locked.rows[0].outcome).toBe("failed");
    expect(locked.rows[0].reason).toContain(String(LOCKOUT_THRESHOLD));
  });

  it("AC1: a correct password clears the counter and the lock", async () => {
    const userId = await makeUser("lock-ac1d", "user@lock-ac1d.test");

    for (let attempt = 0; attempt < LOCKOUT_THRESHOLD - 1; attempt++) {
      await registerFailedAttempt(pool, userId);
    }
    await clearFailedAttempts(pool, userId);

    const state = await pool.query<{ failed_login_count: number; locked_until: Date | null }>(
      `SELECT failed_login_count, locked_until FROM "user" WHERE id = $1`,
      [userId]
    );
    expect(state.rows[0].failed_login_count).toBe(0);
    expect(state.rows[0].locked_until).toBeNull();
  });

  // ── AC2 ───────────────────────────────────────────────────────────────────

  it("AC2: refuses with 429 once the per-source limit is passed", async () => {
    await makeUser("rate-ac2", "user@rate-ac2.test");

    const statuses: number[] = [];
    for (let attempt = 0; attempt < AUTH_RATE_LIMIT + 3; attempt++) {
      const response = await signIn({
        slug: "rate-ac2",
        email: "user@rate-ac2.test",
        password: "wrong-password"
      });
      statuses.push(response.status);
      if (response.status === 429) {
        // Tells a well-behaved client when to come back rather than leaving it
        // to guess or hammer.
        expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
      }
    }

    expect(statuses).toContain(429);
    // The limit is a limit, not a suggestion: no more than AUTH_RATE_LIMIT
    // requests got through to be judged on their credentials.
    expect(statuses.filter((status) => status !== 429).length).toBeLessThanOrEqual(
      AUTH_RATE_LIMIT
    );
  }, 60000);

  it("AC2: one source cannot lock a victim out on demand", async () => {
    // The trap this AC names, and the invariant that answers it. If the
    // per-source limit sat at or above the lockout threshold, an attacker could
    // burn a stranger's account inside a single window with nothing but their
    // email address.
    //
    // Asserted here rather than at API boot on purpose: importing the threshold
    // into the guard pulled the whole @growpath/db barrel — pg and the native
    // argon2 binding — into Nest's module initialisation and stalled the Redis
    // readiness probe past its 2s budget. This is the same guarantee without
    // the cost, since a crossed limit fails CI before it can ship.
    expect(AUTH_RATE_LIMIT).toBeLessThan(LOCKOUT_THRESHOLD);

    const userId = await makeUser("rate-ac2b", "victim@rate-ac2b.test");

    // Everything one source can spend in a window, and then some.
    for (let attempt = 0; attempt < AUTH_RATE_LIMIT + 5; attempt++) {
      await signIn({
        slug: "rate-ac2b",
        email: "victim@rate-ac2b.test",
        password: "wrong-password"
      });
    }

    // Throttled before enough failures could accumulate, so the victim can
    // still sign in.
    expect(await isLocked(pool, userId)).toBe(false);

    const failures = await pool.query<{ failed_login_count: number }>(
      `SELECT failed_login_count FROM "user" WHERE id = $1`,
      [userId]
    );
    expect(failures.rows[0].failed_login_count).toBeLessThan(LOCKOUT_THRESHOLD);
  }, 60000);

  it("AC2: the window is bounded, so throttling is not a permanent ban", async () => {
    expect(AUTH_RATE_WINDOW_MS).toBeGreaterThan(0);
    expect(AUTH_RATE_WINDOW_MS).toBeLessThanOrEqual(5 * 60_000);
  });

  // ── AC3 ───────────────────────────────────────────────────────────────────

  it("AC3: a locked account and a wrong password are indistinguishable", async () => {
    await makeUser("quiet-ac3", "known@quiet-ac3.test");
    const userId = await makeUser("quiet-ac3b", "locked@quiet-ac3b.test");
    for (let attempt = 0; attempt < LOCKOUT_THRESHOLD; attempt++) {
      await registerFailedAttempt(pool, userId);
    }

    const wrongPassword = await authenticate(pool, {
      slug: "quiet-ac3",
      email: "known@quiet-ac3.test",
      password: "wrong-password"
    });
    const lockedOut = await authenticate(pool, {
      slug: "quiet-ac3b",
      email: "locked@quiet-ac3b.test",
      password: PASSWORD
    });
    const unknown = await authenticate(pool, {
      slug: "quiet-ac3",
      email: "nobody@quiet-ac3.test",
      password: PASSWORD
    });

    // Same shape, carrying nothing to tell them apart. The distinction exists
    // only in auth_event, where an operator sees it and a caller does not.
    expect(wrongPassword).toEqual({ ok: false });
    expect(lockedOut).toEqual({ ok: false });
    expect(unknown).toEqual({ ok: false });
  });

  it("AC3: the 429 body says nothing about accounts", async () => {
    await makeUser("quiet-ac3c", "user@quiet-ac3c.test");

    let throttled: Response | undefined;
    for (let attempt = 0; attempt < AUTH_RATE_LIMIT + 3; attempt++) {
      const response = await signIn({
        slug: "quiet-ac3c",
        // An address that does not exist. The refusal must read the same as it
        // would for one that does.
        email: "nobody@quiet-ac3c.test",
        password: "wrong-password"
      });
      if (response.status === 429) {
        throttled = response;
        break;
      }
    }

    expect(throttled).toBeDefined();
    const body = JSON.stringify(await throttled!.json()).toLowerCase();
    for (const leak of ["nobody@", "unknown", "no such", "not found", "exist"]) {
      expect(body).not.toContain(leak);
    }
  }, 60000);
});
