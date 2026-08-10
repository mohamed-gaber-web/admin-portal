# Grow Path Admin — Monorepo

pnpm workspaces + Turborepo monorepo housing the API, admin portal, and shared contracts so they stay in step.

## Structure

| Path                  | What it is                                  |
| --------------------- | ------------------------------------------- |
| `apps/api`            | NestJS API (exposes `/health`)              |
| `apps/portal`         | Angular admin portal                        |
| `packages/contracts`  | Shared TypeScript contracts (types + routes) |

## Prerequisites

- Node.js >= 20
- pnpm 9 (`corepack enable`)

## Commands

```bash
pnpm install      # install every workspace
pnpm dev          # start API and portal together (turbo)
pnpm build        # build all workspaces (dependents rebuild via turbo)
pnpm lint         # eslint across every workspace
pnpm typecheck    # tsc --noEmit across every workspace
pnpm test         # acceptance-criterion tests (vitest)
```

## CI

`.github/workflows/ci.yml` runs on every pull request as independent jobs — `lint`, `typecheck`, `test` (with a throwaway Postgres), `build`, and `db-migrations` — aggregated by a single `ci-success` gate job. Add future guard-rail jobs and list them in the gate's `needs`.

### Branch protection (blocks merges on failing checks)

Merge-blocking is enforced by GitHub branch protection requiring the `ci-success` check. Desired state lives in `.github/branch-protection.json`; apply it once per repo (needs admin + `gh` authenticated):

```bash
gh api -X PUT repos/:owner/:repo/branches/main/protection \
  --input .github/branch-protection.json
```
