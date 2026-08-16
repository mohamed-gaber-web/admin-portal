import type { MessageKey } from "@core/i18n/messages/en";
import type { IconName } from "@shared/ui/icon.component";

/**
 * One entry in the sidebar.
 *
 * Carries a message key, not a label. Navigation is defined once as data and
 * rendered in whichever language is active, so a hard-coded English label here
 * would be the one part of the chrome that never translates.
 */
export interface NavItem {
  labelKey: MessageKey;
  route: string;
  icon: IconName;
  /** Rendered as a pill on the end of the row — unread counts, alerts. */
  badge?: string;
}

/** A titled run of nav items, so the sidebar can group rather than list. */
export interface NavSection {
  titleKey: MessageKey;
  items: NavItem[];
  /**
   * Hides the whole section unless the session holds this permission.
   *
   * A display rule, not a security one. The routes it leads to are guarded on
   * the client *and* on the API, which re-checks the signed token claim on every
   * request — so someone who edits their stored permissions gets the menu entry
   * and a page full of refusals, which is the correct outcome.
   *
   * Declared on the section rather than per item because the one section that
   * needs it is all-or-nothing: an operator holds the tier or does not.
   */
  requiresPermission?: string;
}

/** One hop in the topbar breadcrumb trail. The last hop carries no route. */
export interface Crumb {
  labelKey: MessageKey;
  route?: string;
}
