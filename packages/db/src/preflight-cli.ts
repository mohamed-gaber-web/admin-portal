import { loadRepoEnv } from "./env";
import { checkDatabase, redactUrl } from "./preflight";

async function main(): Promise<void> {
  loadRepoEnv();
  const info = await checkDatabase();

  // version() is a long banner; its first clause is the useful part.
  console.log(`Postgres reachable at ${redactUrl(process.env.DATABASE_URL ?? "")}`);
  console.log(`  ${info.version.split(",")[0]}`);
  console.log(`  database: ${info.database}`);
  if (!info.canCreateDatabase) {
    console.warn(
      "  warning: this account cannot CREATE DATABASE — the throwaway-database tests will fail."
    );
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
