import "reflect-metadata";
import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { API_ROUTES } from "@growpath/contracts";
import { AppModule } from "../apps/api/src/app.module";
import { readJson, type PackageJson } from "./helpers";

// AC1: Given a clean clone, when I run the install and dev commands,
// then API and portal both start.
describe("AC1 - install + dev starts API and portal", () => {
  let app: INestApplication | undefined;

  afterAll(async () => {
    await app?.close();
  });

  it("boots the API and serves the /health endpoint", async () => {
    app = await NestFactory.create(AppModule, { logger: false });
    await app.init();

    const res = await request(app.getHttpServer()).get(API_ROUTES.health);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok", service: "api" });
  });

  it("wires `dev` to start both the API and the portal", () => {
    const root = readJson<PackageJson>("package.json");
    const api = readJson<PackageJson>("apps/api/package.json");
    const portal = readJson<PackageJson>("apps/portal/package.json");

    // Root `dev` fans out across workspaces via turbo.
    expect(root.scripts?.dev).toContain("turbo run dev");
    // Each app exposes its own `dev` so turbo can start both.
    expect(api.scripts?.dev).toBeTruthy();
    expect(portal.scripts?.dev).toBeTruthy();
  });
});
