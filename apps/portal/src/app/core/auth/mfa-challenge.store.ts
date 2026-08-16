import { Injectable, computed, signal } from "@angular/core";
import type { MfaRequired } from "@growpath/contracts";

/**
 * The half-finished sign-in between a correct password and a verified code.
 *
 * In memory, and never persisted. A challenge token is a credential — a weak
 * one, exchangeable for nothing but an MFA verification, but a credential all
 * the same — and it is deliberately short-lived. Writing it to storage would
 * let it outlive the page it belongs to for no benefit: if the tab reloads
 * mid-challenge, signing in again is both correct and cheap.
 *
 * A route guard uses `hasChallenge` so `/mfa` cannot be opened directly. That
 * is a usability control, not a security one — the endpoint refuses a request
 * with no valid challenge token regardless of what the browser shows.
 */
@Injectable({ providedIn: "root" })
export class MfaChallengeStore {
  private readonly state = signal<MfaRequired | null>(null);

  readonly challenge = this.state.asReadonly();
  readonly token = computed(() => this.state()?.challengeToken ?? null);
  readonly hasChallenge = computed(() => this.state() !== null);

  start(challenge: MfaRequired): void {
    this.state.set(challenge);
  }

  clear(): void {
    this.state.set(null);
  }
}
