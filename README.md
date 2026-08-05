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

CI (`.github/workflows/ci.yml`) runs `lint` and `typecheck` across every workspace on each pull request.
