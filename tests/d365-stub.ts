import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";

/**
 * A stand-in for a customer's D365 instance.
 *
 * The companion to `entra-stub.ts`, and a real HTTP server for the same reason
 * that one is: what the proxy suite most needs to prove is *what travels on the
 * wire* — that the ERP is presented a token the device never held, that the
 * caller's own JWT is not forwarded, and that an OData `$filter` survives the
 * hop byte for byte. A mocked `fetch` asserts on the arguments our own code
 * assembled, which is the thing under test rather than the evidence.
 *
 * No environment override is needed to point the proxy here. `d365_environment.url`
 * is a plain `text` column with no CHECK constraint, so a fixture writes this
 * server's origin into the row and the real resolution path runs unmodified.
 */

export interface RecordedRequest {
  method: string;
  /** Path and query exactly as received, undecoded. */
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

export interface D365Stub {
  origin: string;
  /** Every request that arrived, in order. Assert on what actually travelled. */
  requests: RecordedRequest[];
  /** Answer the next request with this status and body, once. */
  answerOnce: (status: number, body: unknown, headers?: Record<string, string>) => void;
  /** Answer every request with this status and body until reset. */
  answerWith: (status: number, body: unknown, headers?: Record<string, string>) => void;
  /** Back to the default 200 `{ value: [] }`. */
  reset: () => void;
  stop: () => Promise<void>;
}

interface Answer {
  status: number;
  body: unknown;
  headers: Record<string, string>;
}

const DEFAULT: Answer = { status: 200, body: { value: [] }, headers: {} };

export async function startD365Stub(): Promise<D365Stub> {
  const requests: RecordedRequest[] = [];
  const queued: Answer[] = [];
  let standing: Answer = DEFAULT;

  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      requests.push({
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body: raw
      });

      const answer = queued.shift() ?? standing;
      res.writeHead(answer.status, {
        "content-type": "application/json",
        ...answer.headers
      });
      res.end(typeof answer.body === "string" ? answer.body : JSON.stringify(answer.body));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    answerOnce: (status, body, headers = {}) => queued.push({ status, body, headers }),
    answerWith: (status, body, headers = {}) => {
      standing = { status, body, headers };
    },
    reset: () => {
      queued.length = 0;
      standing = DEFAULT;
    },
    stop: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve()))
      )
  };
}
