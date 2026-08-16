import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import helmet from "helmet";
import { loadRepoEnv } from "@growpath/db";
import { AppModule } from "./app.module";
import { apiLogger } from "./observability/logger";
import { CORRELATION_ID_HEADER } from "@growpath/observability";

/**
 * Loads the repo-root `.env`, if there is one and nothing has set DATABASE_URL.
 *
 * The migration CLIs went through `scripts/with-env.mjs` for this while the API
 * did not, so `pnpm dev` started the portal and then failed the API with
 * "DATABASE_URL is not set" — the one command a new contributor runs first.
 * `with-env.mjs` cannot be reused here: it forces cwd to the repo root, and
 * `nest start` has to run inside `apps/api` to find its own config.
 *
 * Called before anything imports a pool, and before `AppModule` is constructed.
 * An already-exported variable always wins, so this changes nothing in CI or in
 * production, where the environment comes from the platform and no .env exists.
 */
loadRepoEnv();

/**
 * Origins allowed to call this API with credentials.
 *
 * Comma-separated PORTAL_ORIGIN, defaulting to the Angular dev server. There is
 * deliberately no wildcard fallback: `origin: true` reflects whatever Origin
 * the caller sends, which combined with credentials means any site a signed-in
 * admin visits can call this API as them. That matters from the moment auth
 * issues a cookie or token (S3), so the default is a list, not a reflection.
 */
function allowedOrigins(): string[] {
  const configured = process.env.PORTAL_ORIGIN?.trim();
  if (configured) {
    return configured
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean);
  }
  return ["http://localhost:4200"];
}

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);

  // Security headers. contentSecurityPolicy is off because this process serves
  // JSON, not documents — a CSP here protects nothing and the portal sets its
  // own. HSTS is left on: staging and production terminate TLS in front.
  app.use(helmet({ contentSecurityPolicy: false }));

  const origins = allowedOrigins();
  app.enableCors({
    origin: origins,
    // The portal is a separate origin, so sign-in cannot work without this.
    credentials: true,
    // Echoed so a browser client can send and read the correlation ID, which is
    // what makes a support ticket traceable back to a log line.
    allowedHeaders: ["content-type", "authorization", CORRELATION_ID_HEADER],
    exposedHeaders: [CORRELATION_ID_HEADER]
  });

  // So the connection pool is closed on SIGTERM/SIGINT rather than leaking
  // connections that keep a test database undroppable.
  app.enableShutdownHooks();
  const port = process.env.PORT ? Number(process.env.PORT) : 3000;
  await app.listen(port);
  apiLogger.info("api.listening", { port, corsOrigins: origins });
}

void bootstrap();
