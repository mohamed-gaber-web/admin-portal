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
> The access token that makes it possible now exists (US-022), so this is
> unblocked rather than waiting on anything.

### Sign-in (US-021)

```jsonc
POST /auth/login { "slug": "acme", "email": "ali@example.com", "password": "…" }
```

The slug is required because `user.email` is unique per tenant — one address may
exist in several tenants, so email alone is not an identity. The slug is a
*claim*, verified here, never a context.

**Every failure returns the same 401 with the same body**, in indistinguishable
time: wrong password, unknown email, unknown slug, an invited user who has not
set a password, a disabled user, and a soft-deleted tenant. Branches that stop
before verifying a password burn an equivalent Argon2id hash, so "no such user"
cannot be recognised by returning faster. The real cause is written to
`auth_event`, where only an operator sees it.

**Attempts are recorded outside the caller's control flow.** `authenticate`
returns a result rather than throwing, because callers run it in a transaction —
rejecting from inside rolled that transaction back and discarded the record of
the failed attempt, which is the one a security review asks about. The 401 is
raised after the commit.

### Access tokens (US-022)

A successful sign-in returns a signed access token alongside the identity:

```jsonc
{ "status": "authenticated", "user": {…}, "tenant": {…},
  "accessToken": "eyJ…", "tokenType": "Bearer", "expiresIn": 900 }
```

The token is the **only** thing that says which tenant a request belongs to.
`setRequestTenant()` is called from token verification and nowhere else, so the
tenant cannot come from a header, a query parameter or a route parameter — US-012's
rule, enforced at the edge. Anything a caller can type is something a caller can
iterate.

Claims are `sub`, `tenantId`, `tenantSlug`, `email` and `permissions`, signed
HS256 with `AUTH_JWT_SECRET`. Issuer and audience are checked as well as the
signature, so a token minted by another service sharing the key is not accepted.
A correctly signed token whose shape is wrong — no `tenantId`, say — is rejected
too: a signature proves the payload was not altered, not that it is what this
code expects.

**Fifteen minutes**, deliberately. Permissions are stamped in at sign-in rather
than joined per request, so the expiry is what bounds how long a revoked
permission keeps working. Sessions outlive it via refresh tokens, below.

### Refresh tokens (US-023)

```jsonc
POST /auth/refresh { "refreshToken": "…" }   // 200 -> a new access + refresh pair
```

Sign-in starts a **family**; every exchange mints a new token in that family and
marks the presented one used. A refresh token is therefore **single use** — the
one you just spent never works again.

**Presenting a spent token revokes the entire family**, not just that token.
Revoking only the replayed one would leave the thief's newer token working,
which is the whole failure this prevents. Whether it was the thief replaying a
copy or the legitimate user replaying one the thief already spent is unknowable
from here, so both are signed out and an `auth_event` records `token.replayed`
for review.

> **A double-submit signs the session out.** Two tabs racing the same token, or
> a client retrying a request whose response it lost, is indistinguishable from
> a replay — and the design deliberately resolves that ambiguity in favour of
> assuming theft. Clients must serialise their refresh calls. A grace window
> would soften this, at the cost of a window in which a stolen token works.

Only SHA-256 digests are stored, for the same reason as invitation tokens.
Nothing in `refresh_token` can be presented as a token, so read access to the
table does not yield a session.

Exchanges are serialised by a `FOR UPDATE` row lock. Without it two concurrent
exchanges would both read an unused token and both rotate, leaving two live
tokens in one family — after which the user's next call is indistinguishable
from a thief's.

Unknown, expired, revoked and replayed tokens all return one identical 401.
Telling a caller their token was *recognised but spent* confirms they hold a
real one.

### Multi-factor authentication (US-025)

```jsonc
POST /auth/mfa/enrol                                  // authenticated -> { secret, uri }
POST /auth/mfa/confirm { "code": "123456" }           // authenticated -> { recoveryCodes }
POST /auth/login       { … }                          // -> { status: "mfa_required", challengeToken }
POST /auth/mfa/verify  { "challengeToken": "…", "code": "…" }  // -> a full session
```

