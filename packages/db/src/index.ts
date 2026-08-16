export { createPool } from "./pool";
export { MIGRATIONS_DIR, MIGRATIONS_TABLE, PACKAGE_ROOT } from "./config";
export { REPO_ROOT, loadRepoEnv } from "./env";
export { checkDatabase, redactUrl, type DatabaseInfo } from "./preflight";
export {
  orderByClause,
  limitOffset,
  likeArgument,
  toPage,
  type PageRequest,
  type PagedResult,
  type RowWithTotal
} from "./paging";
export {
  findPlatformTenant,
  isPlatformTenant,
  isPlatformPermissionKey,
  ensurePlatformAdmin,
  listPlatformAdmins,
  listPermissionCatalogue,
  PlatformTenantMissingError,
  PLATFORM_TENANT_SLUG,
  PLATFORM_ADMIN_ROLE,
  PLATFORM_PERMISSION_PREFIX,
  type PlatformTenant,
  type EnsurePlatformAdminResult,
  type PlatformAdminRecord,
  type CatalogPermissionRecord
} from "./platform";
export {
  listTenants,
  findTenantDetail,
  setTenantStatus,
  isUuid,
  type ListTenantsOptions,
  type TenantStatus,
  type TenantPlan,
  type TenantStatusTarget,
  type TenantSummary,
  type TenantDetail,
  type TenantEnvironmentRecord,
  type TenantCompanyRecord,
  type EnvironmentKind
} from "./tenant-administration";
export {
  listTenantModules,
  listOwnModules,
  setTenantModules,
  setTenantPlan,
  UNSUBSCRIBED_PLAN,
  type ModuleKey,
  type ModuleRecord,
  type SetTenantModulesInput,
  type SetTenantPlanInput
} from "./modules";
export {
  listUsers,
  findUserDetail,
  setUserStatus,
  setUserRoles,
  setUserName,
  UnknownRoleError,
  UserHasNoCredentialError,
  type UserStatus,
  type UserSummary,
  type UserDetail,
  type UserPageRequest
} from "./user-administration";
export {
  listRoles,
  findRole,
  setRolePermissions,
  UnknownPermissionError,
  PlatformPermissionNotGrantableError,
  PlatformRoleNotEditableError,
  type RoleRecord
} from "./role-administration";
export {
  sealSecret,
  openSecret,
  isSealed,
  resetSecretEncryptionKey,
  type SecretPurpose
} from "./secret-box";
/**
 * D365 connection configuration (US-040).
 *
 * `openClientSecret` is exported alongside the rest, and it is the one function
 * here that yields a usable credential. Its callers are the token client and
 * nothing else — every other consumer takes a `ConnectionRecord`, which has no
 * field a secret could travel in.
 */
export {
  listConnections,
  findConnection,
  saveConnection,
  recordConnectionCheck,
  credentialsForSave,
  openClientSecret,
  tokenUrlFor,
  scopeFor,
  daysUntilExpiry,
  secretNeedsAttention,
  AUTHORITY_HOSTS,
  SECRET_EXPIRY_WARNING_DAYS,
  type ConnectionRecord,
  type ConnectionCredentials,
  type ConnectionState,
  type ConnectionErrorCode,
  type ConnectionCheck,
  type AuthorityHost,
  type SaveConnectionInput
} from "./connections";
export {
  findMobileBootstrap,
  findMobileConfig,
  saveMobileConfig,
  type MobileConfigRecord,
  type MobileUserAuth,
  type SaveMobileConfigInput
} from "./mobile-config";
export {
  recordAuditEntry,
  listAuditEntries,
  listAuditPage,
  listAuditEntriesForTenant,
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
  beginMfaEnrolment,
  confirmMfaEnrolment,
  verifyMfa,
  mfaIsEnabled,
  countUnusedRecoveryCodes,
  generateRecoveryCode,
  hashRecoveryCode,
  normaliseRecoveryCode,
  InvalidMfaCodeError,
  MfaAlreadyEnabledError,
  RECOVERY_CODE_COUNT,
  type MfaEnrolment,
  type ConfirmedMfaEnrolment,
  type MfaVerification,
  type MfaFailure
} from "./mfa";
export {
  generateTotpSecret,
  verifyTotpCode,
  totpCodeNow,
  totpCodeForStep,
  totpStep,
  totpUri,
  encryptSecret,
  decryptSecret,
  resetMfaEncryptionKey,
  base32Encode,
  base32Decode,
  TOTP_PERIOD_SECONDS,
  TOTP_DIGITS,
  TOTP_WINDOW_STEPS
} from "./totp";
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
  loadAuthenticatedUser,
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
  MIN_PASSWORD_LENGTH,
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

/**
 * Account lockout (US-026).
 *
 * `LOCKOUT_THRESHOLD` is imported by the API's rate-limit guard, which asserts
 * at boot that the per-source limit sits below it — the relationship that stops
 * one source locking an account on demand.
 */
export {
  isLocked,
  registerFailedAttempt,
  clearFailedAttempts,
  LOCKOUT_THRESHOLD,
  LOCKOUT_MINUTES,
  type LockoutOutcome
} from "./lockout";
export {
  seedDemoData,
  DEMO_TENANTS,
  DEMO_PERMISSIONS,
  DEMO_PLATFORM_ADMIN,
  type DemoTenant,
  type DemoUser,
  type DemoAuditEntry,
  type SeedSummary
} from "./seed";
