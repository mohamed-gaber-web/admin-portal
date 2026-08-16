/**
 * The portal's model surface.
 *
 * Anything shared with the API is re-exported from `@growpath/contracts` rather
 * than redeclared — a duplicated interface drifts silently, whereas a re-export
 * breaks the build the moment the contract changes. Only types the API has no
 * opinion about (view state, navigation, table shape) are declared locally.
 */

export type {
  Authenticated,
  SignInInput,
  AcceptInvitationInput,
  AcceptedInvitation,
  CreateTenantInput,
  ProvisionedTenant,
  IssuedInvitation
} from "@growpath/contracts";

export * from "./nav.model";
export * from "./page.model";
export * from "./permission.model";
export * from "./tenant.model";
export * from "./user.model";
export * from "./activity.model";
export * from "./metric.model";
