# Admin portal

Angular 18 (standalone, signals) + Tailwind CSS. This document is the contract
for how the UI is put together — read it before adding a screen.

```
pnpm --filter @growpath/portal dev        # http://localhost:4200
pnpm --filter @growpath/portal build
pnpm --filter @growpath/portal typecheck
pnpm --filter @growpath/portal lint
```

The API must be running on `http://localhost:3000` for sign-in to work. Its
default `PORTAL_ORIGIN` is this dev server, so a fresh clone needs no CORS
configuration.

## Folder structure

```
src/
├── environments/            # apiBaseUrl per build; prod swapped in by angular.json
├── styles.css               # design tokens + base layer. The only global stylesheet.
├── tailwind.config.js       # semantic colour names → CSS variables
└── app/
    ├── core/                # no templates live here
    │   ├── auth/            # SessionStore, AuthService, authGuard/guestGuard
    │   ├── http/            # ApiService, ApiError, interceptors, mock.ts
    │   ├── layout/          # LayoutStore (sidebar), navigation.ts (the nav, as data)
    │   ├── models/          # contract re-exports + view models. Import from '@core/models'.
    │   ├── notifications/   # ToastService
    │   └── theme/           # ThemeService (light/dark/system)
    ├── shared/              # reusable, feature-agnostic
    │   ├── ui/              # the design system. Import from '@shared/ui'.
    │   ├── components/      # composed pieces used by >1 feature (activity list)
    │   └── pipes/           # relativeTime
    ├── layout/              # the app shell: sidebar, topbar, page header, theme toggle
    └── features/            # one folder per screen; each lazy-loaded
        ├── auth/  dashboard/  tenants/  users/  activity/  settings/  not-found/
```

Path aliases (`tsconfig.json`): `@core/*`, `@shared/*`, `@features/*`, `@env`.

**The dependency rule.** `features → shared → core`, never upward and never
sideways. A feature that needs another feature's component means the component
belongs in `shared/`. Nothing in `core/` or `shared/` may import from
`features/`.

## Design system

### Tokens, not colours

Every colour is a semantic CSS variable defined twice in `styles.css` — once on
`:root`, once under `.dark` — and exposed to Tailwind under a name that says
what it is *for*:

| Token | Use |
|---|---|
| `background` / `surface` / `surface-muted` / `surface-hover` | page, cards, insets, hover fills |
| `border` / `border-strong` | hairlines; the second for hover and emphasis |
| `foreground` / `foreground-muted` / `foreground-subtle` | body text, secondary, tertiary |
| `primary` / `success` / `warning` / `danger` / `info` | each with `-subtle` (background) and `-foreground` (text on the solid fill) |
| `chart-1` / `chart-2` / `grid` | data series and gridlines |

Write `bg-surface text-foreground-muted border-border`. Never `bg-white`,
`text-gray-500`, `dark:bg-slate-800` — a literal colour cannot be re-themed, and
a `dark:` variant on every element is the thing the tokens exist to avoid.
Dark mode is one class on `<html>`; nothing below it needs to react.

Opacity modifiers work (`bg-primary/10`) because the tokens store bare HSL
channels rather than `hsl(...)` strings.

### Conventions

- **Radius** — `rounded-xl` for controls, `rounded-2xl` for containers.
- **Spacing** — `p-4` inside dense chrome, `p-6` inside cards, `gap-6` between
  sections, `gap-4` within them.
- **Motion** — `transition-all duration-200`. All of it is decorative, and
  `prefers-reduced-motion` cuts it globally in `styles.css`.
- **Focus** — never remove the ring. One `:focus-visible` treatment is defined
  in the base layer and applies everywhere.
- **Size** — components stay under ~200 lines. Past that, split out a
  sub-component (see `features/dashboard/components/`).

### Primitives (`@shared/ui`)

