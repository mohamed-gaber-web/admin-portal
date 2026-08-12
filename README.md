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

### Automatic tenant scoping

Application code does not choose a tenant. `withRequestTenantScope(pool, fn)`
takes the tenant from the authenticated request context, drops the session to
`app_user` and sets `app.tenant_id` for the transaction — so every query on that
client is filtered by the database.

```ts
const companies = await withRequestTenantScope(pool, (client) =>
  client.query("SELECT * FROM company")   // no WHERE tenant_id, and none needed
);
```

There is deliberately **no `tenantId` parameter**. A parameter can be fed from a
header or a route param, and if a header can set the tenant, someone will
iterate it. The tenant is set by authentication via `setRequestTenant()` and
read from nowhere else. With no tenant in context the call **throws** rather
than running unscoped — forgetting authentication is an error, not a
cross-tenant read.

A deliberate bypass goes through the escape hatch, which demands a reason and
logs every use with the request's correlation ID:

```ts
await withoutTenantScope(pool, { reason: "Cross-tenant billing rollup" }, fn);
// -> {"level":"warn","msg":"tenant.scope.bypassed","reason":"...","correlationId":"..."}
```

Tenant provisioning (`POST /tenants`) is the one path that uses it today: the
tenant being created is the one there is no context for yet.

### Logging

`@growpath/observability` provides structured JSON logging. Every line carries
`correlationId`, `tenantId` and `userId` from the request context automatically —
present even when null, so "unknown" is a visible fact rather than a missing key.

```ts
apiLogger.info("tenant.provisioned", { slug });
```

The correlation ID comes from an inbound `x-correlation-id` when it is
well-formed (it is caller-controlled text that lands in every line for that
request), otherwise one is generated; either way it is echoed back on the
response. Downstream calls join the same trace via `fetchWithCorrelation()`,
which is how the D365 client in Sprint 5 should make every call.

**Secrets never reach the log.** Fields are redacted by key using the same rule
as the audit log, and nothing serialises a request body or header bag — there is
no `log(req)`. Logged URLs keep the path and drop the query string, because no
key-based rule can redact a token once it is flattened into a URL.

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

### Health and readiness

Two endpoints answering two different questions. Do not merge them.

| Endpoint | Question | Checks | Codes |
| -------- | -------- | ------ | ----- |
| `GET /health` | Is this process wedged? | Nothing downstream | 200 |
| `GET /health/ready` | Should traffic come here? | Postgres + Redis | 200 / 503 |

Point the orchestrator's **liveness** probe at `/health` and its **readiness**
probe at `/health/ready`. If liveness checked Postgres, a database blip would
fail it on every instance at once and the orchestrator would restart the whole
fleet — a restart cannot fix a dependency that is down, so the outage gets worse
rather than better. Readiness is where "the database is unreachable" belongs: it
pulls the instance out of rotation and puts it back when the dependency returns.

```jsonc
// 503
{ "status": "not_ready", "checks": { "database": "up", "redis": "down" } }
```

`up`, `down` or `not_configured` per dependency, and **nothing else**. The
endpoint is unauthenticated — orchestrators cannot present credentials — so
everything it returns is public: no driver message, host, port, credentials or
stack trace. The cause is logged instead, with the request's correlation ID, so
an operator can still diagnose it from somewhere access-controlled.

Checks run concurrently, each capped at 2s. A probe that can hang is worse than
one that fails: the orchestrator's own timeout fires instead, so the instance is
reported unhealthy later than it needed to be.

**`REDIS_URL` is required in production only.** The local stack does not run
Redis, so leaving it unset reports `not_configured` and readiness still passes;
with `NODE_ENV=production` an unset `REDIS_URL` is a misconfiguration and
readiness returns 503 — a dependency nobody configured is a dependency nobody is
checking. Azure Redis Cache is TLS-only, so staging and production use
`rediss://`.

### Authentication schema (sprint S3)

Local passwords with **Argon2id**, not Entra ID. `user.email` is unique per
tenant, so an address alone does not identify a person and **sign-in supplies the
tenant slug**:

```jsonc
POST /auth/login { "slug": "acme", "email": "ali@example.com", "password": "…" }
```

A bad slug, an unknown email and a wrong password must be indistinguishable in
both message and response time.

| Table | Holds |
| ----- | ----- |
| `user.password_hash` etc. | Credential, status, lockout counters, TOTP secret |
| `role_permission` | Joins roles to the permission catalogue |
| `user_invitation` | Hashed, expiring invitation tokens |
| `refresh_token` | Rotation families, hashed, with replay detection |
| `auth_event` | Every sign-in attempt, including tenantless ones |

Nothing stores a usable credential: passwords are Argon2id digests, invitation
and refresh tokens are stored hashed. A user is `invited` until it accepts one,
and `status = 'active'` with no `password_hash` is rejected by a check
constraint rather than surfacing later as a confusing login bug.

**`auth_event` exists because `audit_log.tenant_id` is NOT NULL.** A failed
sign-in for an address belonging to no tenant is exactly the event a security
review asks about, and it cannot be written to a table that demands a tenant. So
`auth_event.tenant_id` is nullable, its reads are tenant-scoped, and its writes
deliberately are not — authentication runs before a tenant is in the session, and
a write policy keyed on `current_tenant_id()` would make the failed case
unrecordable. Rows are append-only.

### Invitations (US-020)

Provisioning creates a tenant's first admin **with no credential**, so a new
tenant used to contain nobody who could ever sign in. `POST /tenants` now issues
that admin an invitation and returns the link once:

```jsonc
// 201
{
  "tenant": { … }, "adminUser": { … }, "roles": [ … ],
  "invitation": { "id": "…", "expiresAt": "…", "token": "…" }  // shown once
}
```

The invitee redeems it unauthenticated — they have no credential yet, which is
the point, and the token is what resolves the tenant:

```jsonc
POST /auth/accept-invitation { "token": "…", "password": "…" }  // 200
```

Two different hashes, for two different reasons. The **password** is Argon2id
(19 MiB, t=2, p=1) because it is human-chosen and therefore guessable, so the
cost per guess is the defence. The **token** is a SHA-256 digest because it is
256 random bits — there is nothing to guess, and a 19 MiB hash on an
unauthenticated lookup path would be a denial-of-service lever.

Unknown, expired, already-accepted and disabled-user tokens are refused through
one path with one error type, taking the same time — a per-reason error class is
how "already used" leaks that the token was real.

> **Not yet built:** an admin-facing *invite a colleague* endpoint. It needs
> authentication to know who is inviting and into which tenant; shipping it
> unauthenticated would let anyone invite themselves into any tenant and accept.
> It lands with US-022.

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

A **mutating** route (`POST`, `PUT`, `PATCH`, `DELETE`) additionally needs an
`audits` list naming the audit actions it writes:

```ts
{
  method: "PATCH", path: "/connections/:id", visibility: "tenant-scoped",
  note: "...",
  audits: ["connection.updated"]
}
```

CI checks each name against the `recordAuditEntry({ action: "..." })` calls in
the source, and checks the reverse — an action written in the source that no
route claims must be listed in `NON_ROUTE_AUDIT_ACTIONS` with a reason. So a
route cannot claim an audit it does not write, and cannot quietly drop one it
does.

Deciding *not* to audit a mutation is allowed, but not silently: set
`audits: []` together with a `noAuditReason`.

This exists because a missing audit call fails silently — the endpoint works and
its own tests pass, while the compliance answer is absent forever, since history
you never recorded cannot be backfilled.

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
