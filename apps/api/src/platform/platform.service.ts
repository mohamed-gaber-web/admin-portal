import { Inject, Injectable } from "@nestjs/common";
import {
  ensurePlatformAdmin,
  findTenantDetail,
  findUserDetail,
  isPlatformPermissionKey,
  isPlatformTenant,
  listAuditEntriesForTenant,
  listPermissionCatalogue,
  listPlatformAdmins,
  listTenantModules,
  listTenants,
  listUsers,
  setTenantModules,
  setTenantPlan,
  setTenantStatus,
  setUserStatus,
  withoutTenantScope,
  type AuditActor,
  type AuditEntry,
  type CatalogPermissionRecord,
  type ModuleRecord,
  type PageRequest,
  type PlatformAdminRecord,
  type TenantDetail as TenantDetailRecord,
  type TenantPlan,
  type TenantStatusTarget,
  type TenantSummary as TenantSummaryRecord,
  type UserDetail as UserDetailRecord,
  type UserPageRequest,
  type UserSummary as UserSummaryRecord
} from "@growpath/db";
import {
  severityForAction,
  type ActivityEntry,
  type CatalogPermission,
  type CreatePlatformAdminInput,
  type Page,
  type PlatformAdmin,
  type PlatformAdminCreated,
  type TenantDetail,
  type TenantModule,
  type TenantSummary,
  type UserDetail,
  type UserSummary
} from "@growpath/contracts";
import type { Pool } from "pg";
import { DATABASE_POOL } from "../database/database.module";

/**
 * Reads and writes that span every tenant.
 *
 * The one place in the application where `withoutTenantScope` is used for
 * ordinary reads rather than for a bootstrap. Everywhere else the escape hatch
 * covers an operation with no tenant to scope to — provisioning, sign-in,
 * redeeming a token. Here the absence of scoping *is* the feature, which is why
 * the guard in front of it checks two independent things and why every call
 * below states its reason: the reason is written to the log with the request's
 * correlation ID, so a review can ask why any particular bypass happened and
 * get an answer that names the screen.
 *
 * The query functions are the same ones the tenant-scoped services use. They
 * contain no `WHERE tenant_id` — the boundary was always the database's row
 * level security, so running them unscoped returns the whole installation
 * without a second implementation that could drift from the first.
 */

const toTenantSummary = (record: TenantSummaryRecord): TenantSummary => ({
  id: record.id,
  name: record.name,
  slug: record.slug,
  status: record.status,
  plan: record.plan,
  userCount: record.userCount,
  createdAt: record.createdAt.toISOString()
});

const toTenantDetail = (record: TenantDetailRecord): TenantDetail => ({
  ...toTenantSummary(record),
  adminEmail: record.adminEmail,
  environments: record.environments.map((environment) => ({
    id: environment.id,
    name: environment.name,
    kind: environment.kind,
    url: environment.url,
    // The stored result of the last credential check (US-040), same as the
    // tenant-scoped detail returns — an operator diagnosing a tenant's D365
    // connection needs the real state, and a constant here would make this
    // screen quietly disagree with the one the tenant is looking at.
    connection: environment.connection,
    companies: environment.companies
  }))
});

const toUserSummary = (record: UserSummaryRecord): UserSummary => ({
  id: record.id,
  email: record.email,
  name: record.name,
  role: record.role,
  status: record.status,
  tenantSlug: record.tenantSlug,
  lastSeenAt: record.lastSeenAt?.toISOString() ?? null
});

const toUserDetail = (record: UserDetailRecord): UserDetail => ({
  ...toUserSummary(record),
  roles: record.roles,
  createdAt: record.createdAt.toISOString(),
  invitedBy: record.invitedBy
});

const toActivity = (entry: AuditEntry): ActivityEntry => ({
  id: entry.id,
  action: entry.action,
  actor: entry.actorLabel,
  target: activityTarget(entry),
  at: entry.createdAt.toISOString(),
  severity: severityForAction(entry.action)
});

function activityTarget(entry: AuditEntry): string {
  const values = { ...entry.beforeValues, ...entry.afterValues } as Record<string, unknown>;
  for (const key of ["slug", "email", "userEmail", "role", "name"]) {
    const value = values[key];
    if (typeof value === "string" && value) return value;
  }
  return entry.entityId ?? entry.entityType;
}

const toTenantModule = (record: ModuleRecord): TenantModule => ({
  key: record.key,
  description: record.description,
  enabled: record.enabledAt !== null,
  enabledAt: record.enabledAt?.toISOString() ?? null
});

const toPlatformAdmin = (record: PlatformAdminRecord): PlatformAdmin => ({
  id: record.id,
  email: record.email,
  name: record.name,
  status: record.status,
  lastLoginAt: record.lastLoginAt?.toISOString() ?? null,
  createdAt: record.createdAt.toISOString()
});

