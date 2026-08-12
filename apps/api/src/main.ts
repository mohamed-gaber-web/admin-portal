import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { apiLogger } from "./observability/logger";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  // So the connection pool is closed on SIGTERM/SIGINT rather than leaking
  // connections that keep a test database undroppable.
  app.enableShutdownHooks();
  const port = process.env.PORT ? Number(process.env.PORT) : 3000;
  await app.listen(port);
  apiLogger.info("api.listening", { port });
}

void bootstrap();
