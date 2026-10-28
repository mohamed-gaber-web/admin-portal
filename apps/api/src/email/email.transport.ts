import { createHash, createHmac } from "node:crypto";
import { fetchWithCorrelation } from "@growpath/observability";
import { createTransport, type Transporter } from "nodemailer";
import { apiLogger } from "../observability/logger";

/**
 * Where outbound email goes, chosen by `EMAIL_PROVIDER`.
 *
 *   graph  A Microsoft 365 mailbox, through Microsoft Graph `sendMail`, as an
 *          Entra app registration holding the `Mail.Send` application
 *          permission. The same kind of client-credentials app the D365
 *          connection uses, so a tenant on Microsoft 365 needs no new service.
 *   acs    Azure Communication Services Email, through its REST API, signed
 *          with the resource's access key.
 *   smtp   Any SMTP server — Gmail, Office 365, or ACS's own SMTP endpoint.
 *          Chosen automatically when `EMAIL_HOST` is set and `EMAIL_PROVIDER`
 *          is not, because a host with no provider can only mean SMTP.
 *   log    Nothing is sent; a line is logged saying a message would have been.
 *          The default, so a developer machine and the test suites need no
 *          mail account — and so an unconfigured server degrades to "the
 *          operator copies the link", which is how it worked before email.
 *
 * Plain `fetch` for Graph and ACS, rather than the Microsoft SDKs: two POSTs each are
 * the whole surface, and an SDK would add a dependency tree to a process that
 * holds the installation's most valuable credentials.
 */

export interface OutboundEmail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface EmailTransport {
  readonly name: "graph" | "acs" | "smtp" | "log";
  /** Resolves on acceptance by the provider; rejects with a message safe to log. */
  send(message: OutboundEmail): Promise<void>;
}

const SEND_TIMEOUT_MS = 10_000;

/** The parts of a response worth logging: never the body, which can echo the request. */
class EmailSendError extends Error {
  constructor(stage: string, status?: number) {
    super(status ? `${stage} answered ${status}` : `${stage} was unreachable`);
  }
}

/**
 * Test seam: replaces the scheme and host of the Graph and Entra endpoints.
 *
 * Ignored in production, loudly, for the reason the D365 override is: it would
 * redirect a client secret to whatever host it names.
 */
function originOverride(): string | null {
  const configured = process.env.EMAIL_ORIGIN_OVERRIDE?.trim();
  if (!configured) return null;
  if (process.env.NODE_ENV === "production") {
    apiLogger.error("email.origin_override.refused", {
      reason: "EMAIL_ORIGIN_OVERRIDE is set in production and has been ignored."
    });
    return null;
  }
  return configured;
}

function withOverride(url: string): string {
  const override = originOverride();
  if (!override) return url;
  const target = new URL(url);
  const replacement = new URL(override);
  target.protocol = replacement.protocol;
  target.host = replacement.host;
  return target.toString();
}

// ── Microsoft Graph ─────────────────────────────────────────────────────────

export interface GraphSettings {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  /** The mailbox that sends: a user or shared mailbox the app may send as. */
  sender: string;
}

class GraphTransport implements EmailTransport {
  readonly name = "graph" as const;
  private token: { value: string; expiresAt: number } | null = null;

  constructor(private readonly settings: GraphSettings) {}

  private async accessToken(): Promise<string> {
    // Refreshed a minute early, so a token never expires in flight.
    if (this.token && this.token.expiresAt - 60_000 > Date.now()) return this.token.value;

    const url = withOverride(
      `https://login.microsoftonline.com/${encodeURIComponent(this.settings.tenantId)}/oauth2/v2.0/token`
    );
    let response: Response;
    try {
      response = await fetchWithCorrelation(
        url,
        {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "client_credentials",
            client_id: this.settings.clientId,
            client_secret: this.settings.clientSecret,
            scope: "https://graph.microsoft.com/.default"
          }),
          signal: AbortSignal.timeout(SEND_TIMEOUT_MS)
        },
        { target: "entra" }
      );
    } catch {
      throw new EmailSendError("the Entra token endpoint");
    }
    if (!response.ok) throw new EmailSendError("the Entra token endpoint", response.status);

    const body = (await response.json()) as { access_token?: string; expires_in?: number };
    if (!body.access_token) throw new EmailSendError("the Entra token endpoint", response.status);
    this.token = {
      value: body.access_token,
      expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000
    };
    return this.token.value;
  }

  async send(message: OutboundEmail): Promise<void> {
    const token = await this.accessToken();
    const url = withOverride(
      `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(this.settings.sender)}/sendMail`
    );

    let response: Response;
    try {
      response = await fetchWithCorrelation(
        url,
        {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({
            message: {
              subject: message.subject,
              body: { contentType: "HTML", content: message.html },
              toRecipients: [{ emailAddress: { address: message.to } }]
            },
            // A noreply mailbox's Sent Items would fill with every reset link.
            saveToSentItems: false
          }),
          signal: AbortSignal.timeout(SEND_TIMEOUT_MS)
        },
        { target: "graph" }
      );
    } catch {
      throw new EmailSendError("Microsoft Graph");
    }
    // 401 here means the cached token is stale or the permission was revoked;
    // dropped so the next message asks again rather than failing forever.
    if (response.status === 401) this.token = null;
    if (response.status !== 202) throw new EmailSendError("Microsoft Graph", response.status);
  }
}

