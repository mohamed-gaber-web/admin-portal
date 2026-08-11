# Grow Path Admin — Monorepo

pnpm workspaces + Turborepo monorepo housing the API, admin portal, and shared contracts so they stay in step.

## Structure

| Path                  | What it is                                  |
| --------------------- | ------------------------------------------- |
| `apps/api`            | NestJS API (exposes `/health`)              |
| `apps/portal`         | Angular admin portal                        |
| `packages/contracts`  | Shared TypeScript contracts (types + routes) |
| `packages/db`         | Migrations, connection pool, and demo seed data |

## Prerequisites

- Node.js >= 20
- pnpm 9 (`corepack enable`)
- PostgreSQL 16 running locally (matches the `postgres:16` image CI uses)

## Getting started

```bash
pnpm install
createdb growpath_dev   # or: psql -c "CREATE DATABASE growpath_dev"
cp .env.example .env    # then set DATABASE_URL to your local Postgres
pnpm bootstrap          # check Postgres -> run migrations -> seed demo data
pnpm dev
```

`pnpm bootstrap` is safe to re-run: the seed is idempotent, so it never duplicates
rows. If Postgres isn't reachable it stops at the first step with a message
saying what to fix, rather than failing midway through a migration.

### Tenancy hierarchy

```
tenant ──< d365_environment ──< company (dataAreaId)
```

One tenant holds several D365 environments (PROD, UAT); each environment holds
several legal entities. These are three distinct levels — collapsing them is the
most expensive modelling mistake available here. `company` carries both
`tenant_id` and `environment_id`, kept consistent by a composite foreign key
rather than by application discipline.

Tenants are **soft-deleted** (`deleted_at`): children are left in place, so a
restore is a genuine recovery rather than a re-creation.

### Tenant isolation (row level security)

Every tenant table carries a `tenant_isolation` policy keyed on
`current_tenant_id()`, which reads the `app.tenant_id` session setting. Scope a
transaction with `withTenantContext(client, tenantId, fn)`; with no context set
the function returns NULL and **zero rows** come back, so the safe state is the
default one.

This catches raw SQL that bypasses the application's own filtering — the
analytics queries coming in later sprints. Application-level `WHERE` clauses are
not the boundary; these policies are.

> **Deployment requirement:** the application must connect as `app_user`, never
> as a superuser. **Superusers bypass RLS unconditionally** and every policy
> here becomes decorative. The migration creates `app_user` with `NOLOGIN` and
> no password — granting `LOGIN` and credentials is an ops step, deliberately
> not baked into a migration.

Seeding and platform-admin work run as the admin user and bypass RLS by design.
A new tenant table with no policy is reported by `findTablesMissingRlsPolicies()`
and fails CI.

### Audit log

`audit_log` is append-only. Write entries with `recordAuditEntry()`, never with
a raw INSERT — it captures actor, action, target, before/after values, changed
fields, IP and timestamp, and redacts secrets on the way in.

```ts
await recordAuditEntry(client, {
  tenantId, action: "connection.updated", entityType: "d365_environment", entityId,
  actor: { label: "platform-admin", userId, ip },
  before: { clientSecret: oldValue },   // stored as "[redacted]"
  after:  { clientSecret: newValue }    // changed_fields still names it
});
```

Secret-looking keys (`secret`, `password`, `token`, `credential`, `apiKey`,
`authorization`, `cookie`, `private_key`) are redacted recursively. The diff is
computed **before** redaction, so an entry records *that* a secret changed
without ever storing what it changed to.

`UPDATE`, `DELETE` and `TRUNCATE` are rejected by triggers, which apply to
superusers and table owners as privilege revocation does not. Deleting a tenant
or user that has audit history is refused by foreign key.

> **This is tamper-resistant, not tamper-proof.** A superuser can still
> `DISABLE TRIGGER` or drop them. Real immutability means shipping entries to
> append-only storage outside this database.

### Adding an API route

Every route must be classified in `tests/route-manifest.ts` as `public`,
`platform` or `tenant-scoped`. CI fails on any route a controller declares that
the manifest does not list, and on any manifest entry no controller declares.

A `tenant-scoped` route additionally needs an isolation test under
`tests/isolation/` declaring the route it covers:

```ts
describe(coversRoute("GET /companies/:id"), () => {
  it("returns 404, not 403, for another tenant's company", async () => { /* ... */ });
});
```

**404, never 403** — a 403 confirms the resource exists, which is itself a leak.

### Demo data

The seed creates **two** tenants — `acme` and `globex` — each with a D365
environment, companies, users, roles and audit entries. Two, not one, because
every tenant-isolation test needs a second tenant to prove a query cannot reach
across the boundary.

The `DATABASE_URL` account needs `CREATEDB` rights: the tests create and drop
throwaway databases.

## Commands

```bash
pnpm install      # install every workspace
pnpm bootstrap        # one-command local setup (preflight, migrate, seed)
pnpm dev          # start API and portal together (turbo)
pnpm build        # build all workspaces (dependents rebuild via turbo)
pnpm lint         # eslint across every workspace
pnpm typecheck    # tsc --noEmit across every workspace
pnpm test         # acceptance-criterion tests (vitest)
pnpm db:preflight # check Postgres is reachable
pnpm db:migrate   # run migrations up
pnpm db:rollback  # roll back the most recent migration
pnpm seed         # seed demo tenants (idempotent)
```

## CI

`.github/workflows/ci.yml` runs on every pull request as independent jobs — `lint`, `typecheck`, `test` (with a throwaway Postgres), `build`, and `db-migrations` — aggregated by a single `ci-success` gate job. Add future guard-rail jobs and list them in the gate's `needs`.

### Branch protection (blocks merges on failing checks)

Merge-blocking is enforced by GitHub branch protection requiring the `ci-success` check. Desired state lives in `.github/branch-protection.json`; apply it once per repo (needs admin + `gh` authenticated):

```bash
gh api -X PUT repos/:owner/:repo/branches/main/protection \
  --input .github/branch-protection.json
```