`ui-alert` · `ui-avatar` · `ui-badge` · `uiButton` · `ui-card` /
`ui-card-header` · `ui-dropdown` / `uiMenuItem` · `ui-empty-state` ·
`ui-error-state` · `ui-field` · `ui-icon` · `uiInput` / `uiSelect` · `ui-modal` ·
`ui-pagination` · `ui-skeleton` · `ui-sparkline` · `ui-spinner` · `ui-table` /
`uiSortHeader` · `ui-tabs` · `ui-toast-host` · `ui-trend-chart`

Buttons, inputs, menu items and sort headers are **attribute selectors on native
elements** (`<button uiButton>`, `<input uiInput>`). The element stays real, so
form submission, `formControlName`, autofill, keyboard activation and focus
order keep working without the component proxying any of it.

Icons live in one frozen table in `icon.component.ts`; `IconName` is a union, so
a typo is a compile error rather than an invisible blank box.

### Every data-driven view handles four states

Loading (skeleton in the shape of the real layout), success, **empty**, and
**error with a retry**. `Async<T>` in `@core/models` models them as one object —
`asyncLoading()` / `asyncSuccess()` / `asyncError()` — because "loading with an
error" and "loaded with neither data nor error" are not reachable states and
three loose signals would let a template render them.

Empty splits by cause: a genuinely empty collection offers a create action; a
filter that matched nothing offers a way to clear it.

### Charts

Two categorical slots (`chart-1`, `chart-2`), assigned per entity and never
cycled, so a filter that hides a series never repaints the survivors. Both
light and dark pairs were validated for contrast, chroma, lightness band and
separation under protanopia/deuteranopia/tritanopia — **re-run that check if you
change a hue.** One y-axis, always; a legend whenever there are two series;
labels wear text tokens, never the series colour.

## Localisation (US-062)

English and Arabic, switchable at runtime. **This is a definition-of-done item,
not polish** — every new screen ships translated and mirrored.

### Adding a string

1. Add the key to `core/i18n/messages/en.ts`.
2. Add its translation to `ar.ts`. Skipping this is a **compile error** — `ar`
   is declared as `Messages`, which is `Record<MessageKey, string>`.
3. Use it: `protected readonly t = injectT()`, then `{{ t('your.key') }}`.

Never put a user-visible string in a template. `scripts/check-i18n.mjs` runs as
part of `pnpm lint` (and so in CI) and fails on a bare literal, a missing
translation, an orphaned Arabic key, or a key nothing uses. Interpolate with
`t('key', { name })` rather than concatenating fragments — Arabic word order
differs, and a sentence split across elements cannot be reordered by a
translator.

Domain vocabulary (statuses, plans, severities) maps to keys in
`core/i18n/label-keys.ts`, written out in full. No key is ever built by
interpolation: that would blind the unused-key check for a whole family.

### Writing RTL-safe markup

- **Logical utilities only**: `ps-/pe-`, `ms-/me-`, `start-/end-`, `border-s/e`,
  `rounded-s/e`, `text-start/end`. A physical `pl-4` stays on the left in Arabic
  while everything around it moves — that is how a layout ends up half-mirrored.
  A test in `tests/us062-localisation.test.ts` fails on physical utilities in
  templates.
- **Icons mirror themselves.** `IconComponent` flips the glyphs in
  `DIRECTIONAL_ICONS` under RTL. Don't add `trending-up`/`trending-down` — a
  mirrored rise reads as a fall.
- **Numbers and dates** go through `I18nService.formatNumber` / `formatDate`,
  never `toLocaleString()` with no locale — that follows the OS, not the app.
- Where CSS has no logical equivalent (`background-position`, keyframe
  transforms), use an `rtl:` variant or the `--slide-from` variable.

Arabic uses Noto Sans Arabic, scoped to `:lang(ar)` rather than `[dir="rtl"]` so
Latin text inside an Arabic page stays in Inter. Digits are Latin, set by one
field — `LOCALE_META.ar.intl`.

**Known limitation:** the growth chart's time axis stays left-to-right under
RTL; only its legend, tooltip and labels mirror. Both conventions ship in real
Arabic products. Revisit if users expect a mirrored axis.

