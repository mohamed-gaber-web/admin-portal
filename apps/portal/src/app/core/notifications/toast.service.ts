import { Injectable, signal } from "@angular/core";

export type ToastTone = "success" | "danger" | "warning" | "info";

export interface Toast {
  id: number;
  tone: ToastTone;
  title: string;
  detail?: string;
}

const DISMISS_AFTER_MS = 5_000;

/**
 * Transient confirmations and failures.
 *
 * Toasts are for things the user already knows they did — "tenant created",
 * "copy failed". Anything they have to act on belongs inline, next to the
 * control that caused it: a toast that disappears after five seconds is a poor
 * place to put a message that matters.
 */
@Injectable({ providedIn: "root" })
export class ToastService {
  private readonly items = signal<readonly Toast[]>([]);
  private nextId = 1;

  readonly toasts = this.items.asReadonly();

  success(title: string, detail?: string): void {
    this.push("success", title, detail);
  }

  error(title: string, detail?: string): void {
    this.push("danger", title, detail);
  }

  warn(title: string, detail?: string): void {
    this.push("warning", title, detail);
  }

  info(title: string, detail?: string): void {
    this.push("info", title, detail);
  }

  dismiss(id: number): void {
    this.items.update((current) => current.filter((toast) => toast.id !== id));
  }

  private push(tone: ToastTone, title: string, detail?: string): void {
    const id = this.nextId++;
    this.items.update((current) => [...current, { id, tone, title, detail }]);
    setTimeout(() => this.dismiss(id), DISMISS_AFTER_MS);
  }
}
