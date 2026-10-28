import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Pool } from "pg";
import migrate from "node-pg-migrate";
import { join } from "node:path";
import { repoRoot } from "./helpers";
import { createThrowawayDatabase, type ThrowawayDatabase } from "./pg-helpers";
import { startApi, type RunningApi } from "./api-server";
import { seedTenant, type TenantFixture } from "./tenant-fixtures";
import { parseAcsConnectionString } from "../apps/api/src/email/email.transport";

/**
 * Invitation and password reset links reach people by email.
 *
 * Driven through the real API process and the real Microsoft Graph code path,
 * pointed at a stub that stands in for both Entra's token endpoint and Graph's
 * `sendMail` — so what is asserted is what actually went over the wire, not
 * what a mocked `fetch` was handed.
 */

const MIGRATIONS_DIR = join(repoRoot, "packages/db/migrations");
const PORT = 34877;
const PORTAL_URL = "https://portal.growpath.example";
const SENDER = "noreply@growpath.example";

interface SentMail {
  sender: string;
  to: string;
  subject: string;
  html: string;
  bearer: string | null;
}

interface MailStub {
  origin: string;
  sent: SentMail[];
  tokenRequests: URLSearchParams[];
  /** Make Graph refuse every message, for the "never in the way" case. */
  failSends: boolean;
  stop: () => Promise<void>;
}

async function startMailStub(): Promise<MailStub> {
  const stub = { sent: [], tokenRequests: [], failSends: false } as unknown as MailStub;

  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const url = req.url ?? "";
      if (url.endsWith("/oauth2/v2.0/token")) {
        stub.tokenRequests.push(new URLSearchParams(raw));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ token_type: "Bearer", expires_in: 3599, access_token: "graph.stub.token" }));
        return;
      }
      const sendMail = /^\/v1\.0\/users\/([^/]+)\/sendMail$/.exec(url);
      if (sendMail) {
        if (stub.failSends) {
          res.writeHead(503).end();
          return;
        }
        const body = JSON.parse(raw) as {
          message: {
            subject: string;
            body: { content: string };
            toRecipients: { emailAddress: { address: string } }[];
          };
        };
        stub.sent.push({
          sender: decodeURIComponent(sendMail[1]),
          to: body.message.toRecipients[0].emailAddress.address,
          subject: body.message.subject,
          html: body.message.body.content,
          bearer: req.headers.authorization ?? null
        });
        res.writeHead(202).end();
        return;
      }
      res.writeHead(404).end();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  stub.origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  stub.stop = () => new Promise((resolve) => server.close(() => resolve()));
  return stub;
}

/** Sending is fire-and-forget, so a message lands shortly after the response. */
async function waitForMail(stub: MailStub, to: string, timeoutMs = 5000): Promise<SentMail> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = stub.sent.find((mail) => mail.to === to);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`no email reached ${to}; sent: ${stub.sent.map((m) => m.to).join(", ") || "none"}`);
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 500));

describe("email - parsing the ACS connection string the Azure portal shows", () => {
  it("reads the endpoint and access key, without a trailing slash", () => {
    expect(
      parseAcsConnectionString("endpoint=https://gp-mail.europe.communication.azure.com/;accesskey=c2VjcmV0")
    ).toEqual({ endpoint: "https://gp-mail.europe.communication.azure.com", accessKey: "c2VjcmV0" });
  });

  it("refuses a string missing either half", () => {
    expect(parseAcsConnectionString("endpoint=https://x.communication.azure.com/")).toBeNull();
    expect(parseAcsConnectionString("")).toBeNull();
  });
});

const adminUrl = process.env.DATABASE_URL;
const hasDb = Boolean(adminUrl);

if (!hasDb) {
  console.warn("[email] DATABASE_URL not set — the email delivery suite is SKIPPED.");
}