**Bundle note:** both catalogues load eagerly, which is why the initial budget
is 560 kB. That is deliberate — it keeps `t()` synchronous. A third locale
should switch to lazy-loaded catalogues rather than raising the budget again.

## Authentication (US-061)

Screens: sign-in, MFA challenge, MFA enrolment (Settings → Security), forgot
password, reset password, invitation redemption.

**Sign-in returns a discriminated union.** A correct password either completes
the sign-in or produces an `mfa_required` challenge; the two branches carry
different fields. Parse with `signInResponseSchema`, never `authenticatedSchema`
— the latter throws on a challenge, so an MFA-enabled account would see a
contract error instead of a prompt.

**Where credentials live**

| | Stored | Why |
|---|---|---|
| Identity | `localStorage` | Not a credential. A returning user sees their name, not a blank shell. |
| Access token | memory only | Short-lived and reissuable; persisting adds exposure for nothing. |
| Refresh token | `sessionStorage` | Compromise — see below. |
| MFA challenge token | memory only | Short-lived; a reload correctly sends you back to sign in. |

`sessionStorage` for the refresh token is a **deliberate compromise, not the end
state**. It is scoped to one tab and cleared when that tab closes, so an XSS
payload gets a session rather than a permanent credential. The contract's own
note says a browser client should move it to an httpOnly cookie; that needs an
API change and remains the correct fix. Memory-only was the alternative, and it
made MFA enrolment permanently unreachable after any page refresh, since
`/auth/mfa/enrol` is tenant-scoped.

`provideSessionRestore()` exchanges the refresh token at `/auth/refresh` before
the first route resolves. A failed exchange **clears everything and never
retries** — the token is single use, so a failure means spent, expired, or
replayed, and replay signs the session out by design (US-023).

**Things not to undo**

- The forgot-password screen must not branch on whether the account exists, and
  its copy must not either. The API answers identically both ways specifically
  to remove the enumeration oracle.
- MFA failures use one message for a wrong code, a replayed code and a spent
  recovery code. So does the API.
- Reset-password hands back no session: redeeming revokes every refresh token,
  and issuing a fresh one would undo that.

**Still missing:** `POST /auth/logout`. Signing out clears this browser but
revokes nothing, so the refresh token stays exchangeable for its full lifetime.

## Tenant administration (US-063)

`/tenants` lists; `/tenants/:id` is the detail screen — overview, D365
environments, lifecycle, and that tenant's audit entries.

**The hierarchy is three levels, not two.** One tenant holds several D365
environments (PROD, UAT); each environment holds several legal entities. US-010
calls collapsing that the most expensive modelling mistake available here, so
`TenantDetail.environments[].companies[]` stays nested and the screen renders it
nested. A flat tenant→company list would have nowhere to record that the same
`dataAreaId` means different data in PROD and UAT.

**Lifecycle transitions are data, not template branches.**
`TENANT_ACTIONS_BY_STATUS` decides which buttons exist, so reactivating an
archived tenant is unrepresentable rather than merely unlikely. Archiving — and
only archiving — requires typing the slug: it is the one action that hides the
tenant from every other screen. Put that friction on everything and it stops
being read.

**Lifecycle is not wired to an API, and cannot be yet.** There is no route.
`softDeleteTenant()` / `restoreTenant()` exist in `@growpath/db`, and
`route-manifest.ts` parks their audit actions in `NON_ROUTE_AUDIT_ACTIONS`
noting that this screen would claim them. Claiming them needs, in order:

1. a route on the API — something like `PATCH /tenants/:id/status`;
2. its `route-manifest.ts` entry, `platform`, listing `tenant.soft_deleted` and
   `tenant.restored` under `audits`;
3. those two removed from `NON_ROUTE_AUDIT_ACTIONS` — the guard is
   bidirectional and fails on a double claim;
4. `TenantsService.setStatus` calling the API instead of the fixture.

Adding a route constant to `@growpath/contracts` before step 1 fails CI, which
is why none is imported there. The screen says so in the UI rather than
pretending the change stuck.

Connection state per environment is shown but not actionable — configuring and
testing a D365 connection is US-065.

## Users, roles and permissions (US-064)