// ── Azure Communication Services ────────────────────────────────────────────

export interface AcsSettings {
  /** `https://<resource>.communication.azure.com` */
  endpoint: string;
  /** The resource's access key, base64, from its connection string. */
  accessKey: string;
  /** A MailFrom address on a domain connected to the resource. */
  sender: string;
  senderName: string;
}

/** Parses `endpoint=https://…/;accesskey=…` — the form the Azure portal shows. */
export function parseAcsConnectionString(value: string): { endpoint: string; accessKey: string } | null {
  const parts = new Map(
    value
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const at = part.indexOf("=");
        return [part.slice(0, at).toLowerCase(), part.slice(at + 1)] as const;
      })
  );
  const endpoint = parts.get("endpoint")?.replace(/\/+$/, "");
  const accessKey = parts.get("accesskey");
  return endpoint && accessKey ? { endpoint, accessKey } : null;
}

class AcsTransport implements EmailTransport {
  readonly name = "acs" as const;

  constructor(private readonly settings: AcsSettings) {}

  async send(message: OutboundEmail): Promise<void> {
    const url = new URL(withOverride(`${this.settings.endpoint}/emails:send?api-version=2023-03-31`));
    const body = JSON.stringify({
      senderAddress: this.settings.sender,
      content: { subject: message.subject, plainText: message.text, html: message.html },
      recipients: { to: [{ address: message.to }] },
      // Reply-to the sender name's mailbox is meaningless for a DoNotReply
      // address; omitted rather than inventing one.
      userEngagementTrackingDisabled: true
    });

    // The ACS HMAC scheme: sign verb, path+query, date, host and body digest.
    const date = new Date().toUTCString();
    const contentHash = createHash("sha256").update(body).digest("base64");
    const host = new URL(this.settings.endpoint).host;
    const toSign = `POST\n${url.pathname}${url.search}\n${date};${host};${contentHash}`;
    const signature = createHmac("sha256", Buffer.from(this.settings.accessKey, "base64"))
      .update(toSign)
      .digest("base64");

    let response: Response;
    try {
      response = await fetchWithCorrelation(
        url.toString(),
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-ms-date": date,
            "x-ms-content-sha256": contentHash,
            authorization: `HMAC-SHA256 SignedHeaders=x-ms-date;host;x-ms-content-sha256&Signature=${signature}`
          },
          body,
          signal: AbortSignal.timeout(SEND_TIMEOUT_MS)
        },
        { target: "acs" }
      );
    } catch {
      throw new EmailSendError("Azure Communication Services");
    }
    if (response.status !== 202) {
      throw new EmailSendError("Azure Communication Services", response.status);
    }
  }
}

// ── SMTP ────────────────────────────────────────────────────────────────────

export interface SmtpSettings {
  host: string;
  port: number;
  /** Implicit TLS from the first byte (465). Otherwise STARTTLS when offered (587). */
  secure: boolean;
  user: string;
  password: string;
  sender: string;
  senderName: string;
}

class SmtpTransport implements EmailTransport {
  readonly name = "smtp" as const;
  private readonly transporter: Transporter;

  constructor(private readonly settings: SmtpSettings) {
    this.transporter = createTransport({
      host: settings.host,
      port: settings.port,
      secure: settings.secure,
      auth: { user: settings.user, pass: settings.password },
      // Bounded, so a server that accepts the connection and then says nothing
      // cannot hold a send open indefinitely.
      connectionTimeout: SEND_TIMEOUT_MS,
      greetingTimeout: SEND_TIMEOUT_MS,
      socketTimeout: SEND_TIMEOUT_MS
    });
  }

