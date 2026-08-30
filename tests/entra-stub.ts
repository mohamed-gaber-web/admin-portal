import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";

/**
 * A stand-in for the Entra token endpoint.
 *
 * The connection tests have to exercise the real code path — assemble the token
 * URL from stored fields, open the sealed secret, POST it, classify the answer —
 * without a Microsoft directory to point at. This is that directory, and it is
 * deliberately a real HTTP server rather than a mocked `fetch`: the thing most
 * worth proving is that the secret which arrives on the wire is the one that was
 * stored, and a mock that intercepts the call cannot show that.
 *
 * `D365_AUTHORITY_ORIGIN_OVERRIDE` points the API here. The API refuses that
 * variable in production, so this seam cannot be used anywhere it would matter.
 */

export interface TokenRequest {
  grantType: string | null;
  clientId: string | null;
  clientSecret: string | null;
  scope: string | null;
  /** The path, which carries the directory id the API assembled. */
  path: string;
}

export interface EntraStub {
  origin: string;
  /** Every exchange attempted, in order. Assert on what actually travelled. */
  requests: TokenRequest[];
  /**
   * Register a credential pair the directory will accept. Anything else is
   * rejected the way Entra rejects a wrong secret.
   */
  accept: (clientId: string, clientSecret: string) => void;
  /** Force the next answers, for the failure classifications. */
  rejectWith: (body: { error?: string; error_description?: string }, status?: number) => void;
  /** Back to normal credential checking. */
  reset: () => void;
  stop: () => Promise<void>;
}

export async function startEntraStub(): Promise<EntraStub> {
  const accepted = new Map<string, string>();
  const requests: TokenRequest[] = [];
  let forcedRejection: { body: object; status: number } | null = null;

  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      const form = new URLSearchParams(raw);
      requests.push({
        grantType: form.get("grant_type"),
        clientId: form.get("client_id"),
        clientSecret: form.get("client_secret"),
        scope: form.get("scope"),
        path: req.url ?? ""
      });

      const answer = (status: number, body: object): void => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };

      if (forcedRejection) {
        answer(forcedRejection.status, forcedRejection.body);
        return;
      }

      const clientId = form.get("client_id") ?? "";
      const secret = form.get("client_secret") ?? "";

      if (accepted.get(clientId) === secret) {
        // Shaped like a real answer, including the token, so nothing downstream
        // is accidentally tolerant of a response that omits it.
        answer(200, { token_type: "Bearer", expires_in: 3599, access_token: "stub.token.value" });
        return;
      }

      answer(401, {
        error: "invalid_client",
        error_description:
          "AADSTS7000215: Invalid client secret provided. Trace ID: 00000000-0000-0000-0000-000000000000"
      });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    accept: (clientId, clientSecret) => accepted.set(clientId, clientSecret),
    rejectWith: (body, status = 400) => {
      forcedRejection = { body, status };
    },
    reset: () => {
      forcedRejection = null;
    },
    stop: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve()))
      )
  };
}