`/users` lists · `/users/:id` is the person · `/roles` is the matrix.

**Three levels, three owners.** Identity is read-only; **roles** decide
capability; **access** decides whether any of it applies. Suspending someone
does not touch their roles, so restoring access restores exactly what they had.

**Permissions are global and read-only to the application.** The
row-level-security migration grants `SELECT` on `permission` and nothing else,
so the screen never offers to create, rename or delete one — that would be
offering an operation the database refuses. What *is* editable is
`role_permission`: which role holds which permission. The matrix says so on
screen rather than leaving someone hunting for an add button.

**Roles are tenant-scoped; permissions are not.** `RolesService.list()` takes no
tenant parameter for the same reason the users service doesn't — the tenant
comes from the token's claims and RLS filters. Passing one would be the first
step towards a cross-tenant read.

**Write implies read, both ways.** Granting `tenant.write` grants `tenant.read`;
revoking the read revokes the write. Writing something you cannot see is not a
state the API models, and letting the matrix express it produces a role that
looks coherent and behaves oddly.

**Nothing here is wired to an API** — there is no `/users`, no `/roles`, and no
invitation-*issuing* route (only redemption). Every write is local, and the
screens say so.

**Keep role names as names.** `UserSummary.role` holds `admin`, not `Owner`.
Display text in a data field is invisible to the untranslated-string check and
would print English on an Arabic screen — which is exactly how it slipped in
before this story caught it.

## Demo mode

`environment.useMockApi` is **on**. The portal makes no network request at all:
it runs with no API, no database and no migrations, so the UI can be built
without the backend being up.

- Sign-in accepts anything, and the form is prefilled. Password `fail` returns
  the 401 path; password `mfa` returns a challenge, so both branches of the
  sign-in union are reachable without a server. In the MFA and enrolment
  screens, code `000000` is rejected and anything else is accepted.
- Every list, metric and audit entry is a fixture.
- Creating a tenant returns a fabricated provisioning response, so the one-time
  invitation-token panel is reachable.

Turning it off is the only change needed to go back to the real calls
(`POST /auth/login`, `POST /auth/accept-invitation`, `POST /tenants`) — each
service keeps the real code path beside the fixture and branches on the flag.
It is hard-off in `environment.prod.ts`, so no build can ship demo data.

Endpoints that do not exist yet — metrics, tenant list, user list, audit log —
route through `mockResponse()` in `core/http/mock.ts` regardless of the flag.
**Grep for that function to find every call site**; each is a one-line swap to
`this.api.get(...)`.

Responses on the real path are parsed through the `@growpath/contracts` Zod
schemas, so a contract drift fails loudly here rather than surfacing as
`undefined` three components away. `packages/contracts` is a build dependency:
run `pnpm --filter @growpath/contracts build` after changing a schema, or the
portal typechecks against a stale `.d.ts`.

## Three things to know about auth

**`authGuard` is a usability control, not a security one.** It spares signed-out
visitors a dashboard that would fail to load; the API decides what it hands
over.

**Tokens are never persisted.** Sign-in returns an access token and a refresh
token (US-022/023). `SessionStore` splits the response: identity goes to
`localStorage`, both tokens stay in memory. Anything in `localStorage` is
readable by any script that reaches the page, so one XSS would become a stolen
session that outlives the tab. The cost is that a page refresh keeps the user's
name and workspace on screen but loses the credential — `needsCredential()`
reports exactly that state.

**Two pieces of auth work remain**, both deferred while the UI is being built:

1. *Restoring a session after refresh* — either exchange the refresh token at
   `/auth/refresh` on startup (it is single use, so this rotates it), or have
   the API set it as an httpOnly cookie, which is why it already sets
   `credentials: true` in its CORS config. Persisting the token in
   `localStorage` is the option that must not be taken.
2. *Attaching the token to requests, and revoking it* — there is no
   `Authorization` interceptor yet, and `signOut` only clears this browser. A
   `POST /auth/logout` that invalidates the refresh token server-side is needed
   before signing out on a shared machine means anything.
