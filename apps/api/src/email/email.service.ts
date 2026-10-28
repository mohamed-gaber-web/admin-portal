import { Injectable } from "@nestjs/common";
import { apiLogger } from "../observability/logger";
import { invitationEmail, passwordResetEmail } from "./email.templates";
import { transportFromEnv, type EmailTransport, type OutboundEmail } from "./email.transport";

/**
 * Sends the installation's mail: invitations and password reset links.
 *
 * ### Never in the way
 *
 * Every method is fire-and-forget and cannot throw. The invitation or reset
 * already exists when this is called — it was committed by the caller — and a
 * mail provider being down must not turn a successful operation into a failed
 * request. The portal still shows the operator every link it issues, so a
 * message that did not arrive has a fallback that does not involve this class.
 *
 * Not awaiting is also what keeps `POST /auth/forgot-password` uniform: an
 * address with an account would otherwise answer a provider round-trip slower
 * than one without, which is an enumeration oracle measured in milliseconds.
 *
 * ### Never the link in the log
 *
 * A failure logs the recipient, the kind of message and the provider's status.
 * Never the body: until it is redeemed, the link inside it is a credential.
 */
@Injectable()
export class EmailService {
  private readonly transport: EmailTransport = transportFromEnv();

  /** The portal's public address, which every link in a message points at. */
  private readonly portalUrl: string | null = portalUrlFromEnv();

  constructor() {
    apiLogger.info("email.configured", {
      provider: this.transport.name,
      portalUrl: this.portalUrl ?? "(unset)"
    });
  }

  /** An invitation to accept, for a new user or a tenant's first administrator. */
  sendInvitation(input: {
    to: string;
    token: string;
    expiresAt: Date | string;
    workspaceName?: string | null;
    name?: string | null;
  }): void {
    const link = this.link("/accept-invitation", input.token);
    if (!link) return;
    this.dispatch(input.to, "invitation", () =>
      invitationEmail({
        link,
        expiresAt: new Date(input.expiresAt),
        workspaceName: input.workspaceName,
        name: input.name
      })
    );
  }

  /** A link to choose a new password, self-service or issued by an operator. */
  sendPasswordReset(input: { to: string; token: string; expiresAt: Date | string }): void {
    const link = this.link("/reset-password", input.token);
    if (!link) return;
    this.dispatch(input.to, "password_reset", () =>
      passwordResetEmail({ link, expiresAt: new Date(input.expiresAt) })
    );
  }

  private link(path: string, token: string): string | null {
    if (!this.portalUrl) {
      apiLogger.warn("email.skipped", {
        reason: "PORTAL_URL is not set, so there is no address to put in the link."
      });
      return null;
    }
    return `${this.portalUrl}${path}?token=${encodeURIComponent(token)}`;
  }

  private dispatch(to: string, kind: string, build: () => OutboundEmail): void {
    // `admin@<slug>.local` is what provisioning invents when no admin address
    // was given. It reaches nobody, and a provider would bounce it against the
    // sender's reputation.
    if (to.trim().toLowerCase().endsWith(".local")) {
      apiLogger.info("email.skipped", { kind, reason: "placeholder .local address" });
      return;
    }
    const message: OutboundEmail = { ...build(), to };
    void this.transport.send(message).then(
      () => {
        // The log transport has already said it sent nothing; "sent" here
        // would contradict it.
        if (this.transport.name !== "log") {
          apiLogger.info("email.sent", { kind, to, provider: this.transport.name });
        }
      },
      (error: unknown) =>
        apiLogger.error("email.failed", {
          kind,
          to,
          provider: this.transport.name,
          reason: error instanceof Error ? error.message : "unknown"
        })
    );
  }
}

/**
 * `PORTAL_URL`, or the first `PORTAL_ORIGIN` when it is not set — that list is
 * already the portal's address for CORS, and asking for it twice invites the
 * two to disagree. No trailing slash, so paths concatenate predictably.
 */
function portalUrlFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = env.PORTAL_URL?.trim();
  const fromOrigins = env.PORTAL_ORIGIN?.split(",")
    .map((origin) => origin.trim())
    .find(Boolean);
  const value = explicit || fromOrigins;
  return value ? value.replace(/\/+$/, "") : null;
}
