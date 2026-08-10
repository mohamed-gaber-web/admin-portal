import type { CreateTenantInput } from "@growpath/contracts";

// Correct shape — must compile.
const tenant: CreateTenantInput = { name: "Acme", slug: "acme" };

void tenant;