describe.skipIf(!hasDb)("email - links reach people through Microsoft Graph", () => {
  let db: ThrowawayDatabase | undefined;
  let pool: Pool;
  let api: RunningApi | undefined;
  let stub: MailStub;
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
    stub = await startMailStub();

    api = await startApi(PORT, {
      DATABASE_URL: db.url,
      AUTH_JWT_SECRET: "email-suite-signing-key-at-least-32-characters",
      EMAIL_PROVIDER: "graph",
      EMAIL_FROM: SENDER,
      EMAIL_GRAPH_TENANT_ID: "26c58d65-b577-4f92-aed2-cec1395d146d",
      EMAIL_GRAPH_CLIENT_ID: "mail-app-client-id",
      EMAIL_GRAPH_CLIENT_SECRET: "mail-app-client-secret",
      EMAIL_ORIGIN_OVERRIDE: stub.origin,
      PORTAL_URL: PORTAL_URL
    });

    tenant = await seedTenant(pool, api.baseUrl, "acme-mail", {});
    // Fixture addresses are `.local`, which the API deliberately never mails.
    await pool.query(`UPDATE "user" SET email = $1 WHERE id = $2`, [
      "admin@acme-mail.example",
      tenant.userId
    ]);
  });

  afterAll(async () => {
    api?.stop();
    await stub?.stop();
    await pool?.end();
    await db?.drop();
  });

  beforeEach(() => {
    stub.sent.length = 0;
    stub.failSends = false;
  });

  const post = (path: string, body: unknown, token?: string) =>
    fetch(`${api!.baseUrl}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {})
      },
      body: JSON.stringify(body)
    });

  it("emails a reset link to an address that has an account", async () => {
    const res = await post("/auth/forgot-password", { email: "admin@acme-mail.example" });
    expect(res.status).toBe(202);

    const mail = await waitForMail(stub, "admin@acme-mail.example");
    expect(mail.sender).toBe(SENDER);
    expect(mail.subject).toContain("Reset your Grow Path password");
    expect(mail.html).toContain(`${PORTAL_URL}/reset-password?token=`);
    expect(mail.bearer).toBe("Bearer graph.stub.token");

    // The app credential went to Entra with the Graph scope, and only there.
    const token = stub.tokenRequests.at(-1)!;
    expect(token.get("grant_type")).toBe("client_credentials");
    expect(token.get("scope")).toBe("https://graph.microsoft.com/.default");
  });

  it("sends nothing for an address with no account, and answers the same", async () => {
    const res = await post("/auth/forgot-password", { email: "nobody@acme-mail.example" });
    expect(res.status).toBe(202);
    await settle();
    expect(stub.sent).toHaveLength(0);
  });

  it("emails an invitation carrying the same link the portal shows", async () => {
    const res = await post(
      "/users/invitations",
      { email: "new.person@acme-mail.example", role: "viewer", name: "Nour" },
      tenant.accessToken
    );
    expect(res.status, await res.clone().text()).toBe(201);
    const issued = (await res.json()) as { token: string };

    const mail = await waitForMail(stub, "new.person@acme-mail.example");
    expect(mail.html).toContain(
      `${PORTAL_URL}/accept-invitation?token=${encodeURIComponent(issued.token)}`
    );
    expect(mail.html).toContain("Hello Nour,");
  });

  it("never mails a placeholder .local address", async () => {
    const res = await post(
      "/users/invitations",
      { email: "someone@acme-mail.local", role: "viewer" },
      tenant.accessToken
    );
    expect(res.status).toBe(201);
    await settle();
    expect(stub.sent).toHaveLength(0);
  });

  it("still issues the invitation when the mail provider is down", async () => {
    stub.failSends = true;
    const res = await post(
      "/users/invitations",
      { email: "unlucky@acme-mail.example", role: "viewer" },
      tenant.accessToken
    );
    // The portal shows the link, so a failed send is a fallback, not an error.
    expect(res.status).toBe(201);
    expect(((await res.json()) as { token: string }).token).toBeTruthy();
  });

  it("escapes a name typed by somebody else", async () => {
    const res = await post(
      "/users/invitations",
      { email: "html@acme-mail.example", role: "viewer", name: "<img src=x onerror=alert(1)>" },
      tenant.accessToken
    );
    expect(res.status).toBe(201);
    const mail = await waitForMail(stub, "html@acme-mail.example");
    expect(mail.html).not.toContain("<img src=x");
    expect(mail.html).toContain("&lt;img src=x");
  });
});
