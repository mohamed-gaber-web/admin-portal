import { Injectable, inject } from "@angular/core";
import type { Observable } from "rxjs";
import { map } from "rxjs";
import {
  API_ROUTES,
  roleListSchema,
  roleSchema,
  type Role as RoleContract
} from "@growpath/contracts";
import { ApiService, pathFor } from "@core/http/api.service";
import type { MessageKey } from "@core/i18n/messages/en";
import { impliedBy, type PermissionKey, type Role } from "@core/models";

/**
 * Roles, and which permissions each holds.
 *
 * `role` is tenant-scoped, so this is the caller's own tenant's roles and the
 * request carries no tenant — the API takes it from the access token's claims.
 * The permission catalogue the roles reference is global and read-only to the
 * application, which is why nothing here creates or renames one.
 */
@Injectable({ providedIn: "root" })
export class RolesService {
  private readonly api = inject(ApiService);

  list(): Observable<Role[]> {
    return this.api
      .getValidated(API_ROUTES.roles, roleListSchema)
      .pipe(map((roles) => roles.map(toRole)));
  }

  get(id: string): Observable<Role | null> {
    return this.list().pipe(
      map((roles) => roles.find((role) => role.id === id) ?? null)
    );
  }

  /**
   * Grants or revokes one permission on one role.
   *
   * Granting a `.write` also grants its `.read`. That is not a convenience —
   * writing something you cannot read is not a state the API models, and
   * letting the matrix express it would produce a role that looks coherent on
   * screen and behaves oddly in practice. Revoking a `.read` revokes the
   * matching `.write` for the same reason.
   *
   * The resolved set is what travels, not the single toggle: the rule above can
   * change two entries for one click, and an endpoint receiving only the click
   * would have to reapply the same rule — two places deciding one thing. The
   * API still enforces it, because a rule that lives only in a client is a rule
   * every other client skips.
   */
  setPermission(
    role: Role,
    permission: PermissionKey,
    granted: boolean
  ): Observable<Role> {
    const held = new Set(role.permissions);

    if (granted) {
      held.add(permission);
      const read = impliedBy(permission);
      if (read) held.add(read);
    } else {
      held.delete(permission);
      // Dropping a read drops the write that depended on it.
      for (const candidate of held) {
        if (impliedBy(candidate) === permission) held.delete(candidate);
      }
    }

    return this.api
      .putValidated(
        pathFor(API_ROUTES.rolePermissions, { id: role.id }),
        { permissions: [...held].sort() },
        roleSchema
      )
      .pipe(map(toRole));
  }
}

/**
 * Message keys for the roles provisioning creates.
 *
 * The API returns a role's name and no description, deliberately: the
 * catalogue's descriptions are English text in a global table, and returning
 * them would give the product a permanently English roles screen. The
 * translation is chosen here, from the name.
 */
const DESCRIPTION_KEYS: Record<string, MessageKey> = {
  admin: "role.admin",
  viewer: "role.viewer",
  member: "role.member"
};

/**
 * A tenant may name a role anything, and there is no translation for a name
 * nobody anticipated — so an unrecognised role falls back to the generic
 * wording rather than rendering a raw key at someone.
 */
function toRole(role: RoleContract): Role {
  return {
    id: role.id,
    name: role.name,
    descriptionKey: DESCRIPTION_KEYS[role.name] ?? "role.member",
    permissions: [...role.permissions],
    userCount: role.userCount,
    builtIn: role.builtIn
  };
}
