import { ChangeDetectionStrategy, Component, inject, signal } from "@angular/core";
import { FormBuilder, ReactiveFormsModule, Validators } from "@angular/forms";
import { Router, RouterLink } from "@angular/router";
import {
  AuthService,
  DEMO_FAILURE_PASSWORD,
  DEMO_MFA_PASSWORD
} from "@core/auth/auth.service";
import { MfaChallengeStore } from "@core/auth/mfa-challenge.store";
import { describeError } from "@core/http/api-error";
import { injectT } from "@core/i18n/i18n.service";
import { environment } from "@env";
import {
  AlertComponent,
  ButtonComponent,
  FieldComponent,
  IconComponent,
  InputDirective
} from "@shared/ui";
import { AuthLayoutComponent } from "./auth-layout.component";

/**
 * Sign-in.
 *
 * Two fields. An address is unique across the installation, so it identifies one
 * person and the API resolves their workspace from it — the workspace comes back
 * on the response and is shown in the shell, rather than being something the
 * person has to know and type before they are allowed in.
 *
 * The failure message is whatever the API said, unedited. The API answers a
 * wrong password and an unknown email identically and in indistinguishable time,
 * specifically so the response cannot be used to discover who holds an account
 * here. Any attempt to be more helpful — "no such account", "check your
 * password" — hands back exactly what that design is spending effort to
 * withhold.
 */
@Component({
  selector: "app-login-page",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    ReactiveFormsModule,
    RouterLink,
    AlertComponent,
    AuthLayoutComponent,
    ButtonComponent,
    FieldComponent,
    IconComponent,
    InputDirective
  ],
  template: `
    <app-auth-layout [title]="t('login.title')" [subtitle]="t('login.subtitle')">
      <form [formGroup]="form" class="space-y-4" (ngSubmit)="submit()">
        @if (failure()) {
          <ui-alert tone="danger">{{ failure() }}</ui-alert>
        }

        @if (isDemo) {
          <ui-alert tone="info" [title]="t('login.demoTitle')">
            {{
              t("login.demoBody", {
                password: DEMO_FAILURE_PASSWORD,
                mfaPassword: DEMO_MFA_PASSWORD
              })
            }}
          </ui-alert>
        }

        <ui-field
          [label]="t('login.email')"
          controlId="login-email"
          [required]="true"
          [error]="errorFor('email')"
        >
          <input
            uiInput
            id="login-email"
            type="email"
            formControlName="email"
            autocomplete="username"
            placeholder="you@company.com"
            [invalid]="!!errorFor('email')"
          />
        </ui-field>

        <ui-field
          [label]="t('login.password')"
          controlId="login-password"
          [required]="true"
          [error]="errorFor('password')"
        >
          <div class="relative">
            <input
              uiInput
              id="login-password"
              [type]="showPassword() ? 'text' : 'password'"
              formControlName="password"
              autocomplete="current-password"
              class="!pe-11"
              [invalid]="!!errorFor('password')"
            />
            <button
              type="button"
              class="absolute end-1.5 top-1/2 -translate-y-1/2 rounded-lg p-2 text-foreground-subtle transition-colors duration-200 hover:text-foreground"
              [attr.aria-label]="
                showPassword() ? t('login.hidePassword') : t('login.showPassword')
              "
              (click)="showPassword.set(!showPassword())"
            >
              <ui-icon [name]="showPassword() ? 'eye-off' : 'eye'" [size]="16" />
            </button>
          </div>
        </ui-field>

        <button
          uiButton
          type="submit"
          size="lg"
          [block]="true"
          class="!mt-6"
          [loading]="submitting()"
        >
          {{ submitting() ? t("login.submitting") : t("login.submit") }}
        </button>

        <div class="pt-1 text-center">
          <a
            routerLink="/forgot-password"
            class="text-sm text-foreground-muted transition-colors duration-200 hover:text-foreground"
          >
            {{ t("forgot.title") }}
          </a>
        </div>
      </form>

      <!--
        No "create a workspace" link.
        
        Provisioning is a platform-administrator operation now, so this pointed
        signed-out visitors at a form the API would refuse. A tenant is created
        for a customer by whoever operates the installation, not by whoever
        reaches the sign-in page.
      -->
    </app-auth-layout>
  `
})
export class LoginPage {
  private readonly auth = inject(AuthService);
  private readonly challenge = inject(MfaChallengeStore);
  private readonly router = inject(Router);

  protected readonly t = injectT();
  protected readonly submitting = signal(false);
  protected readonly failure = signal<string | null>(null);
  protected readonly showPassword = signal(false);

  /** The two passwords the demo sign-in treats specially. See `fakeSignIn`. */
  protected readonly DEMO_FAILURE_PASSWORD = DEMO_FAILURE_PASSWORD;
  protected readonly DEMO_MFA_PASSWORD = DEMO_MFA_PASSWORD;

  /**
   * Prefilled while the UI is being built, empty otherwise.
   *
   * Reviewing a dashboard should not start with typing a form that accepts
   * anything. The values are inert — nothing authenticates them — and the flag
   * is hard-off in the production environment.
   */
  protected readonly isDemo = environment.useMockApi;

  protected readonly form = inject(FormBuilder).nonNullable.group({
    // No `Validators.email`: the API's own schema takes a non-empty string, and
    // a stricter rule here would reject an address the server would accept.
    email: [this.isDemo ? "amelia.hart@acme.com" : "", [Validators.required]],
    password: [this.isDemo ? "demo-password" : "", [Validators.required]]
  });

  protected errorFor(control: "email" | "password"): string | null {
    const field = this.form.controls[control];
    // Only after they have left the field — validating as someone types tells
    // them their half-typed email is wrong, which it always is.
    if (!field.touched || field.valid) return null;
    return this.t("common.required");
  }

  protected submit(): void {
    this.failure.set(null);

    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }

    this.submitting.set(true);
    this.auth.signIn(this.form.getRawValue()).subscribe({
      next: (response) => {
        // A correct password is not a session when MFA is on. The challenge
        // token is held in memory and exchanged on the next screen; nothing
        // here has, or should have, an access token yet.
        if (response.status === "mfa_required") {
          this.challenge.start(response);
          void this.router.navigateByUrl("/mfa");
          return;
        }

        const returnUrl =
          this.router.parseUrl(this.router.url).queryParams["returnUrl"];
        // Only same-app paths are honoured. `returnUrl` comes from the query
        // string, so an absolute or protocol-relative value would turn this
        // redirect into an open redirect off the back of a real sign-in.
        const target =
          typeof returnUrl === "string" &&
          returnUrl.startsWith("/") &&
          !returnUrl.startsWith("//")
            ? returnUrl
            : "/dashboard";
        void this.router.navigateByUrl(target);
      },
      error: (error: unknown) => {
        this.submitting.set(false);
        this.failure.set(describeError(error, this.t, "login.failed"));
      }
    });
  }
}
