/**
 * The design system's public surface.
 *
 * Features import from `@shared/ui` and never reach for a file inside it, so a
 * primitive can be split, renamed or reimplemented without touching the screens
 * that use it.
 *
 * Everything here is standalone, so a component imports only the handful of
 * primitives it actually renders — there is no module to pull the whole kit in
 * behind one import.
 */

export * from "./alert.component";
export * from "./avatar.component";
export * from "./badge.component";
export * from "./bar-chart.component";
export * from "./button.component";
export * from "./card.component";
export * from "./confirm-dialog.component";
export * from "./dropdown.component";
export * from "./empty-state.component";
export * from "./error-state.component";
export * from "./field.component";
export * from "./icon.component";
export * from "./input.directive";
export * from "./modal.component";
export * from "./otp-input.component";
export * from "./pagination.component";

/**
 * `QrCodeComponent` is deliberately **not** re-exported here.
 *
 * It pulls in the `qrcode` library (~45 kB), and this barrel is imported by the
 * shell and topbar — both eager. Re-exporting it drags the encoder into the
 * initial bundle for every visitor, including the ones who never open Settings.
 * Import it directly from `@shared/ui/qr-code.component` at the one place that
 * renders it, and it stays in that route's lazy chunk.
 *
 * The general rule: anything with a heavy third-party dependency stays off this
 * barrel.
 */
export * from "./skeleton.component";
export * from "./sparkline.component";
export * from "./spinner.component";
export * from "./table.component";
export * from "./tabs.component";
export * from "./toast-host.component";
export * from "./trend-chart.component";
