import { Injectable, signal } from "@angular/core";

const STORAGE_KEY = "growpath.sidebar-collapsed";

/**
 * Chrome state the shell and the topbar both need.
 *
 * Two separate flags rather than one, because the sidebar behaves differently
 * at each end of the breakpoint: on a desktop it collapses to an icon rail and
 * that choice should stick, while on a phone it is an overlay that must close
 * on every navigation. One shared flag would make a phone remember a drawer it
 * should never have remembered.
 */
@Injectable({ providedIn: "root" })
export class LayoutStore {
  private readonly collapsedState = signal(restoreCollapsed());
  private readonly drawerState = signal(false);

  /** Desktop: sidebar reduced to an icon rail. Persisted. */
  readonly collapsed = this.collapsedState.asReadonly();
  /** Mobile: sidebar shown as an overlay drawer. Never persisted. */
  readonly drawerOpen = this.drawerState.asReadonly();

  toggleCollapsed(): void {
    const next = !this.collapsedState();
    this.collapsedState.set(next);
    try {
      localStorage.setItem(STORAGE_KEY, String(next));
    } catch {
      // Private browsing; the collapse still applies for this session.
    }
  }

  openDrawer(): void {
    this.drawerState.set(true);
  }

  closeDrawer(): void {
    this.drawerState.set(false);
  }
}

function restoreCollapsed(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}
