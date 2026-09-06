/**
 * English messages. The source catalogue.
 *
 * `en` is the shape every other locale is typed against: `ar.ts` declares
 * `Messages`, so a key added here and forgotten there is a compile error rather
 * than a string that silently renders in English for Arabic readers.
 *
 * Keys are flat and dotted, grouped by the screen that owns them, with
 * `common.*` for anything used in more than one place. Flat rather than nested
 * because it makes the key a single string literal — which is what lets
 * `MessageKey` be a union, and a typo a compile error.
 *
 * Interpolation is `{name}`. Plurals use a `.zero/.one/.two/.few/.many/.other`
 * family resolved by `Intl.PluralRules` — Arabic uses all six, and picking the
 * form with `count === 1 ? a : b` is wrong in Arabic for 0, 2, and 3–10.
 *
 * A string that reaches a user belongs here. `scripts/check-i18n.mjs` fails CI
 * on any bare literal left in a template.
 */
export const en = {
  // ── Brand ────────────────────────────────────────────────────────────────
  "app.name": "Grow Path",
  "app.subtitle": "Admin portal",

  // ── Common ───────────────────────────────────────────────────────────────
  "common.cancel": "Cancel",
  "common.done": "Done",
  "common.close": "Close",
  "common.search": "Search",
  "common.searchPlaceholder": "Search…",
  "common.refresh": "Refresh",
  "common.tryAgain": "Try again",
  "common.viewAll": "View all",
  "common.clearFilters": "Clear filters",
  "common.clearSearch": "Clear search",
  "common.actions": "Actions",
  "common.status": "Status",
  "common.never": "Never",
  "common.unknown": "Unknown",
  "common.justNow": "Just now",
  "common.required": "This is required.",
  "common.somethingWentWrong": "Something went wrong",
  "common.loading": "Loading",
  "common.allStatuses": "All statuses",
  "common.previousPage": "Previous page",
  "common.nextPage": "Next page",
  "common.showingRange": "Showing {start}–{end} of {total}",

  // ── Navigation ───────────────────────────────────────────────────────────
  "nav.overview": "Overview",
  "nav.manage": "Manage",
  "nav.workspace": "Workspace",
  "nav.dashboard": "Dashboard",
  "nav.tenants": "Tenants",
  "nav.users": "Users",
  "nav.roles": "Roles",
  "nav.activity": "Activity",
  "nav.settings": "Settings",
  "nav.main": "Main",
  "nav.platform": "Platform",
  "nav.allTenants": "All tenants",
  "nav.allUsers": "All users",
  "nav.packages": "Packages",
  "nav.superAdmins": "Super administrators",
  "nav.permissions": "Permissions",
  "nav.configuration": "Configuration",

  // ── Top bar ──────────────────────────────────────────────────────────────
  "topbar.openNavigation": "Open navigation",
  "topbar.expandSidebar": "Expand sidebar",
  "topbar.collapseSidebar": "Collapse sidebar",
  "topbar.notifications": "Notifications",
  "topbar.accountMenu": "Account menu for {name}",
  "topbar.signOut": "Sign out",

  // ── Theme and language ───────────────────────────────────────────────────
  "theme.label": "Colour theme",
  "theme.light": "Light",
  "theme.dark": "Dark",
  "theme.system": "Match system",
  "locale.label": "Language",

  // ── Sign in ──────────────────────────────────────────────────────────────
  // ── The brand panel beside every signed-out screen ───────────────────────
  "auth.panelTitle": "Every workspace, under one roof.",
  "auth.panelBody": "Provision tenants, invite their admins, and see what changed.",
  "auth.panelTenants": "Provision a tenant in one step",
  "auth.panelRoles": "Roles and permissions you can audit",
  "auth.panelAudit": "A record of every change, by whom",
  "auth.panelFooter": "Per-tenant isolation and two-step verification.",

  "login.title": "Sign in",
  "login.subtitle": "Enter your email and password to continue.",
  "login.email": "Email",
  "login.password": "Password",
  "login.showPassword": "Show password",
  "login.hidePassword": "Hide password",
  "login.submit": "Sign in",
  "login.submitting": "Signing in…",
  "login.failed": "Sign-in failed. Try again shortly.",
  "login.demoTitle": "Demo mode",
  "login.demoBody":
    "No API is running and none is called. Any details sign you in — the form is prefilled, so just press the button. Use {password} as the password for the rejected-credentials state, or {mfaPassword} for the two-step verification prompt.",

  // ── Invitation ───────────────────────────────────────────────────────────
  "invite.title": "Set your password",
  "invite.subtitle": "Choose a password to finish setting up your account.",
  "invite.doneTitle": "You are all set",
  "invite.doneBody": "Your password is saved. Sign in to continue.",
  "invite.goToSignIn": "Go to sign in",
  "invite.invalidTitle": "This link is not valid",
  "invite.invalidBody":
    "The invitation token is missing. Open the link from your invitation email again, or ask an administrator to reissue it — tokens are stored as a digest and cannot be looked up.",
  "invite.newPassword": "New password",
  "invite.passwordHint": "At least {count} characters. A passphrase works well.",
  "invite.confirmPassword": "Confirm password",
  "invite.submit": "Save password",
  "invite.tooShort": "Use at least {count} characters.",
  "invite.mismatch": "The passwords do not match.",
  "invite.failed": "That invitation could not be redeemed.",

  // ── Multi-factor authentication ──────────────────────────────────────────
  "mfa.title": "Two-step verification",
  "mfa.subtitle": "Enter the 6-digit code from your authenticator app.",
  "mfa.codeLabel": "Verification code",
  "mfa.digit": "Digit",
  "mfa.verify": "Verify",
  "mfa.verifying": "Verifying…",
  "mfa.useRecovery": "Use a recovery code instead",
  "mfa.useAuthenticator": "Use your authenticator app instead",
  "mfa.recoveryLabel": "Recovery code",
  "mfa.recoveryHint": "One of the codes you saved when you set up verification.",
  "mfa.failed": "That code was not accepted.",
  "mfa.expired": "This sign-in attempt has expired. Sign in again.",
  "mfa.backToSignIn": "Back to sign in",

  "mfaSetup.title": "Two-step verification",
  "mfaSetup.subtitle": "Adds a code from your phone to every sign-in.",
  "mfaSetup.start": "Set up two-step verification",
  "mfaSetup.starting": "Preparing…",
  "mfaSetup.scanTitle": "Scan this with your authenticator app",
  "mfaSetup.scanBody":
    "Google Authenticator, 1Password, Authy — any app that supports time-based codes.",
  "mfaSetup.manualLabel": "Or enter this key by hand",
  "mfaSetup.copyKey": "Copy setup key",
  "mfaSetup.confirmLabel": "Enter the 6-digit code to confirm",
  "mfaSetup.confirm": "Confirm and enable",
  "mfaSetup.confirming": "Confirming…",
  "mfaSetup.qrFailed": "The QR code could not be drawn. Enter the key by hand instead.",
  "mfaSetup.failed": "Two-step verification could not be enabled.",
  "mfaSetup.recoveryTitle": "Save your recovery codes",
  "mfaSetup.recoveryBody":
    "Each code works once, and only these are stored. If you lose your phone and these codes, an administrator has to reset your account.",
  "mfaSetup.recoveryWarning": "These are shown once",
  "mfaSetup.copyCodes": "Copy all codes",
  "mfaSetup.codesCopied": "Recovery codes copied",
  "mfaSetup.enabled": "Two-step verification is on",
  "mfaSetup.cancel": "Not now",

  // ── Password reset ───────────────────────────────────────────────────────
  "forgot.title": "Reset your password",
  "forgot.subtitle": "We will send a reset link to the address on your account.",
  "forgot.submit": "Send reset link",
  "forgot.submitting": "Sending…",
  "forgot.backToSignIn": "Back to sign in",
  "forgot.sentTitle": "Check your email",
  // Says nothing about whether the account exists. The API answers identically
  // either way precisely so this response cannot be used to discover accounts,
  // and wording like "if we found your account" hands that back.
  "forgot.sentBody":
    "If those details match an account, a reset link is on its way. The link expires shortly, so use it soon.",
  "forgot.failed": "The reset request could not be sent.",

  "reset.title": "Choose a new password",
  "reset.subtitle": "Then sign in with it to confirm.",
  "reset.newPassword": "New password",
  "reset.confirmPassword": "Confirm new password",
  "reset.submit": "Save new password",
  "reset.doneTitle": "Password changed",
  "reset.doneBody":
    "Every other session was signed out. Sign in with your new password.",
  "reset.invalidTitle": "This link is not valid",
  "reset.invalidBody":
    "The reset token is missing. Request a new link — tokens expire quickly and can only be used once.",
  "reset.failed": "That reset link could not be used.",

  // ── Dashboard ────────────────────────────────────────────────────────────
  "dashboard.morning": "Good morning",
  "dashboard.afternoon": "Good afternoon",
  "dashboard.evening": "Good evening",
  "dashboard.greeting": "{greeting}, {name}",
  "dashboard.subtitle": "Here is what has happened across {tenant} recently.",
  "dashboard.manageTenants": "Manage tenants",
  "dashboard.keyMetrics": "Key metrics",
  "dashboard.deltaCaption": "Change is against the previous 30 days.",
  "dashboard.growth": "Growth",
  "dashboard.growthSubtitle": "Tenants and users over time.",
  "dashboard.attention": "Needs attention",
  "dashboard.attentionSubtitle": "Ranked by what to look at first.",
  "dashboard.attentionClear": "All clear",
  "dashboard.attentionClearBody": "Nothing needs attention right now.",
  "dashboard.recentActivity": "Recent activity",
  "dashboard.recentActivitySubtitle": "From the audit log.",
  "dashboard.plans": "Tenants by plan",
  "dashboard.plansSubtitle": "Share of all active tenants.",
  "dashboard.loadFailed": "The dashboard did not load",
  "dashboard.loadError": "Could not load the dashboard.",
  "dashboard.loadingLabel": "Loading dashboard",
  "dashboard.seriesTenants": "Tenants",
  "dashboard.seriesUsers": "Users",
  "dashboard.range30d": "30d",
  "dashboard.range90d": "90d",
  "dashboard.range12m": "12m",

  // Metric labels. Held here rather than in the fixture so the tiles are
  // translated the day the metrics endpoint replaces it — an API returning
  // display text in one language is the usual way localisation gets stuck.
  "metric.tenants": "Active tenants",
  "metric.users": "Total users",
  "metric.invitations": "Pending invitations",
  "metric.failedSignins": "Failed sign-ins",

  "attention.failedSignins.title": "Failed sign-ins up 22%",
  "attention.failedSignins.detail": "17 in the last 30 days, across 3 tenants",
  "attention.staleInvitations.title": "9 invitations expiring soon",
  "attention.staleInvitations.detail": "Unredeemed for more than 5 days",
  "attention.suspended.title": "1 tenant suspended",
  "attention.suspended.detail": "Initech · suspended 6 weeks ago",
  "attention.trials.title": "4 trials ending this month",
  "attention.trials.detail": "No plan selected yet",

  // ── Tenants ──────────────────────────────────────────────────────────────
  "tenants.title": "Tenants",
  "tenants.subtitle": "Every workspace on the platform, with its plan and headcount.",
  "tenants.new": "New tenant",
  "tenants.searchPlaceholder": "Search tenants…",
  "tenants.searchLabel": "Search tenants",
  "tenants.columnTenant": "Tenant",
  "tenants.columnPlan": "Plan",
  "tenants.columnUsers": "Users",
  "tenants.seatsUsed": "{used} / {limit}",
  "tenants.columnCreated": "Created",
  "tenants.emptyTitle": "No tenants yet",
  "tenants.emptyBody": "Provision the first workspace to get started.",
  "tenants.noMatchTitle": "No tenants match that search",
  "tenants.noMatchBody": "Nothing found for “{query}”.",
  "tenants.loadFailed": "Tenants did not load",
  "tenants.loadError": "Could not load tenants.",
  "tenants.loadingLabel": "Loading tenants",

  "tenantStatus.active": "Active",
  "tenantStatus.pending": "Pending",
  "tenantStatus.suspended": "Suspended",
  "tenantStatus.archived": "Archived",
  "plan.trial": "Trial",
  "plan.starter": "Starter",
  "plan.growth": "Growth",
  "plan.enterprise": "Enterprise",

  "confirm.typeToConfirm": "Type {phrase} to confirm",

  // ── Tenant detail ────────────────────────────────────────────────────────
  "tenantDetail.back": "All tenants",
  "tenantDetail.overview": "Overview",
  "tenantDetail.adminEmail": "First admin",
  "tenantDetail.created": "Created",
  "tenantDetail.userCount": "Users",
  "tenantDetail.viewUsers": "View users",
  "tenantDetail.loadFailed": "This tenant did not load",
  "tenantDetail.loadError": "Could not load this tenant.",
  "tenantDetail.loadingLabel": "Loading tenant",
  "tenantDetail.notFoundTitle": "No such tenant",
  "tenantDetail.notFoundBody":
    "It may have been archived, or the address may be wrong.",

  "tenantDetail.environments": "D365 environments",
  "tenantDetail.environmentsSubtitle":
    "Each environment holds its own legal entities.",
  "tenantDetail.environmentsEmpty": "No environments yet",
  "tenantDetail.environmentsEmptyBody":
    "This tenant has no D365 environment configured.",
  "tenantDetail.companies": "Legal entities",
  "tenantDetail.companiesEmpty": "No legal entities in this environment.",
  "tenantDetail.dataAreaId": "Data area",

  "environmentKind.production": "Production",
  "environmentKind.sandbox": "Sandbox",
  "connection.connected": "Connected",
  "connection.failing": "Failing",
  "connection.not_configured": "Not configured",

  "tenantDetail.activity": "Activity",
  "tenantDetail.activitySubtitle": "Audit entries for this tenant.",
  "tenantDetail.activityEmpty": "Nothing recorded for this tenant yet.",

  // ── Tenant lifecycle ─────────────────────────────────────────────────────
  "lifecycle.title": "Lifecycle",
  "lifecycle.subtitle": "Suspend, archive or restore this workspace.",
  "lifecycle.suspend": "Suspend",
  "lifecycle.reactivate": "Reactivate",
  "lifecycle.archive": "Archive",
  "lifecycle.restore": "Restore",

  "lifecycle.suspendTitle": "Suspend this tenant?",
  "lifecycle.suspendBody":
    "Nobody in {name} will be able to sign in until it is reactivated. Nothing is deleted.",
  "lifecycle.archiveTitle": "Archive this tenant?",
  "lifecycle.archiveBody":
    "{name} disappears from every screen and nobody in it can sign in. Its data is kept and it can be restored.",
  "lifecycle.archiveWarning":
    "This hides the tenant everywhere. Check you have the right one.",
  "lifecycle.reactivateTitle": "Reactivate this tenant?",
  "lifecycle.reactivateBody": "People in {name} will be able to sign in again.",
  "lifecycle.restoreTitle": "Restore this tenant?",
  "lifecycle.restoreBody": "{name} becomes visible and usable again.",

  "lifecycle.suspended": "{name} suspended",
  "lifecycle.reactivated": "{name} reactivated",
  "lifecycle.archived": "{name} archived",
  "lifecycle.restored": "{name} restored",
  "lifecycle.failed": "That change could not be applied.",
  // Named so an operator can search the audit log for exactly this entry.
  "lifecycle.auditNote": "Recorded in the audit log as {action}.",

  // ── Create tenant ────────────────────────────────────────────────────────
  "createTenant.title": "New tenant",
  "createTenant.subtitle":
    "Provisions the tenant, its default roles and its first admin.",
  "createTenant.createdTitle": "Tenant created",
  "createTenant.createdSubtitle": "Copy the invitation link before you close this.",
  "createTenant.tokenWarningTitle": "This token is shown once",
  "createTenant.tokenWarningBody":
    "It is stored as a digest and cannot be read back. If it is lost, the invitation has to be reissued.",
  "createTenant.invitationLink": "Invitation link",
  "createTenant.copyLink": "Copy invitation link",
  "createTenant.expiresFor": "Expires {date} · for {email}",
  "createTenant.name": "Name",
  "createTenant.namePlaceholder": "Acme Corporation",
  "createTenant.slug": "Slug",
  "createTenant.slugHint": "Lowercase letters, numbers and dashes. Used to sign in.",
  "createTenant.slugInvalid": "Lowercase letters, numbers and dashes only.",
  "createTenant.adminEmail": "Admin email",
  "createTenant.adminEmailHint": "Optional. Defaults to admin@{slug}.local.",
  "createTenant.submit": "Create tenant",
  "createTenant.copyFailed": "Could not copy",
  "createTenant.copyFailedBody": "Select the link and copy it manually.",
  "createTenant.created": "{name} created",
  "createTenant.createdToast": "Copy the invitation link before closing.",
  "createTenant.failed": "The tenant could not be created.",

  // ── Platform (cross-tenant) ──────────────────────────────────────────────
  "platformTenants.title": "All tenants",
  "platformTenants.subtitle":
    "Every tenant on this installation. Actions here affect customers who cannot see you.",
  "platformTenants.emptyTitle": "No tenants yet",
  "platformTenants.emptyBody": "Create the first one to get a customer started.",
  "platformTenants.emptyBodyNoCreate":
    "Tenants are provisioned outside the portal. Ask whoever operates this installation to add one.",
  "platformTenants.rowActions": "Actions for {name}",

  "platformTenantDetail.back": "All tenants",

  // Subscription and plan (US-072)
  "subscription.title": "Subscription",
  "subscription.subtitle": "What this customer pays for.",
  "subscription.currentPlan": "Current plan",
  "subscription.choosePlan": "Choose a plan",
  "subscription.savePlan": "Save plan",
  "subscription.saved": "Moved to {plan}.",
  "subscription.failed": "The plan could not be changed.",
  "subscription.unsubscribe": "Unsubscribe",
  "subscription.unsubscribeTitle": "Cancel this subscription?",
  "subscription.unsubscribeBody":
    "{name} returns to the trial plan. Their people keep their access — cancelling a subscription is not the same as suspending a tenant.",
  "subscription.unsubscribeWarning":
    "Recorded in the audit log as an unsubscription, which is the only thing that distinguishes it from a downgrade afterwards.",
  "subscription.unsubscribeConfirm": "Unsubscribe",
  "subscription.unsubscribed": "{name} has been unsubscribed.",
  // Seats — what the package includes, and how many are taken.
  "subscription.seats": "Seats",
  "subscription.seatsUsed": "{used} of {limit} used",
  "subscription.planSeats": "{count} users",
  "subscription.downgradeTitle": "This package has fewer seats",
  // Negotiated seat allowance, per tenant.
  "seats.overrideLabel": "Seats for this tenant",
  "seats.save": "Save seats",
  "seats.usePackage": "Use package default",
  "seats.inheriting": "Inheriting {limit} from the package.",
  "seats.negotiated": "Negotiated: {limit} seats for this tenant.",
  "seats.belowUsage": "This tenant already has {used} users, more than the {limit} you are setting. Nobody is removed, but no new user can be invited until they are back within it.",
  "seats.savedToast": "Seat allowance set to {limit}.",
  "seats.clearedToast": "Back on the package default of {limit}.",
  "seats.failed": "The seat allowance could not be changed.",
  "subscription.downgradeBody":
    "This tenant has {used} users, and {plan} includes {limit}. The change is allowed, but nobody new can be invited until they are back within the allowance.",

  // Creating a tenant: the package it starts on.
  "createTenant.plan": "Package",
  "createTenant.planHint": "Sets how many users the tenant may have. It can be changed later.",
  "createTenant.planSeats": "{count} users",
  // Renaming a tenant, and its lifecycle, from the detail screen.
  "tenantDetail.pendingTitle": "Waiting for the first sign-in",
  "tenantDetail.pendingBody": "This tenant stays pending until someone signs in for the first time. {email} was invited but has not accepted yet — the status becomes active by itself once they set their password. Reactivating does not change it, because nothing here is suspended.",
  "tenantDetail.resendInvite": "Send a new invitation",
  "tenantDetail.inviteFor": "New invitation for {email}",
  "tenantDetail.inviteExpires": "Expires {date}. This link is shown once — copy it now.",
  "tenantDetail.resendFailed": "The invitation could not be issued.",
  "tenantDetail.rename": "Rename",
  "tenantDetail.renameSave": "Save name",
  "tenantDetail.renameTitle": "Rename tenant",
  "tenantDetail.renameSubtitle": "Changes the display name only. Everything else stays as it is.",
  "tenantDetail.slugFixed": "The identifier cannot be changed — people sign in with it, and invitations already sent carry it.",
  "tenantDetail.renamed": "Renamed to {name}.",
  "tenantDetail.renameFailed": "The tenant could not be renamed.",

  // Package catalogue — the seats each package includes (platform screen).
  "packages.title": "Packages",
  "packages.subtitle": "What each package includes, and how many tenants hold it.",
  "packages.catalogueTitle": "Seats per package",
  "packages.catalogueBody":
    "Changing a number here moves every tenant on that package that has no seat allowance of its own. Tenants given a negotiated figure keep it.",
  "packages.columnPackage": "Package",
  "packages.columnSeats": "Seats included",
  "packages.columnTenants": "Tenants",
  "packages.columnActions": "Actions",
  "packages.seatsFor": "Seats included in {plan}",
  "packages.save": "Save",
  "packages.savedToast": "{plan} now includes {limit} users.",
  "packages.saveFailed": "The package could not be updated.",
  "packages.loadFailed": "Packages could not be loaded",
  "packages.loadError": "The package catalogue could not be loaded.",
  "packages.loadingLabel": "Loading packages",
  "packages.reachNote":
    "Takes effect immediately. A tenant already over a reduced allowance keeps every user it has — it simply cannot add another until it is back within the number.",

  // Module entitlements (US-072)
  "modules.title": "Modules",
  "modules.subtitle": "Which parts of the product this customer may use.",
  "modules.save": "Save modules",
  "modules.saved": "Modules updated.",
  "modules.failed": "The modules could not be saved.",
  "modules.loadFailed": "Could not load modules",
  "modules.loadError": "The modules could not be loaded.",
  "modules.loadingLabel": "Loading modules",
  "modules.enabledSince": "Enabled {date}",
  "module.van-sales": "Van sales",
  "module.van-sales.description": "Mobile order capture and delivery on a route.",
  "module.warehouse": "Warehouse",
  "module.warehouse.description": "Stock counts, transfers and picking.",
  "module.field-service": "Field service",
  "module.field-service.description": "Work orders and site visits.",
  "module.analytics": "Analytics",
  "module.analytics.description": "Dashboards over the tenant's D365 data.",

  // Super administrators
  "platformAdmins.title": "Super administrators",
  "platformAdmins.subtitle": "Everybody who can act across every tenant.",
  "platformAdmins.new": "New super administrator",
  "platformAdmins.newTitle": "New super administrator",
  "platformAdmins.newSubtitle": "Creates the account and issues a one-time invitation.",
  "platformAdmins.reachWarningTitle": "This grants reach over every tenant",
  "platformAdmins.reachWarningBody":
    "A super administrator can read and act on every customer on this installation. Only add somebody who operates it.",
  "platformAdmins.email": "Email",
  "platformAdmins.emailInvalid": "Enter a valid email address.",
  "platformAdmins.name": "Name",
  "platformAdmins.nameHint": "Optional. Shown instead of the address where there is room.",
  "platformAdmins.submit": "Create",
  "platformAdmins.createdTitle": "Super administrator created",
  "platformAdmins.createdSubtitle": "Copy the invitation link before you close this.",
  "platformAdmins.tokenWarningTitle": "This link is shown once",
  "platformAdmins.tokenWarningBody":
    "Only a digest is stored, so nothing can show it again. A lost link is reissued, never recovered.",
  "platformAdmins.invitationLink": "Invitation link",
  "platformAdmins.copyLink": "Copy invitation link",
  "platformAdmins.copied": "Invitation link copied.",
  "platformAdmins.expiresFor": "Expires {date} · for {email}",
  "platformAdmins.alreadyTitle": "Already a super administrator",
  "platformAdmins.alreadyBody":
    "{email} already has an active account, so nothing was changed. If they cannot sign in, use password reset.",
  "platformAdmins.failed": "The super administrator could not be created.",
  "platformAdmins.loadFailed": "Could not load super administrators",
  "platformAdmins.loadError": "The list could not be loaded.",
  "platformAdmins.loadingLabel": "Loading super administrators",
  "platformAdmins.emptyTitle": "No super administrators",
  "platformAdmins.emptyBody":
    "Run pnpm platform-admin on the machine that holds the database credentials to create the first one.",
  "platformAdmins.columnOperator": "Operator",
  "platformAdmins.columnLastSignIn": "Last sign-in",
  "platformAdmins.neverSignedIn": "Never",
  "platformAdmins.you": "(you)",

  // Permission catalogue
  "platformPermissions.title": "Permissions",
  "platformPermissions.subtitle":
    "Every permission this installation defines, and how widely each is held.",
  "platformPermissions.tenantScoped": "Tenant permissions",
  "platformPermissions.tenantScopedBody":
    "Granted by a tenant's own administrator, and they authorise nothing outside that tenant.",
  "platformPermissions.platformScoped": "Platform permissions",
  "platformPermissions.platformScopedBody":
    "Reach across every tenant. The database refuses to grant these to any role outside the platform tenant.",
  "platformPermissions.crossTenant": "Cross-tenant",
  "platformPermissions.columnKey": "Key",
  "platformPermissions.columnMeaning": "What it authorises",
  "platformPermissions.columnRoles": "Roles holding it",
  "platformPermissions.loadFailed": "Could not load permissions",
  "platformPermissions.loadError": "The catalogue could not be loaded.",
  "platformPermissions.loadingLabel": "Loading permissions",

  // Configuration (US-065, US-040)
  "configuration.title": "Configuration",
  "configuration.subtitle": "Connect Dynamics 365 and tell the mobile app where to look.",
  "configuration.tabConnections": "D365 connections",
  "configuration.tabMobile": "Mobile app",
  "configuration.tabModules": "Modules",
  "configuration.readOnlyTitle": "You have view-only access",
  "configuration.readOnlyConnections":
    "Your role can see the D365 connections but not change them. Ask an administrator to update a credential.",
  "configuration.readOnlyMobile":
    "Your role can see the mobile app configuration but not change it. Ask an administrator to update it.",

  "ownModules.title": "Your modules",
  "ownModules.subtitle":
    "What your organisation is licensed for. Changing this is handled by your account manager.",
  "ownModules.included": "Included",
  "ownModules.notIncluded": "Not included",

  "connections.title": "D365 connections",
  "connections.subtitle":
    "One credential per environment. Saving runs a live check first — nothing is stored unless it passes.",
  "connections.loadFailed": "Could not load connections",
  "connections.loadError": "The connections could not be loaded.",
  "connections.loadingLabel": "Loading connections",
  "connections.emptyTitle": "No environments",
  "connections.emptyBody":
    "A connection belongs to an environment, so there is nothing to configure until this tenant has one.",
  "connections.entraTenantId": "Directory (tenant) ID",
  "connections.entraTenantIdHint": "The Entra directory GUID.",
  "connections.clientId": "Application (client) ID",
  "connections.clientIdHint": "The registered application's GUID.",
  "connections.clientSecret": "Client secret",
  "connections.clientSecretKeepHint": "Leave empty to keep the stored secret.",
  "connections.clientSecretFirstHint": "Required — no secret is stored for this environment yet.",
  "connections.clientSecretStored": "A client secret is stored for this environment. It is never displayed.",
  "connections.clientSecretMissing": "No client secret is stored for this environment yet.",
  "connections.secretRequired": "A client secret is required the first time.",
  "connections.guidInvalid": "Enter a GUID.",
  "connections.authorityHost": "Authority host",
  "connections.authorityHostHint": "Change only for a sovereign cloud.",
  "connections.secretExpiresAt": "Secret expires",
  "connections.secretExpiresAtHint": "Optional. Entra does not report this, so it is typed in.",
  "connections.secretExpiring": "This client secret expires in {days} days.",
  "connections.secretExpired": "This client secret has expired. D365 calls will fail until it is replaced.",
  "connections.tokenUrl": "Token URL",
  "connections.scope": "Scope",
  "connections.save": "Save and test",
  "connections.saveHint": "The credential is checked against Entra before anything is stored.",
  "connections.saved": "{name} connected.",
  "connections.saveFailed": "The connection could not be saved.",
  "connections.test": "Test",
  "connections.testPassed": "The connection is working.",
  "connections.testFailed": "The connection test failed",
  "connections.testError": "The test could not be run.",
  "connections.lastChecked": "Last checked {date}",
  "connections.error.invalid_client": "The client ID or secret was rejected. The secret has usually expired.",
  "connections.error.invalid_tenant": "The directory does not know that application. Check the directory ID.",
  "connections.error.invalid_scope":
    "Authenticated, but not entitled to this environment. The application is missing a role.",
  "connections.error.unreachable": "Entra or the environment did not answer.",
  "connections.error.unexpected": "The check failed for an unexpected reason.",

  "mobileConfig.title": "Mobile app configuration",
  "mobileConfig.subtitle": "What devices download at launch, instead of a bundled settings file.",
  "mobileConfig.loadFailed": "Could not load the mobile configuration",
  "mobileConfig.loadError": "The mobile configuration could not be loaded.",
  "mobileConfig.loadingLabel": "Loading the mobile configuration",
  "mobileConfig.apiBaseUrl": "API base URL",
  "mobileConfig.apiBaseUrlHint":
    "Every device in the field sends its requests here. Must be https.",
  "mobileConfig.apiBaseUrlInvalid": "Enter an absolute https:// URL.",
  "mobileConfig.minimumAppVersion": "Minimum app version",
  "mobileConfig.minimumAppVersionHint": "Optional. Older builds are asked to update.",
  "mobileConfig.userAuthTitle": "Entra sign-in",
  "mobileConfig.userAuthSubtitle":
    "The public client the app signs users in with. Turn this off once the tenant uses portal sign-in.",
  "mobileConfig.userAuthEnabled": "Enabled",
  "mobileConfig.userAuthCleared":
    "This tenant uses portal sign-in. The app will be told there is no Entra client, which is different from one configured with blanks.",
  "mobileConfig.clientId": "Client ID",
  "mobileConfig.clientIdHint": "A public client, so it holds no secret.",
  "mobileConfig.authority": "Authority",
  "mobileConfig.redirectUri": "Redirect URI",
  "mobileConfig.scopes": "Scopes",
  "mobileConfig.scopesHint": "Comma separated.",
  "mobileConfig.save": "Save configuration",
  "mobileConfig.create": "Create configuration",
  "mobileConfig.notConfiguredTitle": "Not configured yet",
  "mobileConfig.notConfiguredBody":
    "Devices for this workspace cannot start until this is saved. Fill in the API address, then add the sign-in client if the tenant still uses Entra.",
  "mobileConfig.saved": "Mobile configuration saved.",
  "mobileConfig.failed": "The configuration could not be saved.",
  "mobileConfig.updatedAt": "Last changed {date}",

  "platformUsers.title": "All users",
  "platformUsers.subtitle": "Everyone with an account, across every tenant.",
  "platformInvite.action": "Add user",
  "platformInvite.newTitle": "Add a user to a tenant",
  "platformInvite.newSubtitle":
    "Issues an invitation into the tenant you choose. They set their own password when they accept it.",
  "platformInvite.tenantLabel": "Tenant",
  "platformInvite.tenantHint": "Which workspace this person is being added to.",
  "platformInvite.roleHint":
    "The two roles every tenant is created with. A tenant that renamed its roles will refuse this, and say so.",
  "platformInvite.failed": "The invitation could not be issued.",
  "platformInvite.tenantsFailed": "The tenant list could not be loaded.",
  "platformUsers.searchPlaceholder": "Search by name, email or tenant",
  "platformUsers.emptyTitle": "No users match",
  "platformUsers.emptyBody": "Try a different search or clear the status filter.",
  "platformUsers.reactivate": "Restore access",
  "platformUsers.confirmTitle": "Change access for {name}?",
  "platformUsers.confirmSuspend":
    "They will be signed out of {tenant} and unable to sign in again until this is undone.",
  "platformUsers.confirmReactivate": "They will be able to sign in to {tenant} again.",
  "platformUsers.updated": "{name} updated",
  "platformUsers.updateFailed": "That change could not be applied.",

  // ── Users ────────────────────────────────────────────────────────────────
  "users.title": "Users",
  "users.subtitle": "Everyone with an account, across every tenant.",
  "users.invite": "Invite user",
  "users.searchPlaceholder": "Search name, email or tenant…",
  "users.searchLabel": "Search users",
  "users.filterStatus": "Filter by status",
  "users.columnUser": "User",
  "users.columnTenant": "Tenant",
  "users.columnRole": "Role",
  "users.columnLastSeen": "Last seen",
  "users.emptyTitle": "No users match these filters",
  "users.emptyBody": "Try a different search term, or clear the status filter.",
  "users.loadFailed": "Users did not load",
  "users.loadError": "Could not load users.",
  "users.loadingLabel": "Loading users",
  "users.rowActions": "Actions for {name}",
  "users.viewProfile": "View profile",
  "users.resendInvitation": "Resend invitation",
  "users.suspend": "Suspend access",

  "userStatus.active": "Active",
  "userStatus.invited": "Invited",
  "userStatus.suspended": "Suspended",

  // ── User detail ──────────────────────────────────────────────────────────
  "userDetail.back": "All users",
  "userDetail.overview": "Overview",
  "userDetail.roles": "Roles",
  "userDetail.rolesSubtitle": "What this person can do in their workspace.",
  "userDetail.rolesEmpty": "No roles assigned",
  "userDetail.rolesEmptyBody": "This person can sign in but can do nothing yet.",
  "userDetail.assignRole": "Assign a role",
  "userDetail.removeRole": "Remove {role}",
  "userDetail.created": "Added",
  "userDetail.invitedBy": "Invited by",
  "userDetail.invitedByNobody": "Created with the tenant",
  "userDetail.lastSeen": "Last seen",
  "userDetail.viewTenant": "View tenant",
  "userDetail.loadFailed": "This user did not load",
  "userDetail.loadError": "Could not load this user.",
  "userDetail.loadingLabel": "Loading user",
  "userDetail.notFoundTitle": "No such user",
  "userDetail.notFoundBody": "They may have been removed, or the address may be wrong.",

  "userDetail.access": "Access",
  "userDetail.accessSubtitle": "Suspend or restore this account.",
  "userAction.suspend": "Suspend access",
  "userAction.reactivate": "Restore access",
  "userAction.resendInvitation": "Resend invitation",
  "userAction.suspendTitle": "Suspend this account?",
  "userAction.suspendBody":
    "{name} will not be able to sign in until access is restored. Nothing is deleted.",
  "userAction.reactivateTitle": "Restore access?",
  "userAction.reactivateBody": "{name} will be able to sign in again.",
  "userAction.suspended": "{name} suspended",
  "userAction.reactivated": "{name} restored",
  "userAction.invitationResent": "Invitation resent to {name}",
  "userAction.failed": "That change could not be applied.",
  "userAction.roleAssigned": "{role} assigned",
  "userAction.roleRemoved": "{role} removed",

  // ── Invite user ──────────────────────────────────────────────────────────
  "invite.newTitle": "Invite a user",
  "invite.newSubtitle": "They set their own password from the link.",
  "invite.emailLabel": "Email",
  "invite.roleLabel": "Role",
  "invite.roleHint": "What they can do once they accept.",
  "invite.send": "Create invitation",
  "invite.createdTitle": "Invitation created",
  "invite.createdSubtitle": "Copy the link before you close this.",
  "invite.linkLabel": "Invitation link",
  "invite.copyLink": "Copy invitation link",
  "invite.expires": "Expires {date}",
  "invite.newFailed": "The invitation could not be created.",

  // ── Roles and permissions ────────────────────────────────────────────────
  "roles.title": "Roles",
  "roles.subtitle": "What each role in this workspace is allowed to do.",
  "roles.columnRole": "Role",
  "roles.columnUsers": "Users",
  "roles.columnPermissions": "Permissions",
  "roles.builtIn": "Built-in",
  "roles.loadFailed": "Roles did not load",
  "roles.loadError": "Could not load roles.",
  "roles.loadingLabel": "Loading roles",
  "roles.emptyTitle": "No roles yet",
  "roles.emptyBody": "This workspace has no roles defined.",
  "roles.permissionCount": "{granted} of {total}",
  "roles.matrixTitle": "Permissions",
  "roles.matrixSubtitle": "Tick what each role may do.",
  "roles.readOnlyTitle": "You have view-only access",
  "roles.readOnlyBody":
    "Your role can see the permission matrix but not change it. Ask an administrator to adjust a role.",
  // The catalogue is global and the application holds SELECT on it and nothing
  // else, so the screen says why it cannot be edited rather than offering a
  // control the database would refuse.
  "roles.catalogueReadOnly":
    "The permission list is defined by the platform and is the same for every workspace. Roles decide who holds which of them.",
  "roles.saved": "{role} updated",
  "roles.saveFailed": "That permission change could not be saved.",
  "roles.impliedRead": "Granting write also grants read.",

  "role.admin": "Administrator",
  "role.viewer": "Viewer",
  "role.member": "Member",

  "permission.tenant.read": "View workspace settings",
  "permission.tenant.write": "Change workspace settings",
  "permission.user.read": "View users",
  "permission.user.write": "Invite and modify users",
  "permission.connection.read": "View D365 connections",
  "permission.connection.write": "Manage D365 connections",
  "permission.audit.read": "Read the audit log",

  "permissionGroup.tenant": "Workspace",
  "permissionGroup.user": "Users",
  "permissionGroup.connection": "D365",
  "permissionGroup.audit": "Audit",

  // ── Activity ─────────────────────────────────────────────────────────────
  "activity.title": "Activity",
  "activity.subtitle":
    "Audit entries, newest first. Action names match what the API records.",
  "activity.searchPlaceholder": "Search action, actor or target…",
  "activity.searchLabel": "Search activity",
  "activity.filterSeverity": "Filter by severity",
  "activity.allSeverities": "All severities",
  "activity.emptyTitle": "Nothing matches these filters",
  "activity.emptyBody": "No audit entries were found for that search or severity.",
  "activity.loadFailed": "Activity did not load",
  "activity.loadError": "Could not load activity.",
  "activity.loadingLabel": "Loading activity",

  "severity.info": "Info",
  "severity.success": "Success",
  "severity.warning": "Warning",
  "severity.danger": "Critical",

  // ── Settings ─────────────────────────────────────────────────────────────
  "settings.title": "Settings",
  "settings.subtitle": "Your account, this workspace, and how the portal looks.",
  "settings.tabProfile": "Profile",
  "settings.tabAppearance": "Appearance",
  "settings.tabSecurity": "Security",
  "settings.profile": "Profile",
  "settings.profileSubtitle": "How you appear in this portal.",
  "settings.profileNote":
    "The API has no name field yet, so the display name is derived from your email address.",
  "settings.workspace": "Workspace",
  "settings.workspaceSubtitle": "The tenant you are signed in to.",
  "settings.slug": "Slug",
  "settings.tenantId": "Tenant ID",
  "settings.appearance": "Appearance",
  "settings.appearanceSubtitle":
    "Applies to this browser only, and takes effect immediately.",
  "settings.themeHeading": "Colour theme",
  "settings.themeBody":
    "“Match system” follows your device, including its light/dark schedule.",
  "settings.languageHeading": "Language",
  "settings.languageBody":
    "Arabic switches the whole portal to a right-to-left layout.",
  "settings.password": "Password",
  "settings.passwordSubtitle": "Used together with your workspace name to sign in.",
  "settings.passwordUnavailable": "Not available yet",
  "settings.passwordUnavailableBody":
    "Changing a password from inside the portal needs an endpoint the API does not expose yet. Until it does, a password is set by redeeming an invitation.",
  "settings.sessions": "Sessions",
  "settings.sessionsSubtitle": "Where this account is currently signed in.",
  "settings.signOutLocalTitle": "Signing out is local only",
  "settings.signOutLocalBody":
    "There is no endpoint to revoke a session yet, so signing out clears this browser and nothing else — the refresh token stays valid until it expires on its own.",
  "settings.thisBrowser": "This browser",
  "settings.activeNow": "Active now",

  // ── Not found ────────────────────────────────────────────────────────────
  "notFound.code": "404",
  "notFound.title": "This page does not exist",
  "notFound.body": "The link may be out of date, or the address may have a typo in it.",
  "notFound.backToDashboard": "Back to the dashboard",
  "notFound.goToSignIn": "Go to sign in",

  // ── Request failures ─────────────────────────────────────────────────────
  // Used when the server sent a status and no message of its own. The 401
  // wording says "sign-in details" without saying which was wrong, matching an
  // API that answers identically for a bad password, an unknown email and an
  // unknown workspace so the response cannot be used to enumerate accounts.
  "error.offline": "Could not reach the server. Check your connection and try again.",
  "error.badRequest": "Some of the details are not valid. Check the highlighted fields.",
  "error.unauthorized": "Those sign-in details were not accepted.",
  "error.forbidden": "You do not have access to this.",
  "error.notFound": "We could not find what you asked for.",
  "error.conflict": "That conflicts with something that already exists.",
  "error.tooManyRequests": "Too many attempts. Wait a moment and try again.",
  "error.server": "Something went wrong on our side. Try again shortly.",
  "error.generic": "The request could not be completed."
} as const;

/** Every valid message key. A typo at a call site is a compile error. */
export type MessageKey = keyof typeof en;

/** The shape every other locale must satisfy, exactly. */
export type Messages = Record<MessageKey, string>;