const toCatalogPermission = (record: CatalogPermissionRecord): CatalogPermission => ({
  key: record.key,
  description: record.description,
  // Derived by prefix, mechanically, the same rule the database trigger and the
  // guard use. A stored flag would be a third place this could be wrong.
  platform: isPlatformPermissionKey(record.key),
  roleCount: record.roleCount
});

/** Raised when an operator tries to suspend the account they are signed in as. */
export class SelfSuspensionError extends Error {
  constructor() {
    super("You cannot suspend the account you are signed in as.");
    this.name = "SelfSuspensionError";
  }
}

@Injectable()
export class PlatformService {
  constructor(@Inject(DATABASE_POOL) private readonly pool: Pool) {}

  /** Every tenant on the installation, except the operators' own. */
  async listTenants(request: PageRequest): Promise<Page<TenantSummary>> {
    const page = await withoutTenantScope(
      this.pool,
      { reason: "Platform administration: the tenant list spans every tenant by design." },
      (client) => listTenants(client, request, { excludePlatform: true })
    );
    return { ...page, items: page.items.map(toTenantSummary) };
  }

  /** One tenant, whichever it belongs to. */
  async findTenant(id: string): Promise<TenantDetail | null> {
    return withoutTenantScope(
      this.pool,
      { reason: "Platform administration: reading any tenant's detail by id." },
      async (client) => {
        // The platform tenant answers 404 like an unknown id, and for the same
        // reason it is left out of the list: it is the operators' own
        // workspace, not a customer, and the screen's actions do not apply to
        // it. Hidden consistently, so a link that leaks the id still leads
        // nowhere.
        if (await isPlatformTenant(client, id)) return null;

        const record = await findTenantDetail(client, id);
        return record ? toTenantDetail(record) : null;
      }
    );
  }

  /** One tenant's audit trail, whichever tenant it is. */
  async tenantActivity(id: string): Promise<ActivityEntry[] | null> {
    return withoutTenantScope(
      this.pool,
      { reason: "Platform administration: reading any tenant's audit trail." },
      async (client) => {
        if (await isPlatformTenant(client, id)) return null;

        // Checked first so an unknown tenant is a 404 rather than an empty feed,
        // which would read as a tenant that has never done anything.
        const tenant = await findTenantDetail(client, id);
        if (!tenant) return null;

        const entries = await listAuditEntriesForTenant(client, id);
        return entries.map(toActivity);
      }
    );
  }

  /**
   * Suspends, reactivates or archives any tenant.
   *
   * The actor carries the operator's own user id, so the entry lands in the
   * *target* tenant's audit log naming who did it. That matters more here than
   * anywhere else in the system: from inside the tenant, this is a change made
   * by somebody they cannot see, and a log that recorded it anonymously would
   * make the platform tier unaccountable to the people it acts on.
   */
  async setTenantStatus(
    id: string,
    status: TenantStatusTarget,
    actor: AuditActor
  ): Promise<TenantDetail | null> {
    return withoutTenantScope(
      this.pool,
      { reason: "Platform administration: a lifecycle transition on any tenant." },
      async (client) => {
        // The platform tenant is not suspendable or archivable through this
        // route. Archiving it would soft-delete the only tenant that can create
        // tenants, and there is no screen that could undo it afterwards.
        if (await isPlatformTenant(client, id)) return null;

        const record = await setTenantStatus(client, id, status, actor);
        return record ? toTenantDetail(record) : null;
      }
    );
  }

  /** Every user across every tenant, operators included. */
  async listUsers(request: UserPageRequest): Promise<Page<UserSummary>> {
    const page = await withoutTenantScope(
      this.pool,
      { reason: "Platform administration: the user list spans every tenant by design." },
      (client) => listUsers(client, request)
    );
    return { ...page, items: page.items.map(toUserSummary) };
  }

  async findUser(id: string): Promise<UserDetail | null> {
    const record = await withoutTenantScope(
      this.pool,
      { reason: "Platform administration: reading any user by id." },
      (client) => findUserDetail(client, id)
    );
    return record ? toUserDetail(record) : null;
  }

  /**
   * Suspends or reactivates any user, in any tenant.
   *
   * Refuses the caller's own account. An operator who suspends themselves is
   * signed out with no way back in short of database access — and unlike a
   * tenant administrator, there may be nobody else holding the tier to undo it.
   * Refusing costs nothing; the alternative is a support incident that starts
   * with "we need a DBA".
   */
  async setUserStatus(
    id: string,
    status: "active" | "suspended",
    actor: AuditActor
  ): Promise<UserDetail | null> {
    if (status === "suspended" && actor.userId === id) {
      throw new SelfSuspensionError();
    }

    const record = await withoutTenantScope(
      this.pool,
      { reason: "Platform administration: changing any user's account state." },
      (client) => setUserStatus(client, id, status, actor)
    );
    return record ? toUserDetail(record) : null;
  }

