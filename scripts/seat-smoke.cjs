/*
 * Seat-limit smoke test against the RUNNING dev stack (API :3000).
 *
 * Mints a throwaway platform admin, walks the whole feature, and deletes the
 * admin again. Touches no demo data it does not restore.
 *
 *   node seat-smoke.cjs
 */
const { Pool } = require("pg");
const db = require("../packages/db/dist/index.js");

const DB_URL = "postgresql://postgres:112233445566mMM%40@localhost:5432/growpath_dev";
const API = "http://localhost:3000";
const EMAIL = `seat-smoke-${Date.now()}@platform.test`;
const PASSWORD = "correct-horse-battery-staple-smoke";

const ok = (label, cond, extra = "") =>
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`);

(async () => {
  const pool = new Pool({ connectionString: DB_URL });
  let adminId;
  try {
    // ── a throwaway operator ────────────────────────────────────────────
    const made = await db.ensurePlatformAdmin(pool, { email: EMAIL, name: "Seat Smoke" });
    if (made.invitation) {
      await db.acceptInvitation(pool, { token: made.invitation.token, password: PASSWORD });
    }
    adminId = (
      await pool.query('SELECT id FROM "user" WHERE email = $1', [EMAIL])
    ).rows[0].id;

    const login = await fetch(`${API}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD })
    });
    const session = await login.json();
    const token = session.accessToken;
    ok("signed in as a platform admin", Boolean(token));

    const call = (method, path, body) =>
      fetch(`${API}${path}`, {
        method,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`
        },
        body: body === undefined ? undefined : JSON.stringify(body)
      });

    const acme = (await pool.query("SELECT id FROM tenant WHERE slug = 'acme'")).rows[0].id;
    const before = (
      await pool.query("SELECT plan, seat_limit FROM tenant WHERE id = $1", [acme])
    ).rows[0];

    // ── 1. the package catalogue ────────────────────────────────────────
    const plans = await (await call("GET", "/platform/plans")).json();
    ok(
      "GET /platform/plans lists four packages with seat counts",
      plans.length === 4 && plans.every((p) => p.userLimit > 0),
      plans.map((p) => `${p.key}=${p.userLimit}`).join(" ")
    );

    // ── 2. the tenant reports used vs included ──────────────────────────
    let detail = await (await call("GET", `/platform/tenants/${acme}`)).json();
    ok(
      "tenant detail carries userCount / userLimit",
      typeof detail.userCount === "number" && typeof detail.userLimit === "number",
      `${detail.userCount} of ${detail.userLimit}, plan=${detail.plan}`
    );
    ok("inherits its package (no override)", detail.seatLimitOverride === null);

    // ── 3. a negotiated override ────────────────────────────────────────
    detail = await (await call("PATCH", `/platform/tenants/${acme}/seats`, { seatLimit: 7 })).json();
    ok(
      "PATCH seats=7 overrides the package",
      detail.seatLimitOverride === 7 && detail.userLimit === 7,
      `limit=${detail.userLimit} override=${detail.seatLimitOverride}`
    );

    // ── 4. the override survives a plan change ──────────────────────────
    await call("PATCH", `/platform/tenants/${acme}/plan`, { plan: "trial" });
    detail = await (await call("GET", `/platform/tenants/${acme}`)).json();
    ok(
      "override survives a plan change",
      detail.plan === "trial" && detail.userLimit === 7,
      `plan=${detail.plan} limit=${detail.userLimit}`
    );

    // ── 5. zero and negative are refused ────────────────────────────────
    const zero = await call("PATCH", `/platform/tenants/${acme}/seats`, { seatLimit: 0 });
    const neg = await call("PATCH", `/platform/tenants/${acme}/seats`, { seatLimit: -5 });
    ok("a zero or negative allowance is refused", zero.status === 400 && neg.status === 400,
      `${zero.status} / ${neg.status}`);

    // ── 6. clearing returns it to the package ───────────────────────────
    detail = await (await call("PATCH", `/platform/tenants/${acme}/seats`, { seatLimit: null })).json();
    ok(
      "null clears the override, back to the package's number",
      detail.seatLimitOverride === null && detail.userLimit === 3,
      `limit=${detail.userLimit} (trial includes 3)`
    );

    // ── 7. the audit trail ──────────────────────────────────────────────
    const audit = await pool.query(
      "SELECT before_values, after_values FROM audit_log WHERE tenant_id = $1 AND action = 'tenant.seats_changed' ORDER BY created_at DESC LIMIT 3",
      [acme]
    );
    ok("each change writes a tenant.seats_changed entry", audit.rowCount >= 2,
      audit.rows.map((r) => `${JSON.stringify(r.before_values)}→${JSON.stringify(r.after_values)}`).join(" "));

    // ── 8. editing what a package includes ──────────────────────────────
    const cat = await (await call("GET", "/platform/plans")).json();
    const growthBefore = cat.find((p) => p.key === "growth").userLimit;
    ok("catalogue carries a tenant count per package",
      cat.every((p) => typeof p.tenantCount === "number"),
      cat.map((p) => `${p.key}:${p.userLimit}(${p.tenantCount} tenants)`).join(" "));

    const edited = await call("PATCH", "/platform/plans/growth", { userLimit: 30 });
    const after = await edited.json();
    ok("PATCH /platform/plans/growth raises the package to 30",
      edited.status === 200 && after.find((p) => p.key === "growth").userLimit === 30);

    const badPlan = await call("PATCH", "/platform/plans/platinum", { userLimit: 30 });
    const badNum = await call("PATCH", "/platform/plans/growth", { userLimit: 0 });
    ok("unknown package 404s, zero seats 400s",
      badPlan.status === 404 && badNum.status === 400,
      `${badPlan.status} / ${badNum.status}`);

    await call("PATCH", "/platform/plans/growth", { userLimit: growthBefore });
    console.log(`
restored growth to ${growthBefore} seats`);

    // ── restore ─────────────────────────────────────────────────────────
    await call("PATCH", `/platform/tenants/${acme}/plan`, { plan: before.plan });
    await call("PATCH", `/platform/tenants/${acme}/seats`, { seatLimit: before.seat_limit });
    console.log(`\nrestored acme to plan=${before.plan} seat_limit=${before.seat_limit}`);
  } finally {
    if (adminId) {
      // Disabled, not deleted: the audit log is append-only and references the
      // actor, so removing the row would orphan the entries this run wrote.
      await pool.query(`UPDATE "user" SET status = 'disabled' WHERE id = $1`, [adminId]);
      console.log("disabled the throwaway operator");
    }
    await pool.end();
  }
})().catch((e) => {
  console.error("ERROR", e);
  process.exit(1);
});
