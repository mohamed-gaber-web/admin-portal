import type { CreateTenantInput } from "@growpath/contracts";

// Drift: `slug` is required by the shared schema but omitted here.
// This MUST fail to compile — proving consumers break at compile time, not runtime.
const tenant: CreateTenantInput = { name: "Acme" };

void tenant;
