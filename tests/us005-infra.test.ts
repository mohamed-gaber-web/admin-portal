import { describe, it, expect } from "vitest";
import { readText } from "./helpers";

const moduleMain = readText("infra/modules/environment/main.tf");
const moduleVars = readText("infra/modules/environment/variables.tf");
const devMain = readText("infra/environments/dev/main.tf");
const stagingMain = readText("infra/environments/staging/main.tf");
const devBackend = readText("infra/environments/dev/backend.tf");
const stagingBackend = readText("infra/environments/staging/backend.tf");

describe("US-005 - dev and staging infrastructure as code", () => {
  // AC1: Given the IaC definitions, when applied, then app hosting, Postgres,
  // Redis and the secret vault exist.
  it("AC1: the environment module declares app hosting, Postgres, Redis and a secret vault", () => {
    const required = [
      'resource "azurerm_service_plan"', // app hosting (plan)
      'resource "azurerm_linux_web_app"', // app hosting (app)
      'resource "azurerm_postgresql_flexible_server"', // Postgres
      'resource "azurerm_redis_cache"', // Redis
      'resource "azurerm_key_vault"' // secret vault
    ];
    for (const decl of required) {
      expect(moduleMain, `module must declare ${decl}`).toContain(decl);
    }
  });

  // AC2: Given a teardown, when re-applied, then the environment is identical.
  it("AC2: both environments come from one module, parameterized, with remote state", () => {
    // Same single source of truth for both environments -> identical shape.
    const moduleSource = /source\s*=\s*"\.\.\/\.\.\/modules\/environment"/;
    expect(devMain).toMatch(moduleSource);
    expect(stagingMain).toMatch(moduleSource);

    // Region is a variable, not hardcoded (the blocking data-residency decision),
    // and has no default so it must be set explicitly and consistently.
    const locationFromVar = /location\s*=\s*var\.location/;
    expect(moduleMain).toMatch(locationFromVar);
    expect(devMain).toMatch(locationFromVar);
    expect(stagingMain).toMatch(locationFromVar);
    const locationVarBlock = moduleVars
      .split(/variable\s+"/)
      .find((b) => b.startsWith("location"));
    expect(locationVarBlock, "module must declare a location variable").toBeDefined();
    // No `default = ...` argument -> the region must be set explicitly (blocking decision).
    expect(locationVarBlock).not.toMatch(/default\s*=/);

    // Remote state in both environments -> reproducible, shared, locked state.
    expect(devBackend).toContain('backend "azurerm"');
    expect(stagingBackend).toContain('backend "azurerm"');
    expect(devBackend).toContain("dev.terraform.tfstate");
    expect(stagingBackend).toContain("staging.terraform.tfstate");
  });
});