  async send(message: OutboundEmail): Promise<void> {
    try {
      await this.transporter.sendMail({
        from: { name: this.settings.senderName, address: this.settings.sender },
        to: message.to,
        subject: message.subject,
        text: message.text,
        html: message.html
      });
    } catch (error) {
      // nodemailer's code and the server's reply code are what an operator can
      // act on — EAUTH/535 is a wrong password, ECONNECTION a wrong host or
      // port. Its message is not passed on: it can quote the server's reply.
      const { code, responseCode } = (error ?? {}) as { code?: string; responseCode?: number };
      throw new Error(
        `SMTP ${this.settings.host}:${this.settings.port} failed` +
          (code ? ` (${code})` : "") +
          (responseCode ? ` with reply ${responseCode}` : "")
      );
    }
  }
}

// ── Logging only ────────────────────────────────────────────────────────────

class LogTransport implements EmailTransport {
  readonly name = "log" as const;

  async send(message: OutboundEmail): Promise<void> {
    // The recipient and subject, never the body: the body holds a link that is
    // a credential until it is redeemed.
    apiLogger.info("email.not_sent", {
      reason: "EMAIL_PROVIDER is not configured; set it to graph or acs to deliver mail.",
      to: message.to,
      subject: message.subject
    });
  }
}

/**
 * Builds the transport the environment asks for.
 *
 * A provider named but half-configured falls back to `log` with an error at
 * startup, rather than crashing the API: mail is how a link reaches somebody,
 * not whether the product works, and the portal still shows every link.
 */
export function transportFromEnv(env: NodeJS.ProcessEnv = process.env): EmailTransport {
  const provider =
    env.EMAIL_PROVIDER?.trim().toLowerCase() || (env.EMAIL_HOST?.trim() ? "smtp" : "log");
  const sender = env.EMAIL_FROM?.trim() ?? "";
  const senderName = env.EMAIL_FROM_NAME?.trim() || "Grow Path";

  if (provider === "graph") {
    const settings = {
      tenantId: env.EMAIL_GRAPH_TENANT_ID?.trim() ?? "",
      clientId: env.EMAIL_GRAPH_CLIENT_ID?.trim() ?? "",
      clientSecret: env.EMAIL_GRAPH_CLIENT_SECRET?.trim() ?? "",
      sender
    };
    const missing = Object.entries(settings)
      .filter(([, value]) => !value)
      .map(([key]) => key);
    if (missing.length === 0) return new GraphTransport(settings);
    apiLogger.error("email.misconfigured", { provider, missing });
  } else if (provider === "acs") {
    const parsed = parseAcsConnectionString(env.EMAIL_ACS_CONNECTION_STRING ?? "");
    if (parsed && sender) return new AcsTransport({ ...parsed, sender, senderName });
    apiLogger.error("email.misconfigured", {
      provider,
      missing: [...(parsed ? [] : ["EMAIL_ACS_CONNECTION_STRING"]), ...(sender ? [] : ["EMAIL_FROM"])]
    });
  } else if (provider === "smtp") {
    const port = Number(env.EMAIL_PORT?.trim() || 587);
    const user = (env.EMAIL_USER ?? env.EMAIL_USERNAME)?.trim() ?? "";
    const settings: SmtpSettings = {
      host: env.EMAIL_HOST?.trim() ?? "",
      port,
      // 465 is implicit TLS; everything else upgrades with STARTTLS. Overridable
      // for the odd server that runs implicit TLS elsewhere.
      secure: env.EMAIL_SECURE ? env.EMAIL_SECURE.trim().toLowerCase() === "true" : port === 465,
      user,
      password: env.EMAIL_PASSWORD ?? "",
      // Most SMTP servers refuse a From that is not the signed-in account.
      sender: sender || user,
      senderName
    };
    const missing = [
      ...(settings.host ? [] : ["EMAIL_HOST"]),
      ...(Number.isInteger(port) && port > 0 ? [] : ["EMAIL_PORT"]),
      ...(settings.user ? [] : ["EMAIL_USER"]),
      ...(settings.password ? [] : ["EMAIL_PASSWORD"])
    ];
    if (missing.length === 0) return new SmtpTransport(settings);
    apiLogger.error("email.misconfigured", { provider, missing });
  } else if (provider !== "log") {
    apiLogger.error("email.misconfigured", { provider, reason: "unknown EMAIL_PROVIDER" });
  }

  if (env.NODE_ENV === "production") {
    apiLogger.warn("email.disabled", {
      reason: "No email provider is configured; invitation and reset links will not be emailed."
    });
  }
  return new LogTransport();
}