TOTP is implemented directly on `node:crypto` (RFC 6238 — HMAC-SHA1, 30-second
steps, six digits, ±1 step of drift). It is thirty lines, and a second factor is
a poor place to inherit someone else's supply chain.

**The shared secret is encrypted, not hashed.** Unlike a password or a refresh
token, the server must reproduce it to check a code, so a one-way digest is not
available — which makes `AUTH_MFA_KEY` the real security boundary. AES-256-GCM,
so a stored secret is authenticated as well as confidential: someone with write
access to the column cannot swap in a secret of their own. Production refuses to
start without the key. Recovery codes are the opposite case — nothing needs to
reproduce them, so only SHA-256 digests are kept, and each is single use.

**Sign-in returns a challenge, not a session.** On the `mfa_required` branch no
refresh token is created at all — not issued-and-withheld, not
issued-and-revoked. The challenge token carries a *different audience* from an
access token, so `verifyAccessToken` rejects it and it opens nothing but the
second-factor check. Five-minute life.

**A code cannot be replayed inside its own window.** A TOTP code is valid for a
period, so checking it alone would let it be reused for the rest of that period.
Each spent *time step* is recorded in `mfa_code_use`, unique on `(user_id,
step)` — the step, not the code, so the table holds nothing replayable if it
leaks, and the unique constraint rather than an application check is what makes
two simultaneous presentations resolve to one winner.

> **`ON CONFLICT`, not a caught exception.** A raised unique violation aborts the
> surrounding transaction, and every statement after it — including the
> `auth_event` recording the replay — fails too. That turns a correctly detected
> replay into a 500. This was a real bug, caught by the AC3 test.

Enrolment is two steps on purpose: minting a secret enables nothing, because
enabling on request would lock a user out the moment they asked to enrol, before
they had ever proved their app was configured. Re-enrolling an account that
already has MFA is a 409 rather than a silent replacement of the second factor.

### Password reset (US-024)

```jsonc
POST /auth/forgot-password { "slug": "acme", "email": "ali@example.com" }  // 202, always
POST /auth/reset-password  { "token": "…", "password": "…" }              // 200
```

**The request endpoint answers identically whether or not the account exists** —
same status, same body, for an unknown address, an unknown slug, and a user who
was invited but never accepted. This is the endpoint where an account list
usually leaks, so the status code is fixed as well as the body. What actually
happened goes to `auth_event`, where only an operator sees it.

> It is deliberately *not* audited to `audit_log`. Writing a row only when the
> account exists would make the audit log the enumeration oracle the response
> refuses to be.

Redeeming a link re-hashes the password with Argon2id, burns the token, burns
**every other outstanding reset link for that user**, and revokes **every
refresh token they hold** — a reset is what someone does when they believe the
account is compromised, so leaving a session alive would make it theatre. All of
it lands in one transaction, so a password can never change without its sessions
going with it.

Redeeming returns **no session**. The revocation that just happened would
otherwise have to exempt whoever triggered it; signing in again is also a check
that they know the password they just set.

Reset links live **one hour**, against an invitation's week: the link is a full
account takeover for as long as it lives, and the person asking for it is
sitting at their inbox now. Only SHA-256 digests are stored.

> **Production refuses to start without `AUTH_JWT_SECRET`.** Outside production
> it falls back to a visibly fake key named
> `insecure-development-only-signing-key-do-not-use-in-production`, and logs a
> warning. A silent fallback would make every token forgeable by anyone who has
> read this repository.

### Tenant-scoped routes

```jsonc
GET /companies         // the caller's own companies
GET /companies/:id     // 404 for another tenant's id — never 403
```

Neither takes a tenant. The handler runs inside `withRequestTenantScope`, which
reads the tenant from the token's claims and lets row level security do the
filtering — there is no `WHERE tenant_id` in the service to get wrong.

**404, never 403.** A 403 confirms the row exists, which turns an id into an
oracle for another tenant's data. A malformed id is a 404 for the same reason: a
400 would confirm the guess was at least well-formed.

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
