/* Focused check: does the tenant detail page render, and is the seat field on it?
   Temporary — deleted after the run. */
const { spawn } = require("node:child_process");
const { Pool } = require("pg");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const db = require("./packages/db/dist/index.js");

const URL = "postgresql://postgres:112233445566mMM%40@localhost:5432/growpath_dev";
const EMAIL = `claude-chk-${Date.now()}@platform.test`;
const PASSWORD = "correct-horse-battery-staple-chk";
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = 9251;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const pool = new Pool({ connectionString: URL });
  const made = await db.ensurePlatformAdmin(pool, { email: EMAIL, name: "Chk" });
  if (made.invitation) {
    await db.acceptInvitation(pool, { token: made.invitation.token, password: PASSWORD });
  }
  const login = await fetch("http://localhost:3000/auth/login", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD })
  });
  const S = await login.json();
  const { rows } = await pool.query("SELECT id FROM tenant WHERE slug='acme'");
  const acme = rows[0].id;

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "chk-"));
  const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`, "--no-first-run", "--disable-gpu", "about:blank"],
    { stdio: "ignore" });

  let t = null;
  for (let i = 0; i < 30; i++) {
    try { t = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((x) => x.type === "page"); if (t) break; } catch {}
    await sleep(250);
  }
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  let id = 0; const pend = new Map(); const errs = [];
  const send = (m, p = {}) => new Promise((r) => { const n = ++id; pend.set(n, r); ws.send(JSON.stringify({ id: n, method: m, params: p })); });
  await new Promise((r) => ws.addEventListener("open", r));
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); return; }
    if (m.method === "Runtime.exceptionThrown") errs.push("EXC: " + (m.params.exceptionDetails.exception?.description || "").split("\n")[0]);
    if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error")
      errs.push((m.params.args || []).map((a) => a.value ?? a.description ?? "").join(" ").split("\n")[0]);
  });
  await send("Runtime.enable"); await send("Page.enable");

  await send("Page.navigate", { url: "http://localhost:4200/" });
  await sleep(2500);
  await send("Runtime.evaluate", {
    expression: `localStorage.setItem('growpath.session', ${JSON.stringify(JSON.stringify({ user: S.user, tenant: S.tenant, permissions: S.permissions }))});
                 sessionStorage.setItem('growpath.refresh', ${JSON.stringify(S.refreshToken)}); 'ok'`
  });
  errs.length = 0;

  await send("Page.navigate", { url: `http://localhost:4200/platform/tenants/${acme}` });
  await sleep(7000);

  const probe = await send("Runtime.evaluate", {
    expression: `JSON.stringify({
      path: location.pathname,
      seatField: !!document.querySelector('#seat-override'),
      saveBtn: [...document.querySelectorAll('button')].some(b=>/save seats/i.test(b.innerText)),
      heading: (document.querySelector('h1')||{}).innerText || '',
      text: document.body.innerText.replace(/\\n{2,}/g,' | ').slice(0,700)
    })`
  });
  console.log(JSON.parse(probe.result.value ?? "{}"));
  console.log("errors:", errs.length ? errs.slice(0, 4) : "none");

  const u = await pool.query('SELECT id FROM "user" WHERE email=$1', [EMAIL]);
  if (u.rows[0]) {
    await pool.query("DELETE FROM refresh_token WHERE user_id=$1", [u.rows[0].id]);
    await pool.query(`UPDATE "user" SET password_hash=NULL, status='disabled' WHERE id=$1`, [u.rows[0].id]);
  }
  await pool.end(); ws.close(); chrome.kill(); process.exit(0);
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
