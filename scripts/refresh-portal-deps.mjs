#!/usr/bin/env node
/**
 * Drops the portal's pre-bundled copy of a workspace package when that package
 * has been rebuilt underneath it.
 *
 * ### The failure this exists to prevent
 *
 * Angular's dev server pre-bundles dependencies with Vite and caches the result
 * under `.angular/cache/<version>/portal/vite/deps`. Vite decides whether that
 * cache is stale from the dependency *versions* in the lockfile — which never
 * change for a workspace package linked by `workspace:*`. So editing
 * `packages/contracts`, rebuilding it, and restarting `ng serve` leaves the
 * portal running the copy it pre-bundled days ago.
 *
 * That is normally invisible. It is not invisible here, because the contract
 * schemas are `.strict()`: a response carrying a field the stale copy has never
 * heard of is rejected outright, and the screen renders its error state instead
 * of the data. It has now cost three debugging sessions — once for `userLimit`,
 * once for `seatLimitOverride` and `adminEmail` — each presenting as "tenants do
 * not load" with a healthy API behind it.
 *
 * ### Why this rather than `prebundle: { exclude: [...] }`
 *
 * That option exists and looks like the obvious answer. It does not work here:
 * `@growpath/contracts` is emitted as CommonJS, and pre-bundling is exactly what
 * converts it to something a browser can import. Excluding it serves the raw
 * CJS and the app dies on `Dynamic require of "zod" is not supported` before it
 * renders anything.
 *
 * The real fix is for the contracts package to emit ESM, at which point the
 * exclusion becomes correct and this script can go. Until then, deleting the
 * stale artefact costs one re-bundle (a few seconds) and is never wrong.
 */
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Workspace packages the portal imports, whose rebuilds must invalidate the cache. */
const WATCHED = [join(repoRoot, "packages/contracts/dist")];

/** Newest mtime anywhere under a directory tree. */
function newestMtime(dir) {
  if (!existsSync(dir)) return 0;
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    const mtime = entry.isDirectory()
      ? newestMtime(full)
      : statSync(full).mtimeMs;
    if (mtime > newest) newest = mtime;
  }
  return newest;
}

const cacheRoot = join(repoRoot, "apps/portal/.angular/cache");
if (!existsSync(cacheRoot)) process.exit(0);

const sourceMtime = Math.max(...WATCHED.map(newestMtime));

for (const version of readdirSync(cacheRoot)) {
  const viteRoot = join(cacheRoot, version, "portal/vite");
  if (!existsSync(viteRoot)) continue;

  /*
   * `deps` and any `deps_temp_*` beside it.
   *
   * Vite pre-bundles into `deps_temp_<hash>` and renames it to `deps` when it
   * finishes — but a server that is killed mid-optimise, or one still running
   * from an earlier boot, leaves the temp directory behind and keeps serving
   * out of it. Clearing only `deps` then finds nothing to do and reports
   * success while the stale copy is still the one being served, which is how
   * this script silently failed to prevent the fourth instance of the bug it
   * was written for.
   */
  const bundleDirs = readdirSync(viteRoot).filter(
    (entry) => entry === "deps" || entry.startsWith("deps_temp_")
  );

  for (const entry of bundleDirs) {
    const dir = join(viteRoot, entry);
    // The bundled artefacts, not the directory: on Windows the directory's own
    // mtime does not move when Vite rewrites a file inside it.
    const bundledMtime = newestMtime(dir);
    if (bundledMtime && bundledMtime < sourceMtime) {
      rmSync(dir, { recursive: true, force: true });
      console.log(
        `[refresh-portal-deps] cleared stale pre-bundled dependencies in ${entry} — a workspace package was rebuilt after them`
      );
    }
  }
}