  // ── Commercial administration (US-072) ───────────────────────────────────

  /**
   * Moves a tenant onto a plan, or cancels their subscription.
   *
   * Cancelling does not suspend them, and that separation is deliberate: a
   * customer whose subscription lapsed should stop getting what they no longer
   * pay for, not be locked out of their own data at the moment they most need to
   * export it. Suspension is a different route and a different permission.
   */
  async setTenantPlan(
    id: string,
    plan: TenantPlan,
    unsubscribe: boolean,
    actor: AuditActor
  ): Promise<TenantDetail | null> {
    return withoutTenantScope(
      this.pool,
      { reason: "Platform administration: changing any tenant's commercial plan." },
      async (client) => {
        // Hidden consistently with every other route on this controller: the
        // operators' own workspace is not a customer and has no plan worth
        // editing.
        if (await isPlatformTenant(client, id)) return null;

        const result = await setTenantPlan(client, {
          tenantId: id,
          plan,
          unsubscribe,
          actor
        });
        if (!result) return null;

        // The whole tenant back, not just the plan. The screen that called this
        // renders a detail view, and returning a fragment would have it either
        // re-fetch or patch its own copy — the second of which is how a screen
        // starts disagreeing with the database.
        const record = await findTenantDetail(client, id);
        return record ? toTenantDetail(record) : null;
      }
    );
  }

  /** The module catalogue, marked with what this tenant holds. */
  async listTenantModules(id: string): Promise<TenantModule[] | null> {
    return withoutTenantScope(
      this.pool,
      { reason: "Platform administration: reading any tenant's module entitlements." },
      async (client) => {
        if (await isPlatformTenant(client, id)) return null;

        // Checked first, so an unknown tenant is a 404 rather than a catalogue
        // with nothing enabled — which would read as a real tenant that has
        // bought nothing.
        const tenant = await findTenantDetail(client, id);
        if (!tenant) return null;

        const records = await listTenantModules(client, id);
        return records.map(toTenantModule);
      }
    );
  }

  /** Replaces the set of modules a tenant holds. */
  async setTenantModules(
    id: string,
    keys: readonly string[],
    actor: AuditActor
  ): Promise<TenantModule[] | null> {
    return withoutTenantScope(
      this.pool,
      { reason: "Platform administration: changing any tenant's module entitlements." },
      async (client) => {
        if (await isPlatformTenant(client, id)) return null;

        const records = await setTenantModules(client, { tenantId: id, keys, actor });
        return records ? records.map(toTenantModule) : null;
      }
    );
  }

  // ── The operator tier's own administration ───────────────────────────────

  /** Everybody holding the platform role. */
  async listAdmins(): Promise<PlatformAdmin[]> {
    const records = await withoutTenantScope(
      this.pool,
      { reason: "Platform administration: listing the operators, who live in the reserved tenant." },
      (client) => listPlatformAdmins(client)
    );
    return records.map(toPlatformAdmin);
  }

  /**
   * Mints another operator, and returns their one-time invitation.
   *
   * The same call `pnpm platform-admin` makes, so there is exactly one way an
   * operator account comes into being. What this adds is that an operator who is
   * already signed in can add a colleague without finding a machine that holds
   * the database credentials.
   *
   * Idempotent in the way that matters: an address that already belongs to an
   * active operator comes back with `invitation: null` and is left alone. That
   * is not a failure, and reporting it as one would push whoever hit it towards
   * deleting the account and re-creating it — which is a genuinely bad outcome
   * dressed up as a fix.
   */
  async createAdmin(
    input: CreatePlatformAdminInput,
    actor: AuditActor
  ): Promise<PlatformAdminCreated> {
    const result = await withoutTenantScope(
      this.pool,
      {
        reason:
          "Platform administration: creating an operator in the reserved tenant, which no tenant session can reach."
      },
      (client) => ensurePlatformAdmin(client, { ...input, actor })
    );

    return {
      user: { id: result.userId, email: input.email },
      created: result.created,
      invitation: result.invitation
        ? {
            id: result.invitation.id,
            expiresAt: result.invitation.expiresAt.toISOString(),
            // Readable exactly once. Only the digest is stored, so a lost token
            // is reissued rather than recovered.
            token: result.invitation.token
          }
        : null
    };
  }

  /** Every permission the installation defines, and how widely each is held. */
  async listPermissions(): Promise<CatalogPermission[]> {
    const records = await withoutTenantScope(
      this.pool,
      {
        reason:
          "Platform administration: the permission catalogue is global, and the role counts span every tenant."
      },
      (client) => listPermissionCatalogue(client)
    );
    return records.map(toCatalogPermission);
  }
}
