import { loadRepoEnv } from "./env";
import { createPool } from "./pool";
import { seedDemoData } from "./seed";

async function main(): Promise<void> {
  loadRepoEnv();
  const pool = createPool();
  try {
    const summary = await seedDemoData(pool);
    console.log("Seeded demo data:");
    console.log(`  tenants:      ${summary.tenants}`);
    console.log(`  permissions:  ${summary.permissions}`);
    console.log(`  environments: ${summary.environments}`);
    console.log(`  companies:    ${summary.companies}`);
    console.log(`  roles:        ${summary.roles}`);
    console.log(`  users:        ${summary.users}`);
    console.log(`  audit entries:${summary.auditEntries}`);
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
