# Deploying to Railway + Vercel

Three pieces: a Postgres database and the NestJS API on **Railway**, and the
Angular portal on **Vercel**.

## Why this split

The API is a long-lived process, not a function. It holds a `pg` connection pool
and does `SET LOCAL ROLE app_user` per transaction — that is what makes row level
security apply, and it only works if the transaction, the role and the pool
survive together. Vercel's serverless functions recycle between invocations and
would open a pool per cold start, so the API belongs on Railway beside its
database. The portal is static files after `ng build`, which is exactly what
Vercel is for.

## 1. Database (Railway)

Add a **PostgreSQL** service. Railway provisions it with a `postgres` superuser
and exposes `DATABASE_URL` as a service variable.

Nothing else to configure. The migrations create the `app_user` role themselves,
and the connecting superuser can `SET ROLE` to it — which is what the API does
per transaction. RLS still applies, because after `SET ROLE app_user` the current
role is no longer a superuser.

## 2. API (Railway)

Add a service from this repo. `railway.json` in the repo root already sets the
build, start and healthcheck; you only need the variables.

```
Build   pnpm install --frozen-lockfile && pnpm --filter @growpath/api... build
Start   pnpm --filter @growpath/db migrate:up && node apps/api/dist/main.js
Health  /health
```

Migrations run on every deploy, before the server starts. They are idempotent —
`node-pg-migrate` skips what is already recorded in `pgmigrations`.

### Variables

| Variable | Value | Notes |
| --- | --- | --- |
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` | Railway reference variable — do not paste a literal. |
| `NODE_ENV` | `production` | Makes the three secrets below fatal if unset, instead of silently faked. |
| `AUTH_JWT_SECRET` | 32+ random chars | Signs access tokens. Unset in production is fatal — a fallback would make every token forgeable by anyone who has read the repo. |
| `AUTH_MFA_KEY` | 32+ random chars | Encrypts TOTP secrets. Rotating it makes every enrolled user enrol again. |
| `SECRET_ENCRYPTION_KEY` | 32+ random chars | Seals D365 client secrets. Rotating it makes every stored connection fail until each secret is re-entered. |
| `PORTAL_ORIGIN` | `https://<your>.vercel.app` | Belt and braces — see the CORS note below. |
| `REDIS_URL` | `${{Redis.REDIS_URL}}` | **Only if you add a Redis service.** See the warning below. |

Generate the three keys:

```bash
node -e "for(const k of ['AUTH_JWT_SECRET','AUTH_MFA_KEY','SECRET_ENCRYPTION_KEY'])console.log(k+'='+require('crypto').randomBytes(48).toString('base64url'))"
```

Keep them in Railway only. They are separate keys on purpose: three blast radii
rather than one, so rotating the D365 key does not touch anybody's MFA.

> **Health check must be `/health`, not `/health/ready`.**
> With `NODE_ENV=production`, readiness treats an unset `REDIS_URL` as a
> misconfiguration and returns **503**. If you point Railway's healthcheck at
> `/health/ready` without adding a Redis service, every deploy fails and rolls
> back with a healthy API. `railway.json` uses `/health` (liveness). Add Redis
> and switch to `/health/ready` when you want the stricter check.

## 3. Portal (Vercel)

Import the repo. `vercel.json` in the root sets everything except the API URL.

```
Build     pnpm --filter @growpath/portal... build
Install   pnpm install --frozen-lockfile
Output    apps/portal/dist/browser
Framework Other
```

**Edit `vercel.json` and replace the placeholder** with your Railway public
domain:

```json
{ "source": "/api/:path*", "destination": "https://REPLACE-ME.up.railway.app/:path*" }
```

### Why the `/api` prefix exists

The portal calls `/api/auth/login`; Vercel rewrites that to
`https://<railway>/auth/login`. Two consequences worth knowing:

- **No CORS.** The browser only ever talks to the Vercel origin. Vercel proxies
  server-side, so there is no preflight and no cross-origin token handling.
  `PORTAL_ORIGIN` is then belt and braces rather than load-bearing — set it
  anyway, so a direct browser call to the Railway domain is still refused.
- **The API's domain is not in the bundle.** It lives in the rewrite, so the API
  can move without rebuilding the portal.

`apiBaseUrl` used to be `""`, on the assumption that a proxy would put both on
one origin and `/auth/login` would just work. It cannot: the portal's own routes
collide with the API's paths — `/tenants`, `/users`, `/roles`, `/activity` and
`/platform/tenants/:id` are all real screens *and* real endpoints. A rewrite
matching them at the root sends the browser's navigation to the API and returns
JSON where a page belongs. The prefix is a namespace the router does not claim.

## 4. Create the first operator

Nothing can create a platform administrator over HTTP — `POST /tenants` requires
one, and an endpoint that could mint one would let anyone who reached the port
grant themselves the tier. It is a CLI, run against the production database:

```bash
railway run --service <api-service> pnpm platform-admin -- --email you@example.com --name "Ops"
```

It prints an invitation link **once** (only a digest is stored) pointing at
`http://localhost:4200` by default — pass your real portal URL:

```bash
railway run --service <api-service> pnpm platform-admin -- \
  --email you@example.com --portalUrl https://<your>.vercel.app
```

Open the link, set a password, and you can sign in and provision tenants.

Do **not** run `pnpm seed` against production. It inserts the Acme/Globex demo
tenants and their users.

## Order of operations

1. Postgres service on Railway.
2. API service on Railway, with the variables above. First deploy runs the
   migrations.
3. Confirm `https://<railway>/health` returns 200.
4. Put that domain into `vercel.json`, commit, deploy the portal.
5. Confirm `https://<vercel>/api/health` returns 200 — this proves the rewrite.
6. Run `platform-admin`, redeem the link, sign in.

## Things that will bite

- **`pnpm-lock.yaml` must be committed** and current, or `--frozen-lockfile`
  fails on both platforms. Run `pnpm install` and commit any change first.
- **Node 20+** on both. The root `package.json` declares `engines.node >= 20`
  and `packageManager: pnpm@9.12.0`; Railway and Vercel both honour those.
- **Both platforms build from the repo root**, not from `apps/*`. This is a pnpm
  workspace and the API depends on `@growpath/db`, `@growpath/contracts` and
  `@growpath/observability` by `workspace:*`. Setting a Root Directory of
  `apps/api` breaks the install.
- **The `...` in both build commands is load-bearing.** Every workspace package
  resolves through `"types": "./dist/index.d.ts"`, which does not exist until
  that package is built. `--filter @growpath/api build` builds only the API and
  fails on a fresh checkout with `TS2307: Cannot find module '@growpath/db'`,
  plus a cascade of `implicitly has an 'any'` where TypeScript gave up after the
  import failed. The `...` suffix includes a package's dependencies, so pnpm
  builds them first in topological order. It only breaks in CI — a local `dist/`
  survives from the previous build.
- **`/api/health` is the rewrite test.** If `https://<railway>/health` works but
  `https://<vercel>/api/health` does not, the destination in `vercel.json` is
  wrong — not the API.
- **A redeploy does not re-run seeds or reset data.** Migrations are additive;
  rolling one back is `pnpm --filter @growpath/db migrate:down` and is a
  deliberate act.
