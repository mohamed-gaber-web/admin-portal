export { createPool } from "./pool";
export { MIGRATIONS_DIR, MIGRATIONS_TABLE, PACKAGE_ROOT } from "./config";
export { REPO_ROOT, loadRepoEnv } from "./env";
export { checkDatabase, redactUrl, type DatabaseInfo } from "./preflight";
export {
  recordAuditEntry,
  listAuditEntries,
  redactValues,
  changedFields,
  isSecretKey,
  REDACTED,
  type AuditActor,
  type AuditEntry,
  type AuditValues,
  type RecordAuditEntryInput
} from "./audit";
export {
  withRequestTenantScope,
  withoutTenantScope,
  MissingTenantContextError,
  UnscopedAccessError,
  APPLICATION_ROLE,
  type UnscopedAccessOptions
} from "./scoping";
export {
  requestPasswordReset,
  completePasswordReset,
  generateResetToken,
  hashResetToken,
  InvalidPasswordResetError,
  DEFAULT_RESET_TTL_HOURS,
  type IssuedPasswordReset,
  type CompletedPasswordReset
} from "./password-reset";
export {
  issueRefreshToken,
  rotateRefreshToken,
  revokeRefreshTokenFamily,
  generateRefreshToken,
  hashRefreshToken,
  INVALID_SESSION_MESSAGE,
  REFRESH_TOKEN_TTL_DAYS,
  type IssuedRefreshToken,
  type IssueRefreshTokenInput,
  type RefreshResult,
  type RefreshFailure,
  type RotateRefreshTokenInput
} from "./refresh-tokens";
export {
  authenticate,
  loadPermissions,
  recordAuthEvent,
  INVALID_CREDENTIALS_MESSAGE,
  type AuthenticationResult,
  type AuthenticatedUser,
  type RecordAuthEventInput,
  type SignInInput
} from "./authentication";
export {
  issueInvitation,
  acceptInvitation,
  hashPassword,
  verifyPassword,
  hashInvitationToken,
  generateInvitationToken,
  invitationTokenMatches,
  burnPasswordHashingTime,
  InvalidInvitationError,
  UserAlreadyActiveError,
  DEFAULT_INVITATION_TTL_HOURS,
  PASSWORD_HASH_OPTIONS,
  type AcceptInvitationInput,
  type AcceptedInvitation,
  type IssueInvitationInput,
  type IssuedInvitation
} from "./invitations";
export {
  provisionTenant,
  provisionTenantOnClient,
  defaultAdminEmail,
  TenantAlreadyExistsError,
  DEFAULT_ROLES,
  DEFAULT_ADMIN_ROLE,
  type ProvisionTenantInput,
  type ProvisionTenantResult
} from "./provisioning";
export {
  withTenantContext,
  setTenantContext,
  findTablesMissingRlsPolicies,
  PROTECTED_TABLES,
  TENANT_SCOPED_TABLES,
  ROOT_TENANT_TABLE,
  TENANT_CONTEXT_SETTING,
  type UnprotectedTable
} from "./rls";
export {
  createTenant,
  createEnvironment,
  createCompany,
  listCompaniesForEnvironment,
  listEnvironmentsForTenant,
  listActiveTenants,
  findTenant,
  softDeleteTenant,
  restoreTenant,
  type Tenant,
  type Environment,
  type Company,
  type Queryable
} from "./tenancy";
export {
  seedDemoData,
  DEMO_TENANTS,
  DEMO_PERMISSIONS,
  type DemoTenant,
  type DemoUser,
  type DemoAuditEntry,
  type SeedSummary
} from "./seed";
