import type { Routes } from "@angular/router";
import {
  authGuard,
  guestGuard,
  mfaChallengeGuard,
  platformGuard
} from "@core/auth/auth.guard";
import { ShellComponent } from "./layout/shell.component";

/**
 * Every screen is lazy.
 *
 * The shell itself is eager because it is on screen for the whole session, but
 * each page is a `loadComponent`, so the initial bundle carries the frame and
 * one route rather than the entire portal. That matters more here than in most
 * apps: this is an admin tool where most people live on one or two screens and
 * never open the rest.
 */
export const routes: Routes = [
  {
    path: "login",
    canActivate: [guestGuard],
    title: "Sign in · Grow Path Admin",
    loadComponent: () =>
      import("@features/auth/login.page").then((m) => m.LoginPage)
  },
  {
    // No `guestGuard`: sign-in has happened but is not finished, so the user is
    // not yet authenticated and the guard would not bounce them anyway. The
    // challenge guard is what keeps this route honest.
    path: "mfa",
    canActivate: [mfaChallengeGuard],
    title: "Two-step verification · Grow Path Admin",
    loadComponent: () =>
      import("@features/auth/mfa-challenge.page").then((m) => m.MfaChallengePage)
  },
  /*
   * There is no public `create-tenant` route any more.
   *
   * It existed because `POST /tenants` was unauthenticated — a fresh
   * installation had nobody who could hold a token. That is no longer true: the
   * endpoint requires a platform administrator, the first of whom is minted by
   * `pnpm platform-admin` from a shell on the machine that already holds the
   * database credentials. A page whose every submission would 401 is worse than
   * no page, so tenant creation moved to the operator console instead.
   */
  {
    path: "forgot-password",
    canActivate: [guestGuard],
    title: "Reset your password · Grow Path Admin",
    loadComponent: () =>
      import("@features/auth/forgot-password.page").then((m) => m.ForgotPasswordPage)
  },
  {
    // Deliberately not guarded: someone already signed in on this browser may
    // still be following a reset link, and bouncing them to the dashboard would
    // strand the link they were sent.
    path: "reset-password",
    title: "Choose a new password · Grow Path Admin",
    loadComponent: () =>
      import("@features/auth/reset-password.page").then((m) => m.ResetPasswordPage)
  },
  {
    path: "accept-invitation",
    title: "Accept your invitation · Grow Path Admin",
    loadComponent: () =>
      import("@features/auth/accept-invitation.page").then(
        (m) => m.AcceptInvitationPage
      )
  },
  {
    path: "",
    component: ShellComponent,
    canActivate: [authGuard],
    children: [
      { path: "", pathMatch: "full", redirectTo: "dashboard" },
      {
        path: "dashboard",
        title: "Dashboard · Grow Path Admin",
        loadComponent: () =>
          import("@features/dashboard/dashboard.page").then((m) => m.DashboardPage)
      },
      {
        path: "tenants",
        title: "Tenants · Grow Path Admin",
        loadComponent: () =>
          import("@features/tenants/tenants.page").then((m) => m.TenantsPage)
      },
      {
        // `:id` binds to the page's `id` input via `withComponentInputBinding()`.
        path: "tenants/:id",
        title: "Tenant · Grow Path Admin",
        loadComponent: () =>
          import("@features/tenants/tenant-detail.page").then(
            (m) => m.TenantDetailPage
          )
      },
      {
        path: "users",
        title: "Users · Grow Path Admin",
        loadComponent: () =>
          import("@features/users/users.page").then((m) => m.UsersPage)
      },
      {
        path: "users/:id",
        title: "User · Grow Path Admin",
        loadComponent: () =>
          import("@features/users/user-detail.page").then((m) => m.UserDetailPage)
      },
      {
        path: "roles",
        title: "Roles · Grow Path Admin",
        loadComponent: () =>
          import("@features/roles/roles.page").then((m) => m.RolesPage)
      },
      {
        path: "activity",
        title: "Activity · Grow Path Admin",
        loadComponent: () =>
          import("@features/activity/activity.page").then((m) => m.ActivityPage)
      },
      {
        /*
         * D365 connections and the mobile bootstrap (US-065, US-040).
         *
         * One route rather than two: an administrator setting a tenant up does
         * both in one sitting, so they are tabs on one screen. Not guarded on
         * `connection.read` here — no tenant-scoped route in this portal filters
         * by permission yet (that is US-031), and adding a check on this one
         * alone would read as though the others were covered.
         */
        path: "configuration",
        title: "Configuration · Grow Path Admin",
        loadComponent: () =>
          import("@features/configuration/configuration.page").then(
            (m) => m.ConfigurationPage
          )
      },
      {
        path: "settings",
        title: "Settings · Grow Path Admin",
        loadComponent: () =>
          import("@features/settings/settings.page").then((m) => m.SettingsPage)
      },
      /*
       * The cross-tenant screens.
       *
       * Guarded twice on the way in — `authGuard` on the parent, `platformGuard`
       * here — and a third time by the API, which checks the signed token claim
       * and the caller's tenant on every request. The two client guards spare an
       * ordinary administrator a page of refusals; only the third is a boundary.
       */
      {
        path: "platform/tenants",
        canActivate: [platformGuard],
        title: "All tenants · Grow Path Admin",
        loadComponent: () =>
          import("@features/platform/all-tenants.page").then((m) => m.AllTenantsPage)
      },
      {
        // Declared after `platform/tenants` and before the `:id` form would
        // matter — Angular matches in order, and a literal segment must not be
        // shadowed by a parameter one.
        path: "platform/tenants/:id",
        canActivate: [platformGuard],
        title: "Tenant · Grow Path Admin",
        loadComponent: () =>
          import("@features/platform/platform-tenant-detail.page").then(
            (m) => m.PlatformTenantDetailPage
          )
      },
      {
        path: "platform/users",
        canActivate: [platformGuard],
        title: "All users · Grow Path Admin",
        loadComponent: () =>
          import("@features/platform/all-users.page").then((m) => m.AllUsersPage)
      },
      {
        path: "platform/admins",
        canActivate: [platformGuard],
        title: "Super administrators · Grow Path Admin",
        loadComponent: () =>
          import("@features/platform/platform-admins.page").then(
            (m) => m.PlatformAdminsPage
          )
      },
      {
        path: "platform/permissions",
        canActivate: [platformGuard],
        title: "Permission catalogue · Grow Path Admin",
        loadComponent: () =>
          import("@features/platform/permissions.page").then(
            (m) => m.PlatformPermissionsPage
          )
      }
    ]
  },
  {
    // Outside the shell: a mistyped URL from a signed-out visitor should show
    // "not found", not bounce through the sign-in guard first.
    path: "**",
    title: "Not found · Grow Path Admin",
    loadComponent: () =>
      import("@features/not-found/not-found.page").then((m) => m.NotFoundPage)
  }
];
