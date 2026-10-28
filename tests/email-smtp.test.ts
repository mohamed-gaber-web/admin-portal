import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server, type Socket } from "node:net";
import type { AddressInfo } from "node:net";
import { transportFromEnv } from "../apps/api/src/email/email.transport";

/**
 * The SMTP sender, against a minimal SMTP server that speaks just enough of the
 * protocol — EHLO, AUTH PLAIN/LOGIN, MAIL, RCPT, DATA — to record what arrived.
 *
 * A real socket rather than a mocked nodemailer: what is worth proving is that
 * the credentials and the message the server receives are the configured ones.
 */

const USER = "mailer@growpath.example";
const PASSWORD = "abcd efgh ijkl mnop";

interface Received {
  authUser: string | null;
  from: string | null;
  to: string[];
  data: string;
}

function startSmtpStub(): Promise<{ port: number; received: Received[]; stop: () => Promise<void> }> {
  const received: Received[] = [];

  const server: Server = createServer((socket: Socket) => {
    const mail: Received = { authUser: null, from: null, to: [], data: "" };
    let buffer = "";
    let inData = false;
    let loginStep: "user" | "pass" | null = null;
    let loginUser = "";
    const reply = (line: string) => socket.write(`${line}\r\n`);

    reply("220 stub ESMTP");
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      if (inData) {
        const end = buffer.indexOf("\r\n.\r\n");
        if (end === -1) return;
        mail.data = buffer.slice(0, end);
        buffer = buffer.slice(end + 5);
        inData = false;
        received.push({ ...mail, to: [...mail.to] });
        reply("250 queued");
      }
      let newline: number;
      while (!inData && (newline = buffer.indexOf("\r\n")) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 2);
        const upper = line.toUpperCase();

        if (loginStep === "user") {
          loginUser = Buffer.from(line, "base64").toString("utf8");
          loginStep = "pass";
          reply("334 UGFzc3dvcmQ6");
        } else if (loginStep === "pass") {
          loginStep = null;
          const ok = loginUser === USER && Buffer.from(line, "base64").toString("utf8") === PASSWORD;
          if (ok) mail.authUser = loginUser;
          reply(ok ? "235 accepted" : "535 bad credentials");
        } else if (upper.startsWith("EHLO") || upper.startsWith("HELO")) {
          socket.write("250-stub\r\n250 AUTH PLAIN LOGIN\r\n");
        } else if (upper.startsWith("AUTH PLAIN")) {
          const [, user, pass] = Buffer.from(line.slice(11).trim(), "base64").toString("utf8").split("\0");
          const ok = user === USER && pass === PASSWORD;
          if (ok) mail.authUser = user;
          reply(ok ? "235 accepted" : "535 bad credentials");
        } else if (upper.startsWith("AUTH LOGIN")) {
          loginStep = "user";
          reply("334 VXNlcm5hbWU6");
        } else if (upper.startsWith("MAIL FROM")) {
          mail.from = /<([^>]*)>/.exec(line)?.[1] ?? null;
          reply("250 ok");
        } else if (upper.startsWith("RCPT TO")) {
          mail.to.push(/<([^>]*)>/.exec(line)?.[1] ?? "");
          reply("250 ok");
        } else if (upper === "DATA") {
          inData = true;
          reply("354 go ahead");
        } else if (upper === "QUIT") {
          reply("221 bye");
          socket.end();
        } else {
          reply("250 ok");
        }
      }
    });
  });

  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({
        port: (server.address() as AddressInfo).port,
        received,
        stop: () => new Promise((done) => server.close(() => done()))
      })
    )
  );
}

describe("email - SMTP", () => {
  let stub: Awaited<ReturnType<typeof startSmtpStub>>;

  beforeAll(async () => {
    stub = await startSmtpStub();
  });

  afterAll(async () => {
    await stub.stop();
  });

  const env = (overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
    EMAIL_HOST: "127.0.0.1",
    EMAIL_PORT: String(stub.port),
    EMAIL_USER: USER,
    EMAIL_PASSWORD: PASSWORD,
    EMAIL_FROM_NAME: "Grow Path",
    ...overrides
  });

  it("is chosen by EMAIL_HOST alone, with no EMAIL_PROVIDER", () => {
    expect(transportFromEnv(env()).name).toBe("smtp");
  });

  it("falls back to logging, rather than failing, when the username is missing", () => {
    expect(transportFromEnv(env({ EMAIL_USER: "" })).name).toBe("log");
  });

  it("signs in with the configured account and delivers the message", async () => {
    await transportFromEnv(env()).send({
      to: "person@example.com",
      subject: "Reset your Grow Path password",
      text: "plain body",
      html: "<p>html body</p>"
    });

    const mail = stub.received.at(-1)!;
    expect(mail.authUser).toBe(USER);
    // No EMAIL_FROM: the signed-in account sends, which most servers require.
    expect(mail.from).toBe(USER);
    expect(mail.to).toEqual(["person@example.com"]);
    expect(mail.data).toContain("Subject: Reset your Grow Path password");
    expect(mail.data).toMatch(/From: "?Grow Path"? <mailer@growpath\.example>/);
  });

  it("reports a wrong password by its SMTP code, without the password", async () => {
    const send = transportFromEnv(env({ EMAIL_PASSWORD: "wrong-password" })).send({
      to: "person@example.com",
      subject: "x",
      text: "x",
      html: "x"
    });
    await expect(send).rejects.toThrow(/EAUTH|535/);
    await send.catch((error: Error) => expect(error.message).not.toContain("wrong-password"));
  });
});
