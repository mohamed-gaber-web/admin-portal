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

Import the repo. `vercel.json` sets everything except the API URL.

```
Build     pnpm --filter @growpath/portal... build
Install   pnpm install --frozen-lockfile
Output    apps/portal/dist/browser   (Root Directory empty)
          dist/browser               (Root Directory apps/portal)
Framework Other
```

### There are two `vercel.json` files, on purpose

Vercel reads `vercel.json` **only from the project's Root Directory**, and it
resolves `outputDirectory` relative to that same directory. So the correct
output path depends on a dashboard setting:

| Root Directory | File Vercel reads | `outputDirectory` |
| --- | --- | --- |
| *(empty, repo root)* | `vercel.json` | `apps/portal/dist/browser` |
| `apps/portal` | `apps/portal/vercel.json` | `dist/browser` |

Both files exist so the deploy works either way. Getting this wrong fails the
build *after* Angular has succeeded, with a misleading message — Vercel prints
only the last path segment:

```
Error: No Output Directory named "browser" found after the Build completed.
```

That means the directory was not where Vercel looked, not that Angular failed to
emit it. Check `Output location:` in the build log against the Root Directory.

**Keep the `rewrites` in both files in sync.** They carry the `/api` proxy and
the SPA fallback; a build that reads the wrong file still deploys, but every
deep link 404s and every API call fails.

**Edit `vercel.json` and replace the placeholder** with your Railway public
domain:

```json
{ "source": "/api/:path*", "destination": "https://admin-portal-production-db9b.up.railway.app/:path*" }
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
  --email you@example.com --portal-url https://<your>.vercel.app
```

Open the link, set a password, and you can sign in and provision tenants.

Do **not** run `pnpm seed` against production. It inserts the Acme/Globex demo
tenants and their users.

## 5. Email (invitations and password resets)

The API emails a link whenever one is issued: **forgot password** (portal and
mobile), **inviting a user**, **creating a tenant** (its first admin), an
operator **re-sending an admin invitation**, an operator **issuing a reset
link**, and **adding an operator**. Sending happens after the change is saved
and never fails the request — the portal keeps showing the link as a fallback.

Without these variables nothing is sent and the API logs `email.disabled` at
startup. Set them on the **API service** in Railway, then redeploy.

| Variable | Value |
| --- | --- |
| `PORTAL_URL` | The portal's public address, e.g. `https://<your>.vercel.app` — every link points here |
| `EMAIL_PROVIDER` | `graph` (Microsoft 365), `acs` (Azure Communication Services) or `smtp`. Omit it when using SMTP: `EMAIL_HOST` alone selects it |
| `EMAIL_FROM` | The sending address |
| `EMAIL_FROM_NAME` | Optional, defaults to `Grow Path` |

### Option A — Microsoft 365 mailbox (`graph`)

Use this when the company already has Microsoft 365. No new Azure resource.

1. Create the mailbox that sends, e.g. a **shared mailbox** `noreply@growpath.net`
   (Exchange admin center → Recipients → Mailboxes → Add a shared mailbox). A
   shared mailbox needs no licence.
2. Entra admin center → **App registrations → New registration**, e.g.
   `Grow Path Mail`. Single tenant. No redirect URI.
3. In the app: **API permissions → Add a permission → Microsoft Graph →
   Application permissions → `Mail.Send`**, then **Grant admin consent**.
4. **Certificates & secrets → New client secret.** Copy the *Value* now; it is
   not shown again. Note its expiry date — mail stops when it expires.
5. Recommended: limit the app to that one mailbox, otherwise `Mail.Send` lets it
   send as anyone in the organisation. In Exchange Online PowerShell:
   ```powershell
   New-DistributionGroup -Name "GrowPathMailSenders" -Type Security -Members noreply@growpath.net
   New-ApplicationAccessPolicy -AppId <client-id> -PolicyScopeGroupId GrowPathMailSenders -AccessRight RestrictAccess -Description "Grow Path may send only as noreply"
   ```
6. Railway variables:
   ```
   EMAIL_PROVIDER=graph
   EMAIL_FROM=noreply@growpath.net
   EMAIL_GRAPH_TENANT_ID=<Directory (tenant) ID from the app's Overview>
   EMAIL_GRAPH_CLIENT_ID=<Application (client) ID>
   EMAIL_GRAPH_CLIENT_SECRET=<the secret Value>
   PORTAL_URL=https://<your>.vercel.app
   ```

### Option B — Azure Communication Services (`acs`)

Use this without Microsoft 365, or for high volume.

1. Azure portal → **Create a resource → Email Communication Services**. Then
   **Provision domains**: either the free Azure-managed domain
   (`xxxx.azurecomm.net`, works immediately) or **your own domain**, which needs
   the TXT, SPF and DKIM records it shows added at your DNS provider.
2. **Create a resource → Communication Services**. In it, **Email → Domains →
   Connect domain** and pick the domain from step 1.
3. In the email domain, **MailFrom addresses** shows the sender, e.g.
   `DoNotReply@xxxx.azurecomm.net` (add `noreply@growpath.net` on a custom domain).
4. Communication Services resource → **Keys** → copy the **Connection string**.
5. Railway variables:
   ```
   EMAIL_PROVIDER=acs
   EMAIL_FROM=DoNotReply@xxxx.azurecomm.net
   EMAIL_ACS_CONNECTION_STRING=endpoint=https://<resource>.communication.azure.com/;accesskey=<key>
   PORTAL_URL=https://<your>.vercel.app
   ```

### Option C — any SMTP server (`smtp`)

Gmail, Office 365 SMTP, or ACS's SMTP endpoint. Set `EMAIL_HOST` and the API
uses SMTP without `EMAIL_PROVIDER`.

```
EMAIL_HOST=smtp.gmail.com          # smtp.office365.com, smtp.azurecomm.net …
EMAIL_PORT=587                     # 465 for implicit TLS
EMAIL_USER=noreply@growpath.net    # the account that signs in
EMAIL_PASSWORD=<password>          # Gmail: a 16-character app password, not the account password
EMAIL_FROM=noreply@growpath.net    # optional; defaults to EMAIL_USER
PORTAL_URL=https://<your>.vercel.app
```

A failure logs `email.failed` with the SMTP code: `EAUTH`/`535` is a wrong
user or password (Gmail needs 2-Step Verification on and an app password;
Office 365 needs SMTP AUTH enabled for the mailbox), `ECONNECTION`/`ETIMEDOUT`
is a wrong host or port.

### Checking it works

After the redeploy the API logs `email.configured` with the provider name.
Use **Forgot password** on the sign-in page with a real account: the logs show
`email.sent`, or `email.failed` with the provider's status — `401`/`403` from
Graph means the permission or admin consent is missing, `404` means
`EMAIL_FROM` is not a mailbox in that tenant. Links are never logged.

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
